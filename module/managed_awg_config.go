package main

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

type managedAWGConfig struct {
	Version    string
	Endpoint   string
	Addresses  []netip.Addr
	DNS        []netip.Addr
	MTU        int
	Parameters string
}

var advancedAWGKeys = map[string]string{
	"privatekey": "private_key", "jc": "jc", "jmin": "jmin", "jmax": "jmax",
	"s1": "s1", "s2": "s2", "s3": "s3", "s4": "s4",
	"h1": "h1", "h2": "h2", "h3": "h3", "h4": "h4", "i1": "i1", "i2": "i2", "i3": "i3", "i4": "i4", "i5": "i5",
	"headerprotectionkey": "header_protection_key", "contentpaddingaddition": "content_padding_addition",
	"rekeyaftertime": "rekey_after_time", "rekeytimeout": "rekey_timeout", "rejectaftertime": "reject_after_time",
	"keepalivetimeout": "keepalive_timeout", "maxhandshakeattempts": "max_handshake_attempts",
	"randomtrailers": "random_trailers", "disablecookies": "disable_cookies",
}
var awgRange = regexp.MustCompile(`^[0-9]+(-[0-9]+)?$`)

func validAWGVersion(version string) bool { return version == "2.0" || version == "3.1" }

func awgKey(value string) (string, bool) {
	bits, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(bits) != 32 {
		return "", false
	}
	return hex.EncodeToString(bits), true
}

func awgLines(text string) (map[string]string, map[string]string, string, error) {
	if len(text) > 128<<10 {
		return nil, nil, "", errors.New("файл AmneziaWG превышает 128 КиБ")
	}
	var current map[string]string
	var version string
	intf, peer := map[string]string{}, map[string]string{}
	for i, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			header := strings.ToLower(line[1:])
			if strings.Contains(header, "amneziawg") || strings.Contains(header, "version") {
				for _, option := range []string{"2.0", "3.1"} {
					if strings.Contains(header, option) {
						version = option
					}
				}
			}
			continue
		}
		if line == "" {
			continue
		}
		switch strings.ToLower(line) {
		case "[interface]":
			if current == nil {
				current = intf
				continue
			}
		case "[peer]":
			if len(intf) > 0 && len(peer) == 0 && current["privatekey"] != "" {
				current = peer
				continue
			}
		}
		key, value, found := strings.Cut(line, "=")
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if current == nil || !found || key == "" || value == "" || current[key] != "" ||
			strings.ContainsAny(value, "\r\n\x00") {
			return nil, nil, "", fmt.Errorf("проверьте строку %d файла AmneziaWG. Поддерживается один интерфейс и один peer", i+1)
		}
		current[key] = value
	}
	return intf, peer, version, nil
}

func parseManagedAWG(text, version string) (managedAWGConfig, error) {
	intf, peer, tagged, err := awgLines(text)
	if err != nil {
		return managedAWGConfig{}, err
	}
	version = fallback(version, fallback(tagged, "3.1"))
	if !validAWGVersion(version) || tagged != "" && tagged != version {
		return managedAWGConfig{}, errors.New("проверьте версию AmneziaWG (2.0 или 3.1)")
	}
	settings := managedAWGConfig{Version: version, MTU: 1280}
	var parameters strings.Builder
	privateKey, secretOK := awgKey(intf["privatekey"])
	publicKey, peerOK := awgKey(peer["publickey"])
	if !secretOK || !peerOK {
		return managedAWGConfig{}, errors.New("AmneziaWG требует PrivateKey и PublicKey из 32 байт")
	}
	fmt.Fprintf(&parameters, "private_key=%s\n", privateKey)
	for key, value := range intf {
		switch key {
		case "privatekey", "address", "dns", "mtu":
		default:
			kernelKey, ok := advancedAWGKeys[key]
			if !ok {
				return managedAWGConfig{}, errors.New("в [Interface] есть неизвестный параметр либо команда запуска")
			}
			switch {
			case key == "headerprotectionkey":
				value, ok = awgKey(value)
			case key == "disablecookies":
				value = strings.ToLower(value)
				ok = value == "true" || value == "false"
			case len(key) == 2 && key[0] == 'i':
				ok = len(value) <= 8192 && strings.HasPrefix(value, "<") && strings.HasSuffix(value, ">")
			default:
				ok = awgRange.MatchString(value)
			}
			if !ok {
				return managedAWGConfig{}, errors.New("некорректное значение параметра AmneziaWG")
			}
			fmt.Fprintf(&parameters, "%s=%s\n", kernelKey, value)
		}
	}
	for _, value := range strings.Split(intf["address"], ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil || prefix.Addr().IsUnspecified() || prefix.Addr().IsMulticast() {
			return managedAWGConfig{}, errors.New("укажите адрес интерфейса AmneziaWG в формате CIDR")
		}
		settings.Addresses = append(settings.Addresses, prefix.Addr())
	}
	if servers := intf["dns"]; servers != "" {
		for _, value := range strings.Split(servers, ",") {
			ip, err := netip.ParseAddr(strings.TrimSpace(value))
			if err != nil || ip.Zone() != "" || ip.IsUnspecified() || ip.IsMulticast() {
				return managedAWGConfig{}, errors.New("используйте IP-адреса в параметре DNS AmneziaWG")
			}
			settings.DNS = append(settings.DNS, ip.Unmap())
		}
	}
	if len(settings.DNS) == 0 {
		settings.DNS = []netip.Addr{netip.MustParseAddr("1.1.1.1")}
	}
	if mtu := intf["mtu"]; mtu != "" {
		size, err := strconv.Atoi(mtu)
		if err != nil || size < 576 || size > 1500 {
			return managedAWGConfig{}, errors.New("укажите MTU AmneziaWG в пределах 576–1500")
		}
		settings.MTU = size
	}
	if len(settings.Addresses) > 8 || len(settings.DNS) > 4 {
		return managedAWGConfig{}, errors.New("слишком много адресов интерфейса или DNS")
	}
	host, port, splitErr := net.SplitHostPort(peer["endpoint"])
	number, portErr := strconv.ParseUint(port, 10, 16)
	address, _ := netip.ParseAddr(host)
	if splitErr != nil || portErr != nil || number == 0 ||
		!(validDomain(normalizeHost(host)) || address.IsValid() && address.Zone() == "" && !address.IsUnspecified()) {
		return managedAWGConfig{}, errors.New("укажите Endpoint AmneziaWG в формате сервер:порт")
	}
	settings.Endpoint = net.JoinHostPort(host, port)
	fmt.Fprintf(&parameters, "public_key=%s\nreplace_allowed_ips=true\n", publicKey)
	for key, value := range peer {
		switch key {
		case "publickey", "endpoint", "allowedips":
		case "presharedkey":
			key, ok := awgKey(value)
			if !ok {
				return managedAWGConfig{}, errors.New("проверьте PresharedKey в [Peer]")
			}
			fmt.Fprintf(&parameters, "preshared_key=%s\n", key)
		case "persistentkeepalive":
			if !awgRange.MatchString(value) {
				return managedAWGConfig{}, errors.New("проверьте PersistentKeepalive в [Peer]")
			}
			fmt.Fprintf(&parameters, "persistent_keepalive_interval=%s\n", value)
		default:
			return managedAWGConfig{}, errors.New("в [Peer] есть неизвестный параметр")
		}
	}
	routes := strings.Split(peer["allowedips"], ",")
	if len(routes) > 128 {
		return managedAWGConfig{}, errors.New("допустимо до 128 сетей AllowedIPs")
	}
	for _, value := range routes {
		network, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			return managedAWGConfig{}, errors.New("укажите AllowedIPs в формате CIDR")
		}
		fmt.Fprintf(&parameters, "allowed_ip=%s\n", network.Masked())
	}
	settings.Parameters = parameters.String()
	return settings, nil
}

func parseManagedAWGPreview(text, version string) (profileImportPreview, error) {
	config, err := parseManagedAWG(text, version)
	if err != nil {
		return profileImportPreview{}, err
	}
	return profileImportPreview{Profiles: []profile{{Protocol: "amneziawg", AWGVersion: config.Version, AWGConfig: text}}}, nil
}
