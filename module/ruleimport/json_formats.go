package ruleimport

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

func (importer *importContext) alternateJSON(format string, data []byte) error {
	var raw any
	if json.Unmarshal(data, &raw) != nil {
		return errors.New("некорректный JSON")
	}
	root, _ := raw.(map[string]any)
	_, hasVersion := root["version"].(float64)
	if format == "singbox" || hasVersion && root["rules"] != nil {
		return importer.readSingBox(root)
	}
	if format != "amnezia" {
		native := *importer
		native.rules = nil
		if data[0] == '{' || data[0] == '[' {
			nativeErr := native.document(data)
			if nativeErr == nil {
				importer.rules = native.rules
				return nil
			}
			if hasNativeRouting(raw) {
				return nativeErr
			}
		}
	}
	return importer.readListJSON(raw, true, "")
}

func hasNativeRouting(value any) bool {
	switch value := value.(type) {
	case []any:
		return slices.ContainsFunc(value, hasNativeRouting)
	case map[string]any:
		for key, row := range value {
			switch key {
			case "outboundTag", "target", "destination", "routing", "global_routing_rules", "type", "match", "exact", "geoIP", "geoSource", "disabled",
				"network", "port", "balancerTag", "source", "sourceIP", "sourcePort", "inboundTag", "localIP", "localPort", "process", "protocol",
				"attrs", "user", "domainMatcher", "ruleTag", "vlessRoute", "webhook", "localOS", "invert", "action":
				return true
			case "rules":
				if hasNativeRouting(row) {
					return true
				}
			}
		}
	}
	return false
}

func jsonValues(value any) ([]string, error) {
	switch value := value.(type) {
	case nil:
		return nil, nil
	case string:
		return []string{value}, nil
	case []any:
		result := make([]string, 0, len(value))
		for _, item := range value {
			text, ok := item.(string)
			if !ok {
				return nil, errors.New("вместо назначения ожидалась строка")
			}
			result = append(result, text)
		}
		return result, nil
	default:
		return nil, errors.New("ожидается адрес или список адресов")
	}
}

func (importer *importContext) readSingBox(root map[string]any) error {
	rows, ok := root["rules"].([]any)
	if !ok {
		return errors.New("в sing-box JSON отсутствует массив rules")
	}
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok || row["invert"] != nil && row["invert"] != false || row["type"] != nil && row["type"] != "default" {
			return errors.New("в sing-box JSON есть условия помимо назначений")
		}
		for key := range row {
			switch key {
			case "type", "invert", "domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr":
			default:
				return errors.New("в sing-box JSON есть условия помимо назначений")
			}
		}
		exact, err := jsonValues(row["domain"])
		if err != nil {
			return err
		}
		suffixes, err := jsonValues(row["domain_suffix"])
		if err != nil {
			return err
		}
		converted := make(map[string]bool)
		for _, value := range suffixes {
			entry := suffixEntry(value)
			if strings.HasPrefix(value, ".") && slices.Contains(exact, value[1:]) {
				entry.match = "suffix"
				converted[value[1:]] = true
			}
			if err := importer.appendEntry(entry); err != nil {
				return err
			}
		}
		for _, value := range exact {
			if !converted[value] {
				if err := importer.appendEntry(destinationEntry{value: value, match: "exact"}); err != nil {
					return err
				}
			}
		}
		for _, field := range []struct{ key, match string }{{"domain_keyword", "keyword"}, {"domain_regex", "regex"}, {"ip_cidr", ""}} {
			values, err := jsonValues(row[field.key])
			if err != nil {
				return err
			}
			for _, value := range values {
				if field.key == "ip_cidr" {
					value = "ip:" + value
				}
				if err := importer.appendEntry(destinationEntry{value: value, match: field.match}); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (importer *importContext) readListJSON(value any, root bool, field string) error {
	switch value := value.(type) {
	case string:
		if strings.TrimSpace(value) == "" {
			return nil
		}
		row := destinationEntry{value: value}
		switch field {
		case "domain_suffix":
			row = suffixEntry(value)
		case "domain_keyword":
			row.match = "keyword"
		case "domain_regex":
			row.match = "regex"
		case "ip", "ip4", "ip6", "ipv4", "ipv6", "ip_cidr", "cidr", "cidr4", "cidr6", "subnet":
			row.value = "ip:" + value
		}
		return importer.appendEntry(row)
	case []any:
		for _, nested := range value {
			if err := importer.readListJSON(nested, false, field); err != nil {
				return err
			}
		}
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		for _, key := range keys {
			child := value[key]
			field := strings.ToLower(key)
			switch field {
			case "domains", "ip4", "ip6", "cidr4", "cidr6", "domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr", "hostname", "ip", "ipv4", "ipv6", "cidr", "address", "subnet", "payload", "entries", "items", "rules":
				if err := importer.readListJSON(child, false, field); err != nil {
					return fmt.Errorf("поле списка JSON — %w", err)
				}
			default:
				if root {
					switch child.(type) {
					case []any, map[string]any:
						if err := importer.readListJSON(child, false, ""); err != nil {
							return err
						}
					}
				}
			}
		}
	}
	return nil
}
