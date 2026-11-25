package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"reflect"
	"strconv"
	"strings"

	"routehub/awg"
)

const zapretMark = 0x51000

type object = map[string]any

func xrayProtocol(protocol string) string {
	if protocol == "hysteria2" {
		return "hysteria"
	}
	return protocol
}

func profileOutbound(entry profile) (object, error) {
	if entry.Protocol == "amneziawg" {
		if entry.AWGConfig != "" {
			port := entry.awgPort
			if port == 0 {
				port = 1 // Used only to validate the Xray shape off-line.
			}
			return object{"tag": entry.ID, "protocol": "socks", "settings": object{
				"servers": []object{{"address": "127.0.0.1", "port": port}},
			}}, nil
		}
		return awg.BuildOutbound(entry.ID, entry.Interface)
	}
	if entry.URI != "" {
		return importURI(entry)
	}
	var outbound object
	if err := json.Unmarshal(entry.Outbound, &outbound); err != nil || outbound["protocol"] != xrayProtocol(entry.Protocol) {
		return nil, errors.New("outbound должен содержать соответствующий протокол Xray")
	}
	outbound["tag"] = entry.ID
	return outbound, nil
}

func importURI(entry profile) (object, error) {
	uri, err := url.Parse(entry.URI)
	if err != nil || uri.User == nil || uri.User.Username() == "" || uri.Opaque != "" {
		return nil, errors.New("некорректная ссылка профиля")
	}
	hostname := normalizeHost(uri.Hostname())
	address, _ := netip.ParseAddr(hostname)
	if (!address.IsValid() && !validDomain(hostname)) || address.Zone() != "" {
		return nil, errors.New("некорректный адрес сервера")
	}
	scheme := strings.ToLower(uri.Scheme)
	if scheme == "hy2" {
		scheme = "hysteria2"
	}
	if scheme != entry.Protocol {
		return nil, errors.New("протокол ссылки не совпадает с типом профиля")
	}
	port := uint64(443)
	if uri.Port() != "" {
		port, err = strconv.ParseUint(uri.Port(), 10, 16)
		if err != nil || port == 0 {
			return nil, errors.New("некорректный порт сервера")
		}
	}
	q, err := url.ParseQuery(uri.RawQuery)
	if err != nil {
		return nil, errors.New("некорректные параметры ссылки")
	}
	secret := uri.User.Username()
	if password, ok := uri.User.Password(); ok {
		if scheme == "vless" {
			return nil, errors.New("VLESS ожидает идентификатор в ссылке")
		}
		secret += ":" + password
	}
	settings := object{"address": hostname, "port": port}
	if scheme == "vless" {
		settings["id"] = secret
		settings["encryption"] = fallback(q.Get("encryption"), "none")
		if flow := q.Get("flow"); flow != "" {
			settings["flow"] = flow
		}
	}
	if scheme == "trojan" {
		settings["password"] = secret
	}
	stream, err := transport(scheme, hostname, secret, q)
	if err != nil {
		return nil, err
	}
	if scheme == "hysteria2" {
		settings["version"] = 2
	}
	return object{
		"tag": entry.ID, "protocol": xrayProtocol(scheme),
		"settings": settings, "streamSettings": stream,
	}, nil
}

func fallback(value, defaultValue string) string {
	if value == "" {
		return defaultValue
	}
	return value
}

func transport(scheme, hostname, secret string, q url.Values) (object, error) {
	if q.Get("insecure") == "1" || q.Get("insecure") == "true" ||
		q.Get("allowInsecure") == "1" || q.Get("allowInsecure") == "true" {
		return nil, errors.New("ссылка отключает проверку TLS, нужен проверяемый сертификат или SHA-256 pin")
	}
	security := q.Get("security")
	if scheme != "vless" {
		security = fallback(security, "tls")
	}
	security = fallback(security, "none")
	if (scheme == "hysteria2" && security != "tls") || (scheme == "trojan" && security == "none") {
		return nil, errors.New("этот протокол требует защищённый транспорт")
	}
	method := fallback(q.Get("type"), "raw")
	if scheme == "hysteria2" {
		method = "hysteria"
	}
	stream := object{"security": security}
	switch method {
	case "raw", "tcp":
		method = "raw"
		if header := q.Get("headerType"); header != "" && header != "none" {
			return nil, errors.New("для RAW c нестандартным заголовком используйте JSON outbound")
		}
	case "ws", "websocket":
		method = "websocket"
		stream["wsSettings"] = object{"path": fallback(q.Get("path"), "/"), "host": q.Get("host")}
	case "grpc":
		grpc := object{"serviceName": q.Get("serviceName"), "multiMode": q.Get("mode") == "multi"}
		if authority := q.Get("authority"); authority != "" {
			grpc["authority"] = authority
		}
		stream["grpcSettings"] = grpc
	case "xhttp", "splithttp":
		method = "xhttp"
		stream["xhttpSettings"] = object{"path": fallback(q.Get("path"), "/"), "host": q.Get("host"), "mode": fallback(q.Get("mode"), "auto")}
	case "httpupgrade":
		stream["httpupgradeSettings"] = object{"path": fallback(q.Get("path"), "/"), "host": q.Get("host")}
	case "hysteria":
		if scheme != "hysteria2" {
			return nil, errors.New("транспорт hysteria требует профиль Hysteria2")
		}
		stream["hysteriaSettings"] = object{"version": 2, "auth": secret}
		if obfuscation := q.Get("obfs"); obfuscation != "" {
			if obfuscation != "salamander" || q.Get("obfs-password") == "" {
				return nil, errors.New("поддерживается obfs=salamander с obfs-password")
			}
			stream["finalmask"] = object{"udp": []object{{"type": "salamander", "settings": object{"password": q.Get("obfs-password")}}}}
		}
	default:
		return nil, errors.New("транспорт ссылки не поддерживается, используйте JSON outbound")
	}
	stream["network"] = method
	switch security {
	case "none":
	case "tls":
		tls := object{"serverName": fallback(q.Get("sni"), hostname)}
		if alpn := q.Get("alpn"); alpn != "" {
			tls["alpn"] = strings.Split(alpn, ",")
		}
		if fp := q.Get("fp"); fp != "" {
			tls["fingerprint"] = fp
		}
		if pin := fallback(q.Get("pinSHA256"), q.Get("pcs")); pin != "" {
			tls["pinnedPeerCertSha256"] = pin
		}
		if names := q.Get("vcn"); names != "" {
			tls["verifyPeerCertByName"] = names
		}
		stream["tlsSettings"] = tls
	case "reality":
		if q.Get("pbk") == "" || q.Get("sni") == "" || (method != "raw" && method != "grpc" && method != "xhttp") {
			return nil, errors.New("REALITY требует pbk, sni и транспорт RAW, XHTTP или gRPC")
		}
		stream["realitySettings"] = object{
			"password": q.Get("pbk"), "serverName": q.Get("sni"),
			"fingerprint": fallback(q.Get("fp"), "chrome"), "shortId": q.Get("sid"), "spiderX": q.Get("spx"),
		}
	default:
		return nil, errors.New("поддерживаемые варианты security: tls, reality, none")
	}
	return stream, nil
}

func compileXray(config plan, lan, zapret bool) (object, error) {
	return compileXrayWithAssets(config, lan, zapret, nil)
}

func compileXrayWithAssets(config plan, lan, zapret bool, assetFile func(string) string) (object, error) {
	zapretOutbound := object{"tag": "zapret", "protocol": "freedom"}
	if zapret {
		zapretOutbound["streamSettings"] = object{"sockopt": object{"mark": zapretMark}}
	}
	outbounds := []object{
		{"tag": "direct", "protocol": "freedom"},
		zapretOutbound,
		{"tag": "@block", "protocol": "blackhole"},
	}
	balancers := make([]object, 0)
	groupTargets := make(map[string]string)
	for _, entry := range engineProfiles(config) {
		if entry.XrayGroup != nil {
			members, balancer, err := compileXrayGroup(entry.ID, entry.XrayGroup)
			if err != nil {
				return nil, fmt.Errorf("профиль %q: %w", entry.ID, err)
			}
			outbounds = append(outbounds, members...)
			balancers = append(balancers, balancer)
			groupTargets[entry.ID] = xrayGroupBalancerTag(entry.ID)
			continue
		}
		outbound, err := profileOutbound(entry)
		if err != nil {
			return nil, fmt.Errorf("профиль %q: %w", entry.ID, err)
		}
		outbounds = append(outbounds, outbound)
	}
	inbounds := []object{{
		"tag": "local-socks", "listen": "127.0.0.1", "port": config.SOCKSPort, "protocol": "socks",
		"settings": object{"auth": "noauth", "udp": true, "ip": "127.0.0.1"},
	}}
	if lan {
		listen, network, mode := "127.0.0.1", "tcp,udp", "tproxy"
		if config.Transparent.Mode == transparentRedirectTCP {
			listen, network, mode = config.PanelHost, "tcp", "redirect"
		}
		inbounds = append(inbounds, object{
			"tag": "lan-transparent", "listen": listen, "port": config.Transparent.Port, "protocol": "dokodemo-door",
			"settings":       object{"network": network, "followRedirect": true},
			"streamSettings": object{"sockopt": object{"tproxy": mode}},
			"sniffing":       object{"enabled": true, "destOverride": []string{"http", "tls", "quic"}, "routeOnly": true},
		})
	}
	policy, err := config.policy(lan)
	if err != nil {
		return nil, err
	}
	lanTag := ""
	if lan {
		lanTag = "lan-transparent"
	}
	rules := policy.XrayRulesWithAssets(lanTag, assetFile)
	for _, rule := range rules {
		if target, _ := rule["outboundTag"].(string); groupTargets[target] != "" {
			delete(rule, "outboundTag")
			rule["balancerTag"] = groupTargets[target]
		}
	}
	compiled := object{
		"log":      object{"loglevel": "warning"},
		"inbounds": inbounds, "outbounds": outbounds,
		"routing": object{"domainStrategy": "AsIs", "rules": compactXrayRules(rules)},
	}
	installXrayBalancers(compiled, balancers)
	return compiled, nil
}

// Adjacent rules with the same scope and target can share an OR-list. This
// preserves first-match routing while avoiding thousands of Xray matchers for
// a file containing a list of destinations for one outbound.
func compactXrayRules(rules []object) []object {
	result := make([]object, 0, len(rules))
	for _, next := range rules {
		if len(result) > 0 && appendXrayDestinations(result[len(result)-1], next) {
			continue
		}
		result = append(result, next)
	}
	return result
}

func appendXrayDestinations(previous, next object) bool {
	if len(previous) != len(next) {
		return false
	}
	for _, destination := range []string{"domain", "ip"} {
		left, leftOK := previous[destination].([]string)
		right, rightOK := next[destination].([]string)
		if !leftOK || !rightOK {
			continue
		}
		for key, value := range previous {
			if key != destination && !reflect.DeepEqual(value, next[key]) {
				return false
			}
		}
		previous[destination] = append(left, right...)
		return true
	}
	return false
}
