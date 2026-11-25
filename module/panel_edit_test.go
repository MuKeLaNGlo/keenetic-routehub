package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	testEditOrigin = "http://127.0.0.1:18952"
	testEditKey    = "test-edit-key"
	testSecretURI  = "trojan://sample-secret@example.net:443"
)

func putPanelPlan(editor *panelEditor, origin, key, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, testEditOrigin+"/api/plan", strings.NewReader(body))
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-RouteHub-Key", key)
	response := httptest.NewRecorder()
	editor.update(response, request)
	return response
}

func testPanelEditConfig() plan {
	return plan{
		PanelPort:   18952,
		SOCKSPort:   18953,
		Transparent: &transparent{Port: 18954, Interface: "br0", Source: "192.168.1.0/24"},
		Profiles: []profile{
			{ID: "relay", Protocol: "trojan", URI: testSecretURI},
			{ID: "wire", Protocol: "amneziawg", Interface: "Wireguard0"},
		},
		Rules: []rule{{Name: "existing", Domain: "example.net", Target: "relay"}},
	}
}

func TestPanelEditPreservesPrivateFieldsAndUpdatesDecision(t *testing.T) {
	initial := testPanelEditConfig()
	applied := 0
	editor := newPanelEditor(initial, testEditKey, func(_ context.Context, p plan) error {
		applied++
		if p.Profiles[0].URI != testSecretURI || p.Profiles[1].Interface != "Wireguard0" {
			t.Fatal("missing retained profile fields")
		}
		if p.SOCKSPort != initial.SOCKSPort || *p.Transparent != *initial.Transparent {
			t.Fatal("editor changed runtime settings")
		}
		return nil
	})
	before := editor.snapshot()
	before.Rules[0].Domain = "modified.invalid"
	before.Transparent.Interface = "modified"
	existing, err := editor.evaluate(destination{Host: "example.net", Network: "tcp", Port: 443})
	if err != nil || existing.Rule != "existing" {
		t.Fatal("snapshot changed active routes")
	}
	response := putPanelPlan(editor, testEditOrigin, testEditKey, `{"revision":"`+before.Revision+`","profiles":[{"id":"relay","protocol":"trojan"},{"id":"wire","protocol":"amneziawg"}],"rules":[{"name":"new","domain":"EXAMPLE.NET","target":"wire"}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("expected successful update, got %d %s", response.Code, response.Body)
	}
	for _, secret := range []string{testSecretURI, "Wireguard0", testEditKey} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatal("response exposed private fields")
		}
	}
	var next struct {
		Revision  string `json:"revision"`
		PanelPort uint16 `json:"panelPort"`
		Rules     []rule `json:"rules"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &next); err != nil ||
		next.Revision == before.Revision || next.Revision == "" ||
		next.PanelPort != initial.PanelPort || len(next.Rules) != 1 {
		t.Fatalf("response has wrong flattened shape: %v", err)
	}
	got, err := editor.evaluate(destination{Host: "www.example.net", Network: "tcp", Port: 443})
	if err != nil || got.Rule != "new" || got.Target != "wire" || applied != 1 {
		t.Fatalf("active routes did not switch: %+v %v", got, err)
	}
}

func TestPanelEditRejectsUnauthorizedInvalidOrStaleWrites(t *testing.T) {
	for _, tc := range []struct {
		name     string
		key      string
		origin   string
		incoming string
		want     int
	}{
		{"origin", testEditKey, "http://example.invalid", "", http.StatusForbidden},
		{"missing origin", testEditKey, "", "", http.StatusForbidden},
		{"key", "different-key", testEditOrigin, "", http.StatusForbidden},
		{"unknown field", testEditKey, testEditOrigin, `,"unknown":true`, http.StatusBadRequest},
		{"stale", testEditKey, testEditOrigin, "stale", http.StatusConflict},
		{"oversized body", testEditKey, testEditOrigin, `,"padding":"` + strings.Repeat("x", maxPlanBytes) + `"`, http.StatusRequestEntityTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			editor := newPanelEditor(testPanelEditConfig(), testEditKey, func(context.Context, plan) error {
				t.Fatal("unauthorized or invalid update reached apply")
				return nil
			})
			revision, extra := editor.snapshot().Revision, tc.incoming
			if extra == "stale" {
				revision, extra = extra, ""
			}
			result := putPanelPlan(editor, tc.origin, tc.key, `{"revision":"`+revision+`","profiles":[],"rules":[]`+extra+`}`)
			if result.Code != tc.want {
				t.Fatalf("got %d, want %d", result.Code, tc.want)
			}
		})
	}
	editor := newPanelEditor(testPanelEditConfig(), "", nil)
	if response := putPanelPlan(editor, testEditOrigin, "", "{}"); response.Code != http.StatusForbidden {
		t.Fatalf("editor without a key has status %d", response.Code)
	}
}

func TestPanelEditRetainsRevisionOnFailedApply(t *testing.T) {
	editor := newPanelEditor(testPanelEditConfig(), testEditKey, func(context.Context, plan) error {
		return errors.New(testSecretURI)
	})
	revision := editor.snapshot().Revision
	response := putPanelPlan(editor, testEditOrigin, testEditKey, `{"revision":"`+revision+`","profiles":[],"rules":[]}`)
	if response.Code != http.StatusUnprocessableEntity ||
		strings.Contains(response.Body.String(), testSecretURI) || editor.snapshot().Revision != revision {
		t.Fatalf("failed update compromised the active revision or response (%d)", response.Code)
	}
}

func TestPanelEditSerializesWritesAndKeepsActiveReadsAvailable(t *testing.T) {
	started := make(chan struct{})
	resume := make(chan struct{})
	defer func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	}()
	editor := newPanelEditor(testPanelEditConfig(), testEditKey, func(context.Context, plan) error {
		close(started)
		<-resume
		return nil
	})
	revision := editor.snapshot().Revision
	body := `{"revision":"` + revision + `","profiles":[],"rules":[]}`
	first := make(chan int, 1)
	go func() { first <- putPanelPlan(editor, testEditOrigin, testEditKey, body).Code }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("update did not enter apply")
	}
	inFlight := make(chan string, 1)
	go func() { inFlight <- editor.snapshot().Revision }()
	select {
	case currentRevision := <-inFlight:
		if currentRevision != revision {
			t.Fatal("pending update was published prematurely")
		}
	case <-time.After(time.Second):
		t.Fatal("active reads blocked during apply")
	}
	second := make(chan int, 1)
	go func() { second <- putPanelPlan(editor, testEditOrigin, testEditKey, body).Code }()
	close(resume)
	if got := <-first; got != http.StatusOK {
		t.Fatalf("first update returned %d", got)
	}
	if got := <-second; got != http.StatusConflict {
		t.Fatalf("concurrent stale update returned %d", got)
	}
}
