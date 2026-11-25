package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

func parseYAMLProfiles(data []byte) (profileImportPreview, error) {
	reader := yaml.NewDecoder(bytes.NewReader(data))
	var doc yaml.Node
	if err := reader.Decode(&doc); err != nil || reader.Decode(new(yaml.Node)) != io.EOF || !safeYAMLTree(&doc, 0, new(int)) {
		return profileImportPreview{}, errors.New("загрузите один документ YAML без ссылок и циклов")
	}
	var value any
	if err := doc.Decode(&value); err != nil {
		return profileImportPreview{}, errors.New("проверьте синтаксис профилей YAML")
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return profileImportPreview{}, errors.New("проверьте структуру YAML")
	}
	return parseXrayProfiles(encoded)
}

func safeYAMLTree(node *yaml.Node, depth int, count *int) bool {
	*count++
	if depth > 64 || *count > 32_000 || node.Kind == yaml.AliasNode {
		return false
	}
	for _, child := range node.Content {
		if !safeYAMLTree(child, depth+1, count) {
			return false
		}
	}
	return true
}

func parseExternalProfiles(data []byte) (profileImportPreview, error) {
	entries := []json.RawMessage{data}
	if first := bytes.TrimSpace(data); len(first) != 0 && first[0] == '[' {
		if err := json.Unmarshal(data, &entries); err != nil {
			return profileImportPreview{}, errors.New("проверьте массив профилей")
		}
	}
	preview := profileImportPreview{Profiles: make([]profile, 0, len(entries))}
	for index, entry := range entries {
		parsed, err := parseExternalOutbound(entry, index+1)
		if err != nil {
			return profileImportPreview{}, err
		}
		if parsed.Protocol != "" {
			preview.Profiles = append(preview.Profiles, parsed)
		}
	}
	if len(preview.Profiles) == 0 {
		return profileImportPreview{}, errors.New("в файле нет поддерживаемых VPN-профилей")
	}
	return preview, nil
}

func externalText(fields object, names ...string) string {
	for _, name := range names {
		if text, ok := fields[name].(string); ok && text != "" {
			return text
		}
	}
	return ""
}

func externalSection(fields object, key string) object {
	nested, _ := fields[key].(map[string]any)
	return nested
}

func externalFlag(fields object, keys ...string) bool {
	for _, key := range keys {
		if enabled, _ := fields[key].(bool); enabled {
			return true
		}
	}
	return false
}

func externalPort(fields object, fallbackPort string) string {
	for _, key := range []string{"server_port", "port"} {
		switch port := fields[key].(type) {
		case string:
			return port
		case json.Number:
			return port.String()
		}
	}
	return fallbackPort
}

func querySet(query url.Values, key, value string) {
	if value != "" {
		query.Set(key, value)
	}
}

func parseExternalOutbound(raw []byte, number int) (profile, error) {
	var fields object
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return profile{}, fmt.Errorf("проверьте конфиг профиля №%d", number)
	}
	protocol := strings.ToLower(externalText(fields, "type", "protocol"))
	if protocol == "" && fields["server"] != nil && fields["auth"] != nil {
		protocol = "hysteria2"
	}
	switch protocol {
	case "direct", "block", "dns", "selector", "urltest":
		return profile{}, nil
	case "hy2":
		protocol = "hysteria2"
	case "vless", "hysteria2", "trojan":
	default:
		return profile{}, fmt.Errorf("в профиле №%d нужен VLESS, Hysteria2 или Trojan", number)
	}
	if externalText(fields, "detour", "dialer-proxy", "bind_interface") != "" ||
		fields["wireguard"] != nil || fields["server_ports"] != nil || fields["realm"] != nil {
		return profile{}, fmt.Errorf("профиль №%d требует самостоятельного выхода или экспорта в Xray", number)
	}
	host := externalText(fields, "server", "address")
	port := externalPort(fields, "")
	if server, embedded, err := net.SplitHostPort(host); err == nil {
		host, port = server, fallback(port, embedded)
	}
	host = strings.Trim(host, "[]")
	port = fallback(port, "443")
	value, err := strconv.ParseUint(port, 10, 16)
	if err != nil || value == 0 || host == "" {
		return profile{}, fmt.Errorf("проверьте адрес и порт профиля №%d", number)
	}
	secret := externalText(fields, "password", "auth")
	if protocol == "vless" {
		secret = externalText(fields, "uuid", "id")
	}
	tls := externalSection(fields, "tls")
	query := make(url.Values)
	if protocol != "vless" || externalFlag(fields, "tls") || externalFlag(tls, "enabled") {
		query.Set("security", "tls")
	}
	querySet(query, "sni", fallback(externalText(tls, "server_name", "sni"), externalText(fields, "servername", "sni")))
	querySet(query, "fp", fallback(externalText(externalSection(tls, "utls"), "fingerprint"), externalText(fields, "client-fingerprint")))
	querySet(query, "flow", externalText(fields, "flow"))
	querySet(query, "encryption", externalText(fields, "encryption"))
	querySet(query, "pinSHA256", externalText(tls, "pinSHA256"))
	if externalFlag(tls, "insecure") || externalFlag(fields, "skip-cert-verify") {
		query.Set("insecure", "true")
	}
	reality := externalSection(tls, "reality")
	if reality == nil {
		reality = externalSection(fields, "reality-opts")
	}
	if reality != nil && externalText(reality, "public_key", "public-key") != "" {
		query.Set("security", "reality")
		querySet(query, "pbk", externalText(reality, "public_key", "public-key"))
		querySet(query, "sid", externalText(reality, "short_id", "short-id"))
	}
	if alpn, ok := tls["alpn"].([]any); ok || fields["alpn"] != nil {
		if !ok {
			alpn, _ = fields["alpn"].([]any)
		}
		var values []string
		for _, item := range alpn {
			if value, ok := item.(string); ok {
				values = append(values, value)
			}
		}
		querySet(query, "alpn", strings.Join(values, ","))
	}
	if protocol == "hysteria2" {
		obfs := externalSection(fields, "obfs")
		kind := fallback(externalText(obfs, "type"), externalText(fields, "obfs"))
		querySet(query, "obfs", kind)
		querySet(query, "obfs-password", fallback(externalText(obfs, "password"),
			fallback(externalText(externalSection(obfs, kind), "password"), externalText(fields, "obfs-password"))))
	} else {
		transport := externalSection(fields, "transport")
		method := fallback(externalText(transport, "type"), externalText(fields, "network"))
		if transport == nil {
			transport = externalSection(fields, method+"-opts")
		}
		querySet(query, "type", method)
		querySet(query, "path", externalText(transport, "path"))
		querySet(query, "host", fallback(externalText(transport, "host"), externalText(externalSection(transport, "headers"), "Host", "host")))
		querySet(query, "serviceName", externalText(transport, "service_name", "grpc-service-name"))
	}
	link := url.URL{Scheme: protocol, Host: net.JoinHostPort(host, port), User: url.User(secret), RawQuery: query.Encode()}
	entry := profile{Protocol: protocol, URI: link.String(), Label: importedLabel(externalText(fields, "tag", "name", "remarks"))}
	if _, err := profileOutbound(entry); err != nil {
		return profile{}, fmt.Errorf("проверьте данные и транспорт профиля №%d: %w", number, err)
	}
	return entry, nil
}
