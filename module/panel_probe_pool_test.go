package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProbeSlotsAreSharedAcrossPanelEndpoints(t *testing.T) {
	control, err := newPanelRuntime(options{config: filepath.Join(t.TempDir(), "plan.json")})
	if err != nil {
		t.Fatal(err)
	}
	control.latency = make(chan struct{}, 2)
	entered := make(chan struct{}, 2)
	unblock := make(chan struct{})
	var finish sync.Once
	release := func() { finish.Do(func() { close(unblock) }) }
	defer release()
	control.latencyProfile = func(entry profile) (profile, error) {
		entered <- struct{}{}
		<-unblock
		return profile{}, context.Canceled
	}

	const uri = "vless://1087630c-a34c-4b4c-b46e-162d81d05892@203.0.113.99:443?security=tls"
	initial := testPanelEditConfig()
	initial.Profiles[0] = profile{ID: "relay", Protocol: "vless", URI: uri, SubscriptionID: "sub"}
	editor := newPanelEditor(initial, testEditKey, func(context.Context, plan) error {
		t.Error("testing attempted to change the active plan")
		return nil
	})
	subscriptions := newPanelSubscriptions(editor, control)
	subscriptions.cache("sub", subscriptionPreviewEntry{
		token: "token", revision: editor.current().Revision, expires: time.Now().Add(time.Minute),
		profiles: initial.Profiles,
	})
	diagnostics := newPanelDiagnostics(editor, status{}, control)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/runtime/latency", control.checkLatency(editor))
	mux.HandleFunc("POST /api/panel/profiles/import/probe", control.checkImportedVLESS(editor))
	subscriptions.register(mux, diagnostics)

	request := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, testEditOrigin+path, strings.NewReader(body))
		req.Header.Set("Origin", testEditOrigin)
		req.Header.Set("X-RouteHub-Key", testEditKey)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res
	}
	const latencyRequest = `{"profile":"relay"}`
	latencyResponses := make(chan *httptest.ResponseRecorder, 2)
	for i := 0; i < 2; i++ {
		go func() { latencyResponses <- request("/api/runtime/latency", latencyRequest) }()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("two saved-profile probes should run concurrently")
		}
	}

	for _, test := range []struct{ path, body string }{
		{"/api/runtime/latency", latencyRequest},
		{"/api/panel/profiles/import/probe", `{"uri":"` + uri + `"}`},
		{"/api/panel/subscriptions/probe", `{"subscriptionId":"sub","previewToken":"token","profileId":"relay"}`},
	} {
		got := request(test.path, test.body)
		if got.Code != http.StatusTooManyRequests || got.Header().Get("Retry-After") != "1" {
			t.Fatalf("%s bypassed the probe pool: HTTP %d %s", test.path, got.Code, got.Body)
		}
	}
	if _, _, _, err := diagnostics.probeDialer(context.Background(), initial, "relay"); err != errProfileProbeBusy {
		t.Fatalf("diagnostic probe bypassed the pool: %v", err)
	}
	if got, ok := subscriptions.cached("sub", "token", false); !ok || time.Until(got.expires) < 4*time.Minute {
		t.Fatal("an authorized preview probe must keep the reviewed snapshot available")
	}
	release()
	for i := 0; i < 2; i++ {
		select {
		case got := <-latencyResponses:
			if got.Code != http.StatusOK {
				t.Fatalf("held probe failed unexpectedly: HTTP %d %s", got.Code, got.Body)
			}
		case <-time.After(time.Second):
			t.Fatal("held probe did not release its slot")
		}
	}
	if got := request("/api/runtime/latency", latencyRequest); got.Code != http.StatusOK {
		t.Fatalf("released slots cannot be reused: HTTP %d %s", got.Code, got.Body)
	}
}

func TestAvailableProbeMemory(t *testing.T) {
	for _, tt := range []struct {
		info string
		want int
	}{
		{"MemTotal: 497680 kB\nMemAvailable: 86544 kB\n", 86544},
		{"MemFree: 50000 kB\n", 0},
		{"MemAvailable: not-known kB\n", 0},
	} {
		if got := availableProbeMemory(tt.info); got != tt.want {
			t.Errorf("available memory: got %d, want %d", got, tt.want)
		}
	}
}
