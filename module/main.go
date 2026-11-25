package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"routehub/awg"
)

const runtimeTimeout = 6 * time.Second

type options struct {
	config     string
	xray       string
	output     string
	allowLAN   bool
	panelKey   string
	helperDir  string
	dnsListen  string
	vpnHealth  *runtimeHealthProbe
	serviceLog *serviceLog
}

const version = "0.6.10"

func (opts options) logMessage(message string) {
	if opts.serviceLog == nil || opts.serviceLog.appendLine(message) != nil {
		fmt.Fprintln(os.Stderr, message)
	}
}

type status struct {
	SOCKS     string    `json:"socks"`
	LAN       bool      `json:"lan"`
	LANMode   string    `json:"lanMode,omitempty"`
	Zapret    bool      `json:"zapret"`
	Panel     string    `json:"panel"`
	Version   string    `json:"version"`
	StartedAt time.Time `json:"startedAt"`
	CanEdit   bool      `json:"canEdit"`
}

func sendJSON(response http.ResponseWriter, code int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(code)
	_ = json.NewEncoder(response).Encode(value)
}

func handler(editor *panelEditor, state status, authority string, allowed netip.Prefix, helperDir string, traffic *trafficMonitor, control *panelRuntime, dnsControl *panelDNS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/panel/session", editor.auth.status)
	mux.HandleFunc("POST /api/panel/session", editor.auth.session)
	mux.HandleFunc("DELETE /api/panel/session", editor.auth.session)
	mux.HandleFunc("PUT /api/panel/password", editor.auth.session)
	mux.HandleFunc("GET /api/panel/capabilities", editor.capabilities(state, control, dnsControl))
	mux.HandleFunc("POST /api/panel/apply/preview", editor.previewUpdate)
	mux.HandleFunc("GET /api/panel/revisions", editor.revisionList)
	mux.HandleFunc("POST /api/panel/revisions/restore", editor.revisionRestore)
	diagnostics := newPanelDiagnostics(editor, state, control)
	diagnostics.register(mux)
	if control != nil && control.cores != nil {
		control.cores.register(mux, diagnostics)
	}
	subscriptions := editor.subscriptions
	if subscriptions == nil {
		subscriptions = newPanelSubscriptions(editor, control)
	}
	subscriptions.register(mux, diagnostics)
	panelHandler := diagnostics.audit(mux)
	registerPanelAssets(mux)
	mux.HandleFunc("GET /api/traffic", traffic.serveHTTP)
	if control != nil && control.resources != nil {
		mux.HandleFunc("GET /api/panel/router-resources", control.resources.serveHTTP)
	}
	mux.HandleFunc("GET /api/panel/log-storage", func(response http.ResponseWriter, _ *http.Request) {
		var value serviceLogStatus
		if control != nil && control.opts.serviceLog != nil {
			value = control.opts.serviceLog.status()
		} else {
			value.State = "disabled"
		}
		sendJSON(response, http.StatusOK, value)
	})
	mux.HandleFunc("GET /api/plan", func(response http.ResponseWriter, request *http.Request) {
		sendJSON(response, http.StatusOK, editor.snapshot())
	})
	mux.HandleFunc("PUT /api/plan", editor.update)
	mux.HandleFunc("GET /api/devices", editor.deviceList(state.LAN, allowed))
	mux.HandleFunc("POST /api/import", editor.importRules)
	mux.HandleFunc("POST /api/profiles/import", editor.importProfiles)
	if control != nil {
		mux.HandleFunc("POST /api/panel/profiles/import/probe", control.checkImportedVLESS(editor))
	}
	mux.HandleFunc("POST /api/backup", editor.backup)
	if control != nil {
		mux.HandleFunc("GET /api/runtime", func(response http.ResponseWriter, request *http.Request) {
			sendJSON(response, http.StatusOK, control.snapshot(editor.current().plan))
		})
		mux.HandleFunc("PUT /api/runtime/vpn", control.setVPN(editor))
		mux.HandleFunc("POST /api/runtime/latency", control.checkLatency(editor))
		mux.HandleFunc("PUT /api/runtime/boot", control.setBoot(editor))
		mux.HandleFunc("POST /api/runtime/boot/check", control.bootCheck(editor))
		mux.HandleFunc("PUT /api/runtime/zapret", control.setZapret(editor))
		mux.HandleFunc("POST /api/runtime/zapret/auto", control.autoZapret(editor))
		mux.HandleFunc("POST /api/zapret/check", control.checkZapret(editor))
	} else {
		mux.HandleFunc("POST /api/zapret/check", editor.zapretCheck(state.Zapret, helperDir))
	}
	if dnsControl != nil {
		mux.HandleFunc("GET /api/dns", dnsControl.status)
		mux.HandleFunc("PUT /api/dns", dnsControl.update(editor))
		mux.HandleFunc("POST /api/dns/test", dnsControl.test(editor))
	}
	mux.HandleFunc("GET /api/geoip", editor.geoIPStatus)
	mux.HandleFunc("POST /api/geoip/update", editor.updateGeoIP)
	mux.HandleFunc("GET /api/status", func(response http.ResponseWriter, request *http.Request) {
		current := state
		if control != nil {
			selection, _ := control.state()
			current.Zapret = selection.zapretEnabled()
		}
		sendJSON(response, http.StatusOK, current)
	})
	mux.HandleFunc("POST /api/evaluate", editor.traceHandler(state.LAN, control))
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Host != authority {
			http.Error(response, "Недопустимый HTTP Host", http.StatusBadRequest)
			return
		}
		peer, err := netip.ParseAddrPort(request.RemoteAddr)
		if err != nil || !allowed.Contains(peer.Addr().Unmap()) {
			http.Error(response, "Адрес клиента вне подсети панели", http.StatusForbidden)
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Content-Security-Policy", panelContentPolicy)
		if strings.HasPrefix(request.URL.Path, "/api/panel/") && request.URL.Path != "/api/panel/session" && !editor.panelReadAuthorized(request) {
			sendJSON(response, http.StatusUnauthorized, object{"error": "Войдите в панель"})
			return
		}
		panelHandler.ServeHTTP(response, request)
	})
}

func loopback(port uint16) string {
	return "127.0.0.1:" + strconv.Itoa(int(port))
}

func panelAccessKey(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 256 {
		return "", errors.New("файл ключа должен быть приватным, например с правами 0600")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(data))
	if len(key) < 24 {
		return "", errors.New("минимальная длина ключа панели — 24 символа")
	}
	return key, nil
}

func checkPort(address string) error {
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return err
	}
	defer listener.Close()
	packet, err := net.ListenPacket("udp4", address)
	if err != nil {
		return err
	}
	return packet.Close()
}

func command(ctx context.Context, program string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, runtimeTimeout)
	defer cancel()
	return exec.CommandContext(ctx, program, args...).Run()
}

func networkHelper(opts options, name, action string, args ...string) error {
	return command(context.Background(), filepath.Join(opts.helperDir, "routehub-"+name), append([]string{action}, args...)...)
}

func startTransparent(opts options, lan *transparent) error {
	return networkHelper(opts, "transparent", "start", lan.Interface, lan.Source, strconv.Itoa(int(lan.Port)), strconv.Itoa(os.Getpid()))
}

type engine struct {
	process *exec.Cmd
	done    chan struct{}
	result  error
}

func startEngine(path, configPath string) (*engine, error) {
	instance := &engine{process: exec.Command(path, "run", "-c", configPath), done: make(chan struct{})}
	instance.process.Env = xrayEnvironment(configPath)
	guardParentExit(instance.process)
	if err := instance.process.Start(); err != nil {
		return nil, err
	}
	go func() {
		instance.result = instance.process.Wait()
		close(instance.done)
	}()
	return instance, nil
}

func (instance *engine) stop() {
	select {
	case <-instance.done:
		return
	default:
	}
	_ = instance.process.Process.Signal(syscall.SIGTERM)
	select {
	case <-instance.done:
	case <-time.After(time.Second):
		_ = instance.process.Process.Kill()
		<-instance.done
	}
}

func (instance *engine) waitForSOCKS(ctx context.Context, address string) error {
	deadline := time.NewTimer(runtimeTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(60 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-instance.done:
			return fmt.Errorf("ядро Xray завершилось при запуске: %v", instance.result)
		case <-deadline.C:
			return errors.New("ядро Xray не открыло SOCKS-порт")
		case <-ticker.C:
			client, err := net.DialTimeout("tcp4", address, 200*time.Millisecond)
			if err != nil {
				continue
			}
			_ = client.SetDeadline(time.Now().Add(200 * time.Millisecond))
			_, err = client.Write([]byte{5, 1, 0})
			reply := make([]byte, 2)
			if err == nil {
				_, err = io.ReadFull(client, reply)
			}
			_ = client.Close()
			if err == nil && reply[0] == 5 && reply[1] == 0 {
				return nil
			}
		}
	}
}

type runtimeTransaction struct {
	next          plan
	before, after runtimeSelection
	persist       bool
	result        chan error
}

func serve(ctx context.Context, config plan, opts options) (result error) {
	address := net.JoinHostPort(config.PanelHost, strconv.Itoa(int(config.PanelPort)))
	allowed := netip.MustParsePrefix("127.0.0.0/8")
	if !netip.MustParseAddr(config.PanelHost).IsLoopback() {
		allowed = netip.MustParsePrefix(config.PanelNetwork)
	}
	key, err := panelAccessKey(opts.panelKey)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return err
	}
	defer listener.Close()
	probe, probeReservation, err := reserveRuntimeHealthProbe(config, opts.dnsListen)
	if err != nil {
		opts.logMessage("Локальный канал проверки VPN недоступен.")
	} else {
		opts.vpnHealth = probe
		defer probeReservation.Close()
	}
	control, err := newPanelRuntime(opts)
	if err != nil {
		return err
	}
	initial := control.bootSelection(config)
	_, settings := control.state()
	control.publish(initial, settings)
	state := status{
		SOCKS: loopback(config.SOCKSPort), LAN: opts.allowLAN, Zapret: initial.zapretEnabled(),
		Panel: "http://" + address, Version: version, StartedAt: time.Now().UTC(), CanEdit: key != "",
	}
	redirectTCP := state.LAN && config.Transparent.Mode == transparentRedirectTCP
	if err := checkPort(state.SOCKS); err != nil {
		return fmt.Errorf("SOCKS-порт занят: %w", err)
	}
	if state.LAN {
		state.LANMode = "tproxy"
		if redirectTCP {
			state.LANMode = transparentRedirectTCP
			redirectAddress := net.JoinHostPort(config.PanelHost, strconv.Itoa(int(config.Transparent.Port)))
			reservation, err := net.Listen("tcp4", redirectAddress)
			if err != nil {
				return fmt.Errorf("порт TCP REDIRECT занят или недоступен: %w", err)
			}
			_ = reservation.Close()
		} else if err := checkPort(loopback(config.Transparent.Port)); err != nil {
			return fmt.Errorf("порт TProxy занят: %w", err)
		}
	}
	if err := checkAWG(config); err != nil {
		return err
	}
	awgPool := newManagedAWGPool(ctx)
	defer awgPool.close()
	prepared, finish, err := awgPool.prepare(config)
	if err != nil {
		return err
	}
	finish(true)
	dir, err := os.MkdirTemp("", "routehub-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if state.Zapret {
		if err := startRuntimeZapret(opts, initial); err != nil {
			opts.logMessage("Не запустился Zapret. Панель продолжает работать без него.")
			initial.YouTube, initial.Discord, state.Zapret = false, false, false
			control.publish(initial, settings)
		}
	}
	defer func() {
		selection, _ := control.state()
		if selection.zapretEnabled() {
			result = errors.Join(result, networkHelper(opts, "zapret", "stop"))
		}
	}()
	configPath, err := writeRuntimeXray(opts, dir, runtimePlan(prepared, initial), state.Zapret)
	if err != nil {
		return err
	}
	cores, err := newPanelCoreUpdates(ctx, opts, dir, configPath)
	if err != nil {
		return err
	}
	opts.xray = cores.active
	control.opts.xray = cores.active
	control.cores = cores

	if redirectTCP {
		lan := config.Transparent
		if err := networkHelper(opts, "redirect-tcp", "prepare", lan.Interface, lan.Source, config.PanelHost,
			strconv.Itoa(int(lan.Port)), strconv.Itoa(os.Getpid())); err != nil {
			return fmt.Errorf("не удалось защитить вход TCP REDIRECT: %w", err)
		}
		defer func() {
			result = errors.Join(result, networkHelper(opts, "redirect-tcp", "stop"))
		}()
	}
	if probeReservation != nil {
		_ = probeReservation.Close()
	}
	instance, err := cores.start(ctx, configPath, state.SOCKS)
	if err != nil {
		return err
	}
	defer func() {
		if instance != nil {
			instance.stop()
		}
	}()
	control.resumeVPNHealth(initial, prepared)
	if redirectTCP {
		if err := networkHelper(opts, "redirect-tcp", "activate", strconv.Itoa(instance.process.Process.Pid)); err != nil {
			return fmt.Errorf("не запустился перехват LAN TCP REDIRECT: %w", err)
		}
		defer func() {
			result = errors.Join(result, networkHelper(opts, "redirect-tcp", "deactivate"))
		}()
	} else if state.LAN {
		if err := startTransparent(opts, config.Transparent); err != nil {
			return fmt.Errorf("не запустился перехват LAN: %w", err)
		}
		defer func() {
			result = errors.Join(result, networkHelper(opts, "transparent", "stop"))
		}()
	}

	updates := make(chan runtimeTransaction)
	coreUpdates := make(chan coreTransaction)
	cores.activate = coreUpdateQueue(ctx, coreUpdates)
	queue := func(request context.Context, next plan, before, after runtimeSelection, persist bool) error {
		update := runtimeTransaction{next: next, before: before, after: after, persist: persist, result: make(chan error, 1)}
		select {
		case <-request.Done():
			return request.Err()
		case <-ctx.Done():
			return ctx.Err()
		case updates <- update:
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-update.result:
			return err
		}
	}
	control.apply = func(request context.Context, next plan, before, after runtimeSelection) error {
		return queue(request, next, before, after, false)
	}
	control.latencyProfile = awgPool.probeProfile
	editor := newPanelEditor(config, key, func(request context.Context, next plan) error {
		if err := control.validatePlanChange(next); err != nil {
			return err
		}
		selection, _ := control.state()
		return queue(request, next, selection, selection, true)
	})
	editor.refreshBindings = opts.allowLAN
	editor.subscriptions = newPanelSubscriptions(editor, control)
	editor.auth = newPanelAuth(filepath.Join(filepath.Dir(opts.config), "panel-password.json"), key)
	editor.history = filepath.Join(filepath.Dir(opts.config), "revisions")
	editor.preflight = func(next plan) error {
		if err := control.validatePlanChange(next); err != nil {
			return err
		}
		if err := checkAWG(next); err != nil {
			return err
		}
		selection, _ := control.state()
		effective := runtimePlan(next, selection)
		_, err := compileXray(effective, opts.allowLAN, effective.Zapret)
		return err
	}
	traffic := new(trafficMonitor)
	resources := &routerResourceMonitor{diskPath: filepath.Dir(opts.config)}
	resources.setEngine(instance)
	control.resources = resources
	panelContext, stopPanel := context.WithCancel(ctx)
	defer stopPanel()
	go traffic.run(panelContext)
	go resources.run(panelContext)
	go control.runVPNHealth(panelContext)
	go editor.watchGeoIP(panelContext)
	dnsAllowed := allowed
	if host, _, _ := net.SplitHostPort(opts.dnsListen); host == "127.0.0.1" {
		dnsAllowed = netip.MustParsePrefix("127.0.0.0/8")
	}
	dnsControl := newPanelDNS(panelContext, opts.config, opts.dnsListen, dnsAllowed)
	dnsControl.configureLAN(panelContext, opts, config, allowed)
	defer dnsControl.stop()
	server := &http.Server{
		Handler: handler(editor, state, address, allowed, opts.helperDir, traffic, control, dnsControl), ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout: 8 * time.Second, WriteTimeout: 55 * time.Second, IdleTimeout: 20 * time.Second,
	}
	go editor.subscriptions.run(panelContext)
	defer server.Close()
	failed := make(chan error, 1)
	go func() { failed <- server.Serve(listener) }()
	opts.logMessage("RouteHub готов, панель " + address + ", SOCKS " + state.SOCKS)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-instance.done:
			return fmt.Errorf("ядро Xray завершилось: %v", instance.result)
		case err := <-failed:
			return err
		case update := <-coreUpdates:
			selection, _ := control.state()
			control.suspendVPNHealth()
			instance, err = replaceXrayCore(ctx, opts, instance, configPath, prepared, selection, cores.store, update)
			resources.setEngine(instance)
			if instance != nil {
				control.resumeVPNHealth(selection)
			}
			update.result <- err
			if instance == nil {
				return err
			}
		case update := <-updates:
			next, finish, err := awgPool.prepare(update.next)
			if err == nil {
				control.suspendVPNHealth()
				instance, configPath, err = replaceRuntime(ctx, opts, instance, configPath, prepared, next, update.before, update.after, update.persist)
				resources.setEngine(instance)
				finish(err == nil)
				if err == nil {
					prepared = next
					control.resumeVPNHealth(update.after, prepared)
				} else if instance != nil {
					control.resumeVPNHealth(update.before, prepared)
				}
			}
			update.result <- err
			if instance == nil {
				return err
			}
		}
	}
}

func checkAWG(config plan) error {
	for _, entry := range config.Profiles {
		if entry.Protocol == "amneziawg" && entry.AWGConfig == "" {
			if err := awg.CheckInterface(entry.Interface); err != nil {
				return fmt.Errorf("профиль %q: %w", entry.ID, err)
			}
		}
	}
	return nil
}

func writeRuntimeXray(opts options, dir string, config plan, zapret bool) (string, error) {
	config, err := pinRuntimeXrayProfiles(context.Background(), config, resolvePublicProbeIPv4)
	if err != nil {
		return "", err
	}
	assets := make(map[string]string)
	compiled, err := compileXrayWithAssets(config, opts.allowLAN, zapret, func(id string) string {
		if config.geoRoot == "" {
			return ""
		}
		assets[id] = id + ".dat"
		return assets[id]
	})
	if err != nil {
		return "", err
	}
	if err := opts.vpnHealth.addToXray(compiled, config); err != nil {
		return "", err
	}
	path, err := privateJSON(dir, "xray-*.json", compiled)
	if err != nil {
		return "", err
	}
	if err := stageRuntimeGeoAssets(path, config, assets); err != nil {
		removeRuntimeXray(path)
		return "", err
	}
	return path, nil
}

func writePrivate(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	return errors.Join(err, file.Close())
}

func run(ctx context.Context, args []string) (result error) {
	if len(args) < 1 || (args[0] != "serve" && args[0] != "check" && args[0] != "compile" && args[0] != "boot-enabled") {
		return errors.New("команда: routehub {serve|check|compile|boot-enabled} -config путь")
	}
	action := args[0]
	var opts options
	var logPath string
	flags := flag.NewFlagSet(action, flag.ContinueOnError)
	flags.StringVar(&opts.config, "config", "/opt/etc/routehub/config.json", "путь к конфигу RouteHub")
	flags.StringVar(&opts.xray, "xray", "/opt/sbin/xray", "путь к Xray")
	flags.StringVar(&opts.output, "output", "", "новый приватный JSON для команды compile")
	flags.StringVar(&opts.panelKey, "panel-key-file", "", "приватный файл ключа редактирования панели")
	flags.StringVar(&opts.helperDir, "helper-dir", "/opt/lib/routehub", "каталог исполняемых сетевых помощников")
	flags.StringVar(&opts.dnsListen, "dns-listen", "127.0.0.1:18955", "адрес DNS RouteHub, пустая строка отключает слушатель")
	flags.StringVar(&logPath, "log-file", "", "файл журнала службы с ротацией")
	flags.BoolVar(&opts.allowLAN, "allow-lan", false, "разрешить настроенный перехват LAN")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if action == "serve" && logPath != "" {
		opts.serviceLog = &serviceLog{path: logPath, disk: routerDisk}
		defer func() {
			if result != nil {
				opts.logMessage(result.Error())
			}
		}()
	}
	if action == "boot-enabled" {
		enabled, err := runtimeBootEnabled(opts)
		if err == nil && enabled {
			fmt.Println("enabled")
		}
		return err
	}
	config, err := loadPlan(opts.config)
	if err != nil {
		return err
	}
	if opts.allowLAN && config.Transparent == nil {
		return errors.New("флаг -allow-lan требует секцию transparent")
	}
	if action == "serve" {
		if opts.dnsListen != "" {
			host, port, err := net.SplitHostPort(opts.dnsListen)
			number, invalidPort := strconv.ParseUint(port, 10, 16)
			if err != nil || invalidPort != nil || number == 0 || (host != "127.0.0.1" && host != config.PanelHost) {
				return errors.New("dns-listen должен слушать loopback или частный адрес панели")
			}
		}
		if opts.allowLAN {
			config.bindings = routerBindings(ctx)
		}
		return serve(ctx, config, opts)
	}
	control, err := newPanelRuntime(opts)
	if err != nil {
		return err
	}
	selection := control.bootSelection(config)
	effective := runtimePlan(config, selection)
	if action == "compile" {
		if opts.output == "" {
			return errors.New("укажите -output для записи приватного конфига")
		}
		compiled, err := compileXray(effective, opts.allowLAN, selection.zapretEnabled())
		if err != nil {
			return err
		}
		data, err := json.MarshalIndent(compiled, "", "  ")
		if err != nil {
			return err
		}
		return writePrivate(opts.output, data)
	}
	dir, err := os.MkdirTemp("", "routehub-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path, err := writeRuntimeXray(opts, dir, effective, selection.zapretEnabled())
	if err != nil {
		return err
	}
	if err := validateXrayConfig(ctx, opts.xray, path); err != nil {
		return fmt.Errorf("Xray отклонил конфиг: %w. Для диагностики сохраните private JSON командой compile", err)
	}
	fmt.Println("Xray принял сгенерированный конфиг")
	return nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
