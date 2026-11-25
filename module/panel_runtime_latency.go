package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"

	"golang.org/x/net/proxy"
)

const (
	profileProbeURL         = "https://www.gstatic.com/generate_204"
	profileProbeConcurrency = 4
	minExtraProbeMemoryKiB  = 72 * 1024
)

var errProfileProbeBusy = errors.New("На роутере заняты все слоты проверки VPN")

func (control *panelRuntime) acquireProfileProbe() (func(), error) {
	control.latencyMu.Lock()
	defer control.latencyMu.Unlock()
	if len(control.latency) >= 2 && len(control.latency) >= control.profileProbeLimit() {
		return nil, errProfileProbeBusy
	}
	select {
	case control.latency <- struct{}{}:
		return func() { <-control.latency }, nil
	default:
		return nil, errProfileProbeBusy
	}
}

func (control *panelRuntime) profileProbeLimit() int {
	capacity := cap(control.latency)
	if capacity <= 2 {
		return capacity
	}
	info, err := os.ReadFile("/proc/meminfo")
	if err != nil || availableProbeMemory(string(info)) < minExtraProbeMemoryKiB {
		return 2
	}
	return capacity
}

func availableProbeMemory(info string) int {
	if available, ok := readProcKiB(info, "MemAvailable"); ok && available <= uint64(^uint(0)>>1) {
		return int(available)
	}
	return 0
}

func sendProfileProbeBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	sendJSON(w, http.StatusTooManyRequests, object{"error": errProfileProbeBusy.Error()})
}

type profileLatencyResult struct {
	Profile   string `json:"profile"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	LatencyMS *int64 `json:"latencyMs,omitempty"`
}

func isolateProbeConfig(config profile, port int, username, password string) (object, error) {
	compiled := object{
		"log": object{"loglevel": "error"},
		"inbounds": []object{{
			"tag": "routehub-probe", "listen": "127.0.0.1", "port": port, "protocol": "socks",
			"settings": object{
				"auth": "password", "accounts": []object{{"user": username, "pass": password}},
			},
		}},
	}
	if config.XrayGroup != nil {
		members, balancer, err := compileXrayGroup(config.ID, config.XrayGroup)
		if err != nil {
			return nil, err
		}
		compiled["outbounds"] = append([]object{{"tag": "@block", "protocol": "blackhole"}}, members...)
		compiled["routing"] = object{"rules": []object{{
			"type": "field", "inboundTag": []string{"routehub-probe"}, "balancerTag": balancer["tag"],
		}}}
		installXrayBalancers(compiled, []object{balancer})
		return compiled, nil
	}
	outbound, err := profileOutbound(config)
	if err != nil {
		return nil, err
	}
	compiled["outbounds"] = []object{outbound}
	return compiled, nil
}

func socksProbeReady(ctx context.Context, address, username, password string) bool {
	dial := net.Dialer{Timeout: 250 * time.Millisecond}
	client, err := dial.DialContext(ctx, "tcp4", address)
	if err != nil {
		return false
	}
	defer client.Close()
	if err := client.SetDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		return false
	}
	return authenticateProbeSOCKS(client, username, password) == nil
}

func authenticateProbeSOCKS(client net.Conn, username, password string) error {
	if len(username) == 0 || len(username) > 255 || len(password) == 0 || len(password) > 255 {
		return errors.New("некорректная локальная авторизация SOCKS")
	}
	reply := make([]byte, 2)
	if _, err := client.Write([]byte{5, 1, 2}); err != nil {
		return err
	}
	if _, err := io.ReadFull(client, reply); err != nil || reply[0] != 5 || reply[1] != 2 {
		return errors.New("локальный SOCKS не использует пароль")
	}
	request := append([]byte{1, byte(len(username))}, username...)
	request = append(request, byte(len(password)))
	request = append(request, password...)
	if _, err := client.Write(request); err != nil {
		return err
	}
	if _, err := io.ReadFull(client, reply); err != nil || reply[0] != 1 || reply[1] != 0 {
		return errors.New("локальный SOCKS отклонил пароль")
	}
	return nil
}

func waitForProbeSOCKS(ctx context.Context, instance *engine, address, username, password string) error {
	startup, cancel := context.WithTimeout(ctx, runtimeTimeout)
	defer cancel()
	ticker := time.NewTicker(60 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-startup.Done():
			return startup.Err()
		case <-instance.done:
			return errors.New("ядро проверки профиля завершилось")
		case <-ticker.C:
			if socksProbeReady(startup, address, username, password) {
				return nil
			}
		}
	}
}

func startProfileProbe(ctx context.Context, opts options, entry profile) (proxy.ContextDialer, func(), error) {
	resolve, stop := context.WithTimeout(ctx, 3*time.Second)
	entry, err := pinExecutableXrayProfile(resolve, entry, resolvePublicProbeIPv4)
	stop()
	if err != nil {
		return nil, nil, err
	}
	reserved, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, nil, err
	}
	defer reserved.Close()
	address := reserved.Addr().(*net.TCPAddr)
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, nil, err
	}
	username, password := hex.EncodeToString(nonce[:8]), hex.EncodeToString(nonce[8:])
	config, err := isolateProbeConfig(entry, address.Port, username, password)
	if err != nil {
		return nil, nil, err
	}
	dir, err := os.MkdirTemp("", "routehub-probe-")
	if err != nil {
		return nil, nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(dir)
		}
	}()
	path, err := privateJSON(dir, "xray-probe-*.json", config)
	if err != nil {
		return nil, nil, err
	}
	if err := command(ctx, opts.xray, "run", "-test", "-c", path); err != nil {
		return nil, nil, err
	}
	if err := reserved.Close(); err != nil {
		return nil, nil, err
	}
	instance, err := startEngine(opts.xray, path)
	if err != nil {
		return nil, nil, err
	}
	finish := func() {
		instance.stop()
		_ = os.RemoveAll(dir)
	}
	if err := waitForProbeSOCKS(ctx, instance, address.String(), username, password); err != nil {
		instance.stop()
		return nil, nil, err
	}
	socksURL := &url.URL{Scheme: "socks5", Host: address.String(), User: url.UserPassword(username, password)}
	dialer, err := proxy.FromURL(socksURL, &net.Dialer{Timeout: 2 * time.Second})
	if err != nil {
		instance.stop()
		return nil, nil, err
	}
	contextDialer, ok := dialer.(proxy.ContextDialer)
	if !ok {
		instance.stop()
		return nil, nil, errors.New("SOCKS-проверка не поддерживает отмену")
	}
	keep = true
	return contextDialer, finish, nil
}

func profileLatency(ctx context.Context, opts options, entry profile) profileLatencyResult {
	result := profileLatencyResult{Profile: entry.ID, Status: "unavailable", Message: "Не удалось запустить отдельную проверку туннеля."}
	dialer, finish, err := startProfileProbe(ctx, opts, entry)
	if err != nil {
		return result
	}
	defer finish()
	status, elapsed, err := probeProfileHTTPS(ctx, dialer.DialContext, entry.XrayGroup != nil)
	if err != nil {
		result.Status, result.Message = "failed", "Контрольный HTTPS-запрос через этот профиль не получил ответа."
		return result
	}
	if status != http.StatusNoContent {
		result.Status, result.Message = "unverified", "Контрольный HTTPS-запрос через профиль получил неожиданный ответ."
		return result
	}
	result.Status, result.Message, result.LatencyMS = "verified", "Контрольный HTTPS-запрос прошёл через выбранный туннель.", &elapsed
	return result
}

// A freshly launched health-based group may briefly have no observations.
// Retry only within the existing HTTPS time budget and keep the fail-closed
// balancer active throughout that first check.
func probeProfileHTTPS(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error), group bool) (int, int64, error) {
	if !group {
		return probeHTTPS(ctx, dial, profileProbeURL)
	}
	ctx, cancel := context.WithTimeout(ctx, 7*time.Second)
	defer cancel()
	until := time.Now().Add(4500 * time.Millisecond)
	for {
		status, elapsed, err := probeHTTPS(ctx, dial, profileProbeURL)
		if err == nil || ctx.Err() != nil || time.Now().After(until) {
			return status, elapsed, err
		}
		timer := time.NewTimer(300 * time.Millisecond)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return status, elapsed, err
		}
	}
}

func probeHTTPS(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error), address string) (int, int64, error) {
	transport := &http.Transport{
		DialContext:         dial,
		TLSHandshakeTimeout: 4 * time.Second, ResponseHeaderTimeout: 4 * time.Second,
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	client := http.Client{
		Transport: transport, Timeout: 7 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return 0, 0, err
	}
	started := time.Now()
	response, err := client.Do(request)
	if err != nil {
		return 0, 0, err
	}
	_ = response.Body.Close()
	return response.StatusCode, time.Since(started).Milliseconds(), nil
}

func (control *panelRuntime) checkLatency(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Profile string `json:"profile"`
		}
		if !runtimeRequest(response, request, editor, &input) {
			return
		}
		entry, ok := findProfile(editor.current().plan, input.Profile)
		if !ok {
			sendJSON(response, http.StatusNotFound, object{"error": "Профиль VPN не найден"})
			return
		}
		release, err := control.acquireProfileProbe()
		if err != nil {
			sendProfileProbeBusy(response)
			return
		}
		defer release()
		if control.latencyProfile != nil {
			resolved, err := control.latencyProfile(entry)
			if err != nil {
				sendJSON(response, http.StatusOK, profileLatencyResult{Profile: entry.ID, Status: "unavailable", Message: "Туннель профиля недоступен для проверки."})
				return
			}
			entry = resolved
		}
		ctx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
		defer cancel()
		sendJSON(response, http.StatusOK, profileLatency(ctx, control.opts, entry))
	}
}
