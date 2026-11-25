package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
)

func parseSubscriptionXrayJSON(data []byte) ([]profile, []incompatibleSubscriptionRow, error) {
	clean, err := removeXrayComments(data)
	if err != nil {
		return nil, nil, err
	}
	clean = bytes.TrimSpace(clean)
	if len(clean) == 0 {
		return nil, nil, errors.New("пустая подписка Xray")
	}
	rows := []json.RawMessage{clean}
	if clean[0] == '[' && json.Unmarshal(clean, &rows) != nil {
		return nil, nil, errors.New("некорректный массив профилей Xray")
	}
	if len(rows) > maxSubscriptionRows {
		return nil, nil, errors.New("в подписке слишком много объектов Xray")
	}
	out := make([]profile, 0)
	rejected := make([]incompatibleSubscriptionRow, 0)
	seen := make(map[string]bool)
	var blockedDevice bool
	for index, row := range rows {
		entry, reason := subscriptionXrayRow(row)
		if reason != "" {
			if len(rejected) < 24 {
				rejected = append(rejected, incompatibleSubscriptionRow{
					Key: subscriptionDigest(string(row)), Name: "Профиль Xray " + strconv.Itoa(index+1), Reason: reason,
				})
			}
			continue
		}
		blockedDevice = blockedDevice || strings.EqualFold(entry.Label, blockedDeviceLabel)
		if !seen[entry.UpstreamKey] {
			out = append(out, entry)
			seen[entry.UpstreamKey] = true
		}
		if len(out) > maxSubscriptionProfiles {
			return nil, rejected, errors.New("подписка содержит более 128 совместимых профилей")
		}
	}
	if blockedDevice && len(out) == 1 {
		return nil, rejected, errSubscriptionDeviceBlocked
	}
	if len(out) == 0 {
		return nil, rejected, errors.New("в JSON-подписке нет совместимых профилей VLESS, Hysteria2 или групп Xray")
	}
	return out, rejected, nil
}

func subscriptionJSONEmpty(data json.RawMessage) bool {
	switch string(bytes.TrimSpace(data)) {
	case "", "null", "{}", "[]":
		return true
	default:
		return false
	}
}

func subscriptionXrayRow(raw json.RawMessage) (profile, string) {
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil || envelope == nil || len(raw) > 24<<10 {
		return profile{}, "Некорректный или слишком большой профиль Xray."
	}
	fields, wrapped := envelope["outbounds"]
	if !wrapped {
		return subscriptionXrayNode(raw, "")
	}
	if !subscriptionJSONEmpty(envelope["reverse"]) {
		return profile{}, "Конфигурация Xray использует обратное проксирование."
	}
	var exits []json.RawMessage
	if json.Unmarshal(fields, &exits) != nil || len(exits) == 0 || len(exits) > 16 {
		return profile{}, "Проверьте количество выходов Xray."
	}
	var label string
	_ = json.Unmarshal(envelope["remarks"], &label)
	var routing struct {
		Balancers []subscriptionXrayBalancer
	}
	if !subscriptionJSONEmpty(envelope["routing"]) && json.Unmarshal(envelope["routing"], &routing) != nil {
		return profile{}, "Некорректный раздел маршрутизации Xray."
	}
	if len(routing.Balancers) > 0 {
		if len(routing.Balancers) != 1 {
			return profile{}, "Поддерживается один балансировщик на профиль Xray."
		}
		return subscriptionXrayGroup(exits, routing.Balancers[0], label)
	}
	var entry profile
	for _, raw := range exits {
		var item struct{ Protocol string }
		if json.Unmarshal(raw, &item) != nil {
			return profile{}, "Некорректный выход Xray."
		}
		if item.Protocol == "freedom" || item.Protocol == "blackhole" || item.Protocol == "dns" {
			continue
		}
		if entry.Protocol != "" {
			return profile{}, "Несколько выходов Xray требуют одного явного балансировщика."
		}
		var reason string
		entry, reason = subscriptionXrayNode(raw, label)
		if reason != "" {
			return profile{}, reason
		}
	}
	if entry.Protocol == "" {
		return profile{}, "В конфигурации Xray нет совместимого выхода VLESS или Hysteria2."
	}
	return entry, ""
}

func subscriptionXrayNode(outbound json.RawMessage, label string) (profile, string) {
	var shape struct{ Protocol string }
	if json.Unmarshal(outbound, &shape) == nil && shape.Protocol == "hysteria" {
		return parseSubscriptionHysteriaNode(outbound, label)
	}
	if !safeSubscriptionXrayOutbound(outbound) {
		return profile{}, "Поддерживается VLESS с обычным транспортом и проверяемым TLS."
	}
	entry, err := parseXrayOutbound(outbound, 1)
	if err != nil || entry.Protocol != "vless" {
		return profile{}, "Параметры VLESS не прошли проверку."
	}
	settings, ok := subscriptionJSONServer(entry.Outbound)
	if !ok || !validSubscriptionNodeHost(settings.Address) {
		return profile{}, "Для VLESS нужен публичный адрес сервера."
	}
	label = importedLabel(fallback(label, entry.Label))
	if (settings.ID != "" && strings.Contains(label, settings.ID)) ||
		(len(settings.Users) == 1 && strings.Contains(label, settings.Users[0].ID)) {
		label = ""
	}
	var options map[string]any
	if json.Unmarshal(entry.Outbound, &options) != nil {
		return profile{}, "Некорректный выход VLESS."
	}
	identity, err := json.Marshal(options)
	if err != nil {
		return profile{}, "Некорректный выход VLESS."
	}
	entry.Label = fallback(label, "VLESS")
	entry.UpstreamName, entry.UpstreamKey, entry.CatalogProfile = entry.Label, subscriptionDigest(string(identity)), true
	return entry, ""
}

type subscriptionXrayBalancer struct {
	Tag         string
	Selector    []string
	FallbackTag string
	Strategy    struct {
		Type     string
		Settings struct {
			Baselines []string
			Expected  int
			MaxRTT    string
			Tolerance float64
			Costs     []struct {
				Match  string
				Regexp bool
				Value  float64
			}
		}
	}
}

func subscriptionXrayGroup(exits []json.RawMessage, balancer subscriptionXrayBalancer, label string) (profile, string) {
	if balancer.Tag == "" || len(balancer.Selector) == 0 || len(balancer.Selector) > 16 ||
		slices.Contains(balancer.Selector, "") {
		return profile{}, "В балансировщике Xray нет явного списка выходов."
	}
	group := &xrayProfileGroup{Strategy: fallback(balancer.Strategy.Type, "random")}
	seenTags := make(map[string]bool)
	memberTags := make([]string, 0, len(exits))
	for _, raw := range exits {
		var item struct{ Tag, Protocol string }
		if json.Unmarshal(raw, &item) != nil || item.Tag != "" && seenTags[item.Tag] {
			return profile{}, "Некорректные или повторяющиеся теги выходов Xray."
		}
		seenTags[item.Tag] = true
		selected := slices.ContainsFunc(balancer.Selector, func(prefix string) bool {
			return strings.HasPrefix(item.Tag, prefix)
		})
		isFallback := item.Tag != "" && item.Tag == balancer.FallbackTag
		if isFallback && item.Protocol == "blackhole" {
			// RouteHub provides its own explicit block fallback.
			continue
		}
		if !selected && !isFallback {
			continue
		}
		node, reason := subscriptionXrayNode(raw, label)
		if reason != "" {
			return profile{}, "У группы Xray есть несовместимый выход или резервный маршрут."
		}
		if node.Label == "VLESS" {
			label = ""
		}
		if isFallback {
			index := len(group.Members)
			group.Fallback = &index
		}
		group.Members = append(group.Members, xrayGroupMember{
			Protocol: node.Protocol, Outbound: node.Outbound, FallbackOnly: !selected,
		})
		memberTags = append(memberTags, item.Tag)
	}
	if balancer.FallbackTag != "" && !seenTags[balancer.FallbackTag] {
		return profile{}, "Резервный выход Xray отсутствует в профиле."
	}
	settings := balancer.Strategy.Settings
	if group.Strategy == "leastLoad" {
		group.Settings = &xrayGroupStrategySettings{
			Baselines: settings.Baselines, Expected: settings.Expected, MaxRTT: settings.MaxRTT, Tolerance: settings.Tolerance,
		}
		for _, cost := range settings.Costs {
			if cost.Regexp || cost.Match == "" {
				return profile{}, "Веса с регулярными выражениями в балансировщике Xray не поддерживаются."
			}
			for i, tag := range memberTags {
				if strings.Contains(tag, cost.Match) &&
					!slices.ContainsFunc(group.Settings.Costs, func(old xrayGroupCost) bool { return old.Member == i }) {
					group.Settings.Costs = append(group.Settings.Costs, xrayGroupCost{Member: i, Value: cost.Value})
				}
			}
		}
	}
	if err := validateXrayProfileGroup(group); err != nil {
		return profile{}, err.Error()
	}
	data, err := json.Marshal(group)
	if err != nil {
		return profile{}, "Некорректные параметры группы Xray."
	}
	label = fallback(importedLabel(label), "Группа Xray")
	return profile{Protocol: "vless", Label: label, XrayGroup: group, CatalogProfile: true,
		UpstreamName: label, UpstreamKey: subscriptionDigest("xray-group|" + string(data))}, ""
}

func groupMemberCount(entry profile) int {
	if entry.XrayGroup == nil {
		return 0
	}
	return len(entry.XrayGroup.Members)
}

func subscriptionJSONServer(data json.RawMessage) (xrayImportedServer, bool) {
	var body struct{ Settings xrayImportedSettings }
	if json.Unmarshal(data, &body) != nil {
		return xrayImportedServer{}, false
	}
	settings := body.Settings
	if len(settings.VNext) == 1 && settings.Address == "" && len(settings.Servers) == 0 &&
		len(settings.VNext[0].Users) == 1 && settings.VNext[0].Users[0].ID != "" {
		return settings.VNext[0], true
	}
	if settings.Address != "" && settings.ID != "" && len(settings.VNext) == 0 && len(settings.Servers) == 0 {
		return settings.xrayImportedServer, true
	}
	return xrayImportedServer{}, false
}

func safeSubscriptionXrayOutbound(data json.RawMessage) bool {
	var outbound map[string]json.RawMessage
	if json.Unmarshal(data, &outbound) != nil || string(bytes.TrimSpace(outbound["protocol"])) != `"vless"` {
		return false
	}
	for k := range outbound {
		switch k {
		case "protocol", "tag", "settings", "streamSettings", "mux":
		default:
			return false
		}
	}
	if subscriptionJSONEmpty(outbound["streamSettings"]) {
		return true
	}
	var stream map[string]json.RawMessage
	if json.Unmarshal(outbound["streamSettings"], &stream) != nil {
		return false
	}
	for k := range stream {
		switch k {
		case "network", "security", "rawSettings", "tcpSettings", "wsSettings", "grpcSettings",
			"xhttpSettings", "splithttpSettings", "httpupgradeSettings", "tlsSettings", "realitySettings":
		default:
			return false
		}
	}
	var network, security string
	_ = json.Unmarshal(stream["network"], &network)
	_ = json.Unmarshal(stream["security"], &security)
	switch network {
	case "", "raw", "tcp", "ws", "websocket", "grpc", "xhttp", "splithttp", "httpupgrade":
	default:
		return false
	}
	if security != "" && security != "none" && security != "tls" && security != "reality" {
		return false
	}
	for _, k := range []string{"xhttpSettings", "splithttpSettings"} {
		if !subscriptionJSONEmpty(stream[k]) {
			var options map[string]json.RawMessage
			if json.Unmarshal(stream[k], &options) != nil || !subscriptionJSONEmpty(options["downloadSettings"]) || !subscriptionJSONEmpty(options["extra"]) {
				return false
			}
		}
	}
	if subscriptionJSONEmpty(stream["tlsSettings"]) {
		return true
	}
	var tls map[string]json.RawMessage
	if json.Unmarshal(stream["tlsSettings"], &tls) != nil {
		return false
	}
	for key, value := range tls {
		switch key {
		case "serverName", "verifyPeerCertByName", "alpn", "fingerprint", "pinnedPeerCertSha256",
			"minVersion", "maxVersion", "curvePreferences", "enableSessionResumption", "disableSystemRoot", "useSystemCA":
		case "allowInsecure":
			if string(bytes.TrimSpace(value)) != "false" {
				return false
			}
		default:
			if !subscriptionJSONEmpty(value) && string(bytes.TrimSpace(value)) != `""` {
				return false
			}
		}
	}
	return true
}
