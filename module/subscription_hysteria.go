package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"unicode"
	"unicode/utf8"
)

const invalidSubscriptionHysteria = "Поддерживается самостоятельный выход Hysteria2 с публичным адресом и проверяемым TLS."

type subscriptionHysteriaOutbound struct {
	Protocol string `json:"protocol"`
	Tag      string `json:"tag,omitempty"`
	Settings struct {
		Address string `json:"address"`
		Port    uint16 `json:"port"`
		Version uint8  `json:"version"`
	} `json:"settings"`
	Stream struct {
		Network  string `json:"network"`
		Security string `json:"security"`
		Hysteria struct {
			Version uint8  `json:"version"`
			Auth    string `json:"auth"`
		} `json:"hysteriaSettings"`
		TLS struct {
			Name          string   `json:"serverName,omitempty"`
			ALPN          []string `json:"alpn,omitempty"`
			Fingerprint   string   `json:"fingerprint,omitempty"`
			AllowInsecure bool     `json:"allowInsecure,omitempty"`
		} `json:"tlsSettings"`
		FinalMask *struct {
			QUIC *struct {
				Congestion string `json:"congestion,omitempty"`
				Debug      bool   `json:"debug,omitempty"`
			} `json:"quicParams,omitempty"`
		} `json:"finalmask,omitempty"`
	} `json:"streamSettings"`
}

func validSubscriptionHysteriaHost(value string) bool {
	if value != strings.TrimSpace(value) || !validSubscriptionNodeHost(value) {
		return false
	}
	// Reject ambiguous numeric hostnames such as legacy abbreviated IPv4.
	if _, err := netip.ParseAddr(value); err != nil {
		host := normalizeHost(value)
		topLevel := host[strings.LastIndexByte(host, '.')+1]
		return topLevel >= 'a' && topLevel <= 'z'
	}
	return true
}

func readSubscriptionHysteriaNode(outbound json.RawMessage) (subscriptionHysteriaOutbound, bool) {
	var node subscriptionHysteriaOutbound
	if len(outbound) > 24<<10 || !utf8.Valid(outbound) ||
		decodeJSON(bytes.NewReader(outbound), &node) != nil {
		return node, false
	}
	stream := &node.Stream
	auth := stream.Hysteria.Auth
	if node.Protocol != "hysteria" || node.Settings.Version != 2 || node.Settings.Port == 0 ||
		!validSubscriptionHysteriaHost(node.Settings.Address) || stream.Network != "hysteria" ||
		stream.Security != "tls" || stream.Hysteria.Version != 2 || strings.TrimSpace(auth) == "" ||
		len(auth) > 1024 || strings.ContainsFunc(auth, unicode.IsControl) {
		return node, false
	}
	tls := &stream.TLS
	if tls.AllowInsecure || tls.Name != "" && !validSubscriptionHysteriaHost(tls.Name) ||
		len(tls.ALPN) > 1 || len(tls.ALPN) == 1 && tls.ALPN[0] != "h3" {
		return node, false
	}
	switch tls.Fingerprint {
	case "", "chrome", "firefox", "safari", "ios", "android", "edge", "360", "qq", "random", "randomized", "unsafe":
	default:
		return node, false
	}
	if stream.FinalMask != nil && stream.FinalMask.QUIC != nil {
		quic := stream.FinalMask.QUIC
		switch quic.Congestion {
		case "", "reno", "bbr", "brutal":
		default:
			return node, false
		}
		// A provider may select congestion control but may not turn on router debug logs.
		quic.Debug = false
		if quic.Congestion == "" {
			stream.FinalMask = nil
		}
	} else {
		stream.FinalMask = nil
	}
	node.Settings.Address = normalizeHost(node.Settings.Address)
	tls.Name = normalizeHost(tls.Name)
	return node, true
}

func validateSubscriptionHysteriaNode(outbound json.RawMessage) bool {
	_, ok := readSubscriptionHysteriaNode(outbound)
	return ok
}

func parseSubscriptionHysteriaNode(outbound json.RawMessage, label string) (profile, string) {
	node, ok := readSubscriptionHysteriaNode(outbound)
	if !ok {
		return profile{}, invalidSubscriptionHysteria
	}
	label = importedLabel(fallback(label, node.Tag))
	if strings.Contains(label, node.Stream.Hysteria.Auth) {
		label = ""
	}
	label = fallback(label, "Hysteria2")
	node.Tag = ""
	canonical, err := json.Marshal(node)
	if err != nil {
		return profile{}, invalidSubscriptionHysteria
	}
	return profile{
		Protocol: "hysteria2", Label: label, UpstreamName: label,
		Outbound: canonical, UpstreamKey: subscriptionDigest(string(canonical)), CatalogProfile: true,
	}, ""
}

func pinSubscriptionHysteriaNode(entry profile, address netip.Addr) (profile, error) {
	address = address.Unmap()
	node, ok := readSubscriptionHysteriaNode(entry.Outbound)
	if entry.Protocol != "hysteria2" || entry.URI != "" || !ok || !isZapretPublicIPv4(address) {
		return profile{}, errors.New(invalidSubscriptionHysteria)
	}
	if node.Stream.TLS.Name == "" {
		node.Stream.TLS.Name = node.Settings.Address
	}
	node.Settings.Address = address.String()
	node.Tag = ""
	outbound, err := json.Marshal(node)
	if err != nil {
		return profile{}, errors.New(invalidSubscriptionHysteria)
	}
	entry.Outbound = outbound
	return entry, nil
}
