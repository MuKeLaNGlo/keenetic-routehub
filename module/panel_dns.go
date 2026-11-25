package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
)

const dnsBlocklistLimit = 16 << 20

var denyListAssets = map[string]string{
	"normal": "multi.txt", "pro": "pro.mini.txt", "proplus": "pro.plus.mini.txt",
}

type dnsOverview struct {
	dnsSettings
	Enabled          bool   `json:"enabled"`
	Listen           string `json:"listen,omitempty"`
	LANListen        string `json:"lanListen,omitempty"`
	LANAvailable     bool   `json:"lanAvailable"`
	LANActive        bool   `json:"lanActive"`
	BlocklistEntries int    `json:"blocklistEntries"`
	SampleBlocked    bool   `json:"sampleBlocked"`
	Error            string `json:"error,omitempty"`
}

type dnsProbe struct {
	Role      string `json:"role"`
	Status    string `json:"status"`
	LatencyMS *int64 `json:"latencyMs,omitempty"`
	Message   string `json:"message"`
}

type panelDNS struct {
	path         string
	listen       string
	listener     error
	initial      string
	lanListen    string
	lanCommand   func(string, ...string) error
	lanArguments []string
	lanActive    bool
	lanStatus    func() bool
	mu           sync.Mutex
	resolver     atomic.Pointer[dnsResolver]
	probes       chan struct{}
}

func newPanelDNS(ctx context.Context, planPath, listen string, allowed netip.Prefix) *panelDNS {
	control := &panelDNS{path: filepath.Join(filepath.Dir(planPath), "dns.json"), listen: listen, probes: make(chan struct{}, 2)}
	settings, err := control.readSettings()
	var list map[string]struct{}
	if err == nil && settings.Adblock {
		// Bootstrap never makes external downloads. The saved policy is useful
		// only when its validated companion list is present.
		list, err = control.readBlocklist(settings.Lists[0])
	}
	if err != nil {
		control.initial = "Сохранённые настройки DNS не загружены. Проверьте конфигурацию и список фильтрации."
		settings = defaultDNS
	}
	control.resolver.Store(newDNSResolver(settings, list))
	if listen != "" {
		control.listener = control.serve(ctx, listen, allowed)
	}
	return control
}

func (control *panelDNS) configureLAN(ctx context.Context, opts options, config plan, allowed netip.Prefix) {
	if control.listen == "" || control.listener != nil || config.Transparent == nil || !allowed.IsValid() {
		return
	}
	lan, err := netip.ParsePrefix(config.Transparent.Source)
	if err != nil || !allowed.Contains(lan.Addr()) || lan.Bits() < allowed.Bits() {
		return
	}
	_, port, listenErr := net.SplitHostPort(control.listen)
	native := nativeDNSUpstream(config.PanelHost, port, lan)
	if listenErr != nil || !native.IsValid() {
		return
	}
	path := filepath.Join(opts.helperDir, "routehub-dns")
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o100 == 0 {
		return
	}
	control.lanListen = net.JoinHostPort(config.PanelHost, port)
	if control.lanListen != control.listen {
		if err := control.serve(ctx, control.lanListen, lan); err != nil {
			control.lanListen = ""
			return
		}
	}
	control.lanCommand = func(action string, args ...string) error {
		return command(context.Background(), path, append([]string{action}, args...)...)
	}
	control.lanStatus = func() bool {
		timeout, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		data, err := exec.CommandContext(timeout, path, "status").Output()
		return err == nil && strings.TrimSpace(string(data)) == "active"
	}
	control.lanArguments = []string{config.Transparent.Interface, lan.String(), config.PanelHost, port, strconv.Itoa(os.Getpid())}
	current := control.resolver.Load()
	resolver := newDNSResolver(current.settings, current.blocklist)
	resolver.nativeDNS = native
	control.resolver.Store(resolver)
	if settings := resolver.settings; settings.LAN {
		if !dnsHasAnswer(ctx, settings) || control.applyLAN(true) != nil {
			control.initial = "Перенаправление DNS не запустилось. Keenetic использует штатный DNS."
		}
	}
}

// The helper redirects only inbound PREROUTING for the chosen bridge. DNS
// queries originated here therefore reach Keenetic's port 53 on the same IP.
func nativeDNSUpstream(router, listenPort string, lan netip.Prefix) netip.AddrPort {
	addr, addrErr := netip.ParseAddr(router)
	port, portErr := strconv.ParseUint(listenPort, 10, 16)
	if addrErr != nil || portErr != nil || port == 0 || port == 53 ||
		!addr.Is4() || !addr.IsPrivate() || !lan.Contains(addr) {
		return netip.AddrPort{}
	}
	return netip.AddrPortFrom(addr, 53)
}

func (control *panelDNS) applyLAN(enabled bool) error {
	if enabled {
		if control.lanCommand == nil {
			return errors.New("перенаправление DNS для LAN недоступно в этом запуске RouteHub")
		}
		if err := control.lanCommand("start", control.lanArguments...); err != nil {
			return errors.New("Keenetic не подтвердил перенаправление DNS, проверьте интерфейс и состояние firewall")
		}
	} else if control.lanCommand != nil {
		if err := control.lanCommand("stop"); err != nil {
			return errors.New("не удалось отключить перенаправление DNS")
		}
	}
	control.lanActive = enabled
	return nil
}

func (control *panelDNS) stop() {
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.lanActive {
		_ = control.applyLAN(false)
	}
}

func (control *panelDNS) readSettings() (dnsSettings, error) {
	file, err := os.Open(control.path)
	if errors.Is(err, os.ErrNotExist) {
		return defaultDNS, nil
	}
	if err != nil {
		return dnsSettings{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 64<<10 {
		return dnsSettings{}, errors.New("файл настроек DNS должен быть приватным")
	}
	var settings dnsSettings
	if err := decodeJSON(io.LimitReader(file, 64<<10), &settings); err != nil {
		return dnsSettings{}, err
	}
	return validateDNSSettings(settings)
}

func (control *panelDNS) serve(ctx context.Context, address string, allowed netip.Prefix) error {
	tcp, err := net.Listen("tcp4", address)
	if err != nil {
		return err
	}
	udp, err := net.ListenPacket("udp4", address)
	if err != nil {
		tcp.Close()
		return err
	}
	var queries = make(chan struct{}, 32)
	handler := dns.HandlerFunc(func(writer dns.ResponseWriter, request *dns.Msg) {
		source, err := netip.ParseAddrPort(writer.RemoteAddr().String())
		if err != nil || !allowed.Contains(source.Addr().Unmap()) {
			return
		}
		select {
		case queries <- struct{}{}:
			defer func() { <-queries }()
		default:
			_ = writer.WriteMsg(new(dns.Msg).SetRcode(request, dns.RcodeServerFailure))
			return
		}
		budget, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		reply := control.resolver.Load().resolve(budget, request)
		if _, datagram := writer.RemoteAddr().(*net.UDPAddr); datagram {
			size := uint16(dns.MinMsgSize)
			if opt := request.IsEdns0(); opt != nil {
				size = max(size, min(1232, opt.UDPSize()))
			}
			reply.Truncate(int(size))
		}
		_ = writer.WriteMsg(reply)
	})
	servers := []*dns.Server{
		{Listener: tcp, Handler: handler, ReadTimeout: 4 * time.Second, WriteTimeout: 5 * time.Second, Net: "tcp"},
		{PacketConn: udp, Handler: handler, UDPSize: 4096, Net: "udp"},
	}
	for _, server := range servers {
		go func() { _ = server.ActivateAndServe() }()
	}
	go func() {
		<-ctx.Done()
		shutdown, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		for _, server := range servers {
			_ = server.ShutdownContext(shutdown)
		}
		_ = tcp.Close()
		_ = udp.Close()
	}()
	return nil
}

func parseDNSBlocklist(reader io.Reader) (map[string]struct{}, error) {
	filter := make(map[string]struct{})
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		domain := normalizeHost(scanner.Text())
		if strings.HasPrefix(domain, "#") || domain == "" {
			continue
		}
		if !validDomain(domain) || !strings.Contains(domain, ".") {
			return nil, errors.New("ответ не является списком доменов")
		}
		filter[domain] = struct{}{}
	}
	if scanner.Err() != nil || len(filter) < 1000 || len(filter) > 400_000 {
		return nil, errors.New("неподдерживаемый размер списка DNS")
	}
	return filter, nil
}

func (control *panelDNS) listPath(id string) string {
	return filepath.Join(filepath.Dir(control.path), "dns-hagezi-"+id+".txt")
}

func (control *panelDNS) readBlocklist(id string) (map[string]struct{}, error) {
	path := control.listPath(id)
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > dnsBlocklistLimit {
		return nil, errors.New("некорректный локальный список DNS")
	}
	return parseDNSBlocklist(file)
}

func (control *panelDNS) loadBlocklist(ctx context.Context, id string) (map[string]struct{}, error) {
	path := control.listPath(id)
	stored, oldErr := control.readBlocklist(id)
	if info, err := os.Stat(path); oldErr == nil && err == nil && time.Since(info.ModTime()) < 24*time.Hour {
		return stored, nil
	}
	const upstream = "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/"
	limit, stop := context.WithTimeout(ctx, 12*time.Second)
	defer stop()
	req, err := http.NewRequestWithContext(limit, http.MethodGet, upstream+denyListAssets[id], nil)
	if err != nil {
		return nil, err
	}
	resp, err := dnsHTTP.Do(req)
	if err != nil {
		if oldErr == nil {
			return stored, nil
		}
		return nil, errors.New("сервер HaGeZi недоступен, попробуйте снова")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if oldErr == nil {
			return stored, nil
		}
		return nil, errors.New("не удалось загрузить выбранный список HaGeZi")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, dnsBlocklistLimit+1))
	if err != nil || len(data) > dnsBlocklistLimit {
		return nil, errors.New("некорректный файл HaGeZi")
	}
	list, err := parseDNSBlocklist(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	pending, err := os.CreateTemp(filepath.Dir(path), ".dns-list-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(pending.Name())
	_, err = pending.Write(data)
	if err = errors.Join(err, pending.Sync(), pending.Close()); err != nil {
		return nil, err
	}
	if err := os.Rename(pending.Name(), path); err != nil {
		return nil, err
	}
	return list, nil
}

func (control *panelDNS) snapshot() dnsOverview {
	control.mu.Lock()
	defer control.mu.Unlock()
	return control.snapshotLocked()
}

func (control *panelDNS) snapshotLocked() dnsOverview {
	current := control.resolver.Load()
	status := dnsOverview{dnsSettings: current.settings, Listen: control.listen, Enabled: control.listen != "" && control.listener == nil,
		LANListen: control.lanListen, LANAvailable: control.lanCommand != nil, BlocklistEntries: len(current.blocklist),
		SampleBlocked: current.blocked("doubleclick.net"), Error: control.initial}
	status.LANActive = control.lanActive && control.lanStatus()
	if control.lanActive && !status.LANActive {
		status.Error = "Маршрут DNS для LAN недоступен. Проверьте интерфейс и firewall."
	}
	if control.listener != nil {
		status.Error = "Сокет DNS занят или недоступен. Проверьте адрес резолвера."
	}
	return status
}

func (control *panelDNS) status(response http.ResponseWriter, _ *http.Request) {
	sendJSON(response, http.StatusOK, control.snapshot())
}

func (control *panelDNS) update(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !editor.authorized(request) {
			sendJSON(response, http.StatusForbidden, object{"error": "Доступ к настройкам DNS запрещён"})
			return
		}
		var next dnsSettings
		if err := decodeJSON(http.MaxBytesReader(response, request.Body, 64<<10), &next); err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Некорректные настройки DNS"})
			return
		}
		next, err := validateDNSSettings(next)
		if err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": err.Error()})
			return
		}
		control.mu.Lock()
		defer control.mu.Unlock()
		if err := control.apply(request.Context(), next); err != nil {
			sendJSON(response, http.StatusUnprocessableEntity, object{"error": err.Error()})
			return
		}
		sendJSON(response, http.StatusOK, control.snapshotLocked())
	}
}

func (control *panelDNS) apply(ctx context.Context, next dnsSettings) error {
	current := control.resolver.Load()
	if next.LAN && control.lanCommand == nil {
		return errors.New("перенаправление DNS для LAN недоступно в этом запуске RouteHub")
	}
	if prev := current.settings; next.Protocol != prev.Protocol || next.Primary != prev.Primary || next.Secondary != prev.Secondary || next.LAN && !control.lanActive {
		if !dnsHasAnswer(ctx, next) {
			return errors.New("ни один DNS-сервер не ответил на проверку. Сохранены действующие настройки")
		}
	}
	var list map[string]struct{}
	if next.Adblock {
		var err error
		if current.settings.Adblock && current.settings.Lists[0] == next.Lists[0] {
			list = current.blocklist
		} else {
			list, err = control.loadBlocklist(ctx, next.Lists[0])
		}
		if err != nil {
			return errors.New("список HaGeZi не загружен. Проверьте доступ к GitHub и повторите")
		}
	}
	pending, err := privateJSON(filepath.Dir(control.path), ".dns-plan-", next)
	if err != nil {
		return errors.New("не удалось записать настройки DNS")
	}
	defer os.Remove(pending)
	wasLAN := control.lanActive
	if next.LAN != wasLAN || next.LAN && !control.lanStatus() {
		if err := control.applyLAN(next.LAN); err != nil {
			return err
		}
	}
	if err := os.Rename(pending, control.path); err != nil {
		if wasLAN != control.lanActive {
			_ = control.applyLAN(wasLAN)
		}
		return errors.New("не удалось применить настройки DNS")
	}
	control.initial = ""
	resolver := newDNSResolver(next, list)
	resolver.nativeDNS = current.nativeDNS
	control.resolver.Store(resolver)
	return nil
}

func dnsHasAnswer(ctx context.Context, settings dnsSettings) bool {
	reply := newDNSResolver(settings, nil).resolve(ctx, new(dns.Msg).SetQuestion("example.org.", dns.TypeA))
	return reply.Rcode == dns.RcodeSuccess && len(reply.Answer) != 0
}

func (control *panelDNS) test(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !editor.authorized(request) {
			sendJSON(response, http.StatusForbidden, object{"error": "Доступ к проверке DNS запрещён"})
			return
		}
		select {
		case control.probes <- struct{}{}:
			defer func() { <-control.probes }()
		default:
			sendJSON(response, http.StatusTooManyRequests, object{"error": "Дождитесь текущей проверки DNS"})
			return
		}
		var input struct {
			Protocol  string `json:"protocol"`
			Primary   string `json:"primary"`
			Secondary string `json:"secondary"`
		}
		if err := decodeJSON(http.MaxBytesReader(response, request.Body, 3072), &input); err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Некорректный запрос проверки DNS"})
			return
		}
		settings, err := validateDNSSettings(dnsSettings{Protocol: input.Protocol, Primary: input.Primary, Secondary: input.Secondary})
		if err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": err.Error()})
			return
		}
		servers := []dnsProbe{probeDNS(request.Context(), "primary", settings.Protocol, settings.Primary)}
		if settings.Secondary != "" {
			servers = append(servers, probeDNS(request.Context(), "secondary", settings.Protocol, settings.Secondary))
		}
		sendJSON(response, http.StatusOK, object{"servers": servers})
	}
}

func probeDNS(ctx context.Context, role, protocol, endpoint string) dnsProbe {
	probe := dnsProbe{Role: role, Status: "failed", Message: "Нет подтверждённого ответа DNS"}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	started := time.Now()
	result, err := dnsExchange(ctx, protocol, endpoint, new(dns.Msg).SetQuestion("example.org.", dns.TypeA))
	if err == nil && result.Rcode == dns.RcodeSuccess && len(result.Answer) != 0 {
		elapsed := time.Since(started).Milliseconds()
		probe.Status, probe.LatencyMS, probe.Message = "ok", &elapsed, "DNS-сервер ответил на запрос"
	}
	return probe
}
