package devicepolicy

import (
	"net/netip"
	"reflect"
	"testing"
)

func TestExtendedRulesEvaluateAndCompile(t *testing.T) {
	opts := labOptions()
	opts.Targets["@vpn"] = "vless"
	opts.GeoSources = map[string]bool{"geo": true}
	opts.GeoData = map[string]map[string][]netip.Prefix{"geo": {"RU": {
		netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("2001:db8::/32"),
	}}}
	compiled, err := Compile(Config{Rules: []Rule{
		{Name: "disabled", Domain: "example.org", Target: "@vpn", Disabled: true},
		{Name: "children", Domain: "*.example.org", Match: "wildcard", Target: "@vpn"},
		{Name: "idn", Domain: "тест.рф", Match: "exact", Target: "@vpn"},
		{Name: "keyword", Domain: "NEWS", Match: "keyword", Target: "@vpn"},
		{Name: "regex", Domain: `^cdn[0-9]+\.example\.net$`, Match: "regex", Target: "@vpn"},
		{Name: "country", GeoIP: "ru", GeoSource: "geo", Target: "@vpn"},
	}}, opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ host, ip, expected string }{
		{"example.org", "", ""},
		{"images.example.org", "", "children"},
		{"wrongexample.org", "", ""},
		{"тест.рф", "", "idn"},
		{"a.тест.рф", "", ""},
		{"mynews.example.net", "", "keyword"},
		{"cdn22.example.net", "", "regex"},
		{"cdn.example.net", "", ""},
		{"example.net", "203.0.113.40", "country"},
		{"2001:db8::47", "", "country"},
	} {
		decision, err := compiled.Evaluate(Destination{Host: tc.host, TargetIP: tc.ip, Network: "tcp", Port: 443})
		if err != nil || decision.Rule != tc.expected {
			t.Errorf("%s = %+v, %v; expected %q", tc.host, decision, err, tc.expected)
		}
	}
	rules := compiled.XrayRules("lan")
	for index, token := range []string{`regexp:^.+\.example\.org$`, "full:xn--e1aybc.xn--p1ai", "keyword:news", `regexp:^cdn[0-9]+\.example\.net$`} {
		if !reflect.DeepEqual(rules[index]["domain"], []string{token}) {
			t.Errorf("rule %d: %v", index, rules[index])
		}
	}
	if !reflect.DeepEqual(rules[4]["ip"], []string{"203.0.113.0/24", "2001:db8::/32"}) {
		t.Errorf("GeoIP had wrong prefixes: %v", rules[4])
	}
}

func TestFixedDeviceIgnoresDormantRules(t *testing.T) {
	config := labConfig()
	config.Devices = []Device{{
		MAC: "02:00:00:00:00:01", Addresses: []string{"192.168.1.20"},
		Mode: "fixed", DefaultTarget: "direct",
		Rules: []Rule{{Name: "dormant", Domain: "example.org", Target: "zapret"}},
	}}
	options := labOptions()
	options.LAN = netip.MustParsePrefix("192.168.1.0/24")
	options.RouterIP = netip.MustParseAddr("192.168.1.1")
	options.Inventory = nil
	compiled, err := Compile(config, options)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := compiled.Evaluate(Destination{Host: "example.org", ClientIP: "192.168.1.20", Network: "tcp", Port: 443})
	if err != nil || decision.Scope != "device" || decision.Target != "direct" || decision.Rule != "" {
		t.Fatalf("got %+v, %v", decision, err)
	}
	if initial := compiled.XrayRules("lan")[0]; initial["outboundTag"] != "direct" || initial["domain"] != nil {
		t.Fatalf("fixed rule is not a catch-all: %+v", initial)
	}
}

func TestServiceLabelsMatchOnlyTheirRoutingDomain(t *testing.T) {
	comp, err := Compile(Config{Rules: []Rule{{
		Name: "DKIM", Domain: "_DomainKey.YouTube.com.", Target: "zapret",
	}}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if token := comp.XrayRules("")[0]["domain"]; !reflect.DeepEqual(token, []string{"domain:_domainkey.youtube.com"}) {
		t.Fatalf("unexpected Xray token %v", token)
	}
	for host, want := range map[string]string{
		"_domainkey.youtube.com":          "zapret",
		"selector._domainkey.youtube.com": "zapret",
		"youtube.com":                     "direct",
		"other-domainkey.youtube.com":     "direct",
	} {
		got, err := comp.Evaluate(Destination{Host: host, Network: "tcp", Port: 443})
		if err != nil || got.Target != want {
			t.Fatalf("%s selected %v, %v; want %q", host, got, err, want)
		}
	}
	for _, host := range []string{"_.example.org", "ex_ample.org", "__tcp.example.org", "example._org"} {
		if _, valid := NormalizeRoutingDomain(host); valid {
			t.Errorf("accepted invalid routing domain %q", host)
		}
	}
	if normalized, valid := NormalizeRoutingDomain("_SIP._TCP.тест.рф"); !valid || normalized != "_sip._tcp.xn--e1aybc.xn--p1ai" {
		t.Fatalf("normalized internationalized service name to %q (valid %t)", normalized, valid)
	}
}

func TestAggregateGeoSiteAndNamedGeoIPRuleOrder(t *testing.T) {
	group := &DomainSet{}
	for _, entry := range []struct{ domain, match string }{
		{"limited.example", "suffix"}, {"one.example", "exact"},
		{"trending", "keyword"}, {`^cdn[0-9]+\.example$`, "regex"},
	} {
		if err := group.Add(entry.domain, entry.match); err != nil {
			t.Fatal(err)
		}
	}
	config := Config{Rules: []Rule{
		{Name: "Exception", Domain: "local.limited.example", Exact: true, Target: "direct"},
		{Name: "Blocked site", GeoSite: "ru-blocked", GeoSource: "source-sites", Target: "zapret"},
		{Name: "Blocked IP", GeoIP: "ru-blocked", GeoSource: "source-ip", Target: "@block"},
	}}
	options := Options{
		GeoSources: map[string]bool{"source-sites": true, "source-ip": true},
		GeoSites:   map[string]map[string]*DomainSet{"source-sites": {"RU-BLOCKED": group}},
		GeoData: map[string]map[string][]netip.Prefix{
			"source-ip": {"RU-BLOCKED": {netip.MustParsePrefix("203.0.113.0/24")}},
		},
	}
	compiled, err := Compile(config, options)
	if err != nil {
		t.Fatal(err)
	}
	generated := compiled.XrayRules("")
	want := []string{"domain:limited.example", "full:one.example", "keyword:trending", `regexp:^cdn[0-9]+\.example$`}
	if !reflect.DeepEqual(generated[1]["domain"], want) || !reflect.DeepEqual(generated[2]["ip"], []string{"203.0.113.0/24"}) {
		t.Fatalf("unexpected aggregate rules: %v", generated)
	}
	for host, expected := range map[string]string{
		"local.limited.example": "direct", "sub.limited.example": "zapret", "one.example": "zapret",
		"sub.one.example": "direct", "trending.example": "zapret", "cdn24.example": "zapret",
		"203.0.113.12": "@block", "198.51.100.25": "direct",
	} {
		got, err := compiled.Evaluate(Destination{Host: host, Network: "tcp", Port: 443})
		if err != nil || got.Target != expected {
			t.Fatalf("%s selected %s (%v), want %s", host, got.Target, err, expected)
		}
	}
	config.Rules[1].GeoSource = "source-ip"
	if _, err := Compile(config, options); err == nil {
		t.Fatal("an active GeoSite rule was accepted with an IP source")
	}
}
