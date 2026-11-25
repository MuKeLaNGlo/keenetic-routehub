package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestRuntimeHealthConfigTargetsActiveCatalogProfile(t *testing.T) {
	config := testPanelEditConfig()
	config.DefaultTarget, config.Rules = "direct", nil
	for i := range config.Profiles {
		config.Profiles[i].CatalogProfile = true
	}
	live := runtimePlan(config, runtimeSelection{VPN: true, Profile: "relay"})
	plain, err := compileXray(live, false, false)
	if err != nil || len(plain["inbounds"].([]object)) != 1 {
		t.Fatalf("offline compilation must keep the ordinary listener set: %v", err)
	}
	if profiles := engineProfiles(live); len(profiles) != 1 || profiles[0].ID != "relay" {
		t.Fatal("selected but unreferenced catalog profile was omitted")
	}

	probe, reservation, err := reserveRuntimeHealthProbe(config, "")
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.Close()
	opts := options{vpnHealth: probe}
	dir := t.TempDir()
	for _, tc := range []struct {
		name, target string
		plan         plan
	}{
		{"enabled", "relay", live},
		{"disabled", "@block", runtimePlan(config, runtimeSelection{Profile: "relay"})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, err := writeRuntimeXray(opts, dir, tc.plan, false)
			if err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatal("runtime configuration containing SOCKS credentials must be private")
			}
			var parsed struct {
				Inbounds []struct {
					Tag      string `json:"tag"`
					Listen   string `json:"listen"`
					Port     uint16 `json:"port"`
					Settings struct {
						Auth string `json:"auth"`
						UDP  bool   `json:"udp"`
					} `json:"settings"`
				} `json:"inbounds"`
				Routing struct {
					Rules []struct {
						InboundTag  []string `json:"inboundTag"`
						OutboundTag string   `json:"outboundTag"`
					} `json:"rules"`
				} `json:"routing"`
			}
			data, err := os.ReadFile(path)
			if err != nil || json.Unmarshal(data, &parsed) != nil || len(parsed.Inbounds) != 2 {
				t.Fatal("missing probe listener")
			}
			inbound := parsed.Inbounds[1]
			if inbound.Tag != runtimeHealthInbound || inbound.Listen != "127.0.0.1" || inbound.Port != probe.port ||
				inbound.Settings.Auth != "password" || inbound.Settings.UDP {
				t.Fatal("probe listener lacks isolation")
			}
			first := parsed.Routing.Rules[0]
			if !slices.Equal(first.InboundTag, []string{runtimeHealthInbound}) || first.OutboundTag != tc.target {
				t.Fatal("health traffic misses its dedicated first-match route")
			}
		})
	}
	if path, err := writeRuntimeXray(opts, dir, runtimePlan(config, runtimeSelection{VPN: true, Profile: "gone"}), false); err == nil || path != "" {
		t.Fatal("broken profile unexpectedly allowed the private listener to compile")
	}
}

func TestRuntimeHealthProbeRejectsNoAuthAndUsesOnlySOCKS(t *testing.T) {
	for _, noAuth := range []bool{false, true} {
		listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		probe := &runtimeHealthProbe{port: uint16(listener.Addr().(*net.TCPAddr).Port), user: "user", pass: "test-password"}
		requested := make(chan string, 1)
		go func() {
			defer close(requested)
			client, err := listener.Accept()
			if err != nil {
				return
			}
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(time.Second))
			greeting := make([]byte, 3)
			if _, err := io.ReadFull(client, greeting); err != nil || !slices.Equal(greeting, []byte{5, 1, 2}) {
				return
			}
			if noAuth {
				_, _ = client.Write([]byte{5, 0})
				return
			}
			_, _ = client.Write([]byte{5, 2})
			auth := make([]byte, len(probe.user)+len(probe.pass)+3)
			if _, err := io.ReadFull(client, auth); err != nil || string(auth[2:2+len(probe.user)]) != probe.user || string(auth[3+len(probe.user):]) != probe.pass {
				return
			}
			_, _ = client.Write([]byte{1, 0})
			header := make([]byte, 5)
			if _, err := io.ReadFull(client, header); err != nil || !slices.Equal(header[:4], []byte{5, 1, 0, 3}) {
				return
			}
			target := make([]byte, int(header[4])+2)
			if _, err := io.ReadFull(client, target); err != nil || !slices.Equal(target[len(target)-2:], []byte{1, 187}) {
				return
			}
			requested <- string(target[:len(target)-2])
			_, _ = client.Write([]byte{5, 5, 0, 1})
		}()
		result := probe.check(context.Background())
		if noAuth {
			if result.Status != "unavailable" || result.LatencyMS != nil {
				t.Fatal("unauthenticated endpoint incorrectly supplied VPN health")
			}
		} else if result.Status != "failed" || <-requested != "www.gstatic.com" || result.LatencyMS != nil {
			t.Fatal("failing outbound should have failed HTTPS without retrying on WAN")
		}
	}
}

func TestRuntimeHealthClearsOnTransitionAndNeverReportsDisabled(t *testing.T) {
	opts := options{config: filepath.Join(t.TempDir(), "config.json")}
	control, err := newPanelRuntime(opts)
	if err != nil {
		t.Fatal(err)
	}
	config := testPanelEditConfig()
	current, next := runtimeSelection{VPN: true, Profile: "relay"}, runtimeSelection{VPN: true, Profile: "wire"}
	control.publish(current, runtimeSettings{})
	control.resumeVPNHealth(current)
	control.refreshVPNHealth(context.Background())
	if got := control.snapshot(config).VPN.Health; got == nil || got.Status != "unavailable" || got.CheckedAt.IsZero() {
		t.Fatal("missing unavailable result")
	}
	probeCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	control.healthCancel = cancel
	control.suspendVPNHealth()
	if probeCtx.Err() == nil || control.snapshot(config).VPN.Health != nil {
		t.Fatal("transition failed to clear and cancel stale verification")
	}
	control.resumeVPNHealth(next)
	control.refreshVPNHealth(context.Background())
	if control.snapshot(config).VPN.Health != nil {
		t.Fatal("new outbound result was assigned to the old profile")
	}
	control.publish(next, runtimeSettings{})
	control.refreshVPNHealth(context.Background())
	if got := control.snapshot(config).VPN; got.Profile != next.Profile || got.Health == nil {
		t.Fatal("newly published profile was not checked")
	}
	control.publish(runtimeSelection{Profile: next.Profile}, runtimeSettings{})
	if control.snapshot(config).VPN.Health != nil {
		t.Fatal("disabled VPN leaked a previous health value")
	}
}
