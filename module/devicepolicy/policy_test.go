package devicepolicy

import (
	"net/netip"
	"reflect"
	"testing"
)

const (
	deviceA  = "02:00:00:00:00:aa"
	deviceB  = "02:00:00:00:00:bb"
	addressA = "192.168.10.20"
	addressB = "192.168.10.21"
)

func labOptions() Options {
	return Options{
		Targets:  map[string]string{"vpn": "hysteria2", "secondary": "trojan"},
		LAN:      netip.MustParsePrefix("192.168.10.0/24"),
		RouterIP: netip.MustParseAddr("192.168.10.1"),
	}
}

func labConfig() Config {
	return Config{
		DefaultTarget: "vpn",
		Rules: []Rule{
			{Name: "video", Domain: "video.example", Target: "zapret"},
			{Name: "control", CIDR: "203.0.113.0/24", Target: "direct"},
		},
		Devices: []Device{
			{MAC: deviceA, Addresses: []string{addressA}, Mode: "inherit", Rules: []Rule{{
				Name: "video", Domain: "Video.Example.", Network: "udp", Port: 443, Target: "secondary",
			}}},
			{MAC: deviceB, Addresses: []string{addressB}, Mode: "override", DefaultTarget: "direct", Rules: []Rule{{
				Name: "specific", CIDR: "203.0.113.10/32", Target: "secondary",
			}}},
		},
	}
}

func TestEvaluateAndXrayOrder(t *testing.T) {
	plan, err := Compile(labConfig(), labOptions())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		input Destination
		want  Decision
	}{
		{"global rule", Destination{Host: "CDN.VIDEO.EXAMPLE.", Network: "udp", Port: 443}, Decision{Rule: "video", Target: "zapret", Scope: "global"}},
		{"device rule", Destination{Host: "cdn.video.example", Network: "udp", Port: 443, ClientMAC: deviceA}, Decision{Rule: "video", Target: "secondary", Protocol: "trojan", Scope: "device", DeviceMAC: deviceA}},
		{"inherits after port mismatch", Destination{Host: "video.example", Network: "udp", Port: 80, ClientIP: addressA}, Decision{Rule: "video", Target: "zapret", Scope: "global", DeviceMAC: deviceA}},
		{"inherits after network mismatch", Destination{Host: "video.example", Network: "tcp", Port: 443, ClientIP: addressA}, Decision{Rule: "video", Target: "zapret", Scope: "global", DeviceMAC: deviceA}},
		{"device fallback before global rule", Destination{Host: "video.example", Network: "tcp", Port: 443, ClientIP: addressB}, Decision{Target: "direct", Scope: "device", DeviceMAC: deviceB}},
		{"device CIDR", Destination{Host: "203.0.113.10", Network: "tcp", Port: 443, ClientIP: addressB}, Decision{Rule: "specific", Target: "secondary", Protocol: "trojan", Scope: "device", DeviceMAC: deviceB}},
		{"CIDR with sniffed domain", Destination{Host: "video.example", TargetIP: "203.0.113.10", Network: "tcp", Port: 443, ClientIP: addressB}, Decision{Rule: "specific", Target: "secondary", Protocol: "trojan", Scope: "device", DeviceMAC: deviceB}},
		{"new device inherits", Destination{Host: "unknown.example", Network: "tcp", Port: 443, ClientIP: "192.168.10.200"}, Decision{Target: "vpn", Protocol: "hysteria2", Scope: "global"}},
		{"suffix boundary", Destination{Host: "evilvideo.example", Network: "tcp", Port: 443}, Decision{Target: "vpn", Protocol: "hysteria2", Scope: "global"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := plan.Evaluate(tc.input)
			if err != nil || got != tc.want {
				t.Fatalf("Evaluate: got %+v (%v), want %+v", got, err, tc.want)
			}
		})
	}
	want := []map[string]any{
		{"type": "field", "sourceIP": []string{addressA + "/32"}, "inboundTag": []string{"lan"}, "domain": []string{"domain:video.example"}, "network": "udp", "port": "443", "outboundTag": "secondary"},
		{"type": "field", "sourceIP": []string{addressB + "/32"}, "inboundTag": []string{"lan"}, "ip": []string{"203.0.113.10/32"}, "outboundTag": "secondary"},
		{"type": "field", "sourceIP": []string{addressB + "/32"}, "inboundTag": []string{"lan"}, "network": "tcp,udp", "outboundTag": "direct"},
		{"type": "field", "domain": []string{"domain:video.example"}, "outboundTag": "zapret"},
		{"type": "field", "ip": []string{"203.0.113.0/24"}, "outboundTag": "direct"},
		{"type": "field", "network": "tcp,udp", "outboundTag": "vpn"},
	}
	if got := plan.XrayRules("lan"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Xray rules got %+v, want %+v", got, want)
	}
	if got := plan.XrayRules(""); !reflect.DeepEqual(got, want[3:]) {
		t.Fatalf("local SOCKS should see global rules only: %+v", got)
	}
	if _, err := plan.Evaluate(Destination{Host: "video.example", Network: "udp", Port: 443, ClientIP: addressA, ClientMAC: deviceB}); err == nil {
		t.Fatal("accepted a mismatched MAC and IP in a preview")
	}
}

func TestInventoryMismatchUsesGlobal(t *testing.T) {
	options := labOptions()
	options.Inventory = []Binding{
		{MAC: deviceA, Address: addressA, Fixed: true},
		{MAC: deviceB, Address: addressA, Fixed: false}, // Another MAC is using the address now.
		{MAC: deviceB, Address: addressB, Fixed: false}, // A lease alone is insufficient.
	}
	plan, err := Compile(labConfig(), options)
	if err != nil {
		t.Fatal(err)
	}
	for _, device := range plan.Devices() {
		if device.Active || device.Reason != "unverified-address" {
			t.Errorf("unverified binding was active: %+v", device)
		}
	}
	if got := len(plan.XrayRules("lan")); got != 3 {
		t.Errorf("expected only 3 global rules, got %d", got)
	}
	got, err := plan.Evaluate(Destination{Host: "video.example", Network: "udp", Port: 443, ClientMAC: deviceA})
	if err != nil || got.Scope != "global" || got.Target != "zapret" {
		t.Fatalf("inactive devices should inherit: %+v (%v)", got, err)
	}
	options.Inventory = []Binding{{MAC: deviceA, Address: addressA, Fixed: true}}
	plan, err = Compile(labConfig(), options)
	if err != nil || !plan.Devices()[0].Active || plan.Devices()[1].Active {
		t.Fatalf("fixed binding state %+v (%v)", plan.Devices(), err)
	}
}

func TestNamedSetInPersonalRule(t *testing.T) {
	config := labConfig()
	config.NamedSets = []NamedSet{{
		ID: "video-sites", Name: "Video", Kind: "domains", Entries: []string{"video.example", "media.example"},
	}}
	config.Devices[0].Rules[0].Domain = ""
	config.Devices[0].Rules[0].NamedSet = "video-sites"
	plan, err := Compile(config, labOptions())
	if err != nil {
		t.Fatal(err)
	}
	input := Destination{Host: "cdn.video.example", Network: "udp", Port: 443, ClientMAC: deviceA}
	if got, err := plan.Evaluate(input); err != nil || got.Scope != "device" || got.Target != "secondary" {
		t.Fatalf("personal named set failed: %+v (%v)", got, err)
	}
	input.ClientMAC = ""
	if got, err := plan.Evaluate(input); err != nil || got.Scope != "global" || got.Target != "zapret" {
		t.Fatalf("named set changed the global route: %+v (%v)", got, err)
	}
	first := plan.XrayRules("lan")[0]
	if !reflect.DeepEqual(first["sourceIP"], []string{addressA + "/32"}) ||
		!reflect.DeepEqual(first["domain"], []string{"domain:video.example", "domain:media.example"}) {
		t.Fatalf("source constraint missing in Xray named set: %#v", first)
	}
}

func TestNoLANAndLegacyDefault(t *testing.T) {
	plan, err := Compile(labConfig(), Options{Targets: labOptions().Targets})
	if err != nil || plan.Devices()[0].Reason != "lan-disabled" || len(plan.XrayRules("lan")) != 3 {
		t.Fatalf("LAN-off plan failed: %+v (%v)", plan.Devices(), err)
	}
	plan, err = Compile(Config{}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := plan.Evaluate(Destination{Host: "198.51.100.2", Network: "tcp", Port: 443})
	if err != nil || got.Target != "direct" || got.Scope != "global" {
		t.Fatalf("legacy default got %+v (%v)", got, err)
	}
}

func TestGlobalOnlyPreservesLocalRulesWithoutApplyingThem(t *testing.T) {
	config := labConfig()
	config.Devices[0].Mode = "global"
	config.Rules[0].Target = "@block"
	plan, err := Compile(config, labOptions())
	if err != nil {
		t.Fatal(err)
	}
	if device := plan.Devices()[0]; device.Active || device.Reason != "global-only" {
		t.Fatalf("expected inactive local policy, got %+v", device)
	}
	got, err := plan.Evaluate(Destination{Host: "video.example", Network: "udp", Port: 443, ClientIP: addressA})
	if err != nil || got.Scope != "global" || got.Target != "@block" {
		t.Fatalf("global policy evaluation: %+v (%v)", got, err)
	}
	config.Devices[0].Mode = "inherit"
	plan, err = Compile(config, labOptions())
	if err != nil {
		t.Fatal(err)
	}
	got, err = plan.Evaluate(Destination{Host: "video.example", Network: "udp", Port: 443, ClientIP: addressA})
	if err != nil || got.Scope != "device" || got.Target != "secondary" {
		t.Fatalf("restored local policy: %+v (%v)", got, err)
	}
}

func TestExactDomainKeepsSubdomainFallback(t *testing.T) {
	config := Config{Rules: []Rule{
		{Name: "exact", Domain: "Example.COM.", Exact: true, Target: "zapret"},
		{Name: "suffix", Domain: "example.com", Target: "vpn"},
	}}
	plan, err := Compile(config, labOptions())
	if err != nil {
		t.Fatal(err)
	}
	for host, target := range map[string]string{"example.com": "zapret", "www.example.com": "vpn", "evil-example.com": "direct"} {
		got, err := plan.Evaluate(Destination{Host: host, Network: "tcp", Port: 443})
		if err != nil || got.Target != target {
			t.Errorf("Evaluate %q: %+v (%v), want %s", host, got, err, target)
		}
	}
	compiled := plan.XrayRules("")
	if !reflect.DeepEqual(compiled[0]["domain"], []string{"full:example.com"}) ||
		!reflect.DeepEqual(compiled[1]["domain"], []string{"domain:example.com"}) {
		t.Fatalf("Xray domain types: %+v", compiled)
	}
	config.Rules[0].Domain = ""
	config.Rules[0].CIDR = "203.0.113.0/24"
	if _, err := Compile(config, labOptions()); err == nil {
		t.Fatal("accepted exact matching mode for a CIDR")
	}
}

func TestRejectAmbiguousAssignments(t *testing.T) {
	for label, mutate := range map[string]func(*Config){
		"duplicate MAC normalized": func(c *Config) { c.Devices[1].MAC = "02-00-00-00-00-AA" },
		"duplicate IPv4":           func(c *Config) { c.Devices[1].Addresses = []string{addressA} },
		"EUI-64":                   func(c *Config) { c.Devices[0].MAC = "02:00:00:00:00:00:00:aa" },
		"multi/broadcast MAC":      func(c *Config) { c.Devices[0].MAC = "ff:ff:ff:ff:ff:ff" },
		"zero MAC":                 func(c *Config) { c.Devices[0].MAC = "00:00:00:00:00:00" },
		"router address":           func(c *Config) { c.Devices[0].Addresses = []string{"192.168.10.1"} },
		"network address":          func(c *Config) { c.Devices[0].Addresses = []string{"192.168.10.0"} },
		"broadcast address":        func(c *Config) { c.Devices[0].Addresses = []string{"192.168.10.255"} },
		"outside LAN":              func(c *Config) { c.Devices[0].Addresses = []string{"192.168.11.5"} },
		"IPv6 source":              func(c *Config) { c.Devices[0].Addresses = []string{"fd00::1"} },
		"missing default":          func(c *Config) { c.Devices[1].DefaultTarget = "" },
		"inherit with default":     func(c *Config) { c.Devices[0].DefaultTarget = "direct" },
		"unknown global fallback":  func(c *Config) { c.DefaultTarget = "missing" },
	} {
		t.Run(label, func(t *testing.T) {
			config := labConfig()
			mutate(&config)
			if _, err := Compile(config, labOptions()); err == nil {
				t.Fatal("accepted invalid configuration")
			}
		})
	}
}
