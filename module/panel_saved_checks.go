package main

import (
	"fmt"
	"net/http"
	"net/netip"
	"reflect"
	"slices"
	"strings"

	"routehub/devicepolicy"
)

const maxSavedChecks = 64

type panelRouteSource struct {
	Type      string `json:"type"`
	DeviceID  string `json:"deviceId,omitempty"`
	SegmentID string `json:"segmentId,omitempty"`
}

type savedCheck struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Source   panelRouteSource `json:"source"`
	Target   string           `json:"target"`
	Family   string           `json:"family"`
	Proto    string           `json:"proto"`
	Port     uint16           `json:"port"`
	Expect   string           `json:"expect"`
	Required bool             `json:"required"`
}

func normalizeSavedChecks(input []savedCheck) ([]savedCheck, error) {
	if len(input) > maxSavedChecks {
		return nil, fmt.Errorf("можно сохранить до %d проверок маршрута", maxSavedChecks)
	}
	checks := slices.Clone(input)
	seen := make(map[string]bool, len(checks))
	for i, check := range checks {
		if !validSavedCheckID(check.ID) || seen[check.ID] {
			return nil, fmt.Errorf("проверьте идентификатор сохранённой проверки №%d", i+1)
		}
		seen[check.ID] = true
		var err error
		check.Name, err = profileMetadata(check.Name)
		if err != nil || check.Name == "" {
			return nil, fmt.Errorf("проверьте название сохранённой проверки №%d", i+1)
		}
		check.Source, err = normalizeSavedCheckSource(check.Source)
		if err != nil {
			return nil, fmt.Errorf("проверьте источник сохранённой проверки №%d", i+1)
		}
		check.Target = normalizeHost(check.Target)
		if !validSavedCheckTarget(check.Target, check.Family) || (check.Proto != "tcp" && check.Proto != "udp") || check.Port == 0 {
			return nil, fmt.Errorf("проверьте адрес, семейство IP, протокол и порт сохранённой проверки №%d", i+1)
		}
		switch check.Expect {
		case "direct", "vpn", "zapret", "block", "keenetic":
		default:
			return nil, fmt.Errorf("проверьте ожидаемый выход сохранённой проверки №%d", i+1)
		}
		checks[i] = check
	}
	return checks, nil
}

func validSavedCheckID(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, char := range value {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-", char) {
			return false
		}
	}
	return true
}

func normalizeSavedCheckSource(source panelRouteSource) (panelRouteSource, error) {
	switch source.Type {
	case "device":
		if source.SegmentID == "" {
			mac, err := devicepolicy.NormalizeMAC(source.DeviceID)
			source.DeviceID = mac
			return source, err
		}
	case "segment":
		if source.DeviceID == "" && interfaceName(source.SegmentID) {
			return source, nil
		}
	}
	return source, fmt.Errorf("укажите устройство или сегмент")
}

func validSavedCheckTarget(target, family string) bool {
	if family != "v4" && family != "v6" {
		return false
	}
	if address, err := netip.ParseAddr(target); err == nil {
		return address.Zone() == "" && address.Unmap().Is4() == (family == "v4")
	}
	return validDomain(target)
}

type savedCheckComparison struct {
	ID       string `json:"checkId"`
	Name     string `json:"name"`
	Required bool   `json:"required"`
	Live     string `json:"live"`
	Draft    string `json:"draft"`
	OK       bool   `json:"ok"`
	Message  string `json:"message"`
}

func (editor *panelEditor) savedCheckResults(w http.ResponseWriter, _ *http.Request) {
	active := editor.current().plan
	checks, _ := editor.compareSavedChecks(active, active)
	sendJSON(w, http.StatusOK, checks)
}

func (editor *panelEditor) compareSavedChecks(active, next plan) ([]savedCheckComparison, []string) {
	comparisons := make([]savedCheckComparison, 0, len(next.SavedChecks))
	failures := []string{}
	if len(next.SavedChecks) == 0 {
		return comparisons, failures
	}
	before, beforeErr := active.policy(editor.refreshBindings)
	after, afterErr := next.policy(editor.refreshBindings)
	for _, check := range next.SavedChecks {
		liveResult, liveMessage := evaluateSavedCheck(active, before, beforeErr, editor.refreshBindings, check)
		draftResult, draftMessage := evaluateSavedCheck(next, after, afterErr, editor.refreshBindings, check)
		row := savedCheckComparison{ID: check.ID, Name: check.Name, Required: check.Required,
			Live: liveMessage, Draft: draftMessage, OK: draftResult == check.Expect}
		if liveResult == "unknown" {
			row.Live = "Недоступно · " + row.Live
		}
		if draftResult == "unknown" {
			row.Draft = "Недоступно · " + row.Draft
		}
		if row.OK {
			row.Message = "Расчёт черновика соответствует ожиданию."
		} else {
			row.Message = "Ожидается «" + checkActionLabel(check.Expect) + "»."
			if check.Required {
				failures = append(failures, fmt.Sprintf("Обязательная проверка «%s»: %s Черновик · %s.", check.Name, row.Message, row.Draft))
			}
		}
		comparisons = append(comparisons, row)
	}
	return comparisons, failures
}

func evaluateSavedCheck(config plan, policy devicepolicy.Plan, policyErr error, lan bool, check savedCheck) (string, string) {
	if policyErr != nil {
		return "unknown", "ошибка чтения политики"
	}
	if !lan || config.Transparent == nil {
		return "unknown", "перехват сегмента выключен"
	}
	if check.Family != "v4" || (check.Proto == "udp" && config.Transparent.Mode == transparentRedirectTCP) {
		return "unknown", "текущий режим не перехватывает этот протокол и семейство IP"
	}
	input := destination{Host: check.Target, Network: check.Proto, Port: check.Port}
	if check.Source.Type == "segment" {
		if check.Source.SegmentID != config.Transparent.Interface {
			return "keenetic", checkActionLabel("keenetic")
		}
	} else {
		prefix, err := netip.ParsePrefix(config.Transparent.Source)
		if err != nil || !slices.ContainsFunc(config.bindings, func(binding devicepolicy.Binding) bool {
			ip, err := netip.ParseAddr(binding.Address)
			return err == nil && binding.MAC == check.Source.DeviceID && prefix.Contains(ip)
		}) {
			return "unknown", "инвентарь Keenetic не подтвердил устройство в перехватываемом сегменте"
		}
		input.ClientMAC = check.Source.DeviceID
	}
	decision, err := policy.Evaluate(input)
	if err != nil {
		return "unknown", "ошибка расчёта маршрута"
	}
	action := decision.Target
	switch action {
	case "@block":
		action = "block"
	case "direct", "zapret":
	default:
		action = "vpn"
	}
	return action, checkActionLabel(action)
}

func checkActionLabel(kind string) string {
	switch kind {
	case "direct":
		return "Напрямую"
	case "vpn":
		return "VPN"
	case "zapret":
		return "Zapret"
	case "block":
		return "Блокировка"
	case "keenetic":
		return "Маршрутизация KeeneticOS"
	default:
		return kind
	}
}

func checksOnlyChange(before, next plan) bool {
	if slices.Equal(before.SavedChecks, next.SavedChecks) {
		return false
	}
	before.SavedChecks, next.SavedChecks = nil, nil
	return reflect.DeepEqual(before, next)
}
