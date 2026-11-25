package main

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"routehub/devicepolicy"
)

const selectedVPNTarget = "@vpn"

var errRuntimeNotArmed = errors.New("режим не разрешён в настройках RouteHub")

type runtimeSelection struct {
	VPN             bool
	Profile         string
	YouTube         bool
	Discord         bool
	YouTubeStrategy string
	DiscordStrategy string
}

type bootOptions struct {
	VPN           bool   `json:"vpn"`
	Profile       string `json:"profile"`
	ZapretYouTube bool   `json:"zapretYouTube"`
	ZapretDiscord bool   `json:"zapretDiscord"`
}

type runtimeSettings struct {
	Boot            bootOptions `json:"boot"`
	LastProfile     string      `json:"lastProfile,omitempty"`
	YouTubeStrategy string      `json:"youtubeStrategy,omitempty"`
	DiscordStrategy string      `json:"discordStrategy,omitempty"`
}

type runtimeCheck struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	LatencyMS *int64 `json:"latencyMs,omitempty"`
}

type runtimeVPNStatus struct {
	Enabled   bool              `json:"enabled"`
	Profile   string            `json:"profile"`
	Available bool              `json:"available"`
	Health    *runtimeVPNHealth `json:"health,omitempty"`
}

type runtimeZapretService struct {
	Enabled  bool   `json:"enabled"`
	Strategy string `json:"strategy"`
}

type zapretStrategy struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Services []string `json:"services"`
}

type runtimeZapretStatus struct {
	Available  bool                 `json:"available"`
	YouTube    runtimeZapretService `json:"youtube"`
	Discord    runtimeZapretService `json:"discord"`
	Strategies []zapretStrategy     `json:"strategies"`
}

type runtimeSnapshot struct {
	XrayVersion string              `json:"xrayVersion,omitempty"`
	VPN         runtimeVPNStatus    `json:"vpn"`
	Zapret      runtimeZapretStatus `json:"zapret"`
	Boot        bootOptions         `json:"boot"`
	LAN         bool                `json:"lan"`
}

type panelRuntime struct {
	resources      *routerResourceMonitor
	cores          *panelCoreUpdates
	mu             sync.RWMutex
	selection      runtimeSelection
	settings       runtimeSettings
	legacy         bool
	path           string
	opts           options
	apply          func(context.Context, plan, runtimeSelection, runtimeSelection) error
	latency        chan struct{}
	latencyMu      sync.Mutex
	latencyProfile func(profile) (profile, error)
	health         *runtimeVPNHealth
	healthServing  string
	healthGroup    bool
	healthEpoch    uint64
	healthCancel   context.CancelFunc
	healthRequests chan struct{}
}

func newPanelRuntime(opts options) (*panelRuntime, error) {
	control := &panelRuntime{
		opts: opts, path: filepath.Join(filepath.Dir(opts.config), "runtime.json"),
		latency:        make(chan struct{}, profileProbeConcurrency),
		healthRequests: make(chan struct{}, 1),
	}
	file, err := os.Open(control.path)
	if errors.Is(err, os.ErrNotExist) {
		control.legacy = true
		return control, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 4096 {
		return nil, errors.New("runtime.json должен быть обычным приватным файлом не более 4 КиБ")
	}
	if err := decodeJSON(file, &control.settings); err != nil {
		return nil, errors.New("некорректный runtime.json")
	}
	return control, nil
}

func runtimeBootEnabled(opts options) (bool, error) {
	control, err := newPanelRuntime(opts)
	if err != nil {
		return false, err
	}
	_, settings := control.state()
	start := settings.Boot
	return start.VPN || start.ZapretYouTube || start.ZapretDiscord, nil
}

func findProfile(config plan, id string) (profile, bool) {
	if id == "" {
		return profile{}, false
	}
	for _, entry := range config.Profiles {
		if entry.ID == id {
			return entry, true
		}
	}
	return profile{}, false
}

func bootProfile(config plan, settings runtimeSettings) string {
	if settings.Boot.Profile != "" {
		return settings.Boot.Profile
	}
	if _, ok := findProfile(config, settings.LastProfile); ok {
		return settings.LastProfile
	}
	if len(config.Profiles) > 0 {
		return config.Profiles[0].ID
	}
	return ""
}

func (control *panelRuntime) state() (runtimeSelection, runtimeSettings) {
	control.mu.RLock()
	defer control.mu.RUnlock()
	return control.selection, control.settings
}

func (control *panelRuntime) publish(selection runtimeSelection, settings runtimeSettings) {
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.selection.VPN != selection.VPN || control.selection.Profile != selection.Profile {
		control.invalidateVPNHealthLocked()
		if selection.VPN {
			control.requestVPNHealthLocked()
		}
	}
	control.selection, control.settings = selection, settings
}

func (control *panelRuntime) zapretArmed(config plan) bool {
	return config.Zapret
}

func (control *panelRuntime) bootSelection(config plan) runtimeSelection {
	_, settings := control.state()
	if control.legacy {
		choice := runtimeSelection{Profile: bootProfile(config, settings)}
		if _, ok := findProfile(config, config.DefaultTarget); ok {
			choice.Profile = config.DefaultTarget
		}
		choice.VPN = choice.Profile != ""
		if control.opts.allowLAN && control.zapretArmed(config) && config.ZapretServices != nil {
			choice.YouTube, choice.Discord = config.ZapretServices.YouTube, config.ZapretServices.Discord
			choice.YouTubeStrategy, choice.DiscordStrategy = "custom", "custom"
		}
		return choice
	}
	choice := runtimeSelection{
		Profile:         bootProfile(config, settings),
		YouTubeStrategy: settings.YouTubeStrategy, DiscordStrategy: settings.DiscordStrategy,
	}
	if settings.Boot.VPN {
		_, choice.VPN = findProfile(config, choice.Profile)
	}
	if control.zapretArmed(config) {
		choice.YouTube = settings.Boot.ZapretYouTube && control.hasZapretStrategy("youtube", choice.YouTubeStrategy)
		choice.Discord = settings.Boot.ZapretDiscord && control.hasZapretStrategy("discord", choice.DiscordStrategy)
	}
	return choice
}

func bootZapretChoice(settings runtimeSettings) runtimeSelection {
	return runtimeSelection{
		YouTube: settings.Boot.ZapretYouTube, Discord: settings.Boot.ZapretDiscord,
		YouTubeStrategy: settings.YouTubeStrategy, DiscordStrategy: settings.DiscordStrategy,
	}
}

func (control *panelRuntime) snapshot(config plan) runtimeSnapshot {
	control.mu.RLock()
	selection, settings, health := control.selection, control.settings, control.health
	if !selection.VPN || selection.Profile != control.healthServing {
		health = nil
	}
	control.mu.RUnlock()
	if _, ok := findProfile(config, selection.Profile); !ok {
		selection.Profile = bootProfile(config, settings)
		health = nil
	}
	return runtimeSnapshot{
		LAN:         control.opts.allowLAN,
		XrayVersion: control.cores.version(),
		VPN:         runtimeVPNStatus{Enabled: selection.VPN, Profile: selection.Profile, Available: len(config.Profiles) > 0, Health: health},
		Zapret: runtimeZapretStatus{
			Available:  control.zapretArmed(config),
			YouTube:    runtimeZapretService{Enabled: selection.YouTube, Strategy: selection.YouTubeStrategy},
			Discord:    runtimeZapretService{Enabled: selection.Discord, Strategy: selection.DiscordStrategy},
			Strategies: control.zapretStrategies(),
		},
		Boot: settings.Boot,
	}
}

func (control *panelRuntime) validatePlanChange(config plan) error {
	selection, settings := control.state()
	for _, pick := range []struct {
		required bool
		id       string
	}{
		{selection.VPN, selection.Profile},
		{settings.Boot.Profile != "", settings.Boot.Profile},
	} {
		if _, ok := findProfile(config, pick.id); pick.required && !ok {
			return errors.New("сначала смените профиль в VPN или в автозапуске")
		}
	}
	if settings.Boot.VPN {
		if _, ok := findProfile(config, bootProfile(config, settings)); !ok {
			return errors.New("для автозапуска VPN нужен хотя бы один профиль")
		}
	}
	return nil
}

func (selection runtimeSelection) effectiveDifferent(next runtimeSelection) bool {
	return selection.VPN != next.VPN || selection.VPN && selection.Profile != next.Profile || selection.zapretDifferent(next)
}

func (selection runtimeSelection) mapTarget(target string) string {
	if target == selectedVPNTarget {
		if selection.VPN {
			return selection.Profile
		}
		return "direct"
	}
	if !selection.VPN && target != "direct" && target != "zapret" && target != "@block" && target != "" {
		return "direct"
	}
	if target == "zapret" && !selection.YouTube && !selection.Discord {
		return "direct"
	}
	return target
}

func runtimePlan(config plan, selection runtimeSelection) plan {
	next := copyPanelPlan(config)
	next.runtimeHealthTarget = ""
	if selection.VPN {
		next.runtimeHealthTarget = selection.Profile
	}
	next.DefaultTarget = selection.mapTarget(next.DefaultTarget)
	rewrite := func(rules []devicepolicy.Rule) {
		for i := range rules {
			rules[i].Target = selection.mapTarget(rules[i].Target)
		}
	}
	rewrite(next.Rules)
	for i := range next.Devices {
		device := &next.Devices[i]
		device.DefaultTarget = selection.mapTarget(device.DefaultTarget)
		rewrite(device.Rules)
	}
	next.Zapret = selection.YouTube || selection.Discord
	next.ZapretServices = &zapretServices{YouTube: selection.YouTube, Discord: selection.Discord}
	return next
}

func (control *panelRuntime) store(settings runtimeSettings) error {
	pending, err := privateJSON(filepath.Dir(control.path), ".routehub-runtime-*", settings)
	if err != nil {
		return err
	}
	defer os.Remove(pending)
	return os.Rename(pending, control.path)
}

func (control *panelRuntime) change(ctx context.Context, config plan, next runtimeSelection, settings runtimeSettings) error {
	before, oldSettings := control.state()
	if before.effectiveDifferent(next) {
		if err := control.apply(ctx, config, before, next); err != nil {
			return err
		}
	}
	if settings != oldSettings || control.legacy {
		if err := control.store(settings); err != nil {
			if before.effectiveDifferent(next) {
				if rollback := control.apply(context.WithoutCancel(ctx), config, next, before); rollback != nil {
					control.publish(next, oldSettings)
					return errors.New("настройки не сохранены, вернуть прежний режим не удалось")
				}
			}
			return errors.New("не удалось сохранить настройки запуска")
		}
	}
	control.legacy = false
	control.publish(next, settings)
	return nil
}

func runtimeRequest(response http.ResponseWriter, request *http.Request, editor *panelEditor, value any) bool {
	if !editor.authorized(request) {
		sendJSON(response, http.StatusForbidden, object{"error": "Доступ к управлению запрещён"})
		return false
	}
	contentType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		sendJSON(response, http.StatusUnsupportedMediaType, object{"error": "Требуется application/json"})
		return false
	}
	if err := decodeJSON(http.MaxBytesReader(response, request.Body, 2048), value); err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": "Некорректный запрос управления"})
		return false
	}
	return true
}

func (control *panelRuntime) setVPN(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Enabled *bool  `json:"enabled"`
			Profile string `json:"profile"`
		}
		if !runtimeRequest(response, request, editor, &input) {
			return
		}
		editor.editMutex.Lock()
		defer editor.editMutex.Unlock()

		if request.Context().Err() != nil {
			return
		}
		config := editor.current().plan
		next, settings := control.state()
		if input.Enabled == nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Укажите состояние VPN"})
			return
		}
		if input.Profile != "" {
			next.Profile = input.Profile
		}
		if _, ok := findProfile(config, next.Profile); !ok && input.Profile == "" {
			next.Profile = bootProfile(config, settings)
		}
		if _, ok := findProfile(config, next.Profile); !ok && (*input.Enabled || input.Profile != "") {
			sendJSON(response, http.StatusBadRequest, object{"error": "Выберите существующий профиль VPN"})
			return
		}
		next.VPN = *input.Enabled
		if next.VPN || input.Profile != "" {
			settings.LastProfile = next.Profile
		}
		control.applyResponse(response, request, config, next, settings)
	}
}

func (control *panelRuntime) applyResponse(response http.ResponseWriter, request *http.Request, config plan, next runtimeSelection, settings runtimeSettings) {
	if err := control.change(request.Context(), config, next, settings); err != nil {
		sendJSON(response, http.StatusUnprocessableEntity, object{"error": err.Error()})
		return
	}
	sendJSON(response, http.StatusOK, control.snapshot(config))
}

func (control *panelRuntime) setBoot(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			VPN           *bool  `json:"vpn"`
			Profile       string `json:"profile"`
			ZapretYouTube *bool  `json:"zapretYouTube"`
			ZapretDiscord *bool  `json:"zapretDiscord"`
		}
		if !runtimeRequest(response, request, editor, &input) {
			return
		}
		if input.VPN == nil || input.ZapretYouTube == nil || input.ZapretDiscord == nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Укажите настройки всех трёх служб"})
			return
		}
		editor.editMutex.Lock()
		defer editor.editMutex.Unlock()
		if request.Context().Err() != nil {
			return
		}
		config := editor.current().plan
		selection, settings := control.state()
		settings.Boot = bootOptions{VPN: *input.VPN, Profile: input.Profile,
			ZapretYouTube: *input.ZapretYouTube, ZapretDiscord: *input.ZapretDiscord}
		if settings.Boot.ZapretYouTube && settings.YouTubeStrategy == "" {
			settings.YouTubeStrategy = selection.YouTubeStrategy
		}
		if settings.Boot.ZapretDiscord && settings.DiscordStrategy == "" {
			settings.DiscordStrategy = selection.DiscordStrategy
		}
		if _, ok := findProfile(config, bootProfile(config, settings)); !ok && (settings.Boot.VPN || input.Profile != "") {
			sendJSON(response, http.StatusBadRequest, object{"error": "Выберите существующий профиль автозапуска"})
			return
		}
		if !control.zapretArmed(config) && (settings.Boot.ZapretYouTube || settings.Boot.ZapretDiscord) {
			sendJSON(response, http.StatusConflict, object{"error": errRuntimeNotArmed.Error()})
			return
		}
		if settings.Boot.ZapretYouTube && !control.hasZapretStrategy("youtube", settings.YouTubeStrategy) ||
			settings.Boot.ZapretDiscord && !control.hasZapretStrategy("discord", settings.DiscordStrategy) {
			sendJSON(response, http.StatusConflict, object{"error": "Сначала выберите или проверьте стратегию Zapret для автозапуска"})
			return
		}
		if _, err := runtimeZapretArgs(control.opts, bootZapretChoice(settings), zapretTrial{}); err != nil {
			sendJSON(response, http.StatusConflict, object{"error": err.Error()})
			return
		}
		control.applyResponse(response, request, config, selection, settings)
	}
}

func (control *panelRuntime) bootCheck(editor *panelEditor) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input struct{}
		if !runtimeRequest(response, request, editor, &input) {
			return
		}
		config := editor.current().plan
		_, settings := control.state()
		checks := []runtimeCheck{
			{ID: "vpn", Status: "disabled", Message: "Автозапуск выключен."},
			{ID: "youtube", Status: "disabled", Message: "Автозапуск выключен."},
			{ID: "discord", Status: "disabled", Message: "Автозапуск выключен."},
		}
		if settings.Boot.VPN {
			entry, ok := findProfile(config, bootProfile(config, settings))
			checks[0] = runtimeCheck{ID: "vpn", Status: "ready", Message: "Профиль выбран. Доступность туннеля здесь не проверяется."}
			var err error
			if entry.XrayGroup != nil {
				err = validateXrayProfileGroup(entry.XrayGroup)
			} else {
				_, err = profileOutbound(entry)
			}
			if !ok || err != nil {
				checks[0].Status, checks[0].Message = "unavailable", "Профиль отсутствует или имеет некорректные параметры."
			}
		}
		for i, item := range []struct {
			enabled  bool
			strategy string
		}{
			{settings.Boot.ZapretYouTube, settings.YouTubeStrategy},
			{settings.Boot.ZapretDiscord, settings.DiscordStrategy},
		} {
			check := &checks[i+1]
			if item.enabled {
				check.Status, check.Message = "ready", "Стратегия подготовлена для запуска при загрузке."
				if !control.zapretArmed(config) || !control.hasZapretStrategy(check.ID, item.strategy) {
					check.Status, check.Message = "unavailable", "Проверьте разрешение режима Zapret и наличие выбранной стратегии."
				}
			}
		}
		choice := bootZapretChoice(settings)
		if desired := choice.zapretEnabled(); desired && control.zapretArmed(config) {
			if err := runRuntimeZapret(control.opts, choice, zapretTrial{}, "check"); err != nil {
				for i, enabled := range []bool{choice.YouTube, choice.Discord} {
					if enabled {
						checks[i+1].Status, checks[i+1].Message = "unavailable", err.Error()
					}
				}
			}
		}
		sendJSON(response, http.StatusOK, object{"checks": checks})
	}
}
