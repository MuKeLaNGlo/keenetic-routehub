package ruleimport

import (
	"os"
	"strings"
	"testing"

	"routehub/devicepolicy"
)

func TestDiscordCommunityDomainList(t *testing.T) {
	file, err := os.ReadFile("testdata/dlc/discord")
	if err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"discord", "discord.txt", "discord.dlc"} {
		rows, err := ParsePreview(filename, file, "relay", map[string]bool{"relay": true}, FileOptions{})
		if err != nil || len(rows) != 28 {
			t.Fatalf("expected 28 rules from %s, got %d (%v)", filename, len(rows), err)
		}
		exact := 0
		for _, rule := range rows {
			switch rule.Match {
			case "exact":
				exact++
			case "suffix":
			default:
				t.Fatalf("unexpected match for %s: %s", rule.Domain, rule.Match)
			}
			if rule.Target != "relay" {
				t.Fatalf("unexpected target for %s: %s", rule.Domain, rule.Target)
			}
		}
		if exact != 2 {
			t.Fatalf("expected 2 exact rules from %s, got %d", filename, exact)
		}

		config, err := devicepolicy.Compile(devicepolicy.Config{DefaultTarget: "direct", Rules: rows},
			devicepolicy.Options{Targets: map[string]string{"relay": "hysteria2"}})
		if err != nil {
			t.Fatalf("imported rules could not be activated: %v", err)
		}
		for _, check := range []struct{ host, target string }{
			{"discord.com", "relay"},
			{"cdn.discord.com", "relay"},
			{"discord.com.example.org", "direct"},
			{"discord-attachments-uploads-prd.storage.googleapis.com", "relay"},
			{"sub.discord-attachments-uploads-prd.storage.googleapis.com", "direct"},
			{"storage.googleapis.com", "direct"},
		} {
			got, err := config.Evaluate(devicepolicy.Destination{Host: check.host, Network: "tcp", Port: 443})
			if err != nil || got.Target != check.target {
				t.Fatalf("expected %s to use %s, got %+v (%v)", check.host, check.target, got, err)
			}
		}
	}
}

func TestDLCMatchTypesAndMetadata(t *testing.T) {
	data := []byte(`# source comment
example.org # this is still a suffix
DOMAIN: service.example.org @cn @!test &category-one
suffix:another.example.org
full:api.example.org @group2
exact:only.example.org # exact alias
keyword:APP-CONNECT
regexp:^sub[1-3]\.example\.org$ # preserves the RE2 syntax
regex:full:colon-valued-example
regexp:^foo>bar$
`)
	rows, err := ParsePreview("list.dlc", data, "direct", map[string]bool{"direct": true},
		FileOptions{Format: "dlc", Type: "domain", DomainMatch: "exact"})
	if err != nil || len(rows) != 9 {
		t.Fatalf("import failed: %v (%+v)", err, rows)
	}
	expectedMatches := []string{"suffix", "suffix", "suffix", "exact", "exact", "keyword", "regex", "regex", "regex"}
	for i, match := range expectedMatches {
		if rows[i].Match != match {
			t.Fatalf("line %d got match %s, expected %s", i, rows[i].Match, match)
		}
	}
	if rows[1].Domain != "service.example.org" || rows[5].Domain != "app-connect" ||
		rows[6].Domain != `^sub[1-3]\.example\.org$` || rows[7].Domain != "full:colon-valued-example" ||
		rows[8].Domain != "^foo>bar$" {
		t.Fatalf("wrong domain/pattern in output: %+v", rows)
	}
}

func TestDLCRejectsUnresolvedIncludeAndBadSyntaxAtomically(t *testing.T) {
	for _, tc := range []struct{ line, message string }{
		{"include:category-one @required @-excluded", "include:category-one"},
		{"include:../../file", "имя списка include"},
		{"include:https://example.org/list", "имя списка include"},
		{"include:category &affiliation", "метка группы"},
		{"include:category @-", "некорректный атрибут"},
		{"domain:another.example.org @", "некорректный атрибут"},
		{"full:another.example.org @-negative", "некорректный атрибут"},
		{"keyword:bad*keyword", "ключевое слово"},
		{"regexp:([", "регулярное выражение"},
		{"domain:cidr:192.0.2.0/24", "без URL"},
		{"any:other.example.org", "неизвестный тип"},
	} {
		t.Run(tc.line, func(t *testing.T) {
			data := []byte("example.org\n" + tc.line + "\n")
			rows, err := ParsePreview("list.dlc", data, "direct", map[string]bool{"direct": true}, FileOptions{})
			if err == nil || !strings.Contains(err.Error(), tc.message) || len(rows) != 0 {
				t.Fatalf("expected atomic import rejection with %q, got %+v (%v)", tc.message, rows, err)
			}
		})
	}
	rows, err := ParsePreview("group.txt", []byte("example.org\ninclude:category-one @ads"), "direct", map[string]bool{"direct": true}, FileOptions{})
	if err == nil || !strings.Contains(err.Error(), "include:category-one") || len(rows) != 0 {
		t.Fatalf("auto detection hid missing include: %+v (%v)", rows, err)
	}
}

func TestDLCDetectionKeepsStealthSurfTargetsAndMixedCIDRs(t *testing.T) {
	names := map[string]bool{"direct": true, "relay": true}
	for _, tc := range []struct{ raw, target, cidr string }{
		{"full:service.example.org > relay\ndomain:example.org > direct", "relay", ""},
		{"full:service.example.org>relay\ndomain:example.org>direct", "relay", ""},
		{"full:service.example.org\n192.0.2.0/24", "direct", "192.0.2.0/24"},
	} {
		rows, err := ParsePreview("rules.txt", []byte(tc.raw), "direct", names, FileOptions{})
		if err != nil || len(rows) != 2 || rows[0].Target != tc.target || rows[1].CIDR != tc.cidr {
			t.Fatalf("DLC auto detection changed existing rule format for %q: %+v (%v)", tc.raw, rows, err)
		}
	}
}

func TestDLCDetectsAttachedCommentsOnBareDomains(t *testing.T) {
	rows, err := ParsePreview("bare-domains", []byte("example.org#note\nother.example.org\n"), "direct", map[string]bool{"direct": true}, FileOptions{})
	if err != nil || len(rows) != 2 || rows[0].Domain != "example.org" || rows[0].Match != "suffix" {
		t.Fatalf("unspaced upstream comment did not import: %+v (%v)", rows, err)
	}
}
