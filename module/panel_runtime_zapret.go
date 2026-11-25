package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

const zapretTrialMark = 0x2000000

var candidateIDs = []string{"variant-1", "variant-2", "variant-3"}

func (selection runtimeSelection) zapretEnabled() bool {
	return selection.YouTube || selection.Discord
}

func (selection runtimeSelection) zapretDifferent(next runtimeSelection) bool {
	return selection.YouTube != next.YouTube || selection.Discord != next.Discord ||
		selection.YouTube && selection.YouTubeStrategy != next.YouTubeStrategy ||
		selection.Discord && selection.DiscordStrategy != next.DiscordStrategy
}

func (selection *runtimeSelection) selectZapret(service, strategy string, enabled bool) {
	if service == "youtube" {
		selection.YouTube, selection.YouTubeStrategy = enabled, strategy
	} else {
		selection.Discord, selection.DiscordStrategy = enabled, strategy
	}
}

func (selection runtimeSelection) strategy(service string) string {
	if service == "youtube" {
		return selection.YouTubeStrategy
	}
	return selection.DiscordStrategy
}

func trustedStrategyFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 32<<10 {
		return nil, errors.New("файл стратегии должен быть приватным и не больше 32 КиБ")
	}
	return os.ReadFile(path)
}

func readZapretStrategy(opts options, service, name string) ([]byte, error) {
	base := filepath.Dir(opts.config)
	if name == "custom" {
		return trustedStrategyFile(filepath.Join(base, "zapret.args"))
	}
	if !slices.Contains(candidateIDs, name) {
		return nil, errors.New("неизвестная стратегия Zapret")
	}
	return trustedStrategyFile(filepath.Join(base, "zapret-strategies", service+"-"+name+".args"))
}

func managedZapretArgs(data []byte) (shared, profile []string, err error) {
	strategy := false
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.ContainsAny(line, "\x00\r") || len(line) > 1024 {
			return nil, nil, errors.New("некорректная строка стратегии Zapret")
		}
		argument, value, ok := strings.Cut(line, "=")
		if !ok || value == "" {
			return nil, nil, errors.New("укажите значение аргумента Zapret")
		}
		switch argument {
		case "--lua-init", "--blob":
			shared = append(shared, line)
		case "--filter-l3", "--filter-tcp", "--filter-udp", "--filter-l7", "--payload", "--in-range", "--out-range", "--lua-desync":
			profile = append(profile, line)
			strategy = strategy || argument == "--lua-desync"
		default:
			return nil, nil, errors.New("неподдерживаемый аргумент стратегии Zapret")
		}
	}
	if !strategy {
		return nil, nil, errors.New("стратегия Zapret не содержит lua-desync")
	}
	return shared, profile, nil
}

func (control *panelRuntime) hasZapretStrategy(service, name string) bool {
	data, err := readZapretStrategy(control.opts, service, name)
	if err != nil {
		return false
	}
	if name == "custom" {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "--lua-desync=") {
				return true
			}
		}
		return false
	}
	_, _, err = managedZapretArgs(data)
	return err == nil
}

func (control *panelRuntime) zapretStrategies() []zapretStrategy {
	names := make([]zapretStrategy, 0, 4)
	for _, name := range append([]string{"custom"}, candidateIDs...) {
		var services []string
		for _, service := range []string{"youtube", "discord"} {
			if control.hasZapretStrategy(service, name) {
				services = append(services, service)
			}
		}
		if len(services) == 0 {
			continue
		}
		label := "Конфигурация " + strings.TrimPrefix(name, "variant-")
		if name == "custom" {
			label = "Локальная конфигурация"
		}
		names = append(names, zapretStrategy{ID: name, Label: label, Services: services})
	}
	return names
}

type zapretTrial struct{ service, strategy string }

func zapretServiceDomains(service string) string {
	if service == "youtube" {
		return "youtube.com,youtu.be,youtube-nocookie.com,googlevideo.com,ytimg.com,youtubei.googleapis.com"
	}
	return "discord.com,discordapp.com,discordapp.net,discord.gg,discord.media"
}

func provisionedZapretOption(option, helperDir string) string {
	for _, name := range []string{"zapret-lib.lua", "zapret-antidpi.lua"} {
		if option == "--lua-init=@/opt/lib/routehub/zapret2/lua/"+name && helperDir != "" {
			return "--lua-init=@" + filepath.Join(helperDir, "zapret2", "lua", name)
		}
	}
	return option
}

func runtimeZapretArgs(opts options, selection runtimeSelection, trial zapretTrial) ([]string, error) {
	active := []zapretTrial{}
	if selection.YouTube {
		active = append(active, zapretTrial{"youtube", selection.YouTubeStrategy})
	}
	if selection.Discord {
		active = append(active, zapretTrial{"discord", selection.DiscordStrategy})
	}
	custom := 0
	for _, item := range active {
		if item.strategy == "custom" {
			custom++
		}
	}
	if custom > 0 {
		if len(active) != custom || trial.strategy != "" {
			return nil, errors.New("локальная конфигурация несовместима с одновременной проверкой отдельных вариантов")
		}
		return nil, nil // The pre-existing standalone format remains intact.
	}
	if trial.strategy != "" {
		active = append(active, trial)
	}
	var shared, profiles []string
	for index, item := range active {
		data, err := readZapretStrategy(opts, item.service, item.strategy)
		if err != nil {
			return nil, errors.New("файл выбранной стратегии Zapret недоступен")
		}
		init, recipe, err := managedZapretArgs(data)
		if err != nil {
			return nil, err
		}
		for _, option := range init {
			option = provisionedZapretOption(option, opts.helperDir)
			if !slices.Contains(shared, option) {
				shared = append(shared, option)
			}
		}
		if index > 0 {
			profiles = append(profiles, "--new")
		}
		profiles = append(profiles, "--hostlist-domains="+zapretServiceDomains(item.service))
		if trial.strategy != "" {
			filter := "--filter-mark=0/0x2000000"
			if index == len(active)-1 {
				filter = "--filter-mark=0x2000000/0x2000000"
			}
			profiles = append(profiles, filter)
		}
		profiles = append(profiles, recipe...)
	}
	return append(shared, profiles...), nil
}

func zapretCapability(ctx context.Context, opts options) string {
	ctx, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
	defer cancel()
	command := exec.CommandContext(ctx, filepath.Join(opts.helperDir, "routehub-zapret"), "capability")
	command.Env = append(os.Environ(), "ROUTEHUB_ZAPRET_ETC="+filepath.Dir(opts.config))
	output, err := command.Output()
	if err == nil {
		switch capability := strings.TrimSpace(string(output)); capability {
		case "disabled", "missing-engine", "missing-queue", "connbytes", "userspace":
			return capability
		}
	}
	return "unknown"
}

func runRuntimeZapret(opts options, selection runtimeSelection, trial zapretTrial, action string) error {
	args, err := runtimeZapretArgs(opts, selection, trial)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	program := filepath.Join(opts.helperDir, "routehub-zapret")
	command := exec.CommandContext(ctx, program, action)
	command.WaitDelay = time.Second
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.Env = append(os.Environ(), "ROUTEHUB_ZAPRET_ETC="+filepath.Dir(opts.config),
		"ROUTEHUB_ZAPRET_MANAGED=0", "ROUTEHUB_ZAPRET_ARGS=")
	if len(args) > 0 {
		file, err := os.CreateTemp("", "routehub-nfqws-*")
		if err != nil {
			return err
		}
		path := file.Name()
		defer os.Remove(path)
		_, err = file.WriteString(strings.Join(args, "\n") + "\n")
		if err = errors.Join(err, file.Close()); err != nil {
			return err
		}
		command.Env = append(command.Env, "ROUTEHUB_ZAPRET_ARGS="+path, "ROUTEHUB_ZAPRET_MANAGED=1")
	}
	output, err := command.Output()
	if err != nil || action == "check" && strings.TrimSpace(string(output)) == "disabled" {
		switch zapretCapability(context.Background(), opts) {
		case "disabled":
			return errors.New("Zapret выключен в zapret.conf. Для запуска нужен ENABLED=1")
		case "missing-engine":
			return errors.New("Не найден исполняемый файл nfqws2. Проверьте путь NFQWS в zapret.conf")
		case "missing-queue":
			return errors.New("Ядро роутера не предоставляет интерфейс NFQUEUE")
		case "userspace":
			if len(args) == 0 {
				return errors.New("Без учёта соединений ядром выберите отдельную стратегию YouTube или Discord")
			}
			return errors.New("Совместимый режим Zapret не запустился. Проверьте Lua-файлы, очередь NFQUEUE и поддержку iptables limit")
		}
		return errors.New("ядро и очередь Zapret не подтвердили готовность выбранной стратегии")
	}
	return nil
}

func startRuntimeZapret(opts options, selection runtimeSelection) error {
	if !selection.zapretEnabled() {
		return nil
	}
	return runRuntimeZapret(opts, selection, zapretTrial{}, "start")
}

func (control *panelRuntime) setZapret(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Service  string `json:"service"`
			Enabled  *bool  `json:"enabled"`
			Strategy string `json:"strategy"`
		}
		if !runtimeRequest(response, request, editor, &input) {
			return
		}
		if input.Enabled == nil || input.Service != "youtube" && input.Service != "discord" {
			sendJSON(response, http.StatusBadRequest, object{"error": "Укажите состояние Zapret для YouTube или Discord"})
			return
		}
		editor.editMutex.Lock()
		defer editor.editMutex.Unlock()
		if request.Context().Err() != nil {
			return
		}
		config := editor.current().plan
		next, settings := control.state()
		if input.Strategy == "" {
			input.Strategy = next.strategy(input.Service)
		}
		if input.Strategy != "" && input.Strategy != "custom" && !slices.Contains(candidateIDs, input.Strategy) {
			sendJSON(response, http.StatusBadRequest, object{"error": "Неизвестная стратегия Zapret"})
			return
		}
		if *input.Enabled {
			if !control.zapretArmed(config) {
				sendJSON(response, http.StatusConflict, object{"error": errRuntimeNotArmed.Error()})
				return
			}
			if !control.hasZapretStrategy(input.Service, input.Strategy) {
				sendJSON(response, http.StatusBadRequest, object{"error": "Установите и выберите подготовленную стратегию Zapret"})
				return
			}
		}
		next.selectZapret(input.Service, input.Strategy, *input.Enabled)
		if input.Service == "youtube" {
			settings.YouTubeStrategy = input.Strategy
		} else {
			settings.DiscordStrategy = input.Strategy
		}
		control.applyResponse(response, request, config, next, settings)
	}
}

func (control *panelRuntime) checkZapret(editor *panelEditor) http.HandlerFunc {
	check := editor.zapretCheckWithState(func(config plan) (bool, zapretServices) {
		selection, _ := control.state()
		return control.zapretArmed(config) && selection.zapretEnabled(), zapretServices{YouTube: selection.YouTube, Discord: selection.Discord}
	}, newZapretProbe(control.opts.helperDir, 0))
	return func(response http.ResponseWriter, request *http.Request) {
		if !editor.editMutex.TryLock() {
			sendJSON(response, http.StatusTooManyRequests, object{"error": "Дождитесь завершения другой операции RouteHub"})
			return
		}
		defer editor.editMutex.Unlock()
		check(response, request)
	}
}

func (control *panelRuntime) autoZapret(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Service string `json:"service"`
		}
		if !runtimeRequest(response, request, editor, &input) {
			return
		}
		if input.Service != "youtube" && input.Service != "discord" {
			sendJSON(response, http.StatusBadRequest, object{"error": "Укажите YouTube или Discord"})
			return
		}
		if !editor.editMutex.TryLock() {
			sendJSON(response, http.StatusTooManyRequests, object{"error": "Дождитесь завершения другой операции RouteHub"})
			return
		}
		defer editor.editMutex.Unlock()
		config := editor.current().plan
		if !control.zapretArmed(config) {
			sendJSON(response, http.StatusConflict, object{"error": errRuntimeNotArmed.Error()})
			return
		}

		ctx, cancel := context.WithTimeout(request.Context(), 23*time.Second)
		defer cancel()
		checks, err := control.trialZapret(ctx, config, input.Service)
		if err != nil {
			sendJSON(response, http.StatusUnprocessableEntity, object{"error": err.Error(), "checks": checks, "runtime": control.snapshot(config)})
			return
		}
		sendJSON(response, http.StatusOK, object{"checks": checks, "runtime": control.snapshot(config)})
	}
}

func (control *panelRuntime) trialZapret(ctx context.Context, config plan, service string) ([]runtimeCheck, error) {
	original, settings := control.state()
	probe := newZapretProbe(control.opts.helperDir, zapretTrialMark)
	endpoint := youtubeCheckURL
	if service == "discord" {
		endpoint = discordCheckURL
	}
	checks := make([]runtimeCheck, 0, len(candidateIDs))
	if original.YouTube && original.YouTubeStrategy == "custom" ||
		original.Discord && original.DiscordStrategy == "custom" {
		return checks, errors.New("для проверки отдельных конфигураций отключите общий локальный профиль Zapret")
	}
	var best *runtimeCheck
	for _, name := range candidateIDs {
		outcome := runtimeCheck{ID: name, Status: "unavailable", Message: "Файл стратегии не установлен."}
		if ctx.Err() != nil {
			outcome.Status, outcome.Message = "canceled", "Проверка завершилась до запуска варианта."
		} else if control.hasZapretStrategy(service, name) {
			trial := zapretTrial{service, name}
			if err := runRuntimeZapret(control.opts, original, trial, "check"); err != nil {
				outcome.Message = err.Error()
			} else if ctx.Err() == nil {
				tested, err := control.probeZapretRecipe(ctx, original, trial, endpoint, probe)
				if err != nil {
					return append(checks, outcome), err
				}
				outcome.Status, outcome.Message, outcome.LatencyMS = tested.Status, tested.Message, tested.LatencyMS
			}
		}
		checks = append(checks, outcome)
		item := &checks[len(checks)-1]
		if item.Status == "verified" && item.LatencyMS != nil &&
			(best == nil || *item.LatencyMS < *best.LatencyMS) {
			best = item
		}
	}
	if best != nil && ctx.Err() == nil {
		next := original
		next.selectZapret(service, best.ID, true)
		if service == "youtube" {
			settings.YouTubeStrategy = best.ID
		} else {
			settings.DiscordStrategy = best.ID
		}
		if err := control.change(ctx, config, next, settings); err != nil {
			return checks, err
		}
	}
	return checks, nil
}

func (control *panelRuntime) probeZapretRecipe(ctx context.Context, original runtimeSelection, trial zapretTrial, endpoint string, probe zapretProbe) (zapretCheckResponse, error) {
	result := zapretCheckResponse{Service: trial.service, Status: "unavailable", Message: "Не удалось открыть пробную очередь Zapret."}
	if original.zapretEnabled() {
		if err := networkHelper(control.opts, "zapret", "stop"); err != nil {
			return result, errZapretRuntime
		}
	}
	if ctx.Err() == nil && runRuntimeZapret(control.opts, original, trial, "start") == nil {
		probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		probe.check(probeCtx, endpoint, &result)
		cancel()
	}
	if err := networkHelper(control.opts, "zapret", "stop"); err != nil {
		return result, errors.New("не удалось снять временную конфигурацию Zapret")
	}
	if original.zapretEnabled() {
		if err := startRuntimeZapret(control.opts, original); err != nil {
			return result, errors.New("не удалось восстановить прежнюю очередь Zapret")
		}
	}
	return result, nil
}
