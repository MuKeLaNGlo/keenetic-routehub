package ruleimport

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"net/netip"
	"testing"
)

func TestExtendedDestinationFiles(t *testing.T) {
	for _, tc := range []struct {
		format, source, firstDomain, match, cidr string
		options                                  FileOptions
	}{
		{"pac", `var items = [".example.org", ["203.0.113.6", "255.255.255.0"]]; function FindProxyForURL(){throw new Error("must not run")}`, "example.org", "wildcard", "", FileOptions{}},
		{"mikrotik", "/ip firewall address-list\nadd list=vpn address=203.0.113.0/24", "", "", "203.0.113.0/24", FileOptions{}},
		{"switchy", "[Switchy-RuleList]\n[Wildcard]\n*.example.org/*", "example.org", "suffix", "", FileOptions{}},
		{"nfset", "nftset=/example.org/4#inet#fw4#route", "example.org", "suffix", "", FileOptions{}},
		{"ipset", "ipset=/example.org/route", "example.org", "suffix", "", FileOptions{}},
		{"clashx", "payload:\n  - DOMAIN,example.org\n  - IP-CIDR,203.0.113.0/24,no-resolve", "example.org", "exact", "", FileOptions{}},
		{"kvas", "kvas add example.org y", "example.org", "suffix", "", FileOptions{}},
		{"bat", "route ADD 203.0.113.0 MASK 255.255.255.0 0.0.0.0", "", "", "203.0.113.0/24", FileOptions{}},
		{"wildcard", "*.example.org", "example.org", "wildcard", "", FileOptions{}},
		{"amnezia", `[{"hostname":"example.org"}]`, "example.org", "", "", FileOptions{}},
		{"singbox", `{"version":2,"rules":[{"domain":["example.org"],"domain_suffix":[".example.org"]}]}`, "example.org", "suffix", "", FileOptions{}},
		{"custom", "test {{example.org}} tail", "example.org", "", "", FileOptions{Template: "test {{{data}}} tail"}},
		{"text", "ru", "", "", "", FileOptions{Type: "geo", GeoSource: "sample"}},
	} {
		t.Run(tc.format, func(t *testing.T) {
			tc.options.Format = tc.format
			got, err := ParsePreview("rules", []byte(tc.source), "@vpn", map[string]bool{"@vpn": true}, tc.options)
			if err != nil || len(got) == 0 {
				t.Fatalf("could not import sample: %v", err)
			}
			entry := got[0]
			if entry.Domain != tc.firstDomain || entry.Match != tc.match || entry.CIDR != tc.cidr || entry.Target != "@vpn" {
				t.Fatalf("unexpected preview: %+v", entry)
			}
			if tc.options.Type == "geo" && (entry.GeoIP != "RU" || entry.GeoSource != "sample") {
				t.Fatalf("unexpected GeoIP preview %+v", entry)
			}
		})
	}
}

func fieldBytes(tag byte, value []byte) []byte {
	result := binary.AppendUvarint([]byte{tag}, uint64(len(value)))
	return append(result, value...)
}

func TestDatGeoIPAndGeoSite(t *testing.T) {
	cidr := append(fieldBytes(10, []byte{203, 0, 113, 3}), 16, 24)
	ip := fieldBytes(10, append(fieldBytes(10, []byte("RU")), fieldBytes(18, cidr)...))
	countries, err := GeoIP(ip)
	if err != nil || len(countries["RU"]) != 1 || countries["RU"][0] != netip.MustParsePrefix("203.0.113.0/24") {
		t.Fatalf("unexpected GeoIP groups: %v, %v", countries, err)
	}
	domain := append([]byte{8, 3}, fieldBytes(18, []byte("example.org"))...)
	site := fieldBytes(10, append(fieldBytes(10, []byte("sample")), fieldBytes(18, domain)...))
	rows, err := ParsePreview("sample.dat", site, "direct", map[string]bool{"direct": true}, FileOptions{Format: "geosite"})
	if err != nil || len(rows) != 1 || rows[0].Domain != "example.org" || rows[0].Match != "exact" {
		t.Fatalf("unexpected GeoSite rows: %v, %v", rows, err)
	}
	if _, err := GeoIP(site); err == nil {
		t.Fatal("GeoSite accepted as a GeoIP database")
	}
}

func TestSRSKeywordAndIPRange(t *testing.T) {
	data := []byte{1, 0, 3, 1, 4, 'n', 'e', 'w', 's', 6, 1}
	data = binary.BigEndian.AppendUint64(data, 1)
	data = append(data, 4, 203, 0, 113, 128, 4, 203, 0, 113, 255, 255, 0)
	var payload bytes.Buffer
	payload.WriteString("SRS\x01")
	writer := zlib.NewWriter(&payload)
	if _, err := writer.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := ParsePreview("sample.srs", payload.Bytes(), "direct", map[string]bool{"direct": true}, FileOptions{})
	if err != nil || len(got) != 2 || got[0].Domain != "news" || got[0].Match != "keyword" || got[1].CIDR != "203.0.113.128/25" {
		t.Fatalf("unexpected SRS rules: %v, %v", got, err)
	}
}

func TestExtendedFormatsRejectChangedSemantics(t *testing.T) {
	for _, raw := range []string{
		`{"rules":[{"domain":"example.org","outboundTag":"direct","inboundTag":["lan"]}]}`,
		`{"version":2,"rules":[{"invert":true,"domain":"example.org"}]}`,
	} {
		if rows, err := ParsePreview("sample.json", []byte(raw), "direct", map[string]bool{"direct": true}, FileOptions{}); err == nil || len(rows) != 0 {
			t.Fatalf("unsupported conditions imported: %v, %v", rows, err)
		}
	}
}
