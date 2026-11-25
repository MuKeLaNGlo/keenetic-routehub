package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func savedCheckRequest(t *testing.T, revision string, checks []savedCheck) string {
	t.Helper()
	data, err := json.Marshal(object{"revision": revision, "savedChecks": checks})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func testSavedCheck() savedCheck {
	return savedCheck{ID: "check-1", Name: "Офис", Source: panelRouteSource{Type: "segment", SegmentID: "br0"},
		Target: "example.net", Family: "v4", Proto: "tcp", Port: 443, Expect: "vpn"}
}

func TestSavedChecksPersistWithoutReplacingEngine(t *testing.T) {
	initial, err := validatePlan(testPanelEditConfig())
	if err != nil {
		t.Fatal(err)
	}
	active := initial
	file := filepath.Join(t.TempDir(), "config.json")
	applyCalls := 0
	editor := newPanelEditor(initial, testEditKey, func(ctx context.Context, next plan) error {
		applyCalls++
		// The deliberately absent engine/Xray is valid only for metadata changes.
		_, _, err := replaceRuntime(ctx, options{config: file}, nil, "", active, next, runtimeSelection{}, runtimeSelection{}, true)
		if err == nil {
			active = next
		}
		return err
	})
	check := testSavedCheck()
	check.Name, check.Target = " Офис ", "Example.NET."
	base := editor.current().Revision
	body := savedCheckRequest(t, base, []savedCheck{check})
	if response := putPanelPlan(editor, testEditOrigin, testEditKey, body); response.Code != http.StatusOK {
		t.Fatalf("save returned %d (%s)", response.Code, response.Body)
	}
	loaded, err := loadPlan(file)
	if err != nil || len(loaded.SavedChecks) != 1 || loaded.SavedChecks[0] != testSavedCheck() ||
		loaded.Profiles[0].URI != testSecretURI || applyCalls != 1 {
		t.Fatalf("saved route check did not round-trip (%d applications, %v)", applyCalls, err)
	}
	if response := putPanelPlan(editor, testEditOrigin, testEditKey, body); response.Code != http.StatusConflict {
		t.Fatalf("stale revision returned %d", response.Code)
	}
	noChange := savedCheckRequest(t, editor.current().Revision, []savedCheck{check})
	if response := putPanelPlan(editor, testEditOrigin, testEditKey, noChange); response.Code != http.StatusOK || applyCalls != 1 {
		t.Fatalf("no-op request returned %d, %d applications", response.Code, applyCalls)
	}
	clear := savedCheckRequest(t, editor.current().Revision, []savedCheck{})
	if response := putPanelPlan(editor, testEditOrigin, testEditKey, clear); response.Code != http.StatusOK {
		t.Fatalf("empty list returned %d (%s)", response.Code, response.Body)
	}
	loaded, err = loadPlan(file)
	if err != nil || len(loaded.SavedChecks) != 0 || applyCalls != 2 {
		t.Fatalf("saved checks were not cleared (%d applications, %v)", applyCalls, err)
	}
}

func TestRequiredSavedCheckGuardsPlanReplacement(t *testing.T) {
	initial, err := validatePlan(testPanelEditConfig())
	if err != nil {
		t.Fatal(err)
	}
	check := testSavedCheck()
	check.Required = true
	initial.SavedChecks = []savedCheck{check}
	applyCalls := 0
	editor := newPanelEditor(initial, testEditKey, func(context.Context, plan) error {
		applyCalls++
		return nil
	})
	editor.refreshBindings = true
	revision := editor.current().Revision
	update := `{"revision":"` + revision + `","profiles":[{"id":"relay","protocol":"trojan"},{"id":"wire","protocol":"amneziawg"}],"rules":[],"savedChecks":null}`
	request := httptest.NewRequest(http.MethodPost, testEditOrigin+"/api/panel/apply/preview", strings.NewReader(update))
	request.Header.Set("Origin", testEditOrigin)
	request.Header.Set("X-RouteHub-Key", testEditKey)
	preview := httptest.NewRecorder()
	editor.previewUpdate(preview, request)
	var document struct {
		Checks []savedCheckComparison `json:"checks"`
		Errors []string               `json:"errors"`
	}
	if err := json.Unmarshal(preview.Body.Bytes(), &document); err != nil || len(document.Checks) != 1 || len(document.Errors) != 1 ||
		document.Checks[0].Live != "VPN" || document.Checks[0].Draft != "Напрямую" || document.Checks[0].OK {
		t.Fatalf("preview incorrectly compared required check: %s (%v)", preview.Body, err)
	}
	if response := putPanelPlan(editor, testEditOrigin, testEditKey, update); response.Code != http.StatusUnprocessableEntity || applyCalls != 0 {
		t.Fatalf("application bypassed required check: %d, %d calls", response.Code, applyCalls)
	}
	update = strings.Replace(update, `"rules":[]`, `"rules":[{"name":"VPN","domain":"example.net","target":"relay"}]`, 1)
	if response := putPanelPlan(editor, testEditOrigin, testEditKey, update); response.Code != http.StatusOK || applyCalls != 1 || len(editor.current().SavedChecks) != 1 {
		t.Fatalf("full update with null did not retain checks: %d, %d calls", response.Code, applyCalls)
	}
}

func TestSavedCheckSchemaRejectsInvalidOrExcessiveEntries(t *testing.T) {
	check := testSavedCheck()
	for _, list := range [][]savedCheck{{check, check}, make([]savedCheck, maxSavedChecks+1)} {
		if _, err := normalizeSavedChecks(list); err == nil {
			t.Fatal("invalid catalog accepted")
		}
	}
	check.Target = "https://example.net/"
	if _, err := normalizeSavedChecks([]savedCheck{check}); err == nil {
		t.Fatal("URL accepted as routing domain")
	}
}
