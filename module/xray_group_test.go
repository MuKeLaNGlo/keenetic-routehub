package main

import (
	"context"
	"encoding/json"
	"net/netip"
	"reflect"
	"slices"
	"testing"

	"routehub/devicepolicy"
)

func testXrayGroup(strategy string) *xrayProfileGroup {
	member := func(address string) xrayGroupMember {
		return xrayGroupMember{Protocol: "vless", Outbound: json.RawMessage(
			`{"protocol":"vless","tag":"ignored-vendor-tag","settings":{"address":"` + address +
				`","port":443,"id":"12345678-1234-4123-8123-123456789abc","encryption":"none"},"streamSettings":{"network":"ws","security":"tls","wsSettings":{"path":"/"}}}`)}
	}
	return &xrayProfileGroup{Strategy: strategy, Members: []xrayGroupMember{member("a.example.org"), member("b.example.org")}}
}

func TestXrayGroupRoutesMainDeviceAndHealthThroughSameBalancer(t *testing.T) {
	group := testXrayGroup("leastLoad")
	fallbackIndex := 1
	group.Fallback = &fallbackIndex
	group.Members[1].FallbackOnly = true
	group.Settings = &xrayGroupStrategySettings{Baselines: []string{"2s"}, Expected: 1, MaxRTT: "6s",
		Costs: []xrayGroupCost{{Member: 0, Value: 2e18}, {Member: 1, Value: 1e12}}}
	config := testPanelEditConfig()
	config.Profiles = append(config.Profiles, profile{ID: "group-a", Protocol: "vless", CatalogProfile: true, XrayGroup: group})
	config.Rules = []rule{{Name: "Global", Domain: "example.org", Target: "group-a"}}
	config.Devices = []devicepolicy.Device{{
		MAC: "02:00:00:00:00:aa", Addresses: []string{"192.168.1.99"}, Mode: "inherit",
		Rules: []rule{{Name: "Personal", CIDR: "203.0.113.5/32", Target: "group-a"}},
	}}
	config.DefaultTarget = "direct"
	config = runtimePlan(config, runtimeSelection{VPN: true, Profile: "group-a"})
	assembled, err := compileXray(config, true, false)
	if err != nil {
		t.Fatal(err)
	}
	probe := &runtimeHealthProbe{port: 32123, user: "fixture-user", pass: "fixture-password"}
	if err := probe.addToXray(assembled, config); err != nil {
		t.Fatal(err)
	}
	routing := assembled["routing"].(object)
	rules := routing["rules"].([]object)
	matches := 0
	for _, rule := range rules {
		if rule["outboundTag"] == "group-a" {
			t.Fatal("group must not be used as an ordinary outbound")
		}
		if rule["balancerTag"] == xrayGroupBalancerTag("group-a") {
			matches++
		}
	}
	if matches != 3 || !slices.Equal(rules[0]["inboundTag"].([]string), []string{runtimeHealthInbound}) ||
		rules[0]["balancerTag"] != xrayGroupBalancerTag("group-a") || rules[len(rules)-1]["outboundTag"] != "direct" {
		t.Fatal("the health, personal and global rules must use the same balancer and leave the ordinary fallback intact")
	}
	balancer := routing["balancers"].([]object)[0]
	if balancer["fallbackTag"] != xrayGroupMemberTag("group-a", 1) {
		t.Fatal("the explicitly configured VPN member was lost as fallback")
	}
	observers := assembled["burstObservatory"].(object)
	if assembled["observatory"] != nil ||
		!slices.Equal(observers["subjectSelector"].([]string), []string{xrayGroupMemberTag("group-a", 0)}) ||
		observers["pingConfig"].(object)["destination"] != profileProbeURL {
		t.Fatal("group must use one locally configured observer for selectable members only")
	}
	settings := balancer["strategy"].(object)["settings"].(object)
	if settings["expected"] != 1 || settings["maxRTT"] != "6s" ||
		!reflect.DeepEqual(settings["costs"].([]object)[0], object{"regexp": false, "match": xrayGroupMemberTag("group-a", 0), "value": float64(2e18)}) {
		t.Fatal("normalized leastLoad parameters were lost")
	}
	disabled, err := compileXray(runtimePlan(config, runtimeSelection{Profile: "group-a"}), true, false)
	if err != nil || disabled["burstObservatory"] != nil {
		t.Fatalf("disabled catalog group must not start background probes: %v", err)
	}
}

func TestXrayProbeGroupsFailClosedForAllStrategies(t *testing.T) {
	for _, strategy := range []string{"leastPing", "leastLoad", "random", "roundRobin"} {
		t.Run(strategy, func(t *testing.T) {
			entry := profile{ID: "node", Protocol: "vless", XrayGroup: testXrayGroup(strategy)}
			compiled, err := isolateProbeConfig(entry, 34567, "fixture-user", "fixture-password")
			if err != nil {
				t.Fatal(err)
			}
			balancer := compiled["routing"].(object)["balancers"].([]object)[0]
			if balancer["fallbackTag"] != "@block" || balancer["strategy"].(object)["type"] != strategy {
				t.Fatalf("invalid %s fallback", strategy)
			}
			outbounds := compiled["outbounds"].([]object)
			if len(outbounds) != 3 || outbounds[0]["protocol"] != "blackhole" ||
				outbounds[1]["tag"] == outbounds[2]["tag"] || outbounds[1]["tag"] == "ignored-vendor-tag" {
				t.Fatal("the group probe loaded unexpected exits")
			}
		})
	}
}

func TestXrayGroupMembersUseOnlyPinnedPublicAddress(t *testing.T) {
	group := testXrayGroup("random")
	ctx := context.Background()
	pinned, err := pinXrayProfileGroup(ctx, group, func(_ context.Context, _, _ string) (netip.Addr, bool, error) {
		return netip.MustParseAddr("8.8.8.8"), true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, member := range pinned.Members {
		server, ok := subscriptionJSONServer(member.Outbound)
		original, _ := subscriptionJSONServer(group.Members[i].Outbound)
		var config object
		if !ok || server.Address != "8.8.8.8" || original.Address == server.Address ||
			json.Unmarshal(member.Outbound, &config) != nil {
			t.Fatal("pinning did not isolate runtime address from stored address")
		}
		stream := config["streamSettings"].(object)
		if stream["tlsSettings"].(object)["serverName"] != original.Address || stream["wsSettings"].(object)["host"] != original.Address {
			t.Fatal("pinning changed upstream TLS or WebSocket authority")
		}
	}
	if _, err := pinXrayProfileGroup(ctx, group, func(_ context.Context, _, _ string) (netip.Addr, bool, error) {
		return netip.MustParseAddr("192.168.10.1"), true, nil
	}); err == nil {
		t.Fatal("private resolved member would be allowed to run")
	}
	group.Members[0].Outbound = json.RawMessage(`{"protocol":"vless","settings":{"address":"a.example.org","id":"test","port":443},"streamSettings":{"sockopt":{"interface":"br0"}}}`)
	if err := validateXrayProfileGroup(group); err == nil {
		t.Fatal("vendor-supplied local interface was allowed")
	}
	group.Members[0].Outbound = json.RawMessage(`{"protocol":"vless","settings":{"address":"a.example.org","id":"test","port":443}}`)
	if err := validateXrayProfileGroup(group); err == nil {
		t.Fatal("public VLESS without TLS or REALITY was accepted")
	}
}

func TestXrayGroupPinPreservesRealityGrpcAuthority(t *testing.T) {
	group := testXrayGroup("leastPing")
	group.Members[0].Outbound = json.RawMessage(`{"protocol":"vless","settings":{"address":"a.example.org","id":"test","port":443},"streamSettings":{"security":"reality","grpcSettings":{"serviceName":"fixture"},"network":"grpc","realitySettings":{"serverName":"sni.example.org","publicKey":"synthetic"}}}`)
	pinned, err := pinXrayProfileGroup(context.Background(), group, func(_ context.Context, _, _ string) (netip.Addr, bool, error) {
		return netip.MustParseAddr("8.8.8.8"), true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var config object
	if err := json.Unmarshal(pinned.Members[0].Outbound, &config); err != nil {
		t.Fatal(err)
	}
	stream := config["streamSettings"].(object)
	if stream["grpcSettings"].(object)["authority"] != "a.example.org:443" ||
		stream["realitySettings"].(object)["serverName"] != "sni.example.org" {
		t.Fatal("pinning altered original gRPC authority or REALITY SNI")
	}
}
