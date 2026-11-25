package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"strings"

	"routehub/devicepolicy"
)

const maxPlanBytes = 4 << 20

type profile struct {
	ID                  string            `json:"id"`
	Protocol            string            `json:"protocol"`
	Label               string            `json:"label,omitempty"`
	Location            string            `json:"location,omitempty"`
	Server              string            `json:"server,omitempty"`
	URI                 string            `json:"uri,omitempty"`
	Outbound            json.RawMessage   `json:"outbound,omitempty"`
	XrayGroup           *xrayProfileGroup `json:"xrayPool,omitempty"`
	IsXrayGroup         bool              `json:"xrayGroup,omitempty"`
	GroupSize           int               `json:"groupSize,omitempty"`
	Interface           string            `json:"interface,omitempty"`
	AWGVersion          string            `json:"awgVersion,omitempty"`
	AWGConfig           string            `json:"awgConfig,omitempty"`
	AWGNative           bool              `json:"awgNative,omitempty"`
	SubscriptionID      string            `json:"subscriptionId,omitempty"`
	UpstreamKey         string            `json:"upstreamKey,omitempty"`
	UpstreamName        string            `json:"upstreamName,omitempty"`
	SubscriptionMissing bool              `json:"subscriptionMissing,omitempty"`
	CatalogProfile      bool              `json:"catalogProfile,omitempty"`
	awgPort             uint16
}

type rule = devicepolicy.Rule

type zapretServices struct {
	YouTube bool `json:"youtube"`
	Discord bool `json:"discord"`
}

type plan struct {
	PanelHost           string                  `json:"panelHost,omitempty"`
	PanelNetwork        string                  `json:"panelNetwork,omitempty"`
	PanelPort           uint16                  `json:"panelPort"`
	SOCKSPort           uint16                  `json:"socksPort"`
	Zapret              bool                    `json:"zapret"`
	Transparent         *transparent            `json:"transparent,omitempty"`
	Profiles            []profile               `json:"profiles"`
	Rules               []rule                  `json:"rules"`
	DefaultTarget       string                  `json:"defaultTarget,omitempty"`
	Devices             []devicepolicy.Device   `json:"devices,omitempty"`
	ZapretServices      *zapretServices         `json:"zapretServices,omitempty"`
	GeoSources          []geoSource             `json:"geoSources,omitempty"`
	NamedSets           []devicepolicy.NamedSet `json:"namedSets,omitempty"`
	Games               []gamePreset            `json:"games,omitempty"`
	SavedChecks         []savedCheck            `json:"savedChecks,omitempty"`
	Subscriptions       []subscription          `json:"subscriptions,omitempty"`
	bindings            []devicepolicy.Binding
	geoRoot             string
	geoAssets           map[string]geoAsset
	runtimeHealthTarget string
}

type transparent struct {
	Interface string `json:"interface"`
	Source    string `json:"source"`
	Port      uint16 `json:"port"`
	Mode      string `json:"mode,omitempty"`
}

const transparentRedirectTCP = "redirect-tcp"

type destination = devicepolicy.Destination
type decision = devicepolicy.Decision

func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
}

func validDomain(host string) bool {
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-') {
				return false
			}
		}
	}
	return true
}

func decodeJSON(reader io.Reader, value any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("ожидался один объект JSON")
	}
	return nil
}

func loadPlan(path string) (plan, error) {
	file, err := os.Open(path)
	if err != nil {
		return plan{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return plan{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxPlanBytes {
		return plan{}, errors.New("план должен быть обычным файлом размером не более 4 МиБ")
	}
	config := plan{PanelHost: "127.0.0.1", PanelPort: 18952, SOCKSPort: 18953}
	if err := decodeJSON(file, &config); err != nil {
		return plan{}, err
	}
	config.GeoSources, err = validateGeoSources(config.GeoSources)
	if err != nil {
		return plan{}, err
	}
	config.geoRoot = filepath.Join(filepath.Dir(path), "geoip")
	config.geoAssets = loadGeoAssets(config.geoRoot, config.GeoSources)
	return validatePlan(config)
}

func validatePlan(config plan) (plan, error) {
	if config.PanelHost == "" {
		config.PanelHost = "127.0.0.1"
	}
	if config.PanelPort == 0 || config.SOCKSPort == 0 || config.PanelPort == config.SOCKSPort {
		return plan{}, errors.New("панели и SOCKS нужны разные ненулевые порты")
	}
	host, err := netip.ParseAddr(config.PanelHost)
	if err != nil || !host.Is4() || !(host.IsLoopback() || host.IsPrivate()) {
		return plan{}, errors.New("panelHost должен быть loopback или частным адресом IPv4")
	}
	var panelNetwork netip.Prefix
	if host.IsPrivate() {
		panelNetwork, err = netip.ParsePrefix(config.PanelNetwork)
		if err != nil || panelNetwork != panelNetwork.Masked() || !panelNetwork.Addr().IsPrivate() || !panelNetwork.Contains(host) || panelNetwork.Bits() < 8 {
			return plan{}, errors.New("для LAN-панели укажите её частную подсеть panelNetwork")
		}
	}
	if lan := config.Transparent; lan != nil {
		source, err := netip.ParsePrefix(lan.Source)
		if err != nil || !source.Addr().Is4() || source != source.Masked() || source.Bits() < 8 ||
			!interfaceName(lan.Interface) || lan.Port == 0 || lan.Port == config.PanelPort || lan.Port == config.SOCKSPort {
			return plan{}, errors.New("transparent требует интерфейс LAN, IPv4 CIDR и отдельный порт")
		}
		switch lan.Mode {
		case "", "tproxy":
		case transparentRedirectTCP:
			if !host.IsPrivate() || !panelNetwork.Contains(source.Addr()) || source.Bits() < panelNetwork.Bits() || lan.Port == 53 {
				return plan{}, errors.New("redirect-tcp требует частный адрес панели, источник в её подсети и порт, отличный от DNS")
			}
		default:
			return plan{}, errors.New("поддерживаются режимы transparent tproxy и redirect-tcp")
		}
	}
	profiles := map[string]bool{"direct": true, "zapret": true}
	for index := range config.Profiles {
		entry := &config.Profiles[index]
		if !validDomain(entry.ID) || strings.Contains(entry.ID, ".") || profiles[entry.ID] {
			return plan{}, fmt.Errorf("недопустимый или повторный ID профиля %q", entry.ID)
		}
		var err error
		entry.Label, err = profileMetadata(entry.Label)
		if err != nil {
			return plan{}, err
		}
		entry.Location, err = profileMetadata(entry.Location)
		if err != nil {
			return plan{}, err
		}
		entry.Server, entry.IsXrayGroup, entry.GroupSize = "", false, 0
		if entry.XrayGroup != nil {
			if entry.Protocol != "vless" || entry.URI != "" || len(entry.Outbound) != 0 ||
				entry.Interface != "" || entry.AWGConfig != "" || entry.AWGVersion != "" {
				return plan{}, fmt.Errorf("проверьте параметры группы Xray %q", entry.ID)
			}
			if err := validateXrayProfileGroup(entry.XrayGroup); err != nil {
				return plan{}, fmt.Errorf("профиль %q: %w", entry.ID, err)
			}
			profiles[entry.ID] = true
			continue
		}
		switch entry.Protocol {
		case "vless", "hysteria2", "trojan":
			if (entry.URI == "") == (len(entry.Outbound) == 0) || entry.Interface != "" || entry.AWGConfig != "" || entry.AWGVersion != "" {
				return plan{}, fmt.Errorf("профиль %q требует одно из uri или outbound", entry.ID)
			}
			if entry.CatalogProfile && entry.Protocol == "hysteria2" {
				if !validateSubscriptionHysteriaNode(entry.Outbound) {
					return plan{}, fmt.Errorf("профиль %q: %s", entry.ID, invalidSubscriptionHysteria)
				}
			}
		case "amneziawg":
			if entry.URI != "" || len(entry.Outbound) != 0 || (entry.Interface == "") == (entry.AWGConfig == "") ||
				entry.Interface != "" && !interfaceName(entry.Interface) {
				return plan{}, fmt.Errorf("профиль %q требует файл AmneziaWG или интерфейс WireGuard ASC", entry.ID)
			}
			if entry.AWGConfig != "" {
				parsed, err := parseManagedAWG(entry.AWGConfig, entry.AWGVersion)
				if err != nil {
					return plan{}, fmt.Errorf("профиль %q: %w", entry.ID, err)
				}
				entry.AWGVersion = parsed.Version
			}
		default:
			return plan{}, fmt.Errorf("неизвестный протокол %q", entry.Protocol)
		}
		profiles[entry.ID] = true
	}
	config.DefaultTarget = fallback(config.DefaultTarget, "direct")
	config.Subscriptions, err = validateSubscriptions(config.Subscriptions)
	if err != nil {
		return plan{}, err
	}
	if err := validateSubscriptionProfiles(config); err != nil {
		return plan{}, err
	}
	config.SavedChecks, err = normalizeSavedChecks(config.SavedChecks)
	if err != nil {
		return plan{}, err
	}
	config.GeoSources, err = validateGeoSources(config.GeoSources)
	if err != nil {
		return plan{}, err
	}
	config.Games, err = normalizeGamePresets(config.Games)
	if err != nil {
		return plan{}, err
	}
	if _, err := config.policy(true); err != nil {
		return plan{}, err
	}
	return config, nil
}

func interfaceName(name string) bool {
	if len(name) == 0 || len(name) > 15 || strings.HasPrefix(name, "-") || strings.HasPrefix(name, ".") {
		return false
	}
	for _, character := range name {
		if !strings.ContainsRune("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_.-", character) {
			return false
		}
	}
	return true
}

func (config plan) public() plan {
	sanitized := config
	sanitized.Subscriptions = publicSubscriptions(config.Subscriptions)
	sanitized.Profiles = make([]profile, 0, len(config.Profiles))
	for _, entry := range config.Profiles {
		sanitized.Profiles = append(sanitized.Profiles, profile{
			ID: entry.ID, Protocol: entry.Protocol, Label: entry.Label, Location: entry.Location,
			Server: profileServer(entry), AWGVersion: entry.AWGVersion, AWGNative: entry.Interface != "",
			SubscriptionID: entry.SubscriptionID, UpstreamKey: entry.UpstreamKey, UpstreamName: entry.UpstreamName,
			SubscriptionMissing: entry.SubscriptionMissing, IsXrayGroup: entry.XrayGroup != nil,
			GroupSize: groupMemberCount(entry),
		})
	}
	return sanitized
}

func (config plan) evaluate(input destination) (decision, error) {
	policy, err := config.policy(true)
	if err != nil {
		return decision{}, err
	}
	return policy.Evaluate(input)
}

func (config plan) policy(lan bool) (devicepolicy.Plan, error) {
	options := devicepolicy.Options{Targets: make(map[string]string, len(config.Profiles)), Inventory: config.bindings}
	options.Targets["@vpn"] = ""
	for _, profile := range config.Profiles {
		options.Targets[profile.ID] = profile.Protocol
	}
	options.GeoSources = make(map[string]bool, len(config.GeoSources))
	options.GeoData = make(map[string]map[string][]netip.Prefix, len(config.GeoSources))
	options.GeoSites = make(map[string]map[string]*devicepolicy.DomainSet, len(config.GeoSources))
	for _, source := range config.GeoSources {
		options.GeoSources[source.ID] = true
		if asset := config.geoAssets[source.ID]; asset.matches(source) {
			options.GeoData[source.ID] = asset.Countries
			options.GeoSites[source.ID] = asset.Sites
		}
	}
	if lan && config.Transparent != nil {
		options.LAN, _ = netip.ParsePrefix(config.Transparent.Source)
		options.GameRoutes = config.gameRoutes()
		routerAddress, _ := netip.ParseAddr(config.PanelHost)
		if options.LAN.Contains(routerAddress) {
			options.RouterIP = routerAddress
		}
	}
	rules := config.Rules
	if preset := config.ZapretServices; preset != nil {
		var presets []rule
		if preset.YouTube {
			presets = appendPreset(presets, "YouTube", strings.Split(zapretServiceDomains("youtube"), ",")...)
		}
		if preset.Discord {
			presets = appendPreset(presets, "Discord", strings.Split(zapretServiceDomains("discord"), ",")...)
		}
		if len(presets) != 0 {
			rules = append(presets, rules...)
		}
	}
	return devicepolicy.Compile(devicepolicy.Config{
		DefaultTarget: config.DefaultTarget, Rules: rules, Devices: config.Devices, NamedSets: config.NamedSets,
	}, options)
}

func appendPreset(rules []rule, service string, domains ...string) []rule {
	for _, domain := range domains {
		rules = append(rules, rule{Name: "Zapret " + service + " · " + domain, Domain: domain, Target: "zapret"})
	}
	return rules
}
