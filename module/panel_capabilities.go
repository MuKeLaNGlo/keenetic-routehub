package main

import (
	"net/http"
	"os"
	"runtime"
	"strings"
)

func availability(available bool, reason string) object {
	value := object{"available": available}
	if !available {
		value["reason"] = reason
	}
	return value
}

func coverageCell(supported bool, note string) object {
	state := "unsupported"
	if supported {
		state = "configured"
	}
	return object{"state": state, "note": note}
}

func (editor *panelEditor) capabilities(state status, control *panelRuntime, dns *panelDNS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		canWrite := editor.editable() && editor.panelReadAuthorized(r)
		access := "read"
		if canWrite {
			access = "write"
		}
		lan := state.LAN && state.LANMode != ""
		udp := lan && state.LANMode == "tproxy"
		mode, label := "socks", "Локальный SOCKS"
		if state.LANMode == transparentRedirectTCP {
			mode, label = state.LANMode, "TCP REDIRECT"
		} else if udp {
			mode, label = state.LANMode, "TPROXY"
		}
		model := "Keenetic"
		if data, err := os.ReadFile("/proc/device-tree/model"); err == nil {
			if value := strings.Trim(strings.TrimSpace(string(data)), "\x00"); value != "" {
				model = value
			}
		}
		config := editor.current().plan
		zapret := control != nil && control.snapshot(config).Zapret.Available
		probeConcurrency := 0
		if control != nil {
			probeConcurrency = control.profileProbeLimit()
		}
		knownDevice := availability(lan, "Нужен действующий перехват LAN и закреплённый IPv4-адрес клиента")
		ipv6 := availability(false, "Перехват клиентов поддерживает IPv4")
		uplinks := []object{{"id": "isp-main", "name": "Подключение по умолчанию", "iface": ""}}
		sendJSON(w, http.StatusOK, object{
			"access":                  access,
			"profileProbeConcurrency": probeConcurrency,
			"device":                  object{"model": model, "name": model, "firmware": "—", "arch": runtime.GOARCH, "entware": "—"},
			"routehub":                object{"version": state.Version, "build": "embedded"},
			"interception": object{
				"mode": mode, "label": label, "notes": []string{"Модуль управляет одной настроенной IPv4-подсетью"},
				"coverage": object{
					"v4tcp": coverageCell(lan, "Зависит от настроенной подсети и правил перехвата"),
					"v4udp": coverageCell(udp, "Перехват UDP доступен в режиме TPROXY"),
					"v6tcp": coverageCell(false, "Перехват IPv6 не реализован"),
					"v6udp": coverageCell(false, "Перехват IPv6 не реализован"),
				},
			},
			"actions": object{
				"keenetic": availability(false, "Выбор отдельной политики Keenetic недоступен"),
				"direct":   availability(true, ""), "vpn": availability(control != nil, "Управление VPN недоступно"),
				"zapret": availability(zapret, "Zapret не установлен или недоступен в текущем режиме"),
				"block":  availability(true, ""), "inherit": availability(true, ""),
			},
			"perSsidPolicy": availability(false, "Перехват не различает SSID"),
			"perDeviceDns":  availability(false, "Резолвер использует единую политику DNS"),
			"zapret":        availability(zapret, "Zapret не установлен или недоступен в текущем режиме"),
			"gameRouting": object{
				"routeAtOpen":        availability(lan, "Для прямого маршрута новых TCP-соединений нужен действующий перехват LAN"),
				"udpRouteAtOpen":     availability(false, "UDP-сигнатуры доступны для наблюдения"),
				"lateSignalPriority": availability(false, "Наблюдение Netfilter показывает совпадения и не управляет открытыми соединениями"),
				"intelliQos":         availability(false, "Категорийный приоритет настраивается в KeeneticOS"),
				"strictPriority":     availability(false, "Управление сетевым приоритетом отдельных потоков недоступно"),
			},
			"ipv6":            ipv6,
			"trialApply":      availability(false, "Пробный запуск требует изолированного перехвата для клиента"),
			"liveObservation": availability(observationAvailable(state, config), "Для наблюдения нужны активная IPv4-подсеть RouteHub и доступ к таблице соединений Netfilter"),
			"ispUplinks":      uplinks,
			"features": object{
				"segments":        availability(false, "Модуль управляет только настроенной сетью"),
				"devices":         knownDevice,
				"deviceGroups":    availability(false, "Группы устройств пока не поддерживаются"),
				"namedSets":       availability(true, ""),
				"activeVpnHealth": availability(control != nil && control.opts.vpnHealth != nil, "Локальный канал проверки VPN недоступен"),
				"gamePresets":     availability(true, ""),
				"subscriptions":   availability(true, ""),
				"exitGroups":      availability(false, "Автоматический выбор и резервирование выходов пока недоступны"),
				"engineSelection": availability(false, "Ядро определяется типом профиля и установкой модуля"),
				"updates":         availability(control != nil && control.cores.supported(), "Обновление Xray доступно для установленного ядра Linux ARM64"),
				"savedChecks":     availability(lan, "Для проверок маршрутов нужен перехват LAN"),
				"dnsVpn":          availability(false, "DNS-серверы текущего резолвера доступны напрямую"),
				"dnsLAN":          availability(dns != nil && dns.lanCommand != nil, "Подключение LAN к резолверу недоступно"),
				"bootSettings":    availability(control != nil, "Управление автозапуском недоступно"),
				"profileMetadata": availability(true, ""),
				"profilePause":    availability(false, "Пауза и отключение отдельного профиля пока недоступны"),
				"backup":          availability(canWrite, "Войдите с правом изменения настроек"),
				"realTest":        availability(true, ""),
				"revisions":       availability(editor.history != "", "Хранилище ревизий недоступно"),
			},
		})
	}
}
