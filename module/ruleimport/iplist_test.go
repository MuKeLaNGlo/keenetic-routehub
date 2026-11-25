package ruleimport

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The fixtures are unchanged exports from iplist.opencck.org for site=telegram.org.
// The fixture directories identify each format and the requested data type.
func TestIPListPortalExports(t *testing.T) {
	for _, tc := range []struct {
		dir      string
		filename string
		format   string
		template string
		count    int
		domain   string
		prefix   string
	}{
		{dir: "comma-domains", filename: "ip-list.txt", format: "comma", count: 95, domain: "api.telegram.org"},
		{dir: "kvas-domains", filename: "ip-list.txt", format: "kvas", count: 95, domain: "api.telegram.org"},
		{dir: "bat-cidr4", filename: "ip-list.bat", format: "bat", count: 151, prefix: "91.108.4.0/22"},
		{dir: "wildcard-domains", filename: "ip-list.txt", format: "wildcard", count: 20, domain: "telegram.org"},
		{dir: "amnezia-ip4", filename: "ip-list.json", format: "amnezia", count: 424, prefix: "104.17.94.19/32"},
		{dir: "pac-domains", filename: "ip-list.txt", format: "pac", count: 95, domain: "api.telegram.org"},
		{dir: "singbox-domains", filename: "ip-list.json", format: "singbox", count: 95, domain: "api.telegram.org"},
		{dir: "srs-cidr4", filename: "rule-set.srs", format: "srs", count: 148, prefix: "91.108.4.0/22"},
		{dir: "custom-cidr4", filename: "ip-list.txt", format: "custom", count: 151, prefix: "91.108.4.0/22",
			template: "data: {data} group: {group} site: {site} shortmask: {shortmask} mask: {mask}"},
	} {
		t.Run(tc.dir, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("testdata", "iplist", tc.dir, tc.filename))
			if err != nil {
				t.Fatal(err)
			}
			formats := []string{tc.format}
			if tc.format != "custom" {
				formats = append(formats, "auto")
			}
			for _, format := range formats {
				rows, err := ParsePreview(tc.filename, raw, "@vpn", map[string]bool{"@vpn": true},
					FileOptions{Format: format, Template: tc.template})
				if err != nil || len(rows) != tc.count {
					t.Fatalf("%s imported %d rules, wanted %d: %v", format, len(rows), tc.count, err)
				}
				var found bool
				for _, row := range rows {
					if row.Target != "@vpn" {
						t.Fatalf("%s produced unselected target %q", format, row.Target)
					}
					found = found || tc.domain != "" && row.Domain == tc.domain || tc.prefix != "" && row.CIDR == tc.prefix
				}
				if !found {
					t.Fatalf("%s did not import %s", format, tc.domain+tc.prefix)
				}
			}
		})
	}
}

func TestIPListErrorsAndAmbiguousRules(t *testing.T) {
	for _, tc := range []struct {
		filename, input, errorText string
		options                    FileOptions
	}{
		{"file.srs", "# Error: upstream couldn't compile version", "ошибке iplist", FileOptions{}},
		{"file.txt", "# note, source\n192.0.2.1\n!192.0.2.2", "строка 3", FileOptions{}},
		{"file.txt", "data: example.org\ndifferent example.net", "не соответствует", FileOptions{Format: "custom", Template: "data: {data}"}},
		{"file.json", `{"routing":{"rules":[{"sourcePort":"55","domain":["example.org"]}]}}`, "routing", FileOptions{}},
		{"file.json", `{"rules":[{"process":["browser"],"domain":["example.org"]}]}`, "process", FileOptions{}},
		{"file.txt", "192.0.2.1/24", "один IP", FileOptions{Type: "ip"}},
		{"file.txt", "192.0.2.1", "CIDR", FileOptions{Type: "cidr"}},
	} {
		rows, err := ParsePreview(tc.filename, []byte(tc.input), "direct", map[string]bool{"direct": true}, tc.options)
		if err == nil || len(rows) != 0 || !strings.Contains(err.Error(), tc.errorText) {
			t.Errorf("input %s did not fail atomically with %q: %v", tc.filename, tc.errorText, err)
		}
	}
}

func TestImportPreservesServiceLabels(t *testing.T) {
	const list = "_domainkey.youtube.com\nfull:_sip._tcp.example.net\n"
	rows, err := ParsePreview("ip-list.txt", []byte(list), "@vpn", map[string]bool{"@vpn": true}, FileOptions{})
	if err != nil || len(rows) != 2 || rows[0].Domain != "_domainkey.youtube.com" ||
		rows[1].Domain != "_sip._tcp.example.net" || (!rows[1].Exact && rows[1].Match != "exact") {
		t.Fatalf("service labels were changed: %v, %v", rows, err)
	}
}
