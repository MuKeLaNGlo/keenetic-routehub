package main

import (
	"bytes"
	"encoding/json"
	"net/netip"
	"strings"
	"testing"
)

const subscriptionHysteriaTestNode = `{
	"tag":"Hysteria fixture",
	"protocol":"hysteria",
	"settings":{"version":2,"address":"edge.example.net","port":443},
	"streamSettings":{
		"network":"hysteria","security":"tls",
		"hysteriaSettings":{"version":2,"auth":"fixture-auth"},
		"tlsSettings":{"serverName":"cert.example.net","alpn":["h3"],"fingerprint":"chrome"},
		"finalmask":{"quicParams":{"debug":true,"congestion":"bbr"}}
	}
}`

func TestSubscriptionHysteriaNormalizesStandaloneOutbound(t *testing.T) {
	entry, reason := parseSubscriptionHysteriaNode(json.RawMessage(subscriptionHysteriaTestNode), "Node fixture")
	if reason != "" || entry.Protocol != "hysteria2" || entry.Label != "Node fixture" ||
		entry.UpstreamName != entry.Label || len(entry.UpstreamKey) != 32 || !entry.CatalogProfile ||
		profileServer(entry) != "edge.example.net:443" {
		t.Fatal("standalone profile was not imported")
	}
	normalized, ok := readSubscriptionHysteriaNode(entry.Outbound)
	if !ok || normalized.Tag != "" || normalized.Stream.FinalMask.QUIC.Congestion != "bbr" ||
		bytes.Contains(entry.Outbound, []byte(`"debug"`)) || normalized.Stream.Hysteria.Auth != "fixture-auth" {
		t.Fatal("outbound fields were not safely normalized")
	}
	dup, reason := parseSubscriptionHysteriaNode(json.RawMessage(strings.ReplaceAll(
		subscriptionHysteriaTestNode, `"debug":true`, `"debug":false`,
	)), "fixture-auth")
	if reason != "" || dup.Label != "Hysteria2" || dup.UpstreamKey != entry.UpstreamKey {
		t.Fatal("auth leaked in label or presentation changed profile identity")
	}
}

func TestSubscriptionHysteriaRejectsUnsafeOutbounds(t *testing.T) {
	cases := []struct{ name, old, replace string }{
		{"private destination", "edge.example.net", "192.168.10.1"},
		{"abbreviated loopback", "edge.example.net", "127.1"},
		{"hex loopback", "edge.example.net", "0x7f.0.0.0x1"},
		{"mDNS destination", "edge.example.net", "nas.home.arpa"},
		{"ipv6 destination", "edge.example.net", "2606:4700:4700::1111"},
		{"unsupported version", `"version":2`, `"version":1`},
		{"multiple remotes", `"port":443`, `"port":443,"servers":[{"address":"alt.example","port":443}]`},
		{"alternate transport", `"network":"hysteria"`, `"network":"tcp"`},
		{"no TLS", `"security":"tls"`, `"security":"none"`},
		{"insecure TLS", `"serverName"`, `"allowInsecure":true,"serverName"`},
		{"TLS filesystem", `"serverName"`, `"certificates":[{"certificateFile":"/etc/ignored"}],"serverName"`},
		{"different ALPN", `"h3"`, `"h2"`},
		{"bad fingerprint", `"chrome"`, `"unknown-fingerprint"`},
		{"empty auth", `"fixture-auth"`, `""`},
		{"control in auth", `"fixture-auth"`, `"fixture\nauth"`},
		{"different outbound dependency", `"tag"`, `"proxySettings":{"tag":"other"},"tag"`},
		{"socket dependency", `"network"`, `"sockopt":{"dialerProxy":"other"},"network"`},
		{"unrecognized congestion", `"bbr"`, `"unsupported"`},
		{"forced congestion without rate", `"bbr"`, `"force-brutal"`},
		{"mask plugins", `"quicParams"`, `"udp":[{"type":"ignored"}],"quicParams"`},
		{"port hopping", `"congestion"`, `"udpHop":{"ports":"20000-50000"},"congestion"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			outbound := json.RawMessage(strings.Replace(subscriptionHysteriaTestNode, tc.old, tc.replace, 1))
			entry, reason := parseSubscriptionHysteriaNode(outbound, "")
			if reason == "" || entry.Protocol != "" || validateSubscriptionHysteriaNode(outbound) {
				t.Fatal("unexpectedly accepted unsafe outbound")
			}
		})
	}
}

func TestSubscriptionHysteriaPinKeepsTLSIdentity(t *testing.T) {
	for _, explicitSNI := range []bool{true, false} {
		input, wantSNI := subscriptionHysteriaTestNode, "cert.example.net"
		if !explicitSNI {
			input = strings.Replace(input, `"serverName":"cert.example.net",`, "", 1)
			wantSNI = "edge.example.net"
		}
		entry, reason := parseSubscriptionHysteriaNode(json.RawMessage(input), "")
		if reason != "" {
			t.Fatal(reason)
		}
		original := bytes.Clone(entry.Outbound)
		if _, err := pinSubscriptionHysteriaNode(entry, netip.MustParseAddr("10.0.0.1")); err == nil {
			t.Fatal("private IP accepted")
		}
		pinned, err := pinSubscriptionHysteriaNode(entry, netip.MustParseAddr("1.1.1.1"))
		if err != nil {
			t.Fatal(err)
		}
		normalized, ok := readSubscriptionHysteriaNode(pinned.Outbound)
		if !ok || normalized.Settings.Address != "1.1.1.1" || normalized.Stream.TLS.Name != wantSNI ||
			normalized.Stream.Hysteria.Auth != "fixture-auth" || normalized.Stream.FinalMask.QUIC.Congestion != "bbr" ||
			!bytes.Equal(original, entry.Outbound) {
			t.Fatal("pinning changed the TLS identity, connection options, or original profile")
		}
	}
}
