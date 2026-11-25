package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	youtubeCheckURL      = "https://www.youtube.com/robots.txt"
	discordCheckURL      = "https://discord.com/api/v10/gateway"
	zapretCheckTimeout   = 7 * time.Second
	zapretDiagnosticMark = 0x100000
)

var (
	errZapretMark    = errors.New("не удалось установить метку сокета Zapret")
	errZapretRuntime = errors.New("очередь RouteHub не активна")
	zapretNonPublic  = [...]netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"),
		netip.MustParsePrefix("240.0.0.0/4"),
	}
)

type zapretCheckResponse struct {
	Service    string `json:"service"`
	Status     string `json:"status"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	LatencyMS  *int64 `json:"latencyMs,omitempty"`
}

type zapretQueueSample struct {
	peer     uint32
	sequence uint32
}

type zapretRuntimeSample struct {
	queue   uint16
	packets uint64
}

type zapretProbe struct {
	runtime func(context.Context) (zapretRuntimeSample, error)
	queue   func(uint16) (zapretQueueSample, bool)
	https   func(context.Context, string) (int, error)
}

func (editor *panelEditor) zapretCheck(runtimeActive bool, helperDir string) http.HandlerFunc {
	return editor.zapretCheckHandler(runtimeActive, newZapretProbe(helperDir, 0))
}

func newZapretProbe(helperDir string, extraMark int) zapretProbe {
	return zapretProbe{
		runtime: func(ctx context.Context) (zapretRuntimeSample, error) {
			ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, filepath.Join(helperDir, "routehub-zapret"), "diagnostic")
			command.WaitDelay = 250 * time.Millisecond
			output, err := command.Output()
			if err != nil {
				return zapretRuntimeSample{}, errZapretRuntime
			}
			return parseZapretRuntime(string(output))
		},
		queue: readZapretQueue,
		https: func(ctx context.Context, endpoint string) (int, error) {
			return runMarkedZapretHTTPS(ctx, endpoint, extraMark)
		},
	}
}

func (editor *panelEditor) zapretCheckHandler(runtimeActive bool, probe zapretProbe) http.HandlerFunc {
	return editor.zapretCheckWithState(func(active plan) (bool, zapretServices) {
		var services zapretServices
		if active.ZapretServices != nil {
			services = *active.ZapretServices
		}
		return runtimeActive && active.Zapret, services
	}, probe)
}

func (editor *panelEditor) zapretCheckWithState(state func(plan) (bool, zapretServices), probe zapretProbe) http.HandlerFunc {
	running := make(chan struct{}, 1)
	return func(response http.ResponseWriter, request *http.Request) {
		if !editor.authorized(request) {
			sendJSON(response, http.StatusForbidden, object{"error": "Доступ к проверке Zapret запрещён"})
			return
		}
		mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			sendJSON(response, http.StatusUnsupportedMediaType, object{"error": "Требуется application/json"})
			return
		}
		var input struct {
			Service string `json:"service"`
		}
		if err := decodeJSON(http.MaxBytesReader(response, request.Body, 256), &input); err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Укажите сервис YouTube или Discord"})
			return
		}
		result := zapretCheckResponse{Service: input.Service}
		applied := editor.current()
		runtimeActive, services := state(applied.plan)
		var endpoint string
		var serviceEnabled bool
		switch input.Service {
		case "youtube":
			endpoint = youtubeCheckURL
			serviceEnabled = services.YouTube
		case "discord":
			endpoint = discordCheckURL
			serviceEnabled = services.Discord
		default:
			sendJSON(response, http.StatusBadRequest, object{"error": "Укажите сервис YouTube или Discord"})
			return
		}
		if !runtimeActive {
			result.Status = "disabled"
			result.Message = "Движок Zapret RouteHub выключен."
		} else if !serviceEnabled {
			result.Status = "disabled"
			result.Message = "Набор Zapret для сервиса выключен в применённой конфигурации."
		} else {
			select {
			case running <- struct{}{}:
				defer func() { <-running }()
			default:
				sendJSON(response, http.StatusTooManyRequests, object{"error": "Дождитесь завершения текущей проверки Zapret"})
				return
			}
			ctx, cancel := context.WithTimeout(request.Context(), zapretCheckTimeout)
			defer cancel()
			probe.check(ctx, endpoint, &result)
			if result.Status == "verified" && applied.Revision != editor.current().Revision {
				result.Status = "unverified"
				result.Message = "HTTPS ответил, но во время проверки изменилась конфигурация RouteHub."
			}
		}
		sendJSON(response, http.StatusOK, result)
	}
}

func (probe zapretProbe) check(ctx context.Context, endpoint string, result *zapretCheckResponse) {
	runtimeBefore, err := probe.runtime(ctx)
	if err != nil {
		result.Status = "unavailable"
		result.Message = "Служба Zapret RouteHub не подтвердила готовность очереди."
		return
	}
	before, beforeOK := probe.queue(runtimeBefore.queue)
	started := time.Now()
	status, err := probe.https(ctx, endpoint)
	elapsed := time.Since(started).Milliseconds()
	result.LatencyMS = &elapsed
	result.HTTPStatus = status
	switch {
	case errors.Is(err, errZapretMark):
		result.Status = "unavailable"
		result.Message = "Не удалось открыть соединение с меткой Zapret."
	case err != nil:
		result.Status = "failed"
		result.Message = "HTTPS-проверка с меткой Zapret завершилась ошибкой или истекло время ожидания."
	case status < 200 || status >= 300:
		result.Status = "failed"
		result.Message = "Проверочный адрес вернул ошибочный статус HTTP."
	default:
		runtimeAfter, runtimeErr := probe.runtime(ctx)
		after, afterOK := probe.queue(runtimeBefore.queue)
		result.Status = "unverified"
		result.Message = "HTTPS с меткой RouteHub ответил. Обработка этого соединения движком Zapret не подтверждена."
		// The helper verifies the first dedicated, non-bypass rule. Normal
		// Zapret traffic does not carry the diagnostic bit or increment it.
		if runtimeErr == nil && runtimeBefore.queue == runtimeAfter.queue &&
			runtimeAfter.packets > runtimeBefore.packets && beforeOK && afterOK &&
			before.peer == after.peer && after.sequence > before.sequence {
			result.Status = "verified"
			result.Message = "Проверочный HTTPS-запрос прошёл через диагностическое правило и очередь Zapret RouteHub."
		}
	}
}

func parseZapretRuntime(output string) (zapretRuntimeSample, error) {
	fields := strings.Fields(output)
	if len(fields) != 3 || fields[0] != "running" || !strings.HasPrefix(fields[1], "queue=") ||
		!strings.HasPrefix(fields[2], "packets=") {
		return zapretRuntimeSample{}, errZapretRuntime
	}
	queue, queueErr := strconv.ParseUint(strings.TrimPrefix(fields[1], "queue="), 10, 16)
	packets, packetErr := strconv.ParseUint(strings.TrimPrefix(fields[2], "packets="), 10, 64)
	if queueErr != nil || packetErr != nil {
		return zapretRuntimeSample{}, errZapretRuntime
	}
	return zapretRuntimeSample{queue: uint16(queue), packets: packets}, nil
}

func readZapretQueue(queue uint16) (zapretQueueSample, bool) {
	file, err := os.Open("/proc/net/netfilter/nfnetlink_queue")
	if err != nil {
		return zapretQueueSample{}, false
	}
	defer file.Close()
	return parseZapretQueue(file, queue)
}

func parseZapretQueue(reader io.Reader, queue uint16) (zapretQueueSample, bool) {
	scanner := bufio.NewScanner(io.LimitReader(reader, 64<<10))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 9 {
			continue
		}
		number, err := strconv.ParseUint(fields[0], 10, 16)
		if err != nil || uint16(number) != queue {
			continue
		}
		peer, peerErr := strconv.ParseUint(fields[1], 10, 32)
		sequence, sequenceErr := strconv.ParseUint(fields[7], 10, 32)
		if peerErr != nil || sequenceErr != nil || peer == 0 {
			return zapretQueueSample{}, false
		}
		return zapretQueueSample{peer: uint32(peer), sequence: uint32(sequence)}, true
	}
	return zapretQueueSample{}, false
}

func isZapretPublicIPv4(address netip.Addr) bool {
	if !address.Is4() || !address.IsGlobalUnicast() || address.IsPrivate() {
		return false
	}
	for _, prefix := range zapretNonPublic {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func newZapretHTTPClient(dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:            dial,
			TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
			DisableKeepAlives:      true,
			DisableCompression:     true,
			TLSHandshakeTimeout:    4 * time.Second,
			ResponseHeaderTimeout:  4 * time.Second,
			MaxResponseHeaderBytes: 16 << 10,
		},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func markedZapretHTTPS(ctx context.Context, endpoint string) (int, error) {
	return runMarkedZapretHTTPS(ctx, endpoint, 0)
}

func runMarkedZapretHTTPS(ctx context.Context, endpoint string, extraMark int) (int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set("User-Agent", "RouteHub")
	authority := net.JoinHostPort(request.URL.Hostname(), "443")
	dialer := &net.Dialer{Timeout: 4 * time.Second, Control: zapretSocketMark(extraMark)}
	client := newZapretHTTPClient(func(ctx context.Context, _, address string) (net.Conn, error) {
		if address != authority {
			return nil, errors.New("неизвестное назначение проверки Zapret")
		}
		addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", request.URL.Hostname())
		if err != nil {
			return nil, err
		}
		for _, ip := range addresses {
			if isZapretPublicIPv4(ip) {
				return dialer.DialContext(ctx, "tcp4", net.JoinHostPort(ip.String(), "443"))
			}
		}
		return nil, errors.New("публичный IPv4 для проверки не найден")
	})
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}
