package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/net/publicsuffix"
)

const (
	maxSubscriptions        = 8
	maxSubscriptionURL      = 1536
	maxSubscriptionBody     = 384 << 10
	maxSubscriptionRows     = 512
	maxSubscriptionProfiles = 128
	maxCatalogProfiles      = 256
	blockedDeviceLabel      = "Ключ на устройстве заблокирован"
)

var errSubscriptionDeviceBlocked = errors.New("провайдер заблокировал ключ для этого устройства. Добавьте подписку для роутера в личном кабинете провайдера")
var subscriptionDeviceID = regexp.MustCompile(`^[A-Za-z0-9=\-]{10,64}$`)

type subscription struct {
	ID            string               `json:"id"`
	Name          string               `json:"name"`
	Type          string               `json:"type"`
	URL           string               `json:"url"`
	DeviceID      string               `json:"deviceId,omitempty"`
	UserAgent     string               `json:"userAgent,omitempty"`
	HasDeviceID   bool                 `json:"hasDeviceId,omitempty"`
	IntervalHours int                  `json:"intervalHours"`
	Enabled       bool                 `json:"enabled"`
	AddedAt       time.Time            `json:"addedAt,omitzero"`
	LastSuccess   *subscriptionSuccess `json:"lastSuccess,omitempty"`
	LastAttempt   *subscriptionAttempt `json:"lastAttempt,omitempty"`
	ETag          string               `json:"etag,omitempty"`
	LastModified  string               `json:"lastModified,omitempty"`
}

type subscriptionSuccess struct {
	At       time.Time `json:"at"`
	Revision string    `json:"revision"`
	Profiles int       `json:"profiles"`
}

type subscriptionAttempt struct {
	At     time.Time `json:"at"`
	OK     bool      `json:"ok"`
	Reason string    `json:"reason,omitempty"`
}

type subscriptionStatus struct {
	ID          string               `json:"subscriptionId"`
	LastSuccess *subscriptionSuccess `json:"lastSuccess"`
	LastAttempt *subscriptionAttempt `json:"lastAttempt"`
	NextRun     *time.Time           `json:"nextRun"`
}

func subscriptionEndpoint(value string) (*url.URL, error) {
	invalid := errors.New("нужна HTTPS-ссылка подписки без пользовательского имени, фрагмента и нестандартного порта")
	if len(value) > maxSubscriptionURL {
		return nil, invalid
	}
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Opaque != "" || parsed.User != nil ||
		parsed.Fragment != "" || parsed.Host == "" || (parsed.Port() != "" && parsed.Port() != "443") {
		return nil, invalid
	}
	host := normalizeHost(parsed.Hostname())
	if ip, err := netip.ParseAddr(host); err == nil {
		if !isZapretPublicIPv4(ip.Unmap()) || !ip.Is4() {
			return nil, errors.New("сервер подписки должен иметь публичный IPv4-адрес")
		}
	} else if !validDomain(host) || !strings.Contains(host, ".") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".home.arpa") || strings.HasSuffix(host, ".internal") {
		return nil, invalid
	}
	parsed.Host = host
	return parsed, nil
}

func validateSubscriptions(sources []subscription) ([]subscription, error) {
	if len(sources) > maxSubscriptions {
		return nil, errors.New("поддерживается до восьми подписок")
	}
	if len(sources) == 0 {
		return nil, nil
	}
	sources = slices.Clone(sources)
	usedIDs, usedURLs := make(map[string]bool), make(map[string]bool)
	for i := range sources {
		source := &sources[i]
		if !validDomain(source.ID) || strings.Contains(source.ID, ".") || usedIDs[source.ID] ||
			source.Type != "vless-list" || source.IntervalHours < 1 || source.IntervalHours > 168 {
			return nil, errors.New("проверьте идентификатор, тип и интервал обновления подписки от 1 до 168 часов")
		}
		name, err := profileMetadata(source.Name)
		if err != nil || name == "" || strings.Contains(name, "://") {
			return nil, errors.New("укажите название подписки")
		}
		endpoint, err := subscriptionEndpoint(source.URL)
		if err != nil {
			return nil, err
		}
		if source.DeviceID != "" && !subscriptionDeviceID.MatchString(source.DeviceID) {
			return nil, errors.New("ID устройства должен содержать от 10 до 64 латинских букв, цифр, дефисов или знаков =")
		}
		source.UserAgent = strings.TrimSpace(source.UserAgent)
		if !validSubscriptionUserAgent(source.UserAgent) {
			return nil, errors.New("User-Agent должен содержать не более 128 печатных символов ASCII")
		}
		source.Name, source.URL = name, endpoint.String()
		source.HasDeviceID = false
		source.ETag, source.LastModified = safeSubscriptionHeader(source.ETag), safeSubscriptionHeader(source.LastModified)
		if usedURLs[source.URL] {
			return nil, errors.New("эта ссылка подписки уже добавлена")
		}
		usedIDs[source.ID], usedURLs[source.URL] = true, true
	}
	return sources, nil
}

func publicSubscriptions(sources []subscription) []subscription {
	out := make([]subscription, 0, len(sources))
	for _, source := range sources {
		masked := "••••"
		if endpoint, err := subscriptionEndpoint(source.URL); err == nil {
			masked = "https://" + endpoint.Hostname() + "/••••"
		}
		out = append(out, subscription{ID: source.ID, Name: source.Name, Type: source.Type,
			URL: masked, UserAgent: source.UserAgent, HasDeviceID: source.DeviceID != "", Enabled: source.Enabled, IntervalHours: source.IntervalHours})
	}
	return out
}

func (s subscription) status() subscriptionStatus {
	status := subscriptionStatus{ID: s.ID, LastAttempt: s.LastAttempt, LastSuccess: s.LastSuccess}
	if s.Enabled {
		from := s.AddedAt
		if s.LastAttempt != nil {
			from = s.LastAttempt.At
		}
		if from.IsZero() {
			from = time.Unix(0, 0).UTC()
		}
		next := from.Add(time.Duration(s.IntervalHours) * time.Hour)
		status.NextRun = &next
	}
	return status
}

func subscriptionDial(ctx context.Context, _, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port != "443" {
		return nil, errors.New("неподдерживаемое назначение подписки")
	}
	addresses := []netip.Addr{}
	if addr, err := netip.ParseAddr(host); err == nil {
		addresses = append(addresses, addr)
	} else {
		addresses, err = net.DefaultResolver.LookupNetIP(ctx, "ip4", host+".")
		if err != nil {
			return nil, errors.New("не удалось разрешить имя сервера подписки")
		}
	}
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	for _, addr := range addresses[:min(len(addresses), 4)] {
		if isZapretPublicIPv4(addr.Unmap()) {
			if conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(addr.Unmap().String(), port)); err == nil {
				return conn, nil
			}
		}
	}
	return nil, errors.New("нет доступного публичного IPv4 сервера подписки")
}

type subscriptionDownload struct {
	body           []byte
	etag, modified string
	unchanged      bool
}

func fetchSubscription(ctx context.Context, source subscription) (subscriptionDownload, error) {
	client := newZapretHTTPClient(subscriptionDial)
	client.Timeout = 15 * time.Second
	defer client.CloseIdleConnections()
	return downloadSubscription(ctx, source, client)
}

func downloadSubscription(ctx context.Context, source subscription, client *http.Client) (subscriptionDownload, error) {
	endpoint, err := subscriptionEndpoint(source.URL)
	if err != nil {
		return subscriptionDownload{}, err
	}
	jar, err := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	if err != nil {
		return subscriptionDownload{}, errors.New("не удалось подготовить сеанс подписки")
	}
	client.Jar = jar
	var redirectLoop bool
	var retriedWithCookie bool
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		target, err := subscriptionEndpoint(next.URL.String())
		if err != nil || len(via) > 3 || target.Hostname() != endpoint.Hostname() {
			return http.ErrUseLastResponse
		}
		for i, previous := range via {
			if target.String() != previous.URL.String() {
				continue
			}
			if i == len(via)-1 && !retriedWithCookie && hasNewSubscriptionCookie(previous.Cookies(), jar.Cookies(target)) {
				retriedWithCookie = true
				break
			}
			redirectLoop = true
			return http.ErrUseLastResponse
		}
		next.URL = target
		next.Header.Del("Referer")
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return subscriptionDownload{}, errors.New("не удалось подготовить HTTPS-запрос подписки")
	}
	if !validSubscriptionUserAgent(source.UserAgent) {
		return subscriptionDownload{}, errors.New("некорректный User-Agent подписки")
	}
	request.Header.Set("Accept", "application/json, text/plain;q=0.9, */*;q=0.1")
	request.Header.Set("User-Agent", fallback(source.UserAgent, "RouteHub"))
	if source.DeviceID != "" {
		request.Header.Set("X-HWID", source.DeviceID)
	}
	if source.ETag != "" {
		request.Header.Set("If-None-Match", source.ETag)
	}
	if source.LastModified != "" {
		request.Header.Set("If-Modified-Since", source.LastModified)
	}
	response, err := client.Do(request)
	if err != nil {
		return subscriptionDownload{}, errors.New("сервер подписки не ответил по HTTPS")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified && source.LastSuccess != nil {
		return subscriptionDownload{unchanged: true}, nil
	}
	if response.StatusCode != http.StatusOK {
		if redirectLoop {
			return subscriptionDownload{}, errors.New("сервер подписки вернул HTTP " + strconv.Itoa(response.StatusCode) + " и снова перенаправляет на тот же адрес")
		}
		if response.StatusCode >= 300 && response.StatusCode < 400 {
			return subscriptionDownload{}, errors.New("сервер подписки вернул неподдерживаемое перенаправление")
		}
		return subscriptionDownload{}, errors.New("сервер подписки отклонил запрос")
	}
	if response.ContentLength > maxSubscriptionBody {
		return subscriptionDownload{}, errors.New("ответ подписки больше 384 КиБ")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxSubscriptionBody+1))
	if err != nil {
		return subscriptionDownload{}, errors.New("не удалось прочитать ответ подписки")
	}
	if len(data) > maxSubscriptionBody {
		return subscriptionDownload{}, errors.New("ответ подписки больше 384 КиБ")
	}
	return subscriptionDownload{body: data, etag: safeSubscriptionHeader(response.Header.Get("ETag")),
		modified: safeSubscriptionHeader(response.Header.Get("Last-Modified"))}, nil
}

func hasNewSubscriptionCookie(sent, next []*http.Cookie) bool {
	for _, cookie := range next {
		if cookie.Value != "" && !slices.ContainsFunc(sent, func(previous *http.Cookie) bool {
			return cookie.Name == previous.Name && cookie.Value == previous.Value
		}) {
			return true
		}
	}
	return false
}

func validSubscriptionUserAgent(value string) bool {
	return len(value) <= 128 && !strings.ContainsFunc(value, func(r rune) bool { return r < 0x20 || r > 0x7e })
}

func safeSubscriptionHeader(value string) string {
	if len(value) > 256 || strings.ContainsAny(value, "\r\n\x00") {
		return ""
	}
	return value
}

type incompatibleSubscriptionRow struct {
	Key    string `json:"upstreamKey"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

func parseSubscription(data []byte) ([]profile, []incompatibleSubscriptionRow, error) {
	unsupported := make([]incompatibleSubscriptionRow, 0)
	if len(data) > maxSubscriptionBody {
		return nil, unsupported, errors.New("ответ подписки больше 384 КиБ")
	}
	data = bytes.TrimSpace(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}))
	isJSON := func(data []byte) bool { return len(data) > 0 && (data[0] == '{' || data[0] == '[') }
	if isJSON(data) {
		return parseSubscriptionXrayJSON(data)
	}
	if !bytes.Contains(data, []byte("://")) {
		compact := bytes.Map(func(char rune) rune {
			switch char {
			case '\r', '\n', '\t', ' ':
				return -1
			}
			return char
		}, data)
		decoded := make([]byte, base64.RawStdEncoding.DecodedLen(len(compact)))
		for _, alphabet := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if count, err := alphabet.Decode(decoded, compact); err == nil {
				data = bytes.TrimSpace(bytes.TrimPrefix(decoded[:count], []byte{0xef, 0xbb, 0xbf}))
				break
			}
		}
	}
	if isJSON(data) {
		return parseSubscriptionXrayJSON(data)
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return nil, unsupported, errors.New("подписка должна содержать текстовый список VLESS или Base64")
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if len(lines) > maxSubscriptionRows {
		return nil, unsupported, errors.New("подписка содержит слишком много строк")
	}
	out, unique := make([]profile, 0), make(map[string]bool)
	var blockedDevice bool
	for i, raw := range lines {
		raw = strings.TrimSpace(raw)
		if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		entry := subscriptionRow(raw)
		if entry.Protocol == "" {
			if len(unsupported) < 24 {
				unsupported = append(unsupported, incompatibleSubscriptionRow{
					Key: subscriptionDigest(raw), Name: "Строка " + strconv.Itoa(i+1), Reason: "нужен совместимый профиль VLESS",
				})
			}
			continue
		}
		blockedDevice = blockedDevice || strings.EqualFold(entry.Label, blockedDeviceLabel)
		if !unique[entry.UpstreamKey] {
			out = append(out, entry)
			unique[entry.UpstreamKey] = true
		}
		if len(out) > maxSubscriptionProfiles {
			return nil, unsupported, errors.New("подписка содержит более 128 совместимых профилей")
		}
	}
	if blockedDevice && len(out) == 1 {
		return nil, unsupported, errSubscriptionDeviceBlocked
	}
	if len(out) == 0 {
		return nil, unsupported, errors.New("в подписке нет совместимых профилей VLESS")
	}
	return out, unsupported, nil
}

func subscriptionRow(value string) profile {
	if len(value) > 6000 {
		return profile{}
	}
	raw, _, _ := strings.Cut(value, "#")
	if !strings.HasPrefix(strings.ToLower(raw), "vless://") {
		return profile{}
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User == nil || !validSubscriptionNodeHost(parsed.Hostname()) {
		return profile{}
	}
	result, err := parseProfileLinks([]uploadLine{{value: value, number: 1}})
	if err != nil {
		return profile{}
	}
	entry := result.Profiles[0]
	if strings.Contains(entry.Label, parsed.User.Username()) {
		entry.Label = ""
	}
	entry.Label = fallback(entry.Label, "VLESS")
	entry.UpstreamName = entry.Label
	entry.UpstreamKey = subscriptionKey(parsed)
	entry.CatalogProfile = true
	return entry
}

func validSubscriptionNodeHost(value string) bool {
	if address, err := netip.ParseAddr(value); err == nil {
		return isZapretPublicIPv4(address.Unmap())
	}
	host := normalizeHost(value)
	return validDomain(host) && strings.Contains(host, ".") && !strings.HasSuffix(host, ".home.arpa") &&
		!strings.HasSuffix(host, ".local") && !strings.HasSuffix(host, ".internal") && !strings.HasSuffix(host, ".localhost")
}

func subscriptionKey(parsed *url.URL) string {
	return subscriptionDigest(parsed.User.String() + "@" + subscriptionNodeLocation(parsed) + "?" + parsed.Query().Encode())
}

func subscriptionNodeLocation(parsed *url.URL) string {
	return net.JoinHostPort(normalizeHost(parsed.Hostname()), fallback(parsed.Port(), "443")) + parsed.EscapedPath()
}

func subscriptionEndpointKey(entry profile) string {
	if entry.XrayGroup != nil {
		members := make([]string, 0, len(entry.XrayGroup.Members))
		for _, member := range entry.XrayGroup.Members {
			key := subscriptionJSONEndpointKey(member.Outbound)
			if key == "" {
				return ""
			}
			members = append(members, key)
		}
		slices.Sort(members)
		return "group|" + subscriptionDigest(strings.Join(members, "\n"))
	}
	if len(entry.Outbound) != 0 {
		if entry.Protocol == "hysteria2" {
			return "hysteria2|" + profileServer(entry)
		}
		return subscriptionJSONEndpointKey(entry.Outbound)
	}
	parsed, err := url.Parse(entry.URI)
	if err != nil {
		return ""
	}
	query := parsed.Query()
	return "uri|" + subscriptionNodeLocation(parsed) + "|" + query.Get("type") + "|" + query.Get("security") + "|" +
		query.Get("sni") + "|" + query.Get("host") + "|" + query.Get("path") + "|" + query.Get("serviceName")
}

func subscriptionJSONEndpointKey(outbound json.RawMessage) string {
	server, ok := subscriptionJSONServer(outbound)
	if !ok {
		return ""
	}
	type header struct {
		Host string
		Path string
	}
	type secure struct{ ServerName string }
	var parsed struct {
		StreamSettings struct {
			Network, Security string
			TLS               secure                       `json:"tlsSettings"`
			Reality           secure                       `json:"realitySettings"`
			WebSocket         header                       `json:"wsSettings"`
			XHTTP             header                       `json:"xhttpSettings"`
			SplitHTTP         header                       `json:"splithttpSettings"`
			HTTPUpgrade       header                       `json:"httpupgradeSettings"`
			GRPC              struct{ ServiceName string } `json:"grpcSettings"`
		}
	}
	if json.Unmarshal(outbound, &parsed) != nil {
		return ""
	}
	stream := parsed.StreamSettings
	return strings.Join([]string{
		"json", net.JoinHostPort(normalizeHost(server.Address), strconv.Itoa(int(server.Port))), stream.Network, stream.Security,
		stream.TLS.ServerName, stream.Reality.ServerName, stream.GRPC.ServiceName,
		stream.WebSocket.Host, stream.WebSocket.Path, stream.XHTTP.Host, stream.XHTTP.Path,
		stream.SplitHTTP.Host, stream.SplitHTTP.Path, stream.HTTPUpgrade.Host, stream.HTTPUpgrade.Path,
	}, "|")
}

func subscriptionDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:16])
}
