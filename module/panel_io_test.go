package main

import (
	"bytes"
	"context"
	"encoding/json"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"routehub/devicepolicy"
	"routehub/ruleimport"
)

func panelIOEditor(t *testing.T) *panelEditor {
	t.Helper()
	config := testPanelEditConfig()
	config.DefaultTarget = "relay"
	config.ZapretServices = &zapretServices{YouTube: true}
	config.Devices = []devicepolicy.Device{{
		MAC: "02:00:00:00:00:01", Label: "sample-device", Addresses: []string{"192.168.1.34"},
		Rules: []rule{{Name: "device-route", Domain: "device.example.net", Target: "zapret"}},
	}}
	return newPanelEditor(config, testEditKey, func(context.Context, plan) error {
		t.Fatal("import or export must not apply state")
		return nil
	})
}

func panelImportRequest(t *testing.T, editor *panelEditor, key, filename, contents, target string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(contents)); err != nil {
		t.Fatal(err)
	}
	if target != "" {
		if err := writer.WriteField("target", target); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, testEditOrigin+"/api/import", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Origin", testEditOrigin)
	request.Header.Set("X-RouteHub-Key", key)
	response := httptest.NewRecorder()
	editor.importRules(response, request)
	return response
}

func TestPanelImportBoundsAndKnownTargets(t *testing.T) {
	editor := panelIOEditor(t)
	revision := editor.snapshot().Revision
	for _, tc := range []struct {
		name, key, filename, data, target string
		status                            int
		want                              string
	}{
		{"TXT uses active default", testEditKey, "routes.txt", "example.org\n", "", 200, "relay"},
		{"TXT may override default", testEditKey, "routes.txt", "example.org\n", "direct", 200, "direct"},
		{"CSV supplies explicit target", testEditKey, "routes.csv", "destination,target\nexample.org,zapret\n", "", 200, "zapret"},
		{"JSON supplies explicit target", testEditKey, "routes.json", `{"rules":[{"domain":"example.org","target":"direct"}]}`, "", 200, "direct"},
		{"unknown offered target", testEditKey, "routes.txt", "example.org\n", "missing", 400, ""},
		{"unknown file target rejects batch", testEditKey, "routes.txt", "example.org\nexample.net > missing\n", "", 400, ""},
		{"file limit", testEditKey, "routes.txt", strings.Repeat("x", maxRuleFileBytes+1), "", 413, ""},
		{"key required", "", "routes.txt", "example.org\n", "", 403, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := panelImportRequest(t, editor, tc.key, tc.filename, tc.data, tc.target)
			if response.Code != tc.status {
				t.Fatalf("unexpected status %d (expected %d)", response.Code, tc.status)
			}
			if tc.want != "" {
				var out struct{ Rules []rule }
				if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil ||
					len(out.Rules) != 1 || out.Rules[0].Domain != "example.org" || out.Rules[0].Target != tc.want {
					t.Fatal("preview does not have the expected route")
				}
			}
			if editor.snapshot().Revision != revision {
				t.Fatal("import changed the active revision")
			}
		})
	}
}

func panelBackupRequest(editor *panelEditor, origin, key, input string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, testEditOrigin+"/api/backup", strings.NewReader(input))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", origin)
	request.Header.Set("X-RouteHub-Key", key)
	response := httptest.NewRecorder()
	editor.backup(response, request)
	return response
}

func TestPanelBackupPortableRulesAndExplicitFullPlan(t *testing.T) {
	editor := panelIOEditor(t)
	for _, tc := range []struct {
		name, input, filename string
	}{
		{"global", `{"scope":"rules"}`, "routehub-rules.json"},
		{"device", `{"scope":"rules","deviceMAC":"02:00:00:00:00:01"}`, "routehub-rules.json"},
		{"configuration", `{"scope":"configuration"}`, "routehub-config.json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := panelBackupRequest(editor, testEditOrigin, testEditKey, tc.input)
			disposition, params, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
			if response.Code != 200 || err != nil || disposition != "attachment" ||
				params["filename"] != tc.filename || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("incorrect download response")
			}
			data := response.Body.Bytes()
			if bytes.Contains(data, []byte(testEditKey)) || bytes.Contains(data, []byte(`"revision"`)) {
				t.Fatal("export exposed editor state")
			}
			if tc.name == "configuration" {
				var saved plan
				if err := json.Unmarshal(data, &saved); err != nil || len(saved.Profiles) != 2 || len(saved.Devices) != 1 ||
					saved.Profiles[0].URI != testSecretURI || saved.Devices[0].MAC != "02:00:00:00:00:01" ||
					saved.DefaultTarget != "relay" || saved.ZapretServices == nil || !saved.ZapretServices.YouTube {
					t.Fatal("explicit full export omitted configuration data")
				}
				return
			}
			var values map[string]json.RawMessage
			if err := json.Unmarshal(data, &values); err != nil || len(values) != 1 || values["rules"] == nil ||
				bytes.Contains(data, []byte(testSecretURI)) || bytes.Contains(data, []byte("sample-device")) {
				t.Fatal("rules export exposed unrelated data")
			}
			targets := map[string]bool{"relay": true, "zapret": true}
			rules, err := ruleimport.Parse(tc.filename, data, "relay", targets)
			if err != nil || len(rules) != 1 ||
				(tc.name == "global" && rules[0].Name != "existing") ||
				(tc.name == "device" && rules[0].Name != "device-route") {
				t.Fatal("rules export did not round-trip")
			}
		})
	}
}

func TestPanelBackupRejectsUnauthorizedOrAmbiguousRequests(t *testing.T) {
	editor := panelIOEditor(t)
	for _, tc := range []struct {
		origin, key, input string
		status             int
	}{
		{"http://example.invalid", testEditKey, `{"scope":"configuration"}`, 403},
		{testEditOrigin, "", `{"scope":"configuration"}`, 403},
		{testEditOrigin, testEditKey, `{"scope":"configuration","extra":true}`, 400},
		{testEditOrigin, testEditKey, `{"scope":"configuration","deviceMAC":"02:00:00:00:00:01"}`, 400},
		{testEditOrigin, testEditKey, `{"scope":"rules","deviceMAC":"02:00:00:00:00:02"}`, 404},
	} {
		response := panelBackupRequest(editor, tc.origin, tc.key, tc.input)
		if response.Code != tc.status || strings.Contains(response.Body.String(), testSecretURI) || response.Header().Get("Content-Disposition") != "" {
			t.Fatalf("invalid request received status %d (expected %d)", response.Code, tc.status)
		}
	}
}
