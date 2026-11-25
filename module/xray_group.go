package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"
)

const maxXrayGroupMembers = 8

type xrayProfileGroup struct {
	Strategy string                     `json:"strategy"`
	Members  []xrayGroupMember          `json:"members"`
	Fallback *int                       `json:"fallback,omitempty"`
	Settings *xrayGroupStrategySettings `json:"settings,omitempty"`
}

type xrayGroupMember struct {
	Protocol     string          `json:"protocol"`
	Outbound     json.RawMessage `json:"outbound"`
	FallbackOnly bool            `json:"fallbackOnly,omitempty"`
}

type xrayGroupStrategySettings struct {
	Baselines []string        `json:"baselines,omitempty"`
	Expected  int             `json:"expected,omitempty"`
	MaxRTT    string          `json:"maxRTT,omitempty"`
	Tolerance float64         `json:"tolerance,omitempty"`
	Costs     []xrayGroupCost `json:"costs,omitempty"`
}

type xrayGroupCost struct {
	Member int     `json:"member"`
	Value  float64 `json:"value"`
}

func validateXrayProfileGroup(group *xrayProfileGroup) error {
	if group == nil || len(group.Members) < 2 || len(group.Members) > maxXrayGroupMembers {
		return fmt.Errorf("группа Xray должна содержать от 2 до %d выходов", maxXrayGroupMembers)
	}
	switch group.Strategy {
	case "leastPing", "leastLoad", "random", "roundRobin":
	default:
		return errors.New("неизвестная стратегия группы Xray")
	}
	if group.Fallback != nil && (*group.Fallback < 0 || *group.Fallback >= len(group.Members)) {
		return errors.New("резервный выход должен принадлежать группе Xray")
	}
	selectable := 0
	for index, member := range group.Members {
		if member.FallbackOnly && (group.Fallback == nil || *group.Fallback != index) {
			return errors.New("выход вне пула может использоваться только как резервный")
		}
		if !member.FallbackOnly {
			selectable++
		}
		if member.Protocol != "vless" || len(member.Outbound) > 24<<10 || !safeSubscriptionXrayOutbound(member.Outbound) {
			return fmt.Errorf("выход %d группы Xray должен быть самостоятельным VLESS", index+1)
		}
		var shape struct {
			Stream struct {
				Security string `json:"security"`
			} `json:"streamSettings"`
		}
		if err := json.Unmarshal(member.Outbound, &shape); err != nil || (shape.Stream.Security != "tls" && shape.Stream.Security != "reality") {
			return fmt.Errorf("для выхода %d группы Xray требуется TLS или REALITY", index+1)
		}
		if _, err := parseXrayOutbound(member.Outbound, index+1); err != nil {
			return fmt.Errorf("некорректные параметры выхода %d группы Xray", index+1)
		}
		server, ok := subscriptionJSONServer(member.Outbound)
		if !ok || !validSubscriptionNodeHost(server.Address) {
			return fmt.Errorf("для выхода %d группы Xray нужен публичный IPv4 или домен", index+1)
		}
	}
	if selectable == 0 {
		return errors.New("выберите хотя бы один выход для балансировки")
	}
	return validateXrayGroupStrategy(group, selectable)
}

func validateXrayGroupStrategy(group *xrayProfileGroup, selectable int) error {
	if group.Settings == nil {
		return nil
	}
	settings := group.Settings
	if group.Strategy != "leastLoad" || settings.Expected < 0 || settings.Expected > selectable ||
		!finiteGroupValue(settings.Tolerance, 1) || len(settings.Baselines) > maxXrayGroupMembers ||
		len(settings.Costs) > len(group.Members) {
		return errors.New("некорректные настройки leastLoad группы Xray")
	}
	validDuration := func(value string) bool {
		d, err := time.ParseDuration(value)
		return err == nil && d > 0 && d <= time.Minute
	}
	if settings.MaxRTT != "" && !validDuration(settings.MaxRTT) {
		return errors.New("некорректный maxRTT группы Xray")
	}
	for _, value := range settings.Baselines {
		if !validDuration(value) {
			return errors.New("некорректное время baseline группы Xray")
		}
	}
	seen := make(map[int]bool, len(settings.Costs))
	for _, cost := range settings.Costs {
		if cost.Member < 0 || cost.Member >= len(group.Members) || seen[cost.Member] ||
			cost.Value == 0 || !finiteGroupValue(cost.Value, 2e18) {
			return errors.New("некорректный вес выхода группы Xray")
		}
		seen[cost.Member] = true
	}
	return nil
}

func finiteGroupValue(value, max float64) bool {
	return !math.IsNaN(value) && value >= 0 && value <= max
}

func xrayGroupBalancerTag(id string) string {
	return "@rh/group/" + id
}

func xrayGroupMemberTag(id string, index int) string {
	return "@rh/member/" + id + "/" + strconv.Itoa(index) + "/"
}

func compileXrayGroup(id string, group *xrayProfileGroup) ([]object, object, error) {
	if err := validateXrayProfileGroup(group); err != nil {
		return nil, nil, err
	}
	members := make([]object, 0, len(group.Members))
	selectors := make([]string, 0, len(group.Members))
	for index, member := range group.Members {
		tag := xrayGroupMemberTag(id, index)
		outbound, err := profileOutbound(profile{ID: tag, Protocol: member.Protocol, Outbound: member.Outbound})
		if err != nil {
			return nil, nil, err
		}
		members = append(members, outbound)
		if !member.FallbackOnly {
			selectors = append(selectors, tag)
		}
	}
	fallback := "@block"
	if group.Fallback != nil {
		fallback = xrayGroupMemberTag(id, *group.Fallback)
	}
	strategy := object{"type": group.Strategy}
	if group.Settings != nil {
		settings := group.Settings
		encoded := object{"expected": settings.Expected, "tolerance": settings.Tolerance}
		if len(settings.Baselines) > 0 {
			encoded["baselines"] = settings.Baselines
		}
		if settings.MaxRTT != "" {
			encoded["maxRTT"] = settings.MaxRTT
		}
		if len(settings.Costs) > 0 {
			costs := make([]object, 0, len(settings.Costs))
			for _, cost := range settings.Costs {
				costs = append(costs, object{"regexp": false, "match": xrayGroupMemberTag(id, cost.Member), "value": cost.Value})
			}
			encoded["costs"] = costs
		}
		strategy["settings"] = encoded
	}
	return members, object{
		"tag": xrayGroupBalancerTag(id), "selector": selectors, "strategy": strategy, "fallbackTag": fallback,
	}, nil
}

func installXrayBalancers(compiled object, balancers []object) {
	if len(balancers) == 0 {
		return
	}
	routing := compiled["routing"].(object)
	routing["balancers"] = balancers
	selectors := make([]string, 0)
	for _, balancer := range balancers {
		selectors = append(selectors, balancer["selector"].([]string)...)
	}
	// Keep one observer per process. It probes only our generated members and
	// uses the same fixed HTTPS endpoint as the runtime/panel health check.
	compiled["burstObservatory"] = object{
		"subjectSelector": selectors,
		"pingConfig": object{
			"destination": profileProbeURL, "interval": "45s", "sampling": 2, "timeout": "4s", "httpMethod": "HEAD",
		},
	}
}

type publicXrayResolver func(context.Context, string, string) (netip.Addr, bool, error)

// Pin the only endpoint each member may connect to and retain its TLS name.
// Never emit the supplier's DNS, local interfaces, chaining or routing.
func pinXrayProfileGroup(ctx context.Context, group *xrayProfileGroup, resolve publicXrayResolver) (*xrayProfileGroup, error) {
	if err := validateXrayProfileGroup(group); err != nil {
		return nil, err
	}
	pinned := *group
	pinned.Members = slices.Clone(group.Members)
	type memberResult struct {
		index    int
		outbound json.RawMessage
		err      error
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	results := make(chan memberResult, len(pinned.Members))
	for index, member := range pinned.Members {
		go func() {
			endpoint, _ := subscriptionJSONServer(member.Outbound)
			address, _, err := resolve(ctx, endpoint.Address, "")
			if err != nil {
				results <- memberResult{index: index, err: err}
				return
			}
			entry, err := pinnedVLESSProbe(profile{Protocol: member.Protocol, Outbound: member.Outbound}, address)
			results <- memberResult{index: index, outbound: entry.Outbound, err: err}
		}()
	}
	for range pinned.Members {
		select {
		case result := <-results:
			if result.err != nil {
				return nil, fmt.Errorf("для выхода %d группы Xray не подтверждён публичный IPv4", result.index+1)
			}
			pinned.Members[result.index].Outbound = result.outbound
		case <-ctx.Done():
			return nil, errors.New("не удалось подтвердить публичные IPv4 выходов группы Xray")
		}
	}
	return &pinned, nil
}

func pinRuntimeXrayProfiles(ctx context.Context, config plan, resolve publicXrayResolver) (plan, error) {
	active := make(map[string]bool)
	for _, profile := range engineProfiles(config) {
		if profile.XrayGroup != nil || subscriptionHysteriaProfile(profile) {
			active[profile.ID] = true
		}
	}
	if len(active) == 0 {
		return config, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	config.Profiles = slices.Clone(config.Profiles)
	for i := range config.Profiles {
		entry := &config.Profiles[i]
		if !active[entry.ID] {
			continue
		}
		pinned, err := pinExecutableXrayProfile(ctx, *entry, resolve)
		if err != nil {
			return plan{}, fmt.Errorf("профиль %q: %w", entry.ID, err)
		}
		*entry = pinned
	}
	return config, nil
}

func subscriptionHysteriaProfile(entry profile) bool {
	return entry.Protocol == "hysteria2" && entry.CatalogProfile
}

func pinExecutableXrayProfile(ctx context.Context, entry profile, resolve publicXrayResolver) (profile, error) {
	if entry.XrayGroup != nil {
		pinned, err := pinXrayProfileGroup(ctx, entry.XrayGroup, resolve)
		entry.XrayGroup = pinned
		return entry, err
	}
	if subscriptionHysteriaProfile(entry) {
		host, _, err := net.SplitHostPort(profileServer(entry))
		if err != nil || !validSubscriptionNodeHost(host) {
			return profile{}, errors.New("для выхода Hysteria2 нужен публичный IPv4 или домен")
		}
		address, _, err := resolve(ctx, host, "")
		if err != nil || !isZapretPublicIPv4(address.Unmap()) {
			return profile{}, errors.New("для выхода Hysteria2 не подтверждён публичный IPv4")
		}
		return pinSubscriptionHysteriaNode(entry, address)
	}
	return entry, nil
}

func preserveXrayTransportAuthority(stream object, hostname string, port any) {
	authority := hostname
	if tls, ok := stream["tlsSettings"].(object); ok {
		if name, _ := tls["serverName"].(string); name != "" {
			authority = name
		}
	}
	for _, key := range []string{"wsSettings", "httpupgradeSettings", "xhttpSettings", "splithttpSettings"} {
		if settings, ok := stream[key].(object); ok {
			if host, _ := settings["host"].(string); host == "" {
				headers, _ := settings["headers"].(object)
				explicit := false
				for header := range headers {
					explicit = explicit || strings.EqualFold(header, "Host")
				}
				if explicit {
					continue
				}
				settings["host"] = authority
			}
		}
	}
	if settings, ok := stream["grpcSettings"].(object); ok {
		if host, _ := settings["authority"].(string); host == "" {
			if stream["security"] == "reality" {
				// With no explicit authority gRPC uses the original endpoint
				// (including its port) for REALITY rather than the TLS SNI.
				authority = net.JoinHostPort(hostname, fmt.Sprint(port))
			}
			settings["authority"] = authority
		}
	}
}
