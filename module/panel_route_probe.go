package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/proxy"

	"routehub/devicepolicy"
)

type panelTraceQuery struct {
	Source     panelRouteSource `json:"source"`
	Target     string           `json:"target"`
	ResolvedIP string           `json:"resolvedIp,omitempty"`
	Proto      string           `json:"proto"`
	Port       uint16           `json:"port"`
	FlowID     string           `json:"flowId,omitempty"`
}

type panelProbeStage struct {
	Stage  string `json:"stage"`
	Label  string `json:"label"`
	State  string `json:"state"`
	MS     *int64 `json:"ms,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type panelProbeResult struct {
	Target       string            `json:"target"`
	ExitLabel    string            `json:"exitLabel"`
	Stages       []panelProbeStage `json:"stages"`
	TotalMS      *int64            `json:"totalMs,omitempty"`
	ObservedFrom string            `json:"observedFrom"`
	Note         string            `json:"note"`
}

func (diagnostics *panelDiagnostics) realTest(response http.ResponseWriter, request *http.Request) {
	var query panelTraceQuery
	if !runtimeRequest(response, request, diagnostics.editor, &query) {
		return
	}
	query.Target = normalizeHost(query.Target)
	config := diagnostics.editor.current().plan
	input := destination{Host: query.Target, TargetIP: query.ResolvedIP, Network: query.Proto, Port: query.Port}
	switch query.Source.Type {
	case "device":
		mac, err := devicepolicy.NormalizeMAC(query.Source.DeviceID)
		if err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Выберите устройство"})
			return
		}
		topology := diagnostics.topologySnapshot(request.Context())
		if !diagnostics.state.LAN || config.Transparent == nil || !slices.ContainsFunc(topology.Devices, func(device panelTopologyDevice) bool {
			return device.ID == mac && topologyDeviceCaptured(device, config.Transparent)
		}) {
			sendJSON(response, http.StatusBadRequest, object{"error": "Keenetic не подтвердил устройство в подсети действующего перехвата RouteHub"})
			return
		}
		input.ClientMAC = mac
	case "segment":
		if config.Transparent != nil && query.Source.SegmentID != config.Transparent.Interface {
			sendJSON(response, http.StatusBadRequest, object{"error": "Выберите сегмент перехвата RouteHub"})
			return
		}
	default:
		sendJSON(response, http.StatusBadRequest, object{"error": "Выберите сегмент или устройство"})
		return
	}
	if query.Proto != "tcp" || (query.Port != 80 && query.Port != 443) || query.FlowID != "" {
		sendJSON(response, http.StatusBadRequest, object{"error": "Роутер может выполнить HTTP или HTTPS по TCP на порту 80 или 443"})
		return
	}
	if diagnostics.control != nil {
		selection, _ := diagnostics.control.state()
		config = runtimePlan(config, selection)
	}
	policy, err := config.policy(diagnostics.state.LAN)
	if err != nil {
		sendJSON(response, http.StatusInternalServerError, object{"error": "Не удалось прочитать рабочую политику"})
		return
	}
	resolveDecision := policy.Evaluate
	route, err := resolveDecision(input)
	if err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": err.Error()})
		return
	}
	select {
	case diagnostics.probe <- struct{}{}:
		defer func() { <-diagnostics.probe }()
	default:
		sendJSON(response, http.StatusTooManyRequests, object{"error": "Запрос с роутера уже выполняется"})
		return
	}
	started := time.Now().UTC()
	result := panelProbeResult{Target: query.Target, ExitLabel: "Выход определяется политикой", ObservedFrom: "router",
		Note: "Проверка с роутера использует выбранный политикой выход. Она не измеряет перехват на клиенте. Для DNS используется системный резолвер роутера.",
		Stages: []panelProbeStage{
			{Stage: "dns", Label: "DNS", State: "skipped"},
			{Stage: "connect", Label: "Соединение", State: "skipped"},
			{Stage: "tls", Label: "TLS", State: "skipped"},
			{Stage: "app", Label: "Ответ приложения", State: "skipped"},
		},
	}
	task := panelTask{ID: newPanelRevision(), Kind: "real-test", Title: "Запрос с роутера", Scope: "Диагностика", State: "running", StartedAt: started,
		Steps: []panelTaskStep{{Label: "DNS", State: "running"}, {Label: "Соединение", State: "pending"},
			{Label: "TLS", State: "pending"}, {Label: "Ответ приложения", State: "pending"}},
	}
	diagnostics.updateTask(task)
	ctx, cancel := context.WithTimeout(request.Context(), 18*time.Second)
	defer cancel()
	diagnostics.runProbe(ctx, config, input, route, resolveDecision, &result)
	finished := time.Now().UTC()
	task.State, task.FinishedAt, task.Result = "done", &finished, result
	severity, explanation := "ok", "Получен ожидаемый HTTP-ответ."
	// Build a new slice because readers may hold a snapshot of the running task.
	task.Steps = make([]panelTaskStep, len(result.Stages))
	for i, stage := range result.Stages {
		step := panelTaskStep{Label: stage.Label, State: "skipped", Detail: stage.Detail}
		if stage.MS != nil {
			step.Detail = strings.TrimSpace(step.Detail + " " + strconv.FormatInt(*stage.MS, 10) + " мс")
		}
		switch stage.State {
		case "ok":
			step.State = "done"
		case "fail":
			step.State, task.State, severity, explanation = "error", "error", "warn", stage.Detail
		}
		task.Steps[i] = step
	}
	diagnostics.updateTask(task)
	diagnostics.event("task", severity, "Диагностика", "Запрос с роутера", explanation)
	sendJSON(response, http.StatusOK, task)
}

func topologyDeviceCaptured(device panelTopologyDevice, capture *transparent) bool {
	if device.SegmentID != capture.Interface {
		return false
	}
	prefix, err := netip.ParsePrefix(capture.Source)
	return err == nil && slices.ContainsFunc(device.Addresses, func(address panelDeviceAddress) bool {
		ip, err := netip.ParseAddr(address.Address)
		return err == nil && prefix.Contains(ip)
	})
}

type decisionResolver func(destination) (decision, error)

func (diagnostics *panelDiagnostics) runProbe(ctx context.Context, config plan, input destination, route decision, resolveDecision decisionResolver, result *panelProbeResult) {
	if route.Target == "@block" {
		result.ExitLabel = "Блокировка"
		result.Stages[1].fail("Предварительный расчёт дал блокировку. Для уточнения правил IP укажите адрес назначения.")
		return
	}
	start := time.Now()
	ip, resolved, err := resolvePublicProbeIPv4(ctx, input.Host, input.TargetIP)
	if err != nil {
		result.Stages[0].fail(err.Error())
		return
	}
	if resolved {
		result.Stages[0].pass(start, "Получен публичный IPv4.")
	} else {
		result.Stages[0].Detail = "Использован заданный IPv4."
	}
	input.TargetIP = ip.String()
	route, err = resolveDecision(input)
	if err != nil {
		result.Stages[1].fail("Не удалось рассчитать выход для полученного адреса.")
		return
	}
	if route.Target == "@block" {
		result.ExitLabel = "Блокировка"
		result.Stages[1].fail("Соединение остановлено правилом блокировки.")
		return
	}
	if route.Target == "zapret" {
		result.ExitLabel = "Zapret"
		result.Stages[1].fail("Для проверки очереди и конкретной стратегии используйте диагностику YouTube или Discord в разделе Zapret.")
		return
	}
	dialer, finish, label, err := diagnostics.probeDialer(ctx, config, route.Target)
	result.ExitLabel = label
	if err != nil {
		result.Stages[1].fail(err.Error())
		return
	}
	defer finish()
	result.TotalMS = runProbeHTTP(ctx, dialer, input, result, start)
}

func resolvePublicProbeIPv4(ctx context.Context, host, specified string) (netip.Addr, bool, error) {
	if specified != "" {
		ip, err := netip.ParseAddr(specified)
		if err != nil || !isZapretPublicIPv4(ip.Unmap()) {
			return netip.Addr{}, false, errors.New("Проверка принимает только публичный IPv4.")
		}
		return ip.Unmap(), false, nil
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if !isZapretPublicIPv4(ip.Unmap()) {
			return netip.Addr{}, false, errors.New("Проверка принимает только публичный IPv4.")
		}
		return ip.Unmap(), false, nil
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
	if err != nil {
		return netip.Addr{}, true, errors.New("Резолвер роутера не вернул IPv4.")
	}
	for _, ip := range addresses {
		if isZapretPublicIPv4(ip.Unmap()) {
			return ip.Unmap(), true, nil
		}
	}
	return netip.Addr{}, true, errors.New("Публичный IPv4 среди DNS-ответов отсутствует.")
}

func (diagnostics *panelDiagnostics) probeDialer(ctx context.Context, config plan, target string) (proxy.ContextDialer, func(), string, error) {
	if target == "direct" {
		return &net.Dialer{Timeout: 4 * time.Second}, func() {}, "Напрямую", nil
	}
	label := "VPN · " + target
	entry, exists := findProfile(config, target)
	if diagnostics.control == nil || !exists {
		return nil, nil, label, errors.New("Рабочий адаптер выбранного выхода недоступен.")
	}
	if entry.Label != "" {
		label = "VPN · " + entry.Label
	}
	release, err := diagnostics.control.acquireProfileProbe()
	if err != nil {
		return nil, nil, label, err
	}
	if diagnostics.control.latencyProfile != nil {
		resolved, err := diagnostics.control.latencyProfile(entry)
		if err != nil {
			release()
			return nil, nil, label, errors.New("Выбранный туннель не готов к проверке.")
		}
		entry = resolved
	}
	dialer, cleanup, err := startProfileProbe(ctx, diagnostics.control.opts, entry)
	if err != nil {
		release()
		return nil, nil, label, errors.New("Не удалось запустить изолированную проверку выбранного профиля.")
	}
	return dialer, func() { cleanup(); release() }, label, nil
}

func runProbeHTTP(ctx context.Context, dialer proxy.ContextDialer, input destination, result *panelProbeResult, started time.Time) *int64 {
	start := time.Now()
	connect, cancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := dialer.DialContext(connect, "tcp", net.JoinHostPort(input.TargetIP, strconv.Itoa(int(input.Port))))
	cancel()
	if err != nil {
		result.Stages[1].fail("Выбранный выход не установил TCP-соединение.")
		return nil
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	result.Stages[1].pass(start, "TCP-соединение открыто.")
	var stream net.Conn = conn
	scheme := "http"
	if input.Port == 443 {
		scheme = "https"
		start = time.Now()
		secure := tls.Client(conn, &tls.Config{ServerName: input.Host, MinVersion: tls.VersionTLS12})
		handshake, cancel := context.WithTimeout(ctx, 4*time.Second)
		err := secure.HandshakeContext(handshake)
		cancel()
		if err != nil {
			result.Stages[2].fail("Сервер не завершил TLS с действительным сертификатом для назначения.")
			return nil
		}
		stream = secure
		result.Stages[2].pass(start, "Сертификат проверен.")
	} else {
		result.Stages[2].Detail = "HTTP без TLS на порту 80."
	}
	start = time.Now()
	_ = stream.SetDeadline(start.Add(4 * time.Second))
	req := &http.Request{Method: http.MethodGet, URL: &url.URL{Scheme: scheme, Host: input.Host, Path: "/"},
		Close: true, Header: http.Header{"User-Agent": []string{"RouteHub"}}}
	if err := req.Write(stream); err != nil {
		result.Stages[3].fail("Не удалось отправить HTTP-запрос.")
		return nil
	}
	response, err := http.ReadResponse(bufio.NewReader(io.LimitReader(stream, 32<<10)), req)
	if err != nil {
		result.Stages[3].fail("Сервер не вернул корректные HTTP-заголовки.")
		return nil
	}
	message := "HTTP " + strconv.Itoa(response.StatusCode) + "."
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		result.Stages[3].fail(message + " Сервер доступен, но приложение не подтвердило успешный запрос.")
		return nil
	}
	result.Stages[3].pass(start, message)
	total := time.Since(started).Milliseconds()
	return &total
}

func (stage *panelProbeStage) fail(detail string) {
	stage.State, stage.Detail = "fail", detail
}

func (stage *panelProbeStage) pass(start time.Time, detail string) {
	elapsed := time.Since(start).Milliseconds()
	stage.State, stage.Detail, stage.MS = "ok", detail, &elapsed
}
