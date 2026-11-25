package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"golang.org/x/net/publicsuffix"
)

type dnsSettings struct {
	Protocol   string   `json:"protocol"`
	Primary    string   `json:"primary"`
	Secondary  string   `json:"secondary"`
	Cache      bool     `json:"cache"`
	Adblock    bool     `json:"adblock"`
	LAN        bool     `json:"lan,omitempty"`
	Lists      []string `json:"lists"`
	Exceptions []string `json:"exceptions"`
}

var defaultDNS = dnsSettings{
	Protocol: "doh", Primary: "https://dns.quad9.net/dns-query",
	Secondary: "https://cloudflare-dns.com/dns-query", Cache: true, Lists: []string{"normal"}, Exceptions: []string{},
}

var dnsHTTP = &http.Client{
	Transport: &http.Transport{MaxIdleConns: 8, MaxIdleConnsPerHost: 2, MaxConnsPerHost: 8,
		ForceAttemptHTTP2: true, IdleConnTimeout: time.Minute, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}},
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

func normalizeDNSEndpoint(value, protocol string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > 1000 {
		return "", errors.New("укажите адрес DNS-сервера")
	}
	switch protocol {
	case "plain":
		address, err := netip.ParseAddr(strings.Trim(value, "[]"))
		if err == nil && address.Zone() == "" && !address.IsUnspecified() && !address.IsMulticast() {
			return address.Unmap().String(), nil
		}
	case "dot":
		host, port := value, "853"
		if strings.Contains(value, ":") {
			host, port, _ = net.SplitHostPort(value)
		}
		number, err := strconv.ParseUint(port, 10, 16)
		host = normalizeHost(host)
		if err == nil && number > 0 && strings.Contains(host, ".") && validDomain(host) {
			if port == "853" {
				return host, nil
			}
			return net.JoinHostPort(host, port), nil
		}
	case "doh":
		endpoint, err := url.Parse(value)
		if err == nil && endpoint.Scheme == "https" && endpoint.User == nil && endpoint.Fragment == "" &&
			endpoint.Path != "" && endpoint.RawQuery == "" {
			host := endpoint.Hostname()
			address, _ := netip.ParseAddr(host)
			if validDomain(normalizeHost(host)) || address.IsValid() && address.Zone() == "" && !address.IsUnspecified() && !address.IsMulticast() {
				return endpoint.String(), nil
			}
		}
	}
	return "", errors.New("адрес DNS-сервера не соответствует выбранному протоколу")
}

func validateDNSSettings(config dnsSettings) (dnsSettings, error) {
	primary, err := normalizeDNSEndpoint(config.Primary, config.Protocol)
	if err != nil {
		return dnsSettings{}, err
	}
	config.Primary = primary
	config.Secondary = strings.TrimSpace(config.Secondary)
	if config.Secondary != "" {
		config.Secondary, err = normalizeDNSEndpoint(config.Secondary, config.Protocol)
		if err != nil {
			return dnsSettings{}, err
		}
		if config.Secondary == config.Primary {
			return dnsSettings{}, errors.New("основной и резервный серверы должны различаться")
		}
	}
	if len(config.Lists) == 0 {
		config.Lists = []string{"normal"}
	}
	if len(config.Lists) != 1 || denyListAssets[config.Lists[0]] == "" {
		return dnsSettings{}, errors.New("выберите один список HaGeZi")
	}
	if len(config.Exceptions) > 256 {
		return dnsSettings{}, errors.New("поддерживается до 256 исключений")
	}
	exceptions := make([]string, 0, len(config.Exceptions))
	for _, value := range config.Exceptions {
		domain := normalizeHost(value)
		if !validDomain(domain) || !strings.Contains(domain, ".") {
			return dnsSettings{}, errors.New("укажите домен исключения без схемы, звёздочки и пути")
		}
		if !slices.Contains(exceptions, domain) {
			exceptions = append(exceptions, domain)
		}
	}
	config.Exceptions = exceptions
	return config, nil
}

func dnsExchange(ctx context.Context, protocol, endpoint string, question *dns.Msg) (*dns.Msg, error) {
	var reply *dns.Msg
	var err error
	switch protocol {
	case "doh":
		out := question.Copy()
		out.Id = 0
		wire, packingErr := out.Pack()
		if packingErr != nil {
			return nil, packingErr
		}
		req, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(wire))
		if requestErr != nil {
			return nil, requestErr
		}
		req.Header.Set("Content-Type", "application/dns-message")
		req.Header.Set("Accept", "application/dns-message")
		resp, responseErr := dnsHTTP.Do(req)
		if responseErr != nil {
			return nil, responseErr
		}
		defer resp.Body.Close()
		content, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
		if resp.StatusCode != http.StatusOK || content != "application/dns-message" {
			return nil, errors.New("сервер DoH не вернул DNS-сообщение")
		}
		wire, err = io.ReadAll(io.LimitReader(resp.Body, dns.MaxMsgSize+1))
		if err != nil || len(wire) > dns.MaxMsgSize {
			return nil, errors.New("некорректный размер сообщения DoH")
		}
		reply = new(dns.Msg)
		if err := reply.Unpack(wire); err != nil || reply.Id != out.Id {
			return nil, errors.New("некорректный ответ DoH")
		}
		reply.Id = question.Id
	case "dot":
		host, port, err := net.SplitHostPort(endpoint)
		if err != nil {
			host, port = endpoint, "853"
		}
		client := &dns.Client{Net: "tcp-tls",
			TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host}}
		reply, _, err = client.ExchangeContext(ctx, question, net.JoinHostPort(host, port))
		if err != nil {
			return nil, err
		}
	case "plain":
		return exchangePlainDNS(ctx, net.JoinHostPort(endpoint, "53"), question)
	}
	if err != nil {
		return nil, err
	}
	return checkedDNSResponse(question, reply)
}

func exchangePlainDNS(ctx context.Context, address string, question *dns.Msg) (*dns.Msg, error) {
	client := &dns.Client{Net: "udp"}
	reply, _, err := client.ExchangeContext(ctx, question, address)
	if err == nil && reply != nil && reply.Truncated {
		client.Net = "tcp"
		reply, _, err = client.ExchangeContext(ctx, question, address)
	}
	if err != nil {
		return nil, err
	}
	return checkedDNSResponse(question, reply)
}

func checkedDNSResponse(question, reply *dns.Msg) (*dns.Msg, error) {
	if reply == nil || !reply.Response || reply.Truncated || reply.Id != question.Id ||
		len(reply.Question) != 1 || len(question.Question) != 1 ||
		!strings.EqualFold(reply.Question[0].Name, question.Question[0].Name) ||
		reply.Question[0].Qtype != question.Question[0].Qtype || reply.Question[0].Qclass != question.Question[0].Qclass {
		return nil, errors.New("DNS-сервер вернул ответ на другой запрос")
	}
	return reply, nil
}

func suffixSetMatch(name string, entries map[string]struct{}) bool {
	for name != "" {
		if _, exists := entries[name]; exists {
			return true
		}
		if _, suffix, found := strings.Cut(name, "."); found {
			name = suffix
		} else {
			break
		}
	}
	return false
}

var localDNSSuffixes = map[string]struct{}{"home.arpa": {}, "lan": {}, "local": {}, "localdomain": {}}

var localReverseNetworks = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("::1/128"),
}

func isNativeDNSName(host string) bool {
	name := normalizeHost(host)
	if name == "" {
		return false
	}
	if !strings.ContainsRune(name, '.') {
		_, public := publicsuffix.PublicSuffix(name)
		return !public
	}
	if suffixSetMatch(name, localDNSSuffixes) {
		return true
	}
	reverse := reverseDNSPrefix(name)
	for _, network := range localReverseNetworks {
		if reverse.Bits() >= network.Bits() && network.Contains(reverse.Addr()) {
			return true
		}
	}
	return false
}

func reverseDNSPrefix(name string) netip.Prefix {
	if reversed, ok := strings.CutSuffix(name, ".in-addr.arpa"); ok {
		labels := strings.Split(reversed, ".")
		var packed [4]byte
		if len(labels) <= len(packed) {
			for i, label := range labels {
				value, err := strconv.ParseUint(label, 10, 8)
				if err != nil || strconv.FormatUint(value, 10) != label {
					return netip.Prefix{}
				}
				packed[len(labels)-1-i] = byte(value)
			}
			return netip.PrefixFrom(netip.AddrFrom4(packed), len(labels)*8)
		}
	}
	if reversed, ok := strings.CutSuffix(name, ".ip6.arpa"); ok {
		labels := strings.Split(reversed, ".")
		var packed [16]byte
		if len(labels) <= len(packed)*2 {
			for i, label := range labels {
				value, err := strconv.ParseUint(label, 16, 4)
				if err != nil || len(label) != 1 {
					return netip.Prefix{}
				}
				position := len(labels) - 1 - i
				packed[position/2] |= byte(value) << (4 * (1 - position%2))
			}
			return netip.PrefixFrom(netip.AddrFrom16(packed), len(labels)*4)
		}
	}
	return netip.Prefix{}
}

type dnsCacheKey struct {
	name     string
	kind     uint16
	dnssec   bool
	checking bool
}

type dnsCacheEntry struct {
	msg    *dns.Msg
	stored time.Time
	ttl    time.Duration
}

type dnsResolver struct {
	settings   dnsSettings
	blocklist  map[string]struct{}
	exceptions map[string]struct{}
	nativeDNS  netip.AddrPort
	cacheMu    sync.Mutex
	cache      map[dnsCacheKey]dnsCacheEntry
}

func newDNSResolver(settings dnsSettings, list map[string]struct{}) *dnsResolver {
	resolver := &dnsResolver{settings: settings, blocklist: list,
		exceptions: make(map[string]struct{}, len(settings.Exceptions)), cache: make(map[dnsCacheKey]dnsCacheEntry)}
	for _, domain := range settings.Exceptions {
		resolver.exceptions[domain] = struct{}{}
	}
	return resolver
}

func (resolver *dnsResolver) blocked(name string) bool {
	name = normalizeHost(name)
	return resolver.settings.Adblock && !suffixSetMatch(name, resolver.exceptions) && suffixSetMatch(name, resolver.blocklist)
}

func (resolver *dnsResolver) cached(key dnsCacheKey, question *dns.Msg, now time.Time) *dns.Msg {
	resolver.cacheMu.Lock()
	entry, exists := resolver.cache[key]
	if exists && now.Sub(entry.stored) >= entry.ttl {
		delete(resolver.cache, key)
		exists = false
	}
	resolver.cacheMu.Unlock()
	if !exists {
		return nil
	}
	copy := entry.msg.Copy()
	copy.Id, copy.Question = question.Id, question.Question
	age := uint32(now.Sub(entry.stored) / time.Second)
	for _, section := range [][]dns.RR{copy.Answer, copy.Ns, copy.Extra} {
		for _, record := range section {
			if hdr := record.Header(); hdr.Rrtype != dns.TypeOPT {
				hdr.Ttl -= min(hdr.Ttl, age)
			}
		}
	}
	return copy
}

func (resolver *dnsResolver) memorize(key dnsCacheKey, msg *dns.Msg, now time.Time) {
	if msg.Rcode != dns.RcodeSuccess || len(msg.Answer) == 0 {
		return
	}
	ttl := uint32(3600)
	for _, section := range [][]dns.RR{msg.Answer, msg.Ns, msg.Extra} {
		for _, record := range section {
			if header := record.Header(); header.Rrtype != dns.TypeOPT {
				ttl = min(ttl, header.Ttl)
			}
		}
	}
	if ttl == 0 {
		return
	}
	resolver.cacheMu.Lock()
	defer resolver.cacheMu.Unlock()
	if len(resolver.cache) >= 1024 {
		for key, old := range resolver.cache {
			delete(resolver.cache, key)
			if now.Sub(old.stored) < old.ttl {
				break
			}
		}
	}
	resolver.cache[key] = dnsCacheEntry{msg: msg.Copy(), stored: now, ttl: time.Duration(ttl) * time.Second}
}

func (resolver *dnsResolver) resolve(ctx context.Context, question *dns.Msg) *dns.Msg {
	reply := new(dns.Msg)
	if len(question.Question) != 1 || question.Opcode != dns.OpcodeQuery ||
		question.Question[0].Qclass != dns.ClassINET || question.IsTsig() != nil {
		return reply.SetRcode(question, dns.RcodeRefused)
	}
	q := question.Question[0]
	if resolver.nativeDNS.IsValid() && isNativeDNSName(q.Name) {
		// DHCP records may change before their advertised TTL. Keep the native
		// resolver authoritative and never retry these names via a public upstream.
		native, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		answer, err := exchangePlainDNS(native, resolver.nativeDNS.String(), question)
		if err != nil {
			return reply.SetRcode(question, dns.RcodeServerFailure)
		}
		return answer
	}
	if resolver.blocked(q.Name) {
		return reply.SetRcode(question, dns.RcodeNameError)
	}
	key := dnsCacheKey{name: normalizeHost(q.Name), kind: q.Qtype, checking: question.CheckingDisabled}
	cache := resolver.settings.Cache && question.RecursionDesired
	if option := question.IsEdns0(); option != nil {
		key.dnssec = option.Do()
		cache = cache && len(option.Option) == 0
	}
	now := time.Now()
	if cache {
		if answer := resolver.cached(key, question, now); answer != nil {
			return answer
		}
	}
	for _, server := range []string{resolver.settings.Primary, resolver.settings.Secondary} {
		if server == "" {
			continue
		}
		probe, cancel := context.WithTimeout(ctx, 2*time.Second)
		answer, err := dnsExchange(probe, resolver.settings.Protocol, server, question)
		cancel()
		if err != nil || answer.Rcode == dns.RcodeServerFailure || answer.Rcode == dns.RcodeRefused {
			continue
		}
		if !suffixSetMatch(normalizeHost(q.Name), resolver.exceptions) {
			for _, record := range answer.Answer {
				if alias, ok := record.(*dns.CNAME); ok && resolver.blocked(alias.Target) {
					return reply.SetRcode(question, dns.RcodeNameError)
				}
			}
		}
		if cache {
			resolver.memorize(key, answer, time.Now())
		}
		return answer
	}
	return reply.SetRcode(question, dns.RcodeServerFailure)
}
