package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

const (
	runtimeHealthInbound  = "routehub-vpn-health"
	runtimeHealthInterval = 5 * time.Minute
)

type runtimeVPNHealth struct {
	Status    string    `json:"status"`
	CheckedAt time.Time `json:"checkedAt"`
	LatencyMS *int64    `json:"latencyMs,omitempty"`
	Message   string    `json:"message"`
}

type runtimeHealthProbe struct {
	port       uint16
	user, pass string
}

func reserveRuntimeHealthProbe(config plan, dnsAddress string) (*runtimeHealthProbe, *net.TCPListener, error) {
	_, dnsPort, _ := net.SplitHostPort(dnsAddress)
	avoidDNS, _ := strconv.ParseUint(dnsPort, 10, 16)
	for range 8 {
		reservation, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			return nil, nil, err
		}
		port := uint16(reservation.Addr().(*net.TCPAddr).Port)
		if port == config.PanelPort || port == config.SOCKSPort || port == uint16(avoidDNS) ||
			(config.Transparent != nil && port == config.Transparent.Port) {
			_ = reservation.Close()
			continue
		}
		var nonce [32]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			_ = reservation.Close()
			return nil, nil, err
		}
		return &runtimeHealthProbe{port: port, user: hex.EncodeToString(nonce[:8]), pass: hex.EncodeToString(nonce[8:])}, reservation, nil
	}
	return nil, nil, errors.New("не удалось зарезервировать порт проверки VPN")
}

// A first-match rule on the private inbound is independent of the user's
// routing defaults and always names the actual selected outbound.
func (probe *runtimeHealthProbe) addToXray(compiled object, config plan) error {
	if probe == nil {
		return nil
	}
	target := config.runtimeHealthTarget
	if target == "" {
		target = "@block"
	} else {
		if _, ok := findProfile(config, target); !ok || target == "direct" || target == "zapret" || target == "@block" || target == selectedVPNTarget {
			return errors.New("не найден активный выход для проверки VPN")
		}
	}
	field, tag := "outboundTag", target
	routing := compiled["routing"].(object)
	if entry, ok := findProfile(config, target); ok && entry.XrayGroup != nil {
		field, tag = "balancerTag", xrayGroupBalancerTag(target)
	}
	var available bool
	if field == "balancerTag" {
		balancers, _ := routing["balancers"].([]object)
		for _, balancer := range balancers {
			available = available || balancer["tag"] == tag
		}
	} else {
		for _, outbound := range compiled["outbounds"].([]object) {
			available = available || outbound["tag"] == tag
		}
	}
	if !available {
		return errors.New("активный выход VPN отсутствует в конфигурации Xray")
	}
	compiled["inbounds"] = append(compiled["inbounds"].([]object), object{
		"tag": runtimeHealthInbound, "listen": "127.0.0.1", "port": probe.port, "protocol": "socks",
		"settings": object{
			"auth": "password", "accounts": []object{{"user": probe.user, "pass": probe.pass}}, "udp": false,
		},
	})
	routing["rules"] = append([]object{{"type": "field", "inboundTag": []string{runtimeHealthInbound}, field: tag}}, routing["rules"].([]object)...)
	return nil
}

var errRuntimeHealthSOCKS = errors.New("локальная проверка VPN недоступна")

// Use only the password method even during negotiation. An unrelated SOCKS
// service bound to the port must never count as a healthy VPN.
func (probe *runtimeHealthProbe) dial(ctx context.Context, _ string, address string) (net.Conn, error) {
	host, rawPort, err := net.SplitHostPort(address)
	port, portErr := strconv.ParseUint(rawPort, 10, 16)
	if err != nil || portErr != nil || port == 0 || len(host) == 0 || len(host) > 255 {
		return nil, errors.New("некорректное назначение проверки")
	}
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp4", loopback(probe.port))
	if err != nil {
		return nil, errRuntimeHealthSOCKS
	}
	keep := false
	defer func() {
		if !keep {
			_ = conn.Close()
		}
	}()
	_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
	cancelIO := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer cancelIO()
	if err := authenticateProbeSOCKS(conn, probe.user, probe.pass); err != nil {
		return nil, errRuntimeHealthSOCKS
	}
	request := append([]byte{5, 1, 0, 3, byte(len(host))}, host...)
	request = append(request, byte(port>>8), byte(port))
	if _, err := conn.Write(request); err != nil {
		return nil, err
	}
	var reply [4]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		return nil, err
	}
	if reply[0] != 5 || reply[1] != 0 || reply[2] != 0 {
		return nil, errors.New("выход VPN не смог открыть контрольное соединение")
	}
	var bytes int64
	switch reply[3] {
	case 1:
		bytes = 4
	case 4:
		bytes = 16
	case 3:
		var size [1]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil {
			return nil, err
		}
		bytes = int64(size[0])
	default:
		return nil, errors.New("некорректный ответ SOCKS")
	}
	if _, err := io.CopyN(io.Discard, conn, bytes+2); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	keep = true
	return conn, nil
}

func (probe *runtimeHealthProbe) check(ctx context.Context) runtimeVPNHealth {
	return probe.checkForGroup(ctx, false)
}

func (probe *runtimeHealthProbe) checkForGroup(ctx context.Context, group bool) runtimeVPNHealth {
	if probe == nil {
		return runtimeVPNHealth{Status: "unavailable", CheckedAt: time.Now().UTC(), Message: "Локальная проверка активного VPN недоступна."}
	}
	status, latency, err := probeProfileHTTPS(ctx, probe.dial, group)
	result := runtimeVPNHealth{CheckedAt: time.Now().UTC()}
	switch {
	case errors.Is(err, errRuntimeHealthSOCKS):
		result.Status, result.Message = "unavailable", "Локальная проверка активного VPN недоступна."
	case err != nil:
		result.Status, result.Message = "failed", "Контрольный HTTPS-запрос через активный VPN не получил ответа."
	case status != http.StatusNoContent:
		result.Status, result.Message = "unverified", "Контрольный HTTPS-запрос через активный VPN получил неожиданный ответ."
	default:
		result.Status, result.Message, result.LatencyMS = "verified", "Контрольный HTTPS-запрос прошёл через активный VPN.", &latency
	}
	return result
}

func (control *panelRuntime) invalidateVPNHealthLocked() {
	control.healthEpoch++
	control.health = nil
	if control.healthCancel != nil {
		control.healthCancel()
		control.healthCancel = nil
	}
}

func (control *panelRuntime) requestVPNHealthLocked() {
	select {
	case control.healthRequests <- struct{}{}:
	default:
	}
}

func (control *panelRuntime) suspendVPNHealth() {
	control.mu.Lock()
	defer control.mu.Unlock()
	control.healthServing = ""
	control.invalidateVPNHealthLocked()
}

func (control *panelRuntime) resumeVPNHealth(running runtimeSelection, applied ...plan) {
	control.mu.Lock()
	defer control.mu.Unlock()
	control.invalidateVPNHealthLocked()
	control.healthServing = ""
	if running.VPN {
		if len(applied) > 0 {
			entry, ok := findProfile(applied[0], running.Profile)
			control.healthGroup = ok && entry.XrayGroup != nil
		}
		control.healthServing = running.Profile
		control.requestVPNHealthLocked()
	} else {
		control.healthGroup = false
	}
}

func (control *panelRuntime) runVPNHealth(ctx context.Context) {
	ticker := time.NewTicker(runtimeHealthInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			control.refreshVPNHealth(ctx)
		case <-control.healthRequests:
			control.refreshVPNHealth(ctx)
		}
	}
}

func (control *panelRuntime) refreshVPNHealth(ctx context.Context) {
	control.mu.Lock()
	if !control.selection.VPN || control.healthServing == "" || control.healthServing != control.selection.Profile {
		control.mu.Unlock()
		return
	}
	probeCtx, cancel := context.WithCancel(ctx)
	epoch := control.healthEpoch
	group := control.healthGroup
	control.healthCancel = cancel
	control.mu.Unlock()
	defer cancel()

	result := control.opts.vpnHealth.checkForGroup(probeCtx, group)
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.healthEpoch == epoch {
		control.healthCancel = nil
		if probeCtx.Err() == nil {
			control.health = &result
		}
	}
}
