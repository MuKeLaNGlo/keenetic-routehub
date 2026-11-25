package main

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"routehub/devicepolicy"
	"routehub/ruleimport"
)

func TestPanelNamedSetsRoundTrip(t *testing.T) {
	initial := testPanelEditConfig()
	applied := 0
	editor := newPanelEditor(initial, testEditKey, func(_ context.Context, _ plan) error {
		applied++
		return nil
	})
	put := func(setUpdate string) *versionedPlan {
		t.Helper()
		active := editor.snapshot()
		payload := `{"revision":"` + active.Revision + `","profiles":[{"id":"relay","protocol":"trojan"},{"id":"wire","protocol":"amneziawg"}],"rules":[{"name":"web","set":"sites","target":"relay","network":"tcp","port":443},{"name":"ips","set":"networks","target":"@block"}]` + setUpdate + `}`
		response := putPanelPlan(editor, testEditOrigin, testEditKey, payload)
		if response.Code == http.StatusBadRequest {
			return nil
		}
		var next versionedPlan
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &next) != nil {
			t.Fatalf("named sets update: %d %s", response.Code, response.Body)
		}
		return &next
	}
	next := put(`,"namedSets":[{"id":"sites","name":"Domain list","kind":"domains","entries":["example.org","example.net"]},{"id":"networks","name":"IP list","kind":"cidrs","entries":["203.0.113.6","2001:db8:1::/48"]}]`)
	if next == nil || len(next.NamedSets) != 2 {
		t.Fatal("named sets missing after save")
	}
	if oldClient := put(""); oldClient == nil || !reflect.DeepEqual(oldClient.NamedSets, next.NamedSets) {
		t.Fatal("legacy update without namedSets lost existing sets")
	}
	if put(`,"namedSets":[]`) != nil || applied != 2 {
		t.Fatal("referenced sets were removed")
	}
	if put(`,"namedSets":[{"id":"sites","name":"Empty","kind":"domains","entries":[]},{"id":"networks","name":"Still exists","kind":"cidrs","entries":["203.0.113.6"]}]`) != nil || applied != 2 {
		t.Fatal("a rule was allowed to reference an empty set")
	}

	for _, tc := range []struct {
		host    string
		network string
		port    uint16
		target  string
	}{
		{"cdn.example.org", "tcp", 443, "relay"},
		{"example.net", "tcp", 443, "relay"},
		{"example.org", "udp", 443, "direct"},
		{"example.org", "tcp", 8443, "direct"},
		{"otherexample.org", "tcp", 443, "direct"},
		{"203.0.113.6", "tcp", 443, "@block"},
		{"203.0.113.7", "tcp", 443, "direct"},
		{"2001:db8:1::8", "udp", 53, "@block"},
		{"2001:db8:2::8", "udp", 53, "direct"},
	} {
		got, err := editor.evaluate(destination{Host: tc.host, Network: tc.network, Port: tc.port})
		if err != nil || got.Target != tc.target {
			t.Errorf("%s %s:%d: expected %q, got %+v (%v)", tc.host, tc.network, tc.port, tc.target, got, err)
		}
	}
	compiled, err := editor.current().plan.policy(false)
	if err != nil {
		t.Fatal(err)
	}
	xray := compiled.XrayRulesWithAssets("", func(string) string {
		t.Fatal("manual set tried to load a GeoData asset")
		return ""
	})
	if len(xray) != 3 ||
		!reflect.DeepEqual(xray[0]["domain"], []string{"domain:example.org", "domain:example.net"}) ||
		!reflect.DeepEqual(xray[1]["ip"], []string{"203.0.113.6/32", "2001:db8:1::/48"}) ||
		xray[0]["network"] != "tcp" || xray[0]["port"] != "443" {
		t.Fatalf("unexpected Xray routing: %#v", xray)
	}
}

func TestExportPanelRulesExpandsNamedSets(t *testing.T) {
	sets := []devicepolicy.NamedSet{
		{ID: "sites", Name: "Domains", Kind: "domains", Entries: []string{"example.net", "example.org"}},
		{ID: "ips", Name: "Networks", Kind: "cidrs", Entries: []string{"192.0.2.6", "2001:db8::/32"}},
	}
	rules := []rule{
		{Name: "web", NamedSet: "sites", Target: "direct", Disabled: true, Network: "tcp", Port: 443},
		{Name: "addresses", NamedSet: "ips", Target: "direct"},
		{Name: "plain", Domain: "example.com", Target: "direct"},
	}
	data, err := json.Marshal(object{"rules": exportPanelRules(rules, sets)})
	if err != nil {
		t.Fatal(err)
	}
	exploded, err := ruleimport.ParsePreview("rules.json", data, "direct", map[string]bool{"direct": true}, ruleimport.FileOptions{})
	if err != nil || len(exploded) != 5 {
		t.Fatalf("rules-only backup failed to reimport: %v (%+v)", err, exploded)
	}
	if first := exploded[0]; first.Domain != "example.net" || !first.Disabled || first.Network != "tcp" || first.Port != 443 {
		t.Fatalf("export changed rule restrictions: %+v", first)
	}
	if exploded[2].CIDR != "192.0.2.6/32" || exploded[3].CIDR != "2001:db8::/32" || exploded[4].Domain != "example.com" {
		t.Fatalf("export changed rule order or destinations: %+v", exploded)
	}
}
