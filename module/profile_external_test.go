package main

import (
	"net/url"
	"testing"
)

func TestYAMLAndShortcutProfiles(t *testing.T) {
	yaml := `proxies:
  - name: Нидерланды
    type: trojan
    server: proxy.example.org
    port: 8712
    sni: tls.example.org
    password: 'synthetic:password'
`
	preview, err := parseProfileUpload(profileUpload{data: []byte(yaml)}, nil)
	if err != nil || len(preview.Profiles) != 1 {
		t.Fatalf("parse: %+v %v", preview, err)
	}
	entry := preview.Profiles[0]
	link, _ := url.Parse(entry.URI)
	if entry.Server != "proxy.example.org:8712" || entry.Label != "Нидерланды" ||
		link.User.Username() != "synthetic:password" || link.Query().Get("sni") != "tls.example.org" {
		t.Fatal("incorrect YAML conversion")
	}
	data := []byte("[InternetShortcut]\r\nURL=hy2://only-demo@edge.example:443#Estonia\r\n")
	preview, err = parseProfileUpload(profileUpload{data: data}, nil)
	if err != nil || preview.Profiles[0].Protocol != "hysteria2" || preview.Profiles[0].Label != "Estonia" {
		t.Fatalf("shortcut: %+v %v", preview, err)
	}
}
