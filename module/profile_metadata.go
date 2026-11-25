package main

import (
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func profileMetadata(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 100 ||
		strings.ContainsFunc(value, unicode.IsControl) {
		return "", errors.New("название и локация профиля должны содержать не более 100 символов без управляющих знаков")
	}
	return value, nil
}

func importedLabel(value string) string {
	label, _ := profileMetadata(value)
	if strings.Contains(label, "://") {
		return ""
	}
	return label
}

func profileServer(entry profile) string {
	switch {
	case entry.URI != "":
		parsed, err := url.Parse(entry.URI)
		if err == nil {
			return net.JoinHostPort(parsed.Hostname(), fallback(parsed.Port(), "443"))
		}
	case len(entry.Outbound) != 0:
		var outbound struct {
			Settings xrayImportedSettings `json:"settings"`
		}
		if json.Unmarshal(entry.Outbound, &outbound) == nil {
			settings := outbound.Settings
			server := settings.xrayImportedServer
			if len(settings.VNext) != 0 {
				server = settings.VNext[0]
			} else if len(settings.Servers) != 0 {
				server = settings.Servers[0]
			}
			if server.Address != "" && server.Port > 0 {
				return net.JoinHostPort(server.Address, strconv.Itoa(int(server.Port)))
			}
		}
	case entry.AWGConfig != "":
		if config, err := parseManagedAWG(entry.AWGConfig, entry.AWGVersion); err == nil {
			return config.Endpoint
		}
	}
	return ""
}
