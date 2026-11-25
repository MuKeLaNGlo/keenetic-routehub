// Package devicepolicy evaluates and compiles the same ordered routing policy.
package devicepolicy

import (
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

type Rule struct {
	Name      string `json:"name"`
	Domain    string `json:"domain,omitempty"`
	Exact     bool   `json:"exact,omitempty"`
	Match     string `json:"match,omitempty"`
	CIDR      string `json:"cidr,omitempty"`
	GeoIP     string `json:"geoIP,omitempty"`
	GeoSite   string `json:"geoSite,omitempty"`
	GeoSource string `json:"geoSource,omitempty"`
	NamedSet  string `json:"set,omitempty"`
	Disabled  bool   `json:"disabled,omitempty"`
	Network   string `json:"network,omitempty"`
	Port      uint16 `json:"port,omitempty"`
	Target    string `json:"target"`
}

type Device struct {
	MAC           string   `json:"mac"`
	Label         string   `json:"label,omitempty"`
	Addresses     []string `json:"addresses,omitempty"`
	Mode          string   `json:"mode,omitempty"`
	DefaultTarget string   `json:"defaultTarget,omitempty"`
	Rules         []Rule   `json:"rules,omitempty"`
}

type Config struct {
	DefaultTarget string     `json:"defaultTarget,omitempty"`
	Rules         []Rule     `json:"rules"`
	Devices       []Device   `json:"devices,omitempty"`
	NamedSets     []NamedSet `json:"namedSets,omitempty"`
}

// Binding is a row of a trusted router inventory. A non-fixed row can flag a
// conflicting current owner, but cannot activate a configured address.
type Binding struct {
	MAC     string `json:"mac"`
	Address string `json:"address"`
	Fixed   bool   `json:"fixed"`
}

// GameRoute is an opt-in TCP exception after explicit rules. The destination
// is one IP and one port, and Options.GameRoutes is keyed by device MAC.
type GameRoute struct {
	PresetID    string
	Name        string
	Destination netip.AddrPort
}

type Options struct {
	// Targets maps an outbound tag to its protocol for route explanations.
	Targets map[string]string
	// LAN is the captured IPv4 prefix. An unset prefix makes device rules inactive.
	LAN netip.Prefix
	// RouterIP, when known, is the router address in LAN and cannot be assigned.
	RouterIP netip.Addr
	// Inventory nil trusts the administrator's fixed assignments. A non-nil
	// snapshot requires a unique verified fixed MAC for each configured address.
	Inventory  []Binding
	GeoSources map[string]bool
	GeoData    map[string]map[string][]netip.Prefix
	GeoSites   map[string]map[string]*DomainSet
	GameRoutes map[string][]GameRoute
}

type Destination struct {
	Host      string `json:"host"`
	TargetIP  string `json:"targetIP,omitempty"`
	Network   string `json:"network"`
	Port      uint16 `json:"port"`
	ClientIP  string `json:"clientIP,omitempty"`
	ClientMAC string `json:"clientMAC,omitempty"`
}

type Decision struct {
	Rule         string `json:"rule,omitempty"`
	Target       string `json:"target"`
	Protocol     string `json:"protocol,omitempty"`
	Scope        string `json:"scope"`
	DeviceMAC    string `json:"deviceMAC,omitempty"`
	GamePresetID string `json:"gamePresetId,omitempty"`
}

type DeviceStatus struct {
	MAC               string   `json:"mac"`
	Label             string   `json:"label,omitempty"`
	Addresses         []string `json:"addresses,omitempty"`
	Mode              string   `json:"mode"`
	Active            bool     `json:"active"`
	Reason            string   `json:"reason,omitempty"`
	GameRouteEligible bool     `json:"gameRouteEligible,omitempty"`
}

type plannedRule struct {
	Rule
	CIDRPrefix   netip.Prefix
	DeviceMAC    string
	Sources      []netip.Addr
	DomainToken  string
	DomainRegex  *regexp.Regexp
	Prefixes     []netip.Prefix
	Domains      *DomainSet
	GamePresetID string
}

type Plan struct {
	rules     []plannedRule
	targets   map[string]string
	devices   []DeviceStatus
	sources   map[netip.Addr]string
	addresses map[string][]netip.Addr
}

// Compile gives device rules first priority. An override then uses its own
// fallback. An inherited policy continues into the global rules and fallback.
func Compile(config Config, options Options) (Plan, error) {
	plan := Plan{
		targets:   map[string]string{"direct": "", "zapret": "", "@block": ""},
		sources:   make(map[netip.Addr]string),
		addresses: make(map[string][]netip.Addr),
	}
	for tag, protocol := range options.Targets {
		plan.targets[tag] = protocol
	}
	if options.LAN.IsValid() && (!options.LAN.Addr().Is4() || options.LAN != options.LAN.Masked()) {
		return Plan{}, errors.New("для правил устройств нужна каноническая IPv4-подсеть LAN")
	}
	if config.DefaultTarget == "" {
		config.DefaultTarget = "direct"
	}
	if _, ok := plan.targets[config.DefaultTarget]; !ok {
		return Plan{}, fmt.Errorf("неизвестный маршрут сети по умолчанию %q", config.DefaultTarget)
	}
	inventory, err := inventoryOwners(options.Inventory)
	if err != nil {
		return Plan{}, err
	}
	sets, err := compileNamedSets(config.NamedSets)
	if err != nil {
		return Plan{}, err
	}
	knownMACs := make(map[string]bool)
	configured := make(map[netip.Addr]string)
	var gameRules []plannedRule
	for _, device := range config.Devices {
		mac, err := NormalizeMAC(device.MAC)
		if err != nil {
			return Plan{}, err
		}
		if knownMACs[mac] {
			return Plan{}, fmt.Errorf("повторный MAC устройства %q", mac)
		}
		knownMACs[mac] = true
		gamePolicy := device.Mode == "inherit"
		if device.Mode == "" {
			device.Mode = "inherit"
		}
		switch device.Mode {
		case "global", "inherit":
			if device.DefaultTarget != "" {
				return Plan{}, fmt.Errorf("устройство %s в режиме %s наследует маршрут по умолчанию", mac, device.Mode)
			}
		case "override", "fixed":
			if _, ok := plan.targets[device.DefaultTarget]; !ok || device.DefaultTarget == "" {
				return Plan{}, fmt.Errorf("устройство %s в режиме %s требует известный маршрут по умолчанию", mac, device.Mode)
			}
		default:
			return Plan{}, fmt.Errorf("неизвестный режим устройства %s", mac)
		}
		status := DeviceStatus{MAC: mac, Label: device.Label, Mode: device.Mode}
		var addresses []netip.Addr
		for _, value := range device.Addresses {
			address, err := parseClientIP(value)
			if err != nil || address == options.RouterIP || (options.LAN.IsValid() && !lanHost(options.LAN, address)) {
				return Plan{}, fmt.Errorf("некорректный адрес LAN %q устройства %s", value, mac)
			}
			if owner, exists := configured[address]; exists {
				return Plan{}, fmt.Errorf("адрес %s повторно назначен устройствам %s и %s", address, owner, mac)
			}
			configured[address] = mac
			addresses = append(addresses, address)
			status.Addresses = append(status.Addresses, address.String())
		}
		switch {
		case device.Mode == "global":
			status.Reason = "global-only"
		case !options.LAN.IsValid():
			status.Reason = "lan-disabled"
		case len(addresses) == 0:
			status.Reason = "missing-address"
		case inventory != nil && !hasAllBindings(inventory, mac, addresses):
			status.Reason = "unverified-address"
		default:
			status.Active = true
		}
		status.GameRouteEligible = status.Active && gamePolicy && inventory != nil
		plan.devices = append(plan.devices, status)
		rules, err := plan.compileRules(device.Rules, options, sets, status.Active && device.Mode != "fixed")
		if err != nil {
			return Plan{}, fmt.Errorf("устройство %s: %w", mac, err)
		}
		if !status.Active {
			continue
		}
		plan.addresses[mac] = addresses
		for _, address := range addresses {
			plan.sources[address] = mac
		}
		if device.Mode == "override" || device.Mode == "fixed" {
			rules = append(rules, plannedRule{Rule: Rule{Target: device.DefaultTarget}})
		}
		for _, entry := range rules {
			entry.DeviceMAC = mac
			entry.Sources = addresses
			plan.rules = append(plan.rules, entry)
		}
		if status.GameRouteEligible {
			for _, game := range options.GameRoutes[mac] {
				if !game.Destination.Addr().Is4() || game.Destination.Port() == 0 {
					return Plan{}, fmt.Errorf("некорректное игровое назначение %q", game.Name)
				}
				prefix := netip.PrefixFrom(game.Destination.Addr(), 32)
				gameRules = append(gameRules, plannedRule{
					Rule:       Rule{Name: "Игра · " + game.Name, CIDR: prefix.String(), Target: "direct", Network: "tcp", Port: game.Destination.Port()},
					CIDRPrefix: prefix, DeviceMAC: mac, Sources: addresses, GamePresetID: game.PresetID,
				})
			}
		}
	}
	global, err := plan.compileRules(config.Rules, options, sets, true)
	if err != nil {
		return Plan{}, err
	}
	plan.rules = append(plan.rules, global...)
	plan.rules = append(plan.rules, gameRules...)
	plan.rules = append(plan.rules, plannedRule{Rule: Rule{Target: config.DefaultTarget}})
	return plan, nil
}

func (plan Plan) compileRules(rules []Rule, options Options, sets map[string]compiledNamedSet, active bool) ([]plannedRule, error) {
	compiled := make([]plannedRule, 0, len(rules))
	names := make(map[string]bool)
	for _, rule := range rules {
		rule.Name = strings.TrimSpace(rule.Name)
		if rule.Name == "" || names[rule.Name] {
			return nil, errors.New("имена правил должны быть заполнены и уникальны в своей области")
		}
		names[rule.Name] = true
		conditions := 0
		for _, condition := range []string{rule.Domain, rule.CIDR, rule.GeoIP, rule.GeoSite, rule.NamedSet} {
			if strings.TrimSpace(condition) != "" {
				conditions++
			}
		}
		if _, ok := plan.targets[rule.Target]; !ok || conditions != 1 {
			return nil, fmt.Errorf("правило %q требует одно назначение и известный маршрут", rule.Name)
		}
		if (rule.Exact || rule.Match != "") && rule.Domain == "" {
			return nil, fmt.Errorf("тип совпадения в правиле %q требует домен", rule.Name)
		}
		if rule.GeoIP == "" && rule.GeoSite == "" && rule.GeoSource != "" {
			return nil, fmt.Errorf("источник базы в правиле %q требует тег GeoIP или GeoSite", rule.Name)
		}
		if rule.Network != "" && !validNetwork(rule.Network) {
			return nil, fmt.Errorf("неизвестный транспорт в правиле %q", rule.Name)
		}
		entry := plannedRule{Rule: rule}
		switch {
		case strings.TrimSpace(rule.Domain) != "":
			if err := entry.compileDomain(); err != nil {
				return nil, fmt.Errorf("правило %q: %w", rule.Name, err)
			}
		case rule.GeoIP != "" || rule.GeoSite != "":
			if err := entry.compileGeo(options, active && !rule.Disabled); err != nil {
				return nil, fmt.Errorf("правило %q: %w", rule.Name, err)
			}
		case rule.NamedSet != "":
			set, ok := sets[rule.NamedSet]
			if !ok {
				return nil, fmt.Errorf("правило %q ссылается на отсутствующий набор", rule.Name)
			}
			if len(set.prefixes) == 0 && (set.domains == nil || len(set.domains.tokens) == 0) {
				return nil, fmt.Errorf("правило %q ссылается на пустой набор", rule.Name)
			}
			entry.Prefixes, entry.Domains = set.prefixes, set.domains
		default:
			prefix, err := netip.ParsePrefix(rule.CIDR)
			if err != nil || prefix != prefix.Masked() || prefix.Addr().Is4In6() {
				return nil, fmt.Errorf("некорректный CIDR в правиле %q", rule.Name)
			}
			entry.CIDRPrefix = prefix
		}
		if active && !rule.Disabled {
			compiled = append(compiled, entry)
		}
	}
	return compiled, nil
}

func (entry *plannedRule) compileDomain() error {
	entry.Match = strings.ToLower(strings.TrimSpace(entry.Match))
	if entry.Match == "" || entry.Match == "auto" {
		switch {
		case entry.Exact:
			entry.Match = "exact"
		case strings.HasPrefix(strings.TrimSpace(entry.Domain), "*."):
			entry.Match = "wildcard"
		default:
			entry.Match = "suffix"
		}
	}
	if entry.Match == "regex" || entry.Match == "keyword" {
		entry.Domain = strings.TrimSpace(entry.Domain)
		if entry.Domain == "" || len(entry.Domain) > 2048 || strings.ContainsAny(entry.Domain, "\x00\r\n") {
			return errors.New("проверьте выражение или ключевое слово домена")
		}
		if entry.Match == "regex" {
			pattern, err := regexp.Compile(entry.Domain)
			if err != nil {
				return errors.New("некорректное регулярное выражение RE2")
			}
			entry.DomainRegex = pattern
			entry.DomainToken = "regexp:" + entry.Domain
		} else {
			entry.Domain = strings.ToLower(entry.Domain)
			entry.DomainToken = "keyword:" + entry.Domain
		}
		return nil
	}
	if entry.Match == "wildcard" {
		entry.Domain = strings.TrimPrefix(strings.TrimSpace(entry.Domain), "*.")
	}
	domain, valid := NormalizeRoutingDomain(entry.Domain)
	if !valid {
		return errors.New("некорректный домен")
	}
	entry.Domain = domain
	switch entry.Match {
	case "exact":
		entry.DomainToken = "full:" + entry.Domain
	case "suffix":
		entry.DomainToken = "domain:" + entry.Domain
	case "wildcard":
		entry.DomainToken = "regexp:^.+\\." + regexp.QuoteMeta(entry.Domain) + "$"
	default:
		return errors.New("неизвестный тип совпадения домена")
	}
	return nil
}

func (entry *plannedRule) compileGeo(options Options, active bool) error {
	if !options.GeoSources[entry.GeoSource] {
		return errors.New("выберите сохранённый источник GeoIP или GeoSite")
	}
	if entry.GeoSite != "" {
		tag, valid := GeoTag(entry.GeoSite)
		if !valid {
			return errors.New("укажите допустимый тег GeoSite")
		}
		entry.GeoSite = tag
		entry.Domains = options.GeoSites[entry.GeoSource][tag]
		if active && (entry.Domains == nil || len(entry.Domains.tokens) == 0) {
			return errors.New("обновите базу GeoSite и выберите доступный тег")
		}
		return nil
	}
	tag, valid := GeoTag(entry.GeoIP)
	if !valid {
		return errors.New("укажите допустимый тег GeoIP")
	}
	entry.GeoIP = tag
	entry.Prefixes = options.GeoData[entry.GeoSource][tag]
	if active && len(entry.Prefixes) == 0 {
		return errors.New("обновите базу GeoIP и выберите доступный тег")
	}
	return nil
}

// Devices returns the configured devices and their applied state without sharing
// mutable address lists with the plan.
func (plan Plan) Devices() []DeviceStatus {
	devices := make([]DeviceStatus, 0, len(plan.devices))
	for _, status := range plan.devices {
		status.Addresses = append([]string(nil), status.Addresses...)
		devices = append(devices, status)
	}
	return devices
}

// Evaluate explains the same first match used by Xray. A MAC-only diagnostic
// selects the first active address of the device. No client selects global policy.
func (plan Plan) Evaluate(input Destination) (Decision, error) {
	host := normalizeHost(input.Host)
	hostIP, _ := netip.ParseAddr(host)
	if (!hostIP.IsValid() && !validRoutingDomain(host)) || hostIP.Zone() != "" || !validNetwork(input.Network) || input.Port == 0 {
		return Decision{}, errors.New("укажите домен или IP, протокол TCP или UDP и порт от 1 до 65535")
	}
	address := hostIP.Unmap()
	if input.TargetIP != "" {
		target, err := netip.ParseAddr(input.TargetIP)
		if err != nil || target.Zone() != "" || (address.IsValid() && target.Unmap() != address) {
			return Decision{}, errors.New("неверный или не совпадающий с назначением targetIP")
		}
		address = target.Unmap()
	}
	deviceMAC, err := plan.clientMAC(input.ClientMAC, input.ClientIP)
	if err != nil {
		return Decision{}, err
	}
	for _, entry := range plan.rules {
		if entry.DeviceMAC != "" && entry.DeviceMAC != deviceMAC {
			continue
		}
		if entry.Network != "" && entry.Network != input.Network || entry.Port != 0 && entry.Port != input.Port {
			continue
		}
		if entry.CIDRPrefix.IsValid() && !entry.CIDRPrefix.Contains(address) {
			continue
		}
		if len(entry.Prefixes) > 0 && !slices.ContainsFunc(entry.Prefixes, func(prefix netip.Prefix) bool { return prefix.Contains(address) }) {
			continue
		}
		if entry.DomainToken != "" && (hostIP.IsValid() || !entry.matchesDomain(host)) {
			continue
		}
		if entry.Domains != nil && (hostIP.IsValid() || !entry.Domains.matches(host)) {
			continue
		}
		scope := "global"
		if entry.DeviceMAC != "" {
			scope = "device"
		}
		return Decision{Rule: entry.Name, Target: entry.Target, Protocol: plan.targets[entry.Target], Scope: scope, DeviceMAC: deviceMAC, GamePresetID: entry.GamePresetID}, nil
	}
	return Decision{}, errors.New("план маршрутизации ещё не загружен")
}

func (entry plannedRule) matchesDomain(host string) bool {
	switch entry.Match {
	case "exact":
		return host == entry.Domain
	case "suffix":
		return host == entry.Domain || strings.HasSuffix(host, "."+entry.Domain)
	case "wildcard":
		return strings.HasSuffix(host, "."+entry.Domain)
	case "keyword":
		return strings.Contains(host, entry.Domain)
	case "regex":
		return entry.DomainRegex.MatchString(host)
	default:
		return false
	}
}

func (plan Plan) clientMAC(mac, ip string) (string, error) {
	if mac != "" {
		var err error
		mac, err = NormalizeMAC(mac)
		if err != nil {
			return "", err
		}
	}
	if ip == "" {
		if len(plan.addresses[mac]) > 0 {
			return mac, nil
		}
		return "", nil
	}
	address, err := parseClientIP(ip)
	if err != nil {
		return "", err
	}
	owner := plan.sources[address]
	if mac != "" && owner != mac && (owner != "" || len(plan.addresses[mac]) > 0) {
		return "", errors.New("указанные MAC и IP не принадлежат одному активному устройству")
	}
	return owner, nil
}

// XrayRules emits first-match rules. Source matching is restricted to the
// transparent LAN inbound. Without that inbound only global rules are emitted.
func (plan Plan) XrayRules(lanInboundTag string) []map[string]any {
	return plan.XrayRulesWithAssets(lanInboundTag, nil)
}

// XrayRulesWithAssets resolves the file name for active geodata sources.
// An empty file name keeps a rule self-contained.
func (plan Plan) XrayRulesWithAssets(lanInboundTag string, assetFile func(string) string) []map[string]any {
	rules := make([]map[string]any, 0, len(plan.rules))
	for _, entry := range plan.rules {
		rule := map[string]any{"type": "field", "outboundTag": entry.Target}
		if len(entry.Sources) > 0 {
			if lanInboundTag == "" {
				continue
			}
			sources := make([]string, 0, len(entry.Sources))
			for _, addr := range entry.Sources {
				sources = append(sources, netip.PrefixFrom(addr, 32).String())
			}
			rule["sourceIP"] = sources
			rule["inboundTag"] = []string{lanInboundTag}
		}
		if entry.DomainToken != "" {
			rule["domain"] = []string{entry.DomainToken}
		}
		var file string
		if assetFile != nil && entry.GeoSource != "" {
			file = assetFile(entry.GeoSource)
		}
		if entry.Domains != nil {
			if file != "" {
				rule["domain"] = []string{"ext:" + file + ":" + entry.GeoSite}
			} else {
				rule["domain"] = slices.Clone(entry.Domains.tokens)
			}
		}
		if entry.CIDR != "" {
			rule["ip"] = []string{entry.CIDR}
		}
		if len(entry.Prefixes) > 0 {
			if file != "" {
				rule["ip"] = []string{"ext:" + file + ":" + entry.GeoIP}
			} else {
				prefixes := make([]string, 0, len(entry.Prefixes))
				for _, prefix := range entry.Prefixes {
					prefixes = append(prefixes, prefix.String())
				}
				rule["ip"] = prefixes
			}
		}
		if entry.Network != "" {
			rule["network"] = entry.Network
		}
		if entry.Port != 0 {
			rule["port"] = strconv.Itoa(int(entry.Port))
		}
		if entry.Name == "" {
			rule["network"] = "tcp,udp"
		}
		rules = append(rules, rule)
	}
	return rules
}
