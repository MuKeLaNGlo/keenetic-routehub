package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"time"
)

type coreCandidate struct {
	version string
	path    string
}

type coreChecksums struct {
	State     string `json:"state"`
	Algorithm string `json:"algorithm"`
	Source    string `json:"source"`
}

type coreUpdateRecord struct {
	At     time.Time `json:"at"`
	From   string    `json:"from"`
	To     string    `json:"to"`
	Result string    `json:"result"`
}

type coreUpdateState struct {
	Component  string             `json:"component"`
	Name       string             `json:"name"`
	Current    string             `json:"current"`
	Target     *string            `json:"target"`
	Channel    string             `json:"channel"`
	State      string             `json:"state"`
	Signature  string             `json:"signature"`
	Checksum   coreChecksums      `json:"checksum"`
	AutoUpdate bool               `json:"autoUpdate"`
	Checks     []panelTaskStep    `json:"checks"`
	History    []coreUpdateRecord `json:"history"`
}

type panelCoreUpdates struct {
	ctx       context.Context
	dir       string
	store     string
	active    string
	original  string
	managed   bool
	activate  func(context.Context, coreCandidate, string) error
	mu        sync.Mutex
	state     coreUpdateState
	candidate coreCandidate
}

var errCoreRolledBack = errors.New("прежнее ядро Xray восстановлено")

func newPanelCoreUpdates(ctx context.Context, opts options, dir, activeConfig string) (*panelCoreUpdates, error) {
	base, err := filepath.Abs(opts.xray)
	if err != nil {
		return nil, err
	}
	cores := &panelCoreUpdates{ctx: ctx, dir: dir, store: filepath.Join(filepath.Dir(opts.config), "xray-managed.gz"),
		active: filepath.Join(dir, "xray"), original: base, state: coreUpdateState{
			Component: "xray", Name: "Xray", Channel: "stable", State: "up-to-date", Signature: "unknown",
			Checksum: coreChecksums{State: "untested", Algorithm: "sha256", Source: "github-releases"},
			Checks:   []panelTaskStep{}, History: []coreUpdateRecord{},
		}}
	if err := os.Symlink(base, cores.active); err != nil {
		return nil, err
	}
	cores.state.Current = xrayVersion(ctx, base)
	if _, err := os.Lstat(cores.store); err == nil && runtime.GOOS == "linux" && runtime.GOARCH == "arm64" {
		stored, err := restoreCompressedCore(cores.store, dir)
		if err == nil {
			defer os.Remove(stored)
			if validateCoreArchitecture(stored) && validateXrayConfig(ctx, stored, activeConfig) == nil {
				if candidate := xrayVersion(ctx, stored); xrayIsNewer(candidate, cores.state.Current) {
					if os.Rename(stored, cores.active) == nil {
						cores.state.Current = candidate
						cores.managed = true
					}
				}
			}
		}
	}
	return cores, nil
}

func (cores *panelCoreUpdates) supported() bool {
	return runtime.GOOS == "linux" && runtime.GOARCH == "arm64" && cores.version() != ""
}

func (cores *panelCoreUpdates) start(ctx context.Context, config, socks string) (*engine, error) {
	instance, err := startCore(ctx, cores.active, config, socks)
	if err == nil || !cores.managed || ctx.Err() != nil {
		return instance, err
	}
	base := filepath.Join(cores.dir, "original-xray")
	if os.Symlink(cores.original, base) != nil || os.Rename(base, cores.active) != nil {
		return nil, err
	}
	cores.managed = false
	cores.state.Current = xrayVersion(ctx, cores.original)
	return startCore(ctx, cores.active, config, socks)
}

func (cores *panelCoreUpdates) version() string {
	if cores == nil {
		return ""
	}
	cores.mu.Lock()
	defer cores.mu.Unlock()
	return cores.state.Current
}

func (cores *panelCoreUpdates) register(mux *http.ServeMux, diagnostics *panelDiagnostics) {
	mux.HandleFunc("GET /api/panel/cores/updates", func(w http.ResponseWriter, _ *http.Request) {
		cores.mu.Lock()
		snapshot := cores.state
		snapshot.Checks = slices.Clone(cores.state.Checks)
		snapshot.History = slices.Clone(cores.state.History)
		cores.mu.Unlock()
		sendJSON(w, http.StatusOK, []coreUpdateState{snapshot})
	})
	mux.HandleFunc("POST /api/panel/cores/xray/check", cores.run(diagnostics, false))
	mux.HandleFunc("POST /api/panel/cores/xray/install", cores.run(diagnostics, true))
}

func (cores *panelCoreUpdates) run(diagnostics *panelDiagnostics, install bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input struct{}
		if !runtimeRequest(w, r, diagnostics.editor, &input) {
			return
		}
		cores.mu.Lock()
		if cores.state.State == "checking" || cores.state.State == "updating" {
			cores.mu.Unlock()
			sendJSON(w, http.StatusConflict, object{"error": "операция с ядром уже выполняется"})
			return
		}
		if install && (cores.state.State != "available" || cores.candidate.path == "") {
			cores.mu.Unlock()
			sendJSON(w, http.StatusConflict, object{"error": "сначала проверьте и подготовьте обновление Xray"})
			return
		}
		title, phase := "Проверка обновления Xray", "checking"
		if install {
			title, phase = "Обновление Xray", "updating"
		}
		cores.state.State = phase
		cores.mu.Unlock()
		task := panelTask{ID: newPanelRevision(), Kind: "update", Title: title, Scope: "Xray", State: "running", StartedAt: time.Now().UTC(), Steps: []panelTaskStep{}}
		diagnostics.updateTask(task)
		go cores.finishTask(diagnostics, task, install)
		sendJSON(w, http.StatusAccepted, task)
	}
}

func (cores *panelCoreUpdates) finishTask(diagnostics *panelDiagnostics, task panelTask, install bool) {
	ctx, cancel := context.WithTimeout(cores.ctx, 2*time.Minute)
	defer cancel()
	var err error
	if install {
		err = cores.install(ctx)
	} else {
		err = cores.check(ctx)
	}
	finished := time.Now().UTC()
	task.FinishedAt = &finished
	task.State = "done"
	severity := "ok"
	if errors.Is(err, errCoreRolledBack) {
		task.State, severity = "restored", "warn"
	} else if err != nil {
		task.State, severity = "error", "error"
	}
	cores.mu.Lock()
	task.Steps = slices.Clone(cores.state.Checks)
	cores.mu.Unlock()
	for i := range task.Steps {
		switch task.Steps[i].State {
		case "ok":
			task.Steps[i].State = "done"
		case "fail":
			task.Steps[i].State = "error"
		default:
			task.Steps[i].State = "skipped"
		}
	}
	var detail string
	if err != nil {
		detail = err.Error()
		task.Error = detail
	}
	diagnostics.updateTask(task)
	diagnostics.event("update", severity, "Xray", task.Title, detail)
}

func (cores *panelCoreUpdates) check(ctx context.Context) (result error) {
	cores.mu.Lock()
	previous := cores.candidate
	current := cores.state.Current
	cores.candidate = coreCandidate{}
	cores.state.Target = nil
	cores.state.Checks = []panelTaskStep{}
	cores.state.Checksum.State = "untested"
	cores.mu.Unlock()
	if previous.path != "" {
		_ = os.Remove(previous.path)
	}
	defer func() {
		if result != nil {
			cores.mu.Lock()
			cores.state.State = "blocked"
			cores.state.Checks = append(cores.state.Checks, panelTaskStep{Label: "Проверка кандидата Xray", State: "fail", Detail: result.Error()})
			cores.mu.Unlock()
		}
	}()
	if runtime.GOOS != "linux" || runtime.GOARCH != "arm64" || current == "" {
		return errors.New("обновление поддерживается для установленного Xray на Linux ARM64")
	}
	client := geoHTTPClient()
	client.Timeout = 75 * time.Second
	defer client.CloseIdleConnections()
	release, err := readXrayRelease(ctx, client)
	if err != nil {
		return err
	}
	if !xrayIsNewer(release.version, current) {
		cores.mu.Lock()
		cores.state.State = "up-to-date"
		cores.state.Checks = append(cores.state.Checks, panelTaskStep{Label: "Последний стабильный релиз", State: "ok", Detail: release.version})
		cores.mu.Unlock()
		return nil
	}
	path, err := stageXrayRelease(ctx, client, cores.dir, release)
	if err != nil {
		return err
	}
	if !validateCoreArchitecture(path) || xrayVersion(ctx, path) != release.version {
		_ = os.Remove(path)
		return errors.New("бинарник Xray не соответствует версии релиза или архитектуре ARM64")
	}
	cores.mu.Lock()
	cores.candidate = coreCandidate{release.version, path}
	cores.state.Target = &release.version
	cores.state.State, cores.state.Checksum.State = "available", "ok"
	cores.state.Checks = []panelTaskStep{
		{Label: "SHA-256 из GitHub Releases", State: "ok"},
		{Label: "Запуск кандидата на ARM64", State: "ok", Detail: release.version},
	}
	cores.mu.Unlock()
	go cores.expireCandidate(path)
	return nil
}

func (cores *panelCoreUpdates) expireCandidate(path string) {
	timer := time.NewTimer(15 * time.Minute)
	defer timer.Stop()
	select {
	case <-cores.ctx.Done():
		return
	case <-timer.C:
	}
	cores.mu.Lock()
	defer cores.mu.Unlock()
	if cores.candidate.path == path && cores.state.State == "available" {
		_ = os.Remove(path)
		cores.candidate = coreCandidate{}
		cores.state.State, cores.state.Checksum.State = "blocked", "untested"
		cores.state.Checks = []panelTaskStep{{Label: "Срок проверки пакета", State: "fail", Detail: "Повторите проверку перед установкой"}}
	}
}

func (cores *panelCoreUpdates) install(ctx context.Context) error {
	cores.mu.Lock()
	candidate, current := cores.candidate, cores.state.Current
	cores.candidate = coreCandidate{}
	cores.mu.Unlock()
	defer os.Remove(candidate.path)
	pending, err := stageCompressedCore(candidate.path, cores.store)
	if err == nil {
		defer os.Remove(pending)
		err = cores.activate(ctx, candidate, pending)
	}
	result, state := "failed", "failed"
	if err == nil {
		result, state = "ok", "up-to-date"
	} else if errors.Is(err, errCoreRolledBack) {
		result, state = "rolled-back", "rolled-back"
	}
	cores.mu.Lock()
	defer cores.mu.Unlock()
	cores.state.State = state
	if err == nil {
		cores.state.Current, cores.state.Target = candidate.version, nil
		cores.state.Checks = append(cores.state.Checks, panelTaskStep{Label: "Активная конфигурация и контрольный HTTPS", State: "ok"})
	} else {
		cores.state.Checks = append(cores.state.Checks, panelTaskStep{Label: "Установка Xray", State: "fail", Detail: err.Error()})
	}
	if len(cores.state.History) == 12 {
		cores.state.History = slices.Delete(cores.state.History, 0, 1)
	}
	cores.state.History = append(cores.state.History, coreUpdateRecord{time.Now().UTC(), current, candidate.version, result})
	return err
}
