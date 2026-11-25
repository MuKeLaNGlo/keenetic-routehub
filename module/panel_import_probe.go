package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

var (
	errImportProbeUnsupported = errors.New("Для проверки нужен самостоятельный профиль VLESS")
)

func pinnedVLESSProbe(entry profile, address netip.Addr) (profile, error) {
	if !isZapretPublicIPv4(address.Unmap()) {
		return profile{}, errors.New("Проверка принимает только публичный IPv4")
	}
	outbound, err := profileOutbound(entry)
	if err != nil {
		return profile{}, err
	}
	settings, ok := outbound["settings"].(object)
	if !ok {
		return profile{}, errImportProbeUnsupported
	}
	server := settings
	if upstreams, ok := settings["vnext"].([]any); ok {
		if len(upstreams) != 1 {
			return profile{}, errImportProbeUnsupported
		}
		server, ok = upstreams[0].(object)
		if !ok {
			return profile{}, errImportProbeUnsupported
		}
	}
	hostname, ok := server["address"].(string)
	if !ok || hostname == "" {
		return profile{}, errImportProbeUnsupported
	}
	server["address"] = address.Unmap().String()
	if stream, ok := outbound["streamSettings"].(object); ok {
		preserveXrayTransportAuthority(stream, hostname, server["port"])
		if stream["security"] == "tls" {
			tls, ok := stream["tlsSettings"].(object)
			if !ok {
				tls = object{}
				stream["tlsSettings"] = tls
			}
			if name, _ := tls["serverName"].(string); name == "" {
				tls["serverName"] = hostname
			}
		}
	}
	data, err := json.Marshal(outbound)
	if err != nil {
		return profile{}, err
	}
	entry.URI, entry.Outbound = "", data
	return entry, nil
}

func (control *panelRuntime) probeUnstoredVLESS(ctx context.Context, entry profile) (profileLatencyResult, error) {
	executableSubscription := entry.XrayGroup != nil || subscriptionHysteriaProfile(entry)
	if !executableSubscription && (entry.Protocol != "vless" || entry.URI == "" && !safeSubscriptionXrayOutbound(entry.Outbound)) {
		return profileLatencyResult{}, errImportProbeUnsupported
	}
	release, err := control.acquireProfileProbe()
	if err != nil {
		return profileLatencyResult{}, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if executableSubscription {
		return profileLatency(ctx, control.opts, entry), nil
	}
	host, _, err := net.SplitHostPort(profileServer(entry))
	if err != nil {
		return profileLatencyResult{}, errImportProbeUnsupported
	}
	resolve, stopResolving := context.WithTimeout(ctx, 3*time.Second)
	address, _, err := resolvePublicProbeIPv4(resolve, host, "")
	stopResolving()
	if err != nil {
		return profileLatencyResult{Profile: entry.ID, Status: "unavailable", Message: err.Error()}, nil
	}
	pinned, err := pinnedVLESSProbe(entry, address)
	if err != nil {
		return profileLatencyResult{}, err
	}
	return profileLatency(ctx, control.opts, pinned), nil
}

func (control *panelRuntime) checkImportedVLESS(editor *panelEditor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !editor.authorized(r) {
			sendJSON(w, http.StatusForbidden, object{"error": "Доступ к проверке VPN запрещён"})
			return
		}
		var input struct {
			URI      string          `json:"uri"`
			Outbound json.RawMessage `json:"outbound"`
		}
		if err := decodeJSON(http.MaxBytesReader(w, r.Body, 32<<10), &input); err != nil {
			sendJSON(w, http.StatusBadRequest, object{"error": "Некорректный профиль VLESS"})
			return
		}
		entry := profile{ID: "preview-vless", Protocol: "vless", URI: strings.TrimSpace(input.URI), Outbound: input.Outbound}
		if entry.URI != "" && len(entry.Outbound) > 0 {
			sendJSON(w, http.StatusBadRequest, object{"error": errImportProbeUnsupported.Error()})
			return
		}
		if entry.URI == "" {
			if _, ok := subscriptionJSONServer(entry.Outbound); !ok || !safeSubscriptionXrayOutbound(entry.Outbound) {
				sendJSON(w, http.StatusBadRequest, object{"error": errImportProbeUnsupported.Error()})
				return
			}
		}
		if _, err := profileOutbound(entry); err != nil {
			sendJSON(w, http.StatusBadRequest, object{"error": "Некорректная ссылка VLESS"})
			return
		}
		result, err := control.probeUnstoredVLESS(r.Context(), entry)
		if errors.Is(err, errProfileProbeBusy) {
			sendProfileProbeBusy(w)
			return
		}
		if err != nil {
			sendJSON(w, http.StatusUnprocessableEntity, object{"error": "Не удалось подготовить проверку VLESS"})
			return
		}
		sendJSON(w, http.StatusOK, result)
	}
}
