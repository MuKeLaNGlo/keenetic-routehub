// Package ruleimport parses portable route lists before applying any settings.
package ruleimport

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"routehub/devicepolicy"
)

const MaxFileBytes = 2 << 20
const maxRules = 20000

var errFileSize = errors.New("размер файла должен быть от 1 байта до 2 МиБ. В iplist можно выбрать отдельный портал или тип данных")

type Rule = devicepolicy.Rule

type entry struct {
	Name        string          `json:"name"`
	Destination string          `json:"destination"`
	Domain      json.RawMessage `json:"domain"`
	CIDR        string          `json:"cidr"`
	IP          json.RawMessage `json:"ip"`
	Exact       bool            `json:"exact"`
	Match       string          `json:"match"`
	GeoIP       string          `json:"geoIP"`
	GeoSource   string          `json:"geoSource"`
	Disabled    bool            `json:"disabled"`
	Network     string          `json:"network"`
	Port        json.RawMessage `json:"port"`
	Target      string          `json:"target"`
	Outbound    string          `json:"outboundTag"`
	Type        string          `json:"type"`
}

type importContext struct {
	fallback string
	targets  map[string]bool
	rules    []Rule
	options  FileOptions
}

// Parse is atomic. An invalid row returns an error and no importable rules.
func Parse(filename string, input []byte, fallback string, targets map[string]bool) ([]Rule, error) {
	if len(input) == 0 || len(input) > MaxFileBytes {
		return nil, errFileSize
	}
	data := bytes.TrimSpace(bytes.TrimPrefix(input, []byte{0xef, 0xbb, 0xbf}))
	if len(data) == 0 {
		return nil, errors.New("файл пуст")
	}
	importer := importContext{fallback: fallback, targets: targets}
	var err error
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".txt":
		err = importer.text(data)
	case ".csv":
		err = importer.csv(data)
	case ".json":
		err = importer.document(data)
	default:
		err = errors.New("поддерживаемые форматы — TXT, CSV и JSON")
	}
	if err != nil {
		return nil, err
	}
	if len(importer.rules) == 0 {
		return nil, errors.New("в файле нет правил")
	}
	return importer.rules, nil
}

func (importer *importContext) append(value, name, network, target string, port uint16, exact bool) error {
	return importer.appendMatch(value, name, network, target, port, exact, "")
}

func (importer *importContext) appendMatch(value, name, network, target string, port uint16, exact bool, match string) error {
	if len(importer.rules) >= maxRules {
		return fmt.Errorf("допускается до %d правил за файл. В iplist можно выбрать отдельный портал или тип данных", maxRules)
	}
	target = strings.TrimSpace(target)
	if target == "" {
		target = importer.fallback
	}
	if !importer.targets[target] {
		return fmt.Errorf("неизвестный маршрут %q", target)
	}
	network = strings.ToLower(strings.TrimSpace(network))
	switch network {
	case "tcp,udp", "udp,tcp":
		network = ""
	case "", "tcp", "udp":
	default:
		return errors.New("допустимый транспорт — TCP или UDP")
	}
	if match == "" {
		match = importer.options.DomainMatch
	}
	var rule Rule
	var err error
	if importer.options.Type == "geo" {
		code := strings.ToUpper(strings.TrimSpace(value))
		if len(code) != 2 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z' || importer.options.GeoSource == "" {
			return errors.New("для GeoIP укажите код страны и источник")
		}
		rule = Rule{GeoIP: code, GeoSource: importer.options.GeoSource}
	} else {
		rule, err = parseDestinationMatch(value, exact, match)
	}
	if err != nil {
		return err
	}
	switch importer.options.Type {
	case "domain":
		if rule.Domain == "" {
			return errors.New("ожидается доменное назначение")
		}
	case "ip":
		prefix, _ := netip.ParsePrefix(rule.CIDR)
		if !prefix.IsValid() || prefix.Bits() != prefix.Addr().BitLen() {
			return errors.New("ожидается один IP-адрес")
		}
	case "cidr":
		if rule.CIDR == "" || !strings.Contains(value, "/") {
			return errors.New("ожидается подсеть в формате CIDR")
		}
	}
	rule.Name = strings.TrimSpace(name)
	if rule.Name == "" {
		rule.Name = rule.Domain + rule.CIDR + rule.GeoIP
	}
	rule.Target, rule.Network, rule.Port = target, network, port
	importer.rules = append(importer.rules, rule)
	return nil
}

func parseDestination(value string, exact bool) (Rule, error) {
	return parseDestinationMatch(value, exact, "")
}

func parseDestinationMatch(value string, exact bool, match string) (Rule, error) {
	value = strings.TrimSpace(value)
	forcedIP := false
	if match == "auto" {
		match = ""
	}
	forcedDomain := exact || match != ""
	switch {
	case strings.HasPrefix(value, "ip:"):
		value, forcedIP, forcedDomain, match = strings.TrimPrefix(value, "ip:"), true, false, ""
	case strings.HasPrefix(value, "cidr:"):
		value, forcedIP, forcedDomain, match = strings.TrimPrefix(value, "cidr:"), true, false, ""
	case strings.HasPrefix(value, "domain:"):
		value, forcedDomain = strings.TrimPrefix(value, "domain:"), true
	case strings.HasPrefix(value, "full:"):
		value, forcedDomain, exact = strings.TrimPrefix(value, "full:"), true, true
		match = ""
	case strings.HasPrefix(value, "keyword:"):
		value, match, forcedDomain = strings.TrimPrefix(value, "keyword:"), "keyword", true
	case strings.HasPrefix(value, "regexp:"):
		value, match, forcedDomain = strings.TrimPrefix(value, "regexp:"), "regex", true
	}
	if !forcedDomain {
		if prefix, err := netip.ParsePrefix(value); err == nil && !prefix.Addr().Is4In6() {
			return Rule{CIDR: prefix.Masked().String()}, nil
		}
		if addr, err := netip.ParseAddr(value); err == nil && addr.Zone() == "" {
			addr = addr.Unmap()
			return Rule{CIDR: netip.PrefixFrom(addr, addr.BitLen()).String()}, nil
		}
	}
	if forcedIP {
		return Rule{}, errors.New("некорректный IP или CIDR")
	}
	switch match {
	case "", "exact", "suffix", "wildcard", "regex", "keyword":
	default:
		return Rule{}, errors.New("неизвестный тип совпадения домена")
	}
	if match == "regex" || match == "keyword" {
		if value == "" || len(value) > 2048 || strings.ContainsAny(value, "\x00\r\n") {
			return Rule{}, errors.New("проверьте выражение или ключевое слово домена")
		}
		if match == "regex" {
			if _, err := regexp.Compile(value); err != nil {
				return Rule{}, errors.New("некорректное регулярное выражение RE2")
			}
		}
		return Rule{Domain: value, Match: match}, nil
	}
	if strings.HasPrefix(value, "*.") && (match == "" || match == "wildcard") {
		value, match = strings.TrimPrefix(value, "*."), "wildcard"
	}
	host, valid := devicepolicy.NormalizeRoutingDomain(value)
	if !valid {
		return Rule{}, errors.New("ожидается IP, CIDR, домен или точный домен с префиксом full:")
	}
	return Rule{Domain: host, Exact: exact, Match: match}, nil
}

func (importer *importContext) text(data []byte) error {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for line := 1; scanner.Scan(); line++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		value, target, hasTarget := strings.Cut(text, ">")
		if hasTarget && strings.TrimSpace(target) == "" {
			return fmt.Errorf("строка %d — укажите маршрут после >", line)
		}
		if err := importer.append(value, "", "", target, 0, false); err != nil {
			return fmt.Errorf("строка %d — %w", line, err)
		}
	}
	return scanner.Err()
}

func readPort(value string) (uint16, error) {
	if value == "" {
		return 0, nil
	}
	port, err := strconv.ParseUint(value, 10, 16)
	if err != nil || port == 0 {
		return 0, errors.New("укажите один порт от 1 до 65535")
	}
	return uint16(port), nil
}

func (importer *importContext) csv(data []byte) error {
	reader := csv.NewReader(bytes.NewReader(data))
	reader.TrimLeadingSpace = true
	header, err := reader.Read()
	if err != nil {
		return err
	}
	columns := make(map[string]int, len(header))
	for i, name := range header {
		name = strings.TrimSpace(name)
		switch name {
		case "destination", "target", "name", "network", "port":
		default:
			return fmt.Errorf("неизвестная колонка CSV %q", name)
		}
		if _, exists := columns[name]; exists {
			return fmt.Errorf("дублируется колонка CSV %q", name)
		}
		columns[name] = i
	}
	if _, ok := columns["destination"]; !ok {
		return errors.New("в CSV нужна колонка destination")
	}
	for {
		row, err := reader.Read()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		column := func(key string) string {
			if index, ok := columns[key]; ok {
				return strings.TrimSpace(row[index])
			}
			return ""
		}
		port, err := readPort(column("port"))
		if err == nil {
			err = importer.append(column("destination"), column("name"), column("network"), column("target"), port, false)
		}
		if err != nil {
			line, _ := reader.FieldPos(0)
			return fmt.Errorf("строка CSV %d — %w", line, err)
		}
	}
}

func strictJSON(data []byte, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("ожидается один JSON-документ")
	}
	return nil
}

func stringList(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var value string
	if raw[0] == '"' && strictJSON(raw, &value) == nil {
		return []string{value}, nil
	}
	var list []string
	if err := strictJSON(raw, &list); err != nil || list == nil {
		return nil, errors.New("ожидается адрес или список адресов")
	}
	return list, nil
}

func (importer *importContext) document(data []byte) error {
	var items []entry
	if data[0] == '[' {
		if err := strictJSON(data, &items); err != nil {
			return err
		}
	} else {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			return err
		}
		_, rules := fields["rules"]
		_, global := fields["global_routing_rules"]
		if rules || global {
			var container struct {
				Rules  []entry `json:"rules"`
				Global []entry `json:"global_routing_rules"`
			}
			if err := strictJSON(data, &container); err != nil {
				return err
			}
			if rules == global || container.Rules == nil && container.Global == nil {
				return errors.New("ожидается один массив правил JSON")
			}
			items = append(container.Rules, container.Global...)
		} else {
			var item entry
			if err := strictJSON(data, &item); err != nil {
				return err
			}
			items = []entry{item}
		}
	}
	for i, item := range items {
		if err := importer.jsonEntry(item); err != nil {
			return fmt.Errorf("правило JSON %d — %w", i+1, err)
		}
	}
	return nil
}

func (importer *importContext) jsonEntry(item entry) error {
	if item.Type != "" && item.Type != "field" || item.Target != "" && item.Outbound != "" {
		return errors.New("ожидается правило field с одним маршрутом")
	}
	target := item.Target
	if target == "" {
		target = item.Outbound
	}
	domains, err := stringList(item.Domain)
	if err != nil {
		return err
	}
	addresses, err := stringList(item.IP)
	if err != nil {
		return err
	}
	groups := 0
	for _, set := range []bool{item.Destination != "", len(domains) > 0, len(addresses) > 0, item.CIDR != "", item.GeoIP != ""} {
		if set {
			groups++
		}
	}
	if groups != 1 {
		return errors.New("у каждого правила нужен один тип назначения")
	}
	portString := string(item.Port)
	if len(portString) > 0 && portString[0] == '"' {
		if err := strictJSON(item.Port, &portString); err != nil {
			return err
		}
	}
	port, err := readPort(portString)
	if err != nil {
		return err
	}
	var values []string
	switch {
	case item.GeoIP != "":
		previous := importer.options
		importer.options.Type, importer.options.GeoSource = "geo", item.GeoSource
		err := importer.append(item.GeoIP, item.Name, item.Network, target, port, false)
		importer.options = previous
		if err == nil {
			importer.rules[len(importer.rules)-1].Disabled = item.Disabled
		}
		return err
	case item.Destination != "":
		values = []string{item.Destination}
	case item.CIDR != "":
		values = []string{"cidr:" + item.CIDR}
	case len(addresses) > 0:
		for _, address := range addresses {
			values = append(values, "ip:"+address)
		}
	default:
		for _, domain := range domains {
			if strings.HasPrefix(domain, "full:") || strings.HasPrefix(domain, "domain:") || strings.HasPrefix(domain, "keyword:") || strings.HasPrefix(domain, "regexp:") {
				values = append(values, domain)
			} else {
				values = append(values, "domain:"+domain)
			}
		}
	}
	for i, value := range values {
		name := item.Name
		if len(values) > 1 && name != "" {
			name += " " + strconv.Itoa(i+1)
		}
		if err := importer.appendMatch(value, name, item.Network, target, port, item.Exact, item.Match); err != nil {
			return err
		}
		importer.rules[len(importer.rules)-1].Disabled = item.Disabled
	}
	return nil
}
