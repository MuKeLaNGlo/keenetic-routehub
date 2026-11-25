package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"routehub/devicepolicy"
)

const gamePlayerMAC = "02:00:00:00:00:aa"

func testGamePreset() gamePreset {
	return gamePreset{
		ID: "test-game", Name: "Game server", Enabled: true,
		RouteAction: gameAction{Kind: "direct", UplinkID: "isp-main"}, Priority: "off",
		Scope: gameScope{DeviceIDs: []string{gamePlayerMAC}},
		Signatures: []gameSignature{
			{Destination: "203.0.113.10", Protocol: "tcp", Port: 27015, Category: "match"},
			{Destination: "203.0.113.10", Protocol: "udp", Port: 27015, Category: "voice"},
			{Destination: "203.0.113.20", Protocol: "tcp", Port: 27015, Category: "match"},
		},
	}
}

func testGamePlan() plan {
	config := testPanelEditConfig()
	config.PanelHost = "192.168.10.1"
	config.PanelNetwork = "192.168.10.0/24"
	config.Transparent = &transparent{Source: "192.168.10.0/24", Interface: "br0", Port: 15080, Mode: transparentRedirectTCP}
	config.Devices = []devicepolicy.Device{{MAC: gamePlayerMAC, Mode: "inherit", Addresses: []string{"192.168.10.2"}}}
	config.bindings = []devicepolicy.Binding{{MAC: gamePlayerMAC, Address: "192.168.10.2", Fixed: true}}
	config.DefaultTarget = "relay"
	return config
}

func TestNormalizeGamePresetsRejectsBroadOrUnsupportedSelectors(t *testing.T) {
	for _, row := range []struct {
		name   string
		mutate func(*gamePreset)
	}{
		{"zero-port", func(p *gamePreset) { p.Signatures[0].Port = 0 }},
		{"any-IP", func(p *gamePreset) { p.Signatures[0].Destination = "0.0.0.0" }},
		{"loopback", func(p *gamePreset) { p.Signatures[0].Destination = "127.0.0.1" }},
		{"router-LAN", func(p *gamePreset) { p.Signatures[0].Destination = "192.168.10.1" }},
		{"CIDR", func(p *gamePreset) { p.Signatures[0].Destination = "203.0.113.10/32" }},
		{"mapped-IP", func(p *gamePreset) { p.Signatures[0].Destination = "::ffff:203.0.113.10" }},
		{"hostname", func(p *gamePreset) { p.Signatures[0].Destination = "example.org" }},
		{"any-protocol", func(p *gamePreset) { p.Signatures[0].Protocol = "tcp,udp" }},
		{"launcher", func(p *gamePreset) { p.Signatures[0].Category = "launcher" }},
		{"segment", func(p *gamePreset) { p.Scope.SegmentIDs = []string{"br0"} }},
		{"all-clients", func(p *gamePreset) { p.Scope.DeviceIDs = nil }},
		{"wrong-egress", func(p *gamePreset) { p.RouteAction.UplinkID = "isp-secondary" }},
		{"qos", func(p *gamePreset) { p.Priority = "intelliqos" }},
		{"duplicate", func(p *gamePreset) { p.Signatures = append(p.Signatures, p.Signatures[0]) }},
	} {
		t.Run(row.name, func(t *testing.T) {
			preset := testGamePreset()
			row.mutate(&preset)
			if _, err := normalizeGamePresets([]gamePreset{preset}); err == nil {
				t.Fatalf("accepted %+v", preset)
			}
		})
	}
	active, conflicting := testGamePreset(), testGamePreset()
	conflicting.ID = "another"
	if _, err := normalizeGamePresets([]gamePreset{active, conflicting}); err == nil {
		t.Fatal("accepted two labels for the same device and endpoint")
	}
	conflicting.Enabled = false
	if _, err := normalizeGamePresets([]gamePreset{active, conflicting}); err != nil {
		t.Fatal(err)
	}
}

func TestGameRouteDoesNotOverrideExplicitOrUnconfirmedPolicies(t *testing.T) {
	config := testGamePlan()
	config.Games = []gamePreset{testGamePreset()}
	config.ZapretServices = &zapretServices{Discord: true}
	config.Rules = []rule{
		{Name: "Required block", Target: "@block", CIDR: "203.0.113.20/32"},
		{Name: "Required global VPN", Target: "wire", CIDR: "203.0.113.30/32"},
	}
	const otherDevice = "02:00:00:00:00:bb"
	config.Devices = append(config.Devices, devicepolicy.Device{MAC: otherDevice, Mode: "inherit", Addresses: []string{"192.168.10.3"}})
	config.Games[0].Scope.DeviceIDs = append(config.Games[0].Scope.DeviceIDs, otherDevice)
	// The second device has an address, but the inventory reports a dynamic lease.
	config.bindings = append(config.bindings, devicepolicy.Binding{MAC: otherDevice, Address: "192.168.10.3"})
	config.Devices[0].Rules = []rule{{Name: "Required VPN", Target: "wire", CIDR: "203.0.113.10/32", Port: 27016}}
	config.Games[0].Signatures = append(config.Games[0].Signatures,
		gameSignature{Destination: "203.0.113.10", Protocol: "tcp", Port: 27016, Category: "match"},
		gameSignature{Destination: "203.0.113.30", Protocol: "tcp", Port: 27015, Category: "match"})
	config, err := validatePlan(config)
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := config.policy(true)
	if err != nil {
		t.Fatal(err)
	}
	target := "203.0.113.10"
	for _, tc := range []struct {
		name   string
		query  destination
		target string
		preset string
	}{
		{"new TCP", destination{Host: target, Network: "tcp", Port: 27015, ClientMAC: gamePlayerMAC}, "direct", "test-game"},
		{"UDP observation only", destination{Host: target, Network: "udp", Port: 27015, ClientMAC: gamePlayerMAC}, "relay", ""},
		{"other port", destination{Host: target, Network: "tcp", Port: 27017, ClientMAC: gamePlayerMAC}, "relay", ""},
		{"other address", destination{Host: "203.0.113.11", Network: "tcp", Port: 27015, ClientMAC: gamePlayerMAC}, "relay", ""},
		{"local explicit VPN", destination{Host: target, Network: "tcp", Port: 27016, ClientMAC: gamePlayerMAC}, "wire", ""},
		{"global explicit block", destination{Host: "203.0.113.20", Network: "tcp", Port: 27015, ClientMAC: gamePlayerMAC}, "@block", ""},
		{"global explicit VPN", destination{Host: "203.0.113.30", Network: "tcp", Port: 27015, ClientMAC: gamePlayerMAC}, "wire", ""},
		{"Zapret service", destination{Host: "discord.com", TargetIP: target, Network: "tcp", Port: 27015, ClientMAC: gamePlayerMAC}, "zapret", ""},
		{"unconfirmed address", destination{Host: target, Network: "tcp", Port: 27015, ClientIP: "192.168.10.3"}, "relay", ""},
		{"whole-network no match", destination{Host: target, Network: "tcp", Port: 27015}, "relay", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := compiled.Evaluate(tc.query)
			if err != nil || got.Target != tc.target || got.GamePresetID != tc.preset {
				t.Fatalf("route: %+v (%v), expected %s/%s", got, err, tc.target, tc.preset)
			}
		})
	}
	for _, tc := range []struct {
		name string
		edit func(*plan)
		lan  bool
	}{
		{"disabled", func(p *plan) { p.Games[0].Enabled = false }, true},
		{"inherit intent", func(p *plan) { p.Games[0].RouteAction = gameAction{Kind: "inherit"} }, true},
		{"unavailable inventory", func(p *plan) { p.bindings = nil }, true},
		{"conflicting lease", func(p *plan) {
			p.bindings = append(p.bindings, devicepolicy.Binding{MAC: otherDevice, Address: "192.168.10.2"})
		}, true},
		{"ordinary device policy", func(p *plan) { p.Devices[0].Mode = "global" }, true},
		{"legacy omitted mode", func(p *plan) { p.Devices[0].Mode = "" }, true},
		{"independent device policy", func(p *plan) { p.Devices[0].Mode = "override"; p.Devices[0].DefaultTarget = "relay" }, true},
		{"fixed device route", func(p *plan) { p.Devices[0].Mode = "fixed"; p.Devices[0].DefaultTarget = "relay" }, true},
		{"no LAN capture", func(p *plan) {}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next := copyPanelPlan(config)
			tc.edit(&next)
			alternate, err := next.policy(tc.lan)
			if err != nil {
				t.Fatal(err)
			}
			got, err := alternate.Evaluate(destination{Host: target, Network: "tcp", Port: 27015, ClientIP: "192.168.10.2"})
			if err != nil || got.Target != "relay" || got.GamePresetID != "" {
				t.Fatalf("unsafe game match: %+v (%v)", got, err)
			}
		})
	}
	tproxy := copyPanelPlan(config)
	tproxy.Transparent.Mode = "tproxy"
	tproxyPolicy, err := tproxy.policy(true)
	if err != nil {
		t.Fatal(err)
	}
	udp, err := tproxyPolicy.Evaluate(destination{Host: target, Network: "udp", Port: 27015, ClientMAC: gamePlayerMAC})
	if err != nil || udp.Target != "relay" || udp.GamePresetID != "" {
		t.Fatalf("TPROXY must also leave UDP unmodified: %+v (%v)", udp, err)
	}
	rules := compiled.XrayRules("lan")
	matches := 0
	for _, entry := range rules {
		if entry["outboundTag"] != "direct" {
			continue
		}
		match := map[string]any{
			"type": "field", "inboundTag": []string{"lan"}, "sourceIP": []string{"192.168.10.2/32"},
			"ip": []string{"203.0.113.10/32"}, "outboundTag": "direct", "network": "tcp", "port": "27015",
		}
		if reflect.DeepEqual(entry, match) {
			matches++
		}
	}
	if matches != 1 || rules[len(rules)-1]["outboundTag"] != "relay" || len(compiled.XrayRules("")) >= len(rules) {
		t.Fatalf("expected one exact LAN TCP exception before fallback: %#v", rules)
	}
}

func TestGameObservationChangesPersistWithoutRestart(t *testing.T) {
	prior := testGamePlan()
	next := copyPanelPlan(prior)
	preset := testGamePreset()
	next.Games = []gamePreset{preset}
	if gameMetadataOnly(prior, next, true) {
		t.Fatal("an actual new TCP exception must reload Xray")
	}
	next.Games[0].RouteAction = gameAction{Kind: "inherit"}
	options := options{config: filepath.Join(t.TempDir(), "plan.json"), allowLAN: true}
	instance := new(engine)
	engineConfig := "unchanged-xray-config"
	got, path, err := replaceRuntime(context.Background(), options, instance, engineConfig, prior, next, runtimeSelection{}, runtimeSelection{}, true)
	if err != nil || got != instance || path != engineConfig {
		t.Fatalf("metadata persistence tried to replace Xray (%q, %v)", path, err)
	}
	saved, err := loadPlan(options.config)
	if err != nil || len(saved.Games) != 1 || saved.Games[0].ID != preset.ID {
		t.Fatalf("saved settings: %+v (%v)", saved.Games, err)
	}
}

func TestPanelGamePresetsRoundTrip(t *testing.T) {
	config := testGamePlan()
	editor := newPanelEditor(config, testEditKey, func(context.Context, plan) error { return nil })
	presets := []gamePreset{testGamePreset()}
	payload := panelPlanUpdate{Profiles: []panelProfile{{ID: "relay", Protocol: "trojan"}, {ID: "wire", Protocol: "amneziawg"}}, Rules: []rule{}}
	empty := []gamePreset{}
	for _, input := range []*[]gamePreset{&presets, nil, &empty} {
		payload.Revision, payload.Games = editor.current().Revision, input
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		response := putPanelPlan(editor, testEditOrigin, testEditKey, string(data))
		if response.Code != http.StatusOK {
			t.Fatalf("update returned %d: %s", response.Code, response.Body)
		}
		want := 1
		if input != nil && len(*input) == 0 {
			want = 0
		}
		if snapshot := editor.snapshot(); len(snapshot.Games) != want {
			t.Fatalf("expected %d saved presets, got %+v", want, snapshot.Games)
		}
	}
}

func TestGameObservationFiltersBeforeConntrackLimit(t *testing.T) {
	config := testGamePlan()
	active := testGamePreset()
	active.Signatures = []gameSignature{
		{Destination: "203.0.113.1", Protocol: "tcp", Port: 443, Category: "match"},
		{Destination: "198.51.100.4", Protocol: "udp", Port: 443, Category: "voice"},
	}
	disabled := testGamePreset()
	disabled.ID, disabled.Enabled = "disabled-game", false
	disabled.Signatures[0].Destination, disabled.Signatures[0].Port = "203.0.113.1", 444
	config.Games = []gamePreset{active, disabled}
	editor := newPanelEditor(config, testEditKey, func(context.Context, plan) error {
		t.Error("connection observation changed the routing configuration")
		return nil
	})
	diagnostics := newPanelDiagnostics(editor, status{LAN: true, LANMode: transparentRedirectTCP}, nil)
	observe := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, testEditOrigin+"/api/panel/connections/observe",
			strings.NewReader(`{"seconds":1,"deviceId":"`+gamePlayerMAC+`"}`))
		request.Header.Set("Origin", testEditOrigin)
		request.Header.Set("X-RouteHub-Key", testEditKey)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		diagnostics.observeConnections(response, request)
		return response
	}
	diagnostics.topology = panelTopologySnapshot{FetchedAt: time.Now(), Devices: []panelTopologyDevice{
		{ID: gamePlayerMAC, Addresses: []panelDeviceAddress{{Address: "192.168.10.2", Family: "v4"}}},
	}}
	var fixture strings.Builder
	for i := range observationTrackedLimit + 2 {
		fixture.WriteString(strings.Replace(observationFixtureUDP, "sport=42300", "sport="+strconv.Itoa(40000+i), 1) + "\n")
	}
	fixture.WriteString(observationFixtureTCP + "\n")
	fixture.WriteString(strings.Replace(observationFixtureTCP, "dport=443", "dport=444", 1) + "\n")
	fixture.WriteString(strings.Replace(observationFixtureUDP, "192.168.10.7", "192.168.10.2", 1))
	diagnostics.readConnections = func(ctx context.Context, source netip.Prefix, router netip.Addr) (trackedSnapshot, error) {
		if source != netip.MustParsePrefix("192.168.10.2/32") {
			t.Errorf("device filter applied too late: %v", source)
		}
		return readConnectionTable(ctx, strings.NewReader(fixture.String()), source, router)
	}
	response := observe()
	var got connectionObservation
	if err := json.Unmarshal(response.Body.Bytes(), &got); response.Code != http.StatusOK || err != nil || got.Limited || len(got.Rows) != 3 {
		t.Fatalf("filtered observation: %d %s (%v)", response.Code, response.Body, err)
	}
	if match := got.Rows[0].GameMatch; match == nil || match.PresetID != active.ID || match.Category != "match" || got.Rows[1].GameMatch != nil {
		t.Fatalf("unexpected signatures: %+v, %+v", got.Rows[0], got.Rows[1])
	}
	if match := got.Rows[2].GameMatch; got.Rows[2].Protocol != "udp" || match == nil || match.Category != "voice" || got.Rows[2].Redirected {
		t.Fatalf("UDP observations must only label the signature: %+v", got.Rows[2])
	}
	diagnostics.topology.Devices[0].Addresses = append(diagnostics.topology.Devices[0].Addresses, panelDeviceAddress{Address: "192.168.10.3"})
	if response := observe(); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("ambiguous device observed anyway: %d %s", response.Code, response.Body)
	}
}
