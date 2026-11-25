package main

import (
	"fmt"
	"maps"
	"net/netip"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"routehub/devicepolicy"
)

const (
	maxGamePresets    = 24
	maxGameDevices    = 16
	maxGameSignatures = 32
)

type gameScope struct {
	SegmentIDs []string `json:"segmentIds"`
	DeviceIDs  []string `json:"deviceIds"`
}

type gameAction struct {
	Kind     string `json:"kind"`
	UplinkID string `json:"uplinkId,omitempty"`
}

type gameSignature struct {
	Destination string `json:"destination"`
	Protocol    string `json:"protocol"`
	Port        uint16 `json:"port"`
	Category    string `json:"category"`
}

type gamePreset struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	SignatureSources []string        `json:"signatureSources"`
	Version          string          `json:"version"`
	Confidence       string          `json:"confidence"`
	Families         []string        `json:"families"`
	Scenarios        []string        `json:"scenarios"`
	Exclusions       []string        `json:"exclusions"`
	Enabled          bool            `json:"enabled"`
	Scope            gameScope       `json:"scope"`
	RouteAction      gameAction      `json:"routeAction"`
	Priority         string          `json:"priority"`
	Signatures       []gameSignature `json:"signatures"`
}

type gameEndpoint struct {
	destination netip.AddrPort
	protocol    string
}

type gameFlowKey struct {
	deviceID string
	endpoint gameEndpoint
}

type gameFlowMatch struct {
	PresetID string `json:"presetId"`
	Name     string `json:"name"`
	Category string `json:"category"`
}

var gamePresetID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func copyGamePresets(presets []gamePreset) []gamePreset {
	presets = slices.Clone(presets)
	for i := range presets {
		preset := &presets[i]
		preset.SignatureSources = slices.Clone(preset.SignatureSources)
		preset.Families = slices.Clone(preset.Families)
		preset.Scenarios = slices.Clone(preset.Scenarios)
		preset.Exclusions = slices.Clone(preset.Exclusions)
		preset.Scope.SegmentIDs = slices.Clone(preset.Scope.SegmentIDs)
		preset.Scope.DeviceIDs = slices.Clone(preset.Scope.DeviceIDs)
		preset.Signatures = slices.Clone(preset.Signatures)
	}
	return presets
}

func normalizeGamePresets(presets []gamePreset) ([]gamePreset, error) {
	if len(presets) > maxGamePresets {
		return nil, fmt.Errorf("можно сохранить до %d игровых пресетов", maxGamePresets)
	}
	presets = copyGamePresets(presets)
	ids := make(map[string]bool, len(presets))
	enabled := make(map[gameFlowKey]string)
	for index := range presets {
		preset := &presets[index]
		if !gamePresetID.MatchString(preset.ID) || ids[preset.ID] {
			return nil, fmt.Errorf("проверьте идентификатор игрового пресета №%d", index+1)
		}
		ids[preset.ID] = true
		name, err := profileMetadata(preset.Name)
		if err != nil || name == "" || utf8.RuneCountInString(name) > 80 {
			return nil, fmt.Errorf("название игрового пресета должно содержать от 1 до 80 символов")
		}
		preset.Name = name
		if err := normalizeGamePreset(preset); err != nil {
			return nil, fmt.Errorf("игровой пресет %q: %w", name, err)
		}
		if !preset.Enabled {
			continue
		}
		for _, signature := range preset.Signatures {
			for _, mac := range preset.Scope.DeviceIDs {
				key := gameFlowKey{deviceID: mac, endpoint: signature.endpoint()}
				if previous, exists := enabled[key]; exists {
					return nil, fmt.Errorf("в пресетах %q и %q совпадают сигнатура и устройство", previous, name)
				}
				enabled[key] = name
			}
		}
	}
	return presets, nil
}

func normalizeGamePreset(preset *gamePreset) error {
	if len(preset.Scope.SegmentIDs) != 0 || len(preset.Scope.DeviceIDs) == 0 || len(preset.Scope.DeviceIDs) > maxGameDevices {
		return fmt.Errorf("выберите от 1 до %d отдельных устройств", maxGameDevices)
	}
	devices := make(map[string]bool, len(preset.Scope.DeviceIDs))
	for index, raw := range preset.Scope.DeviceIDs {
		mac, err := devicepolicy.NormalizeMAC(raw)
		if err != nil || devices[mac] {
			return fmt.Errorf("проверьте MAC-адреса устройств и повторения")
		}
		devices[mac] = true
		preset.Scope.DeviceIDs[index] = mac
	}
	switch {
	case preset.RouteAction.Kind == "inherit" && preset.RouteAction.UplinkID == "":
	case preset.RouteAction.Kind == "direct" && preset.RouteAction.UplinkID == "isp-main":
	default:
		return fmt.Errorf("выберите обычную политику или прямой маршрут через основной WAN")
	}
	if preset.Priority != "off" {
		return fmt.Errorf("изменение приоритета игр пока недоступно")
	}
	if len(preset.Signatures) == 0 || len(preset.Signatures) > maxGameSignatures {
		return fmt.Errorf("задайте от 1 до %d сигнатур назначения", maxGameSignatures)
	}

	endpoints := make(map[gameEndpoint]bool, len(preset.Signatures))
	categories := make([]string, 0, 2)
	for index := range preset.Signatures {
		signature := &preset.Signatures[index]
		signature.Destination = strings.TrimSpace(signature.Destination)
		endpoint := signature.endpoint()
		if !validGameAddress(endpoint.destination.Addr()) || signature.Port == 0 ||
			(signature.Protocol != "tcp" && signature.Protocol != "udp") ||
			(signature.Category != "match" && signature.Category != "voice") {
			return fmt.Errorf("сигнатура №%d требует внешний IPv4, один порт, TCP или UDP и категорию «матч» или «голос»", index+1)
		}
		if endpoints[endpoint] {
			return fmt.Errorf("сигнатура №%d повторяет назначение, транспорт и порт", index+1)
		}
		endpoints[endpoint] = true
		if !slices.Contains(categories, signature.Category) {
			categories = append(categories, signature.Category)
		}
	}
	// These fields describe the exact user-supplied selector, not DPI or a
	// provider-verified catalogue. Scope and signatures drive the actual policy.
	preset.Scope.SegmentIDs = []string{}
	preset.SignatureSources = []string{"Точные назначения, заданные вручную"}
	preset.Version = "1"
	preset.Confidence = "high"
	preset.Families = []string{"v4"}
	preset.Scenarios = categories
	preset.Exclusions = []string{}
	return nil
}

func (signature gameSignature) endpoint() gameEndpoint {
	address, _ := netip.ParseAddr(signature.Destination)
	return gameEndpoint{destination: netip.AddrPortFrom(address, signature.Port), protocol: signature.Protocol}
}

var sharedCarrierAddresses = netip.MustParsePrefix("100.64.0.0/10")

func validGameAddress(address netip.Addr) bool {
	return address.Is4() && address.IsGlobalUnicast() && !address.IsPrivate() &&
		!sharedCarrierAddresses.Contains(address) && address.As4()[0] < 224 && address.As4()[0] != 0
}

func (config plan) gameRoutes() map[string][]devicepolicy.GameRoute {
	routes := make(map[string][]devicepolicy.GameRoute)
	for _, preset := range config.Games {
		if !preset.Enabled || preset.RouteAction.Kind != "direct" {
			continue
		}
		for _, signature := range preset.Signatures {
			if signature.Protocol != "tcp" {
				continue
			}
			endpoint := signature.endpoint()
			for _, mac := range preset.Scope.DeviceIDs {
				routes[mac] = append(routes[mac], devicepolicy.GameRoute{
					PresetID: preset.ID, Name: preset.Name, Destination: endpoint.destination,
				})
			}
		}
	}
	return routes
}

func gameObservationIndex(presets []gamePreset) map[gameFlowKey]gameFlowMatch {
	index := make(map[gameFlowKey]gameFlowMatch)
	for _, preset := range presets {
		if !preset.Enabled {
			continue
		}
		for _, signature := range preset.Signatures {
			for _, mac := range preset.Scope.DeviceIDs {
				key := gameFlowKey{deviceID: mac, endpoint: signature.endpoint()}
				index[key] = gameFlowMatch{PresetID: preset.ID, Name: preset.Name, Category: signature.Category}
			}
		}
	}
	return index
}

// Game labels and observation-only signatures do not change Xray's routing.
// Save them without interrupting existing sessions.
func gameMetadataOnly(before, after plan, lan bool) bool {
	previous, next := before.Games, after.Games
	if reflect.DeepEqual(previous, next) {
		return false
	}
	before.Games, after.Games = nil, nil
	if !reflect.DeepEqual(before, after) {
		return false
	}
	if !lan {
		return true
	}
	compiled, err := before.policy(true)
	if err != nil {
		return false
	}
	eligible := make(map[string]bool)
	for _, device := range compiled.Devices() {
		eligible[device.MAC] = device.GameRouteEligible
	}
	tcpExceptions := func(presets []gamePreset) map[gameFlowKey]bool {
		config := plan{Games: presets}
		assignments := make(map[gameFlowKey]bool)
		for mac, routes := range config.gameRoutes() {
			if !eligible[mac] {
				continue
			}
			for _, route := range routes {
				key := gameFlowKey{deviceID: mac, endpoint: gameEndpoint{destination: route.Destination, protocol: "tcp"}}
				assignments[key] = true
			}
		}
		return assignments
	}
	return maps.Equal(tcpExceptions(previous), tcpExceptions(next))
}
