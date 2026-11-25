package main

import (
	"net/http"
	"slices"
	"strings"

	"routehub/devicepolicy"
)

type traceClientPolicy struct {
	Mode   string `json:"mode"`
	Active bool   `json:"active"`
	Reason string `json:"reason,omitempty"`
}

// Keep the legacy fields at the top level for API clients and the old panel.
type traceDecision struct {
	decision
	ConfiguredTarget string             `json:"configuredTarget"`
	RuntimeReason    string             `json:"runtimeReason,omitempty"`
	ClientPolicy     *traceClientPolicy `json:"clientPolicy,omitempty"`
}

func (editor *panelEditor) traceHandler(lan bool, control *panelRuntime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input destination
		if err := decodeJSON(http.MaxBytesReader(response, request.Body, 4096), &input); err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Некорректный запрос JSON"})
			return
		}
		config := editor.current().plan
		active := config
		var selection runtimeSelection
		if control != nil {
			selection, _ = control.state()
			active = runtimePlan(config, selection)
		}
		policy, err := active.policy(lan)
		if err != nil {
			sendJSON(response, http.StatusInternalServerError, object{"error": "Не удалось загрузить активную политику"})
			return
		}
		result, err := policy.Evaluate(input)
		if err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": err.Error()})
			return
		}
		configured := configuredTraceTarget(config, result)
		explained := traceDecision{decision: result, ConfiguredTarget: configured}
		if control != nil && result.Target == "direct" && configured != result.Target {
			switch {
			case configured == "zapret" && !selection.zapretEnabled():
				explained.RuntimeReason = "zapret-disabled"
			case configured != "zapret" && !selection.VPN:
				explained.RuntimeReason = "vpn-disabled"
			}
		}
		client := result.DeviceMAC
		if client == "" && input.ClientMAC != "" {
			client, _ = devicepolicy.NormalizeMAC(input.ClientMAC)
		}
		if client != "" {
			for _, status := range policy.Devices() {
				if status.MAC == client {
					explained.ClientPolicy = &traceClientPolicy{Mode: status.Mode, Active: status.Active, Reason: status.Reason}
					break
				}
			}
		}
		sendJSON(response, http.StatusOK, explained)
	}
}

func configuredTraceTarget(config plan, result decision) string {
	if result.GamePresetID != "" {
		return result.Target
	}
	rules, fallback := config.Rules, config.DefaultTarget
	if result.Scope == "device" {
		index := slices.IndexFunc(config.Devices, func(device devicepolicy.Device) bool {
			mac, _ := devicepolicy.NormalizeMAC(device.MAC)
			return mac == result.DeviceMAC
		})
		if index < 0 {
			return result.Target
		}
		device := config.Devices[index]
		rules, fallback = device.Rules, device.DefaultTarget
	}
	if result.Rule != "" {
		index := slices.IndexFunc(rules, func(rule rule) bool { return strings.TrimSpace(rule.Name) == result.Rule })
		if index < 0 {
			return result.Target
		}
		return rules[index].Target
	}
	if fallback != "" {
		return fallback
	}
	return result.Target
}
