package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/netip"
	"strings"
	"testing"
)

const testSubscriptionVLESS = `{
  "tag":"Fixture",
  "protocol":"vless",
  "settings":{"vnext":[{"address":"edge.example.net","port":443,"users":[{"id":"00000000-0000-4000-8000-000000000001","encryption":"none"}]}]},
  "streamSettings":{"network":"ws","security":"tls","wsSettings":{"host":"edge.example.net","path":"/fixture"}}
}`

func TestSubscriptionXrayJSONRejectsDependenciesAndDeduplicates(t *testing.T) {
	data := `[
	{"remarks":"Стокгольм","outbounds":[` + testSubscriptionVLESS + `,{"protocol":"freedom"}]},
	{"remarks":"Другой ярлык","outbounds":[` + testSubscriptionVLESS + `]},
	{"outbounds":[` + testSubscriptionVLESS + `],"routing":{"balancers":[{"tag":"auto","selector":["p"]}]}},
	{"protocol":"vless","settings":{"address":"192.168.10.1","port":443,"id":"fixture"}}
]`
	for _, body := range [][]byte{[]byte(data), []byte(base64.RawURLEncoding.EncodeToString([]byte(data)))} {
		profiles, rejected, err := parseSubscription(body)
		if err != nil {
			t.Fatal(err)
		}
		if len(profiles) != 1 || len(rejected) != 2 {
			t.Fatalf("got %d profiles and %d rejected entries", len(profiles), len(rejected))
		}
		if entry := profiles[0]; entry.Label != "Стокгольм" || entry.Protocol != "vless" || !entry.CatalogProfile ||
			entry.URI != "" || len(entry.UpstreamKey) != 32 {
			t.Fatal("unexpected normalized profile")
		}
	}
}

func TestSubscriptionVLESSProbePinsAddressAndKeepsTLSName(t *testing.T) {
	entry := profile{ID: "fixture", Protocol: "vless", Outbound: json.RawMessage(testSubscriptionVLESS)}
	if _, err := pinnedVLESSProbe(entry, netip.MustParseAddr("192.168.10.1")); err == nil {
		t.Fatal("probe accepted a private address")
	}
	got, err := pinnedVLESSProbe(entry, netip.MustParseAddr("1.1.1.1"))
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		StreamSettings struct {
			TLSSettings struct{ ServerName string }
		}
	}
	if err := json.Unmarshal(got.Outbound, &body); err != nil || body.StreamSettings.TLSSettings.ServerName != "edge.example.net" {
		t.Fatal("probe did not retain the hostname for TLS validation")
	}
	server, ok := subscriptionJSONServer(got.Outbound)
	if !ok || server.Address != "1.1.1.1" {
		t.Fatal("probe did not pin the nested VLESS destination")
	}
	if profileServer(entry) != "edge.example.net:443" {
		t.Fatal("probe modified the stored profile")
	}
}

func TestSubscriptionXrayGroupsPreserveMembershipAndStayPrivate(t *testing.T) {
	member := func(tag, address string) string {
		return strings.ReplaceAll(strings.ReplaceAll(testSubscriptionVLESS, "Fixture", tag), "edge.example.net", address)
	}
	body := `{"remarks":"Region","dns":{"servers":["127.0.0.1"]},
	"inbounds":[{"listen":"0.0.0.0","port":1080,"protocol":"socks"}],
	"outbounds":[` + member("pool-a", "one.example.net") + `,` + member("pool-b", "two.example.net") + `,` +
		member("replica", "three.example.net") + `,{"tag":"direct","protocol":"freedom"}],
	"observatory":{"probeUrl":"http://127.0.0.1/"}, "routing":{"balancers":[
		{"tag":"region","selector":["pool-"],"fallbackTag":"replica",
		"strategy":{"type":"leastLoad","settings":{"expected":1,"maxRTT":"6s","costs":[{"match":"pool-b","value":2000000000000000000}]}}}]}}`
	entries, rejected, err := parseSubscription([]byte(body))
	if err != nil || len(entries) != 1 || len(rejected) != 0 {
		t.Fatalf("group did not import: %v %v", err, rejected)
	}
	entry := entries[0]
	group := entry.XrayGroup
	if group == nil || len(group.Members) != 3 || group.Fallback == nil || *group.Fallback != 2 ||
		!group.Members[2].FallbackOnly || group.Settings.Costs[0].Member != 1 || group.Settings.Costs[0].Value != 2e18 {
		t.Fatal("member matching, fallback or balancing weights changed")
	}
	entry.ID = "fixture"
	config := plan{Profiles: []profile{entry}}
	public, _ := json.Marshal(config.public())
	if bytes.Contains(public, []byte("xrayPool")) || bytes.Contains(public, []byte("example.net")) ||
		!bytes.Contains(public, []byte(`"xrayGroup":true,"groupSize":3`)) {
		t.Fatal("public plan exposed a connection or omitted group metadata")
	}
	var update struct{ Profiles []panelProfile }
	if err := json.Unmarshal(public, &update); err != nil {
		t.Fatalf("the public profile cannot round trip: %v", err)
	}
	updated, err := mergePanelProfiles(update.Profiles, config.Profiles)
	if err != nil || updated[0].XrayGroup != group {
		t.Fatal("an ordinary plan edit loses the imported group")
	}
	for _, mutated := range []string{
		strings.Replace(body, `"fallbackTag":"replica"`, `"fallbackTag":"direct"`, 1),
		strings.Replace(body, `one.example.net`, `192.168.0.1`, 1),
		strings.Replace(body, `"selector":["pool-"]`, `"selector":["absent"]`, 1),
	} {
		if profiles, _, err := parseSubscription([]byte(mutated)); err == nil || len(profiles) != 0 {
			t.Fatal("an invalid member or unsafe fallback entered the catalog")
		}
	}
}
