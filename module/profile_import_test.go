package main

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

const profileTestHost = "192.168.10.1:18952"
const profileTestOrigin = "http://" + profileTestHost
const profileTestKey = "fictional-panel-key"

func profileRequest(t *testing.T, file []byte, extra string, includeFile bool) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if includeFile {
		part, err := writer.CreateFormFile("file", "router-profile-with-private-name.txt")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(file); err != nil {
			t.Fatal(err)
		}
	}
	if extra != "" {
		if err := writer.WriteField("interface", extra); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, profileTestOrigin+"/api/profiles/import", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Origin", profileTestOrigin)
	request.Header.Set("X-RouteHub-Key", profileTestKey)
	request.RemoteAddr = "192.168.10.42:10001"
	return request
}

func profileTestEditor(t *testing.T, key string) *panelEditor {
	t.Helper()
	return newPanelEditor(plan{Profiles: []profile{{ID: "vless-1", Protocol: "vless", URI: "vless://existing@example.test"}}}, key, func(context.Context, plan) error {
		t.Fatal("profile import must not apply or save the router configuration")
		return nil
	})
}

func TestProfileImportPreviewOnly(t *testing.T) {
	editor := profileTestEditor(t, profileTestKey)
	before := editor.current().Revision
	file := []byte("\ufeff# sample\r\nVLESS://synthetic-id@edge.example:443?security=tls#raw-fragment\r\nhy2://synthetic-pass@edge.example:8443/\r\ntrojan://synthetic-pass@[2001:db8::5]:443\r\n")
	request := profileRequest(t, file, "", true)
	response := httptest.NewRecorder()
	handler(editor, status{}, profileTestHost, netip.MustParsePrefix("192.168.10.0/24"), "", new(trafficMonitor), nil, nil).ServeHTTP(response, request)
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("preview got status %d and cache policy %s: %s", response.Code, response.Header().Get("Cache-Control"), response.Body)
	}
	var parsed profileImportPreview
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Profiles) != 3 || parsed.Profiles[0].ID != "vless-2" || parsed.Profiles[1].Protocol != "hysteria2" || parsed.Profiles[2].Protocol != "trojan" {
		t.Fatalf("unexpected profile metadata: %#v", parsed.Profiles)
	}
	if parsed.Profiles[0].Label != "raw-fragment" || strings.Contains(response.Body.String(), "router-profile-with-private-name") {
		t.Fatal("unexpected imported label or leaked upload filename")
	}
	if editor.current().Revision != before || len(editor.current().Profiles) != 1 {
		t.Fatal("preview changed the active configuration")
	}
}

func TestProfileUploadAuthorizationAndBounds(t *testing.T) {
	for _, tc := range []struct {
		name   string
		file   []byte
		change func(*http.Request)
		status int
	}{
		{"valid", []byte("trojan://fictional@edge.example:443"), nil, http.StatusOK},
		{"malformed line without leak", []byte("trojan://fictional@edge.example:443\ntrojan://sensitive.invalid:bad"), nil, http.StatusBadRequest},
		{"invalid UTF-8", []byte{0xff, 0xfe}, nil, http.StatusBadRequest},
		{"NUL binary", []byte{'#', 0, '\n'}, nil, http.StatusBadRequest},
		{"over size", bytes.Repeat([]byte{'x'}, maxProfileFileBytes+1), nil, http.StatusRequestEntityTooLarge},
		{"wrong media type", []byte("trojan://fictional@edge.example:443"), func(req *http.Request) { req.Header.Set("Content-Type", "application/json") }, http.StatusUnsupportedMediaType},
		{"wrong origin", []byte("trojan://fictional@edge.example:443"), func(req *http.Request) { req.Header.Set("Origin", "https://foreign.example") }, http.StatusForbidden},
		{"wrong key", []byte("trojan://fictional@edge.example:443"), func(req *http.Request) { req.Header.Set("X-RouteHub-Key", "wrong-key") }, http.StatusForbidden},
		{"outside LAN", []byte("trojan://fictional@edge.example:443"), func(req *http.Request) { req.RemoteAddr = "192.0.2.42:10001" }, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			initialized := profileTestEditor(t, profileTestKey)
			request := profileRequest(t, tc.file, "", true)
			if tc.change != nil {
				tc.change(request)
			}
			result := httptest.NewRecorder()
			handler(initialized, status{}, profileTestHost, netip.MustParsePrefix("192.168.10.0/24"), "", new(trafficMonitor), nil, nil).ServeHTTP(result, request)
			if result.Code != tc.status {
				t.Fatalf("got %d: %s", result.Code, result.Body)
			}
			if tc.status != http.StatusOK && (strings.Contains(result.Body.String(), "sensitive.invalid") || strings.Contains(result.Body.String(), "trojan://")) {
				t.Fatal("error echoed confidential upload content")
			}
		})
	}
	request := profileRequest(t, nil, "wg0", false)
	result := httptest.NewRecorder()
	profileTestEditor(t, profileTestKey).importProfiles(result, request)
	if result.Code != http.StatusBadRequest {
		t.Fatalf("missing file returned %d", result.Code)
	}
}

func TestXrayProfileImportValidatesWholeBatch(t *testing.T) {
	const vless = `{"protocol":"vless","tag":"private-tag","settings":{"vnext":[{"address":"v.example","port":443,"users":[{"id":"fictional-id","encryption":"none"}]}]},"streamSettings":{"network":"raw"}}`
	const trojan = `{"protocol":"trojan","settings":{"servers":[{"address":"t.example","port":443,"password":"fictional-password"}]},"streamSettings":{"security":"tls"}}`
	const hysteria = `{"protocol":"hysteria","settings":{"version":2,"address":"h.example","port":443},"streamSettings":{"network":"hysteria","security":"tls","hysteriaSettings":{"version":2,"auth":"fictional-secret"}}}`
	const direct = `{"protocol":"freedom","tag":"direct"}`
	file := []byte(`{"outbounds":[` + vless + `,` + direct + `,` + trojan + `,` + hysteria + `]}`)
	got, err := parseProfileUpload(profileUpload{data: file}, nil)
	if err != nil || len(got.Profiles) != 3 || got.Note == "" || got.Profiles[0].ID != "vless-1" || got.Profiles[2].ID != "hysteria2-1" {
		t.Fatalf("unexpected VPN profiles or diagnostics: %v", err)
	}
	for _, entry := range got.Profiles {
		outbound, err := profileOutbound(entry)
		if err != nil || outbound["tag"] != entry.ID || strings.Contains(string(entry.Outbound), "private-tag") {
			t.Fatalf("invalid outbound or unexpected imported tag: %v", err)
		}
	}
	for _, content := range []string{trojan, `[` + hysteria + `]`} {
		if draft, err := parseProfileUpload(profileUpload{data: []byte(content)}, nil); err != nil || len(draft.Profiles) != 1 {
			t.Fatalf("single outbound or array got %v", err)
		}
	}
	for name, content := range map[string]string{
		"unsupported sibling": "[" + trojan + `,{"protocol":"vmess"}]`,
		"malformed sibling":   "[" + trojan + `,{"protocol":"vless","settings":{}}]`,
		"not array":           `{"outbounds":{}}`,
		"empty array":         `{"outbounds":[]}`,
		"bad JSON":            `{"outbounds":`,
		"array null":          `[null]`,
		"cross-linked":        strings.Replace(trojan, `"settings"`, `"proxySettings":{"tag":"another-private-tag"},"settings"`, 1),
		"Hysteria version 1":  strings.ReplaceAll(hysteria, `"version":2`, `"version":1`),
	} {
		t.Run(name, func(t *testing.T) {
			parsed, err := parseProfileUpload(profileUpload{data: []byte(content)}, nil)
			if err == nil || len(parsed.Profiles) != 0 || strings.Contains(err.Error(), "fictional-secret") || strings.Contains(err.Error(), "private.invalid") {
				t.Fatalf("unexpected batch result: %v", err)
			}
		})
	}
}

func TestXrayProfileImportComments(t *testing.T) {
	const raw = `// Example profile
{"outbounds": [ /* keep the URI in the string */
	{"protocol":"trojan", "settings":{"address":"edge.example", "port":443, "password":"fictional://a/*b*/"}}
]}`
	preview, err := parseProfileUpload(profileUpload{data: []byte(raw)}, nil)
	if err != nil || len(preview.Profiles) != 1 || !strings.Contains(string(preview.Profiles[0].Outbound), "fictional://a/*b*/") {
		t.Fatalf("commented Xray configuration returned %v", err)
	}
	for _, document := range []string{`/* unfinished`, strings.Replace(raw, "443", "44/* split */3", 1)} {
		if _, err := parseProfileUpload(profileUpload{data: []byte(document)}, nil); err == nil {
			t.Fatal("accepted invalid JSON comments")
		}
	}
}

func TestAmneziaWGPreviewAndPublicRedaction(t *testing.T) {
	const ini = "[Interface]\nPrivateKey = 9V69IbZnP98bTaNzrw153boF3SU7je3IzEF8JBc1Ass=\nAddress = 192.0.2.2/32\nJc=8\nI1=<b 0x00>\n[Peer]\nPublicKey = 4LjP7Zb1o/WOmVq7JNSJGTHEVoQwKEugpvDI9w/hTQg=\nEndpoint = edge.example:443\nAllowedIPs = 0.0.0.0/0"
	result := httptest.NewRecorder()
	profileTestEditor(t, profileTestKey).importProfiles(result, profileRequest(t, []byte(ini), "", true))
	var preview profileImportPreview
	if result.Code != http.StatusOK || json.Unmarshal(result.Body.Bytes(), &preview) != nil || len(preview.Profiles) != 1 {
		t.Fatalf("AmneziaWG preview returned %d", result.Code)
	}
	if got := preview.Profiles[0]; got.Protocol != "amneziawg" || got.AWGConfig != ini || got.AWGVersion != "3.1" || got.Server != "edge.example:443" {
		t.Fatal("authenticated AmneziaWG preview contains incorrect metadata")
	}
	config := plan{Profiles: preview.Profiles}
	if got := config.public().Profiles[0]; got.AWGConfig != "" || got.AWGVersion != "3.1" {
		t.Fatal("public AmneziaWG payload should redact private configuration")
	}
	fixed := httptest.NewRecorder()
	profileTestEditor(t, profileTestKey).importProfiles(fixed, profileRequest(t, []byte(ini), "wg0", true))
	if fixed.Code != http.StatusOK || strings.Contains(fixed.Body.String(), "PrivateKey") {
		t.Fatal("preview using an existing interface should not preserve the native key")
	}
	plainWireGuard := strings.Replace(ini, "Jc=8\nI1=<b 0x00>\n", "", 1)
	if _, err := parseProfileUpload(profileUpload{data: []byte(plainWireGuard), interfaceName: "wg0"}, nil); err == nil || !strings.Contains(err.Error(), "WireGuard") {
		t.Fatal("ordinary WireGuard should be distinguished from AmneziaWG")
	}
	if _, err := parseProfileUpload(profileUpload{data: []byte(ini), interfaceName: "lo"}, nil); err == nil {
		t.Fatal("loopback must not be accepted as the WireGuard interface")
	}
}
