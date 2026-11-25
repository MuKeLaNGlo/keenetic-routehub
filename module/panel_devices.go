package main

import (
	"context"
	"net/http"
	"net/netip"

	"routehub/devicepolicy"
)

func routerBindings(ctx context.Context) []devicepolicy.Binding {
	neighbors, _ := devicepolicy.ReadKeeneticInventory(ctx)
	bindings := make([]devicepolicy.Binding, 0, len(neighbors))
	for _, neighbor := range neighbors {
		bindings = append(bindings, devicepolicy.Binding{MAC: neighbor.MAC, Address: neighbor.Address, Fixed: neighbor.Fixed})
	}
	return bindings
}

func (editor *panelEditor) deviceList(lan bool, segment netip.Prefix) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		active := editor.current().plan
		policy, err := active.policy(lan)
		if err != nil {
			sendJSON(response, http.StatusInternalServerError, object{"error": "Не удалось прочитать правила устройств"})
			return
		}
		list := make([]devicepolicy.Neighbor, 0)
		network := segment
		if active.Transparent != nil {
			network = netip.MustParsePrefix(active.Transparent.Source)
		}
		if !network.Addr().IsLoopback() {
			neighbors, err := devicepolicy.ReadKeeneticInventory(request.Context())
			if err != nil {
				sendJSON(response, http.StatusServiceUnavailable, object{"error": "Список устройств Keenetic недоступен"})
				return
			}
			for _, neighbor := range neighbors {
				address, err := netip.ParseAddr(neighbor.Address)
				if err == nil && network.Contains(address) && neighbor.Address != active.PanelHost {
					list = append(list, neighbor)
				}
			}
		}
		sendJSON(response, http.StatusOK, object{"configured": policy.Devices(), "neighbors": list})
	}
}
