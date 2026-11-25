package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"routehub/devicepolicy"
)

func TestTraceExplainsConfiguredAndEffectiveRoutes(t *testing.T) {
	const mac = "02:00:00:00:00:01"
	tests := []struct {
		name, deviceMode, scope, ruleName, configured, target, reason, clientReason string
		selection                                                                   runtimeSelection
		binding, active                                                             bool
	}{
		{"inherited-vpn-disabled", "inherit", "global", "by domain", "@vpn", "direct", "vpn-disabled", "", runtimeSelection{}, true, true},
		{"unconfirmed-binding", "inherit", "global", "by domain", "@vpn", "relay", "", "unverified-address", runtimeSelection{VPN: true, Profile: "relay"}, false, false},
		{"fixed-device-exit", "fixed", "device", "", "wire", "direct", "vpn-disabled", "", runtimeSelection{}, true, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := testPanelEditConfig()
			config.Rules = []rule{{Name: "by domain", Domain: "example.net", Target: "@vpn"}}
			device := devicepolicy.Device{MAC: mac, Mode: test.deviceMode, Addresses: []string{"192.168.1.25"}}
			if device.Mode == "fixed" {
				device.DefaultTarget = "wire"
			}
			config.Devices = []devicepolicy.Device{device}
			config.bindings = []devicepolicy.Binding{{MAC: mac, Address: "192.168.1.25", Fixed: test.binding}}
			control := &panelRuntime{selection: test.selection}
			editor := newPanelEditor(config, "", nil)
			request := httptest.NewRequest(http.MethodPost, "/api/evaluate", strings.NewReader(
				`{"host":"example.net","network":"tcp","port":443,"clientMAC":"02:00:00:00:00:01"}`))
			response := httptest.NewRecorder()
			editor.traceHandler(true, control)(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("unexpected trace status %d: %s", response.Code, response.Body)
			}
			var legacy decision
			if err := json.Unmarshal(response.Body.Bytes(), &legacy); err != nil || legacy.Scope != test.scope ||
				legacy.Target != test.target || legacy.Rule != test.ruleName {
				t.Fatalf("legacy fields lost: %#v, %v", legacy, err)
			}
			var explanation traceDecision
			if err := json.Unmarshal(response.Body.Bytes(), &explanation); err != nil {
				t.Fatal(err)
			}
			if explanation.ConfiguredTarget != test.configured || explanation.RuntimeReason != test.reason {
				t.Fatalf("incorrect runtime explanation: %#v", explanation)
			}
			if client := explanation.ClientPolicy; client == nil || client.Mode != test.deviceMode ||
				client.Reason != test.clientReason || client.Active != test.active {
				t.Fatalf("incorrect client explanation: %#v", client)
			}
		})
	}
}
