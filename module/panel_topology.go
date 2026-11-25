package main

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"routehub/devicepolicy"
)

type panelNetworkSegment struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Interface string   `json:"iface"`
	Kind      string   `json:"kind"`
	VLAN      int      `json:"vlan,omitempty"`
	IPv4      []string `json:"v4"`
	IPv6      []string `json:"v6"`
	SSIDIDs   []string `json:"ssidIds"`
	State     string   `json:"state"`
	Routable  object   `json:"routable"`
	Isolation string   `json:"isolation"`
	addresses []netip.Addr
}

type panelDeviceAddress struct {
	Address   string `json:"addr"`
	Family    string `json:"family"`
	Source    string `json:"source"`
	Confirmed bool   `json:"confirmed"`
}

type panelTopologyDevice struct {
	ID              string               `json:"id"`
	MAC             string               `json:"mac"`
	Hostname        string               `json:"hostname"`
	Vendor          string               `json:"vendor"`
	Kind            string               `json:"kind"`
	SegmentID       string               `json:"segmentId"`
	Addresses       []panelDeviceAddress `json:"addresses"`
	Binding         string               `json:"binding"`
	BindingNote     string               `json:"bindingNote,omitempty"`
	Online          bool                 `json:"online"`
	ConnectionKnown bool                 `json:"connectionKnown"`
	LastSeen        time.Time            `json:"lastSeen"`
}

type panelTopologySnapshot struct {
	Segments  []panelNetworkSegment `json:"segments"`
	SSIDs     []object              `json:"ssids"`
	Devices   []panelTopologyDevice `json:"devices"`
	FetchedAt time.Time             `json:"fetchedAt"`
}

func (diagnostics *panelDiagnostics) readTopology(response http.ResponseWriter, request *http.Request) {
	sendJSON(response, http.StatusOK, diagnostics.topologySnapshot(request.Context()))
}

func (diagnostics *panelDiagnostics) topologySnapshot(ctx context.Context) panelTopologySnapshot {
	diagnostics.topologyMu.Lock()
	defer diagnostics.topologyMu.Unlock()
	if time.Since(diagnostics.topology.FetchedAt) < 5*time.Second {
		return diagnostics.topology
	}
	config := diagnostics.editor.current().plan
	var reported []devicepolicy.KeeneticSegment
	var kernel []panelNetworkSegment
	var neighbors []devicepolicy.Neighbor
	if _, err := os.Stat("/bin/ndmc"); err == nil {
		reported, _ = devicepolicy.ReadKeeneticSegments(ctx)
		kernel = kernelLANNetworks()
		neighbors, _ = devicepolicy.ReadKeeneticInventory(ctx)
	}
	fetched := time.Now().UTC()
	segments := panelNetworkSegments(config, diagnostics.state.LAN, reported, kernel)
	devices := panelTopologyDevices(neighbors, segments, fetched)
	snapshot := panelTopologySnapshot{Segments: segments, SSIDs: []object{}, Devices: devices, FetchedAt: fetched}
	if ctx.Err() == nil {
		diagnostics.topology = snapshot
	}
	return snapshot
}

func newNetworkSegment(iface, kind, state string) panelNetworkSegment {
	return panelNetworkSegment{ID: iface, Name: iface, Interface: iface, Kind: kind, State: state,
		IPv4: []string{}, IPv6: []string{}, SSIDIDs: []string{},
		Routable:  object{"available": false, "reason": "Сегмент находится вне действующего перехвата RouteHub."},
		Isolation: "Изоляция по правилам KeeneticOS"}
}

func kernelLANNetworks() []panelNetworkSegment {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var wan string
	if routes, err := os.Open("/proc/net/route"); err == nil {
		wan = defaultWAN(routes)
		_ = routes.Close()
	}
	var segments []panelNetworkSegment
	for _, iface := range interfaces {
		if iface.Name == wan || iface.Flags&net.FlagLoopback != 0 || !interfaceName(iface.Name) {
			continue
		}
		kind := "l3"
		var vlan int
		if _, err := os.Stat(filepath.Join("/sys/class/net", iface.Name, "bridge")); err == nil {
			kind = "bridge"
		} else if data, err := os.ReadFile(filepath.Join("/proc/net/vlan", iface.Name)); err == nil {
			_, field, present := strings.Cut(string(data), "VID:")
			if parts := strings.Fields(field); present && len(parts) > 0 {
				vlan, _ = strconv.Atoi(parts[0])
			}
		} else {
			continue
		}
		state := "down"
		if iface.Flags&net.FlagUp != 0 {
			state = "up"
		}
		segment := newNetworkSegment(iface.Name, kind, state)
		segment.VLAN = vlan
		addresses, _ := iface.Addrs()
		for _, raw := range addresses {
			prefix, err := netip.ParsePrefix(raw.String())
			if err != nil || !prefix.Addr().IsGlobalUnicast() {
				continue
			}
			segment.addresses = append(segment.addresses, prefix.Addr())
			if prefix.Addr().Is4() {
				segment.IPv4 = append(segment.IPv4, prefix.Masked().String())
			} else {
				segment.IPv6 = append(segment.IPv6, prefix.Masked().String())
			}
		}
		// The NDM inventory validates L3 VLANs. Kernel-only fallback is limited
		// to bridges, since additional WAN VLANs may not be the default route.
		segments = append(segments, segment)
	}
	return segments
}

func panelNetworkSegments(config plan, captured bool, reported []devicepolicy.KeeneticSegment, kernel []panelNetworkSegment) []panelNetworkSegment {
	segments := make([]panelNetworkSegment, 0, len(reported)+1)
	used := map[string]bool{}
	for _, info := range reported {
		segment := newNetworkSegment(info.ID, info.Kind, info.State)
		segment.Interface = ""
		for _, iface := range kernel {
			if info.SystemName != "" && iface.Interface == info.SystemName || info.Address.IsValid() && slices.Contains(iface.addresses, info.Address) {
				segment = iface
				segment.State, segment.Kind = info.State, info.Kind
				break
			}
		}
		if info.Kind == "l3" && segment.Interface == "" {
			continue
		}
		if info.Name != "" {
			segment.Name = info.Name
		}
		if info.Security != "" {
			segment.Isolation = "Уровень доступа KeeneticOS: " + info.Security
		}
		if info.Prefix.IsValid() && !slices.Contains(segment.IPv4, info.Prefix.String()) {
			segment.IPv4 = append(segment.IPv4, info.Prefix.String())
			segment.addresses = append(segment.addresses, info.Address)
		}
		if used[segment.ID] {
			continue
		}
		segments, used[segment.ID] = append(segments, segment), true
	}
	for _, iface := range kernel {
		if iface.Kind == "bridge" && !used[iface.ID] && (len(iface.IPv4) != 0 || len(iface.IPv6) != 0) {
			segments, used[iface.ID] = append(segments, iface), true
		}
	}
	if lan := config.Transparent; lan != nil {
		index := slices.IndexFunc(segments, func(segment panelNetworkSegment) bool { return segment.Interface == lan.Interface })
		if index == -1 {
			index = slices.IndexFunc(segments, func(segment panelNetworkSegment) bool {
				return segment.Interface == "" && slices.Contains(segment.IPv4, lan.Source)
			})
		}
		if index == -1 {
			index = len(segments)
			state := "down"
			if captured {
				state = "up"
			}
			segments = append(segments, newNetworkSegment(lan.Interface, "l3", state))
		}
		segment := &segments[index]
		segment.ID, segment.Interface = lan.Interface, lan.Interface
		if !slices.Contains(segment.IPv4, lan.Source) {
			segment.IPv4 = append(segment.IPv4, lan.Source)
		}
		if address, err := netip.ParseAddr(config.PanelHost); err == nil {
			segment.addresses = append(segment.addresses, address)
		}
		if captured {
			segment.Routable = object{"available": true}
		}
		segments[0], segments[index] = segments[index], segments[0]
	}
	return segments
}

func panelTopologyDevices(neighbors []devicepolicy.Neighbor, segments []panelNetworkSegment, fetched time.Time) []panelTopologyDevice {
	devices := make([]panelTopologyDevice, 0, len(neighbors))
	positions := make(map[string]int)
	for _, neighbor := range neighbors {
		ip, err := netip.ParseAddr(neighbor.Address)
		if err != nil {
			continue
		}
		segmentID, bestBits := "", -1
		var routerAddress bool
		for _, segment := range segments {
			routerAddress = routerAddress || slices.Contains(segment.addresses, ip)
			for _, raw := range segment.IPv4 {
				if prefix, err := netip.ParsePrefix(raw); err == nil && prefix.Contains(ip) {
					if prefix.Bits() > bestBits {
						segmentID, bestBits = segment.ID, prefix.Bits()
					} else if prefix.Bits() == bestBits && segmentID != segment.ID {
						segmentID = ""
					}
				}
			}
		}
		if routerAddress || segmentID == "" {
			continue
		}
		index, exists := positions[neighbor.MAC]
		if !exists {
			index = len(devices)
			positions[neighbor.MAC] = index
			hostname := neighbor.Label
			if hostname == "" {
				hostname = neighbor.MAC
			}
			devices = append(devices, panelTopologyDevice{ID: neighbor.MAC, MAC: neighbor.MAC, Hostname: hostname, Kind: "unknown",
				SegmentID: segmentID, Binding: "observed", LastSeen: fetched})
		}
		device := &devices[index]
		if segmentID != device.SegmentID {
			device.SegmentID = ""
			device.Binding, device.BindingNote = "ambiguous", "В инвентаре есть записи одного MAC из разных сегментов."
		}
		address := panelDeviceAddress{Address: neighbor.Address, Family: "v4", Source: "keenetic", Confirmed: neighbor.Fixed}
		if neighbor.Fixed {
			address.Source = "static"
			if device.Binding != "ambiguous" {
				device.Binding = "confirmed"
			}
		}
		device.Addresses = append(device.Addresses, address)
	}
	return devices
}
