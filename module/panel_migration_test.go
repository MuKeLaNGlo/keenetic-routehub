package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPanelSessionAuthenticatesMutationsAndPersistsPasswordChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-password.json")
	editor := newPanelEditor(testPanelEditConfig(), testEditKey, func(context.Context, plan) error { return nil })
	editor.auth = newPanelAuth(path, testEditKey)
	server := handler(editor, status{}, "127.0.0.1:18952", netip.MustParsePrefix("192.0.2.0/24"), "", new(trafficMonitor), nil, nil)
	request := func(method, path, origin, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, testEditOrigin+path, strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	const sessionPath = "/api/panel/session"
	const initial = `{"password":"test-edit-key"}`
	if got := request("GET", "/api/panel/capabilities", "", "", nil).Code; got != http.StatusUnauthorized {
		t.Fatalf("unauthenticated data request: %d", got)
	}
	if got := request("POST", sessionPath, "http://outside.invalid", initial, nil).Code; got != http.StatusForbidden {
		t.Fatalf("cross-origin sign-in: %d", got)
	}
	login := request("POST", sessionPath, testEditOrigin, initial, nil)
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("sign-in failed: %d", login.Code)
	}
	first := login.Result().Cookies()[0]
	if !first.HttpOnly || first.SameSite != http.SameSiteStrictMode {
		t.Fatal("insecure session cookie attributes")
	}
	if got := request("GET", "/api/panel/capabilities", "", "", first).Code; got != http.StatusOK {
		t.Fatalf("session cannot read capabilities: %d", got)
	}
	planUpdate := `{"revision":"` + editor.current().Revision + `","profiles":[],"rules":[]}`
	if got := request("PUT", "/api/plan", "http://outside.invalid", planUpdate, first).Code; got != http.StatusForbidden {
		t.Fatalf("cross-origin session write: %d", got)
	}
	if got := request("PUT", "/api/plan", testEditOrigin, planUpdate, first).Code; got != http.StatusOK {
		t.Fatalf("same-origin session write: %d", got)
	}
	changed := request("PUT", "/api/panel/password", testEditOrigin,
		`{"currentPassword":"test-edit-key","newPassword":"new test password"}`, first)
	if changed.Code != http.StatusOK || len(changed.Result().Cookies()) != 1 {
		t.Fatalf("password change failed: %d", changed.Code)
	}
	if got := request("GET", "/api/panel/capabilities", "", "", first).Code; got != http.StatusUnauthorized {
		t.Fatalf("stale session survived password change: %d", got)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("password verifier is not stored privately")
	}
	editor.auth = newPanelAuth(path, testEditKey)
	server = handler(editor, status{}, "127.0.0.1:18952", netip.MustParsePrefix("192.0.2.0/24"), "", new(trafficMonitor), nil, nil)
	if got := request("POST", sessionPath, testEditOrigin, initial, nil).Code; got != http.StatusUnauthorized {
		t.Fatalf("initial password still works after rotation: %d", got)
	}
	if got := request("POST", sessionPath, testEditOrigin, `{"password":"new test password"}`, nil).Code; got != http.StatusOK {
		t.Fatalf("new password failed after restart: %d", got)
	}
}

func TestPanelPreviewAndRestoreRoutingRevision(t *testing.T) {
	applied := 0
	editor := newPanelEditor(testPanelEditConfig(), testEditKey, func(context.Context, plan) error {
		applied++
		return nil
	})
	editor.history = filepath.Join(t.TempDir(), "revisions")
	before := editor.current().Revision
	body := `{"revision":"` + before + `","profiles":[],"rules":[]}`
	request := httptest.NewRequest("POST", testEditOrigin+"/api/panel/apply/preview", strings.NewReader(body))
	request.Header.Set("Origin", testEditOrigin)
	request.Header.Set("X-RouteHub-Key", testEditKey)
	w := httptest.NewRecorder()
	editor.previewUpdate(w, request)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"errors":[]`) || applied != 0 {
		t.Fatalf("preview failed or changed the configuration: %d %d %s", w.Code, applied, w.Body)
	}
	if w := putPanelPlan(editor, testEditOrigin, testEditKey, body); w.Code != http.StatusOK || applied != 1 {
		t.Fatalf("apply failed: %d %s", w.Code, w.Body)
	}
	if revisions := editor.listRevisions(); len(revisions) != 1 || revisions[0].Revision != before {
		t.Fatal("previous revision was not archived")
	}
	restore := httptest.NewRequest("POST", testEditOrigin+"/api/panel/revisions/restore", strings.NewReader(
		`{"revision":"`+before+`","baseRevision":"`+editor.current().Revision+`"}`))
	restore.Header.Set("Origin", testEditOrigin)
	restore.Header.Set("X-RouteHub-Key", testEditKey)
	restore.Header.Set("Content-Type", "application/json")
	restored := httptest.NewRecorder()
	editor.revisionRestore(restored, restore)
	if restored.Code != http.StatusOK || applied != 2 || editor.current().Profiles[0].URI != testSecretURI {
		t.Fatalf("restore failed to retain private profile: %d %s", restored.Code, restored.Body)
	}
}
