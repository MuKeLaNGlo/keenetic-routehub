package main

import (
	"encoding/json"
	"net/http"
	"runtime"
	"slices"
	"strconv"
	"sync"
	"time"
)

const (
	panelEventLimit = 120
	panelTaskLimit  = 24
)

type panelEvent struct {
	ID       string    `json:"id"`
	At       time.Time `json:"at"`
	Type     string    `json:"type"`
	Severity string    `json:"severity"`
	Object   object    `json:"object"`
	Title    string    `json:"title"`
	Detail   string    `json:"detail,omitempty"`
}

type panelTask struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Title       string          `json:"title"`
	Scope       string          `json:"scope"`
	State       string          `json:"state"`
	StartedAt   time.Time       `json:"startedAt"`
	FinishedAt  *time.Time      `json:"finishedAt,omitempty"`
	Steps       []panelTaskStep `json:"steps"`
	Cancellable bool            `json:"cancellable"`
	Error       string          `json:"error,omitempty"`
	Result      any             `json:"result,omitempty"`
}

type panelTaskStep struct {
	Label  string `json:"label"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

type panelDiagnostics struct {
	editor          *panelEditor
	state           status
	control         *panelRuntime
	probe           chan struct{}
	observation     chan struct{}
	readConnections observationReader
	mu              sync.Mutex
	events          []panelEvent
	tasks           []panelTask

	topologyMu sync.Mutex
	topology   panelTopologySnapshot
}

func newPanelDiagnostics(editor *panelEditor, state status, control *panelRuntime) *panelDiagnostics {
	diagnostics := &panelDiagnostics{
		editor: editor, state: state, control: control, probe: make(chan struct{}, 1),
		observation: make(chan struct{}, 1), readConnections: readRouterConnections,
	}
	diagnostics.event("engine", "info", "RouteHub", "Модуль запущен", "Журнал хранит последние события текущего запуска.")
	return diagnostics
}

func (diagnostics *panelDiagnostics) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/panel/events", diagnostics.readEvents)
	mux.HandleFunc("GET /api/panel/tasks", diagnostics.readTasks)
	mux.HandleFunc("GET /api/panel/saved-checks/results", diagnostics.editor.savedCheckResults)
	mux.HandleFunc("GET /api/panel/topology", diagnostics.readTopology)
	mux.HandleFunc("GET /api/panel/support-report", diagnostics.supportReport)
	mux.HandleFunc("POST /api/panel/real-test", diagnostics.realTest)
	mux.HandleFunc("POST /api/panel/connections/observe", diagnostics.observeConnections)
}

func (diagnostics *panelDiagnostics) event(eventType, severity, name, title, detail string) {
	event := panelEvent{ID: newPanelRevision(), At: time.Now().UTC(), Type: eventType, Severity: severity,
		Object: object{"kind": eventType, "name": name}, Title: title, Detail: detail}
	diagnostics.mu.Lock()
	defer diagnostics.mu.Unlock()
	if len(diagnostics.events) == panelEventLimit {
		diagnostics.events = slices.Delete(diagnostics.events, 0, 1)
	}
	diagnostics.events = append(diagnostics.events, event)
}

func (diagnostics *panelDiagnostics) readEvents(response http.ResponseWriter, _ *http.Request) {
	diagnostics.mu.Lock()
	events := append(make([]panelEvent, 0, len(diagnostics.events)), diagnostics.events...)
	diagnostics.mu.Unlock()
	slices.Reverse(events)
	sendJSON(response, http.StatusOK, events)
}

func (diagnostics *panelDiagnostics) updateTask(task panelTask) {
	diagnostics.mu.Lock()
	defer diagnostics.mu.Unlock()
	for i := range diagnostics.tasks {
		if diagnostics.tasks[i].ID == task.ID {
			diagnostics.tasks[i] = task
			return
		}
	}
	if len(diagnostics.tasks) == panelTaskLimit {
		diagnostics.tasks = slices.Delete(diagnostics.tasks, 0, 1)
	}
	diagnostics.tasks = append(diagnostics.tasks, task)
}

func (diagnostics *panelDiagnostics) readTasks(response http.ResponseWriter, _ *http.Request) {
	diagnostics.mu.Lock()
	tasks := append(make([]panelTask, 0, len(diagnostics.tasks)), diagnostics.tasks...)
	diagnostics.mu.Unlock()
	slices.Reverse(tasks)
	sendJSON(response, http.StatusOK, tasks)
}

type panelAuditResponse struct {
	http.ResponseWriter
	code int
}

func (response *panelAuditResponse) WriteHeader(code int) {
	if response.code == 0 {
		response.code = code
		response.ResponseWriter.WriteHeader(code)
	}
}

func (response *panelAuditResponse) Write(data []byte) (int, error) {
	if response.code == 0 {
		response.WriteHeader(http.StatusOK)
	}
	return response.ResponseWriter.Write(data)
}

func (response *panelAuditResponse) Unwrap() http.ResponseWriter {
	return response.ResponseWriter
}

func panelAuditAction(method, path string) (string, string, string) {
	switch method + " " + path {
	case "PUT /api/plan":
		return "apply", "Маршрутизация", "Применение конфигурации"
	case "POST /api/panel/revisions/restore":
		return "rollback", "Конфигурация", "Восстановление ревизии"
	case "PUT /api/runtime/vpn":
		return "profile", "VPN", "Изменение активного VPN"
	case "PUT /api/runtime/zapret":
		return "zapret", "Zapret", "Изменение режима Zapret"
	case "POST /api/runtime/zapret/auto":
		return "zapret", "Zapret", "Запрос подбора стратегии Zapret"
	case "POST /api/zapret/check":
		return "zapret", "Zapret", "Запрос диагностики Zapret"
	case "PUT /api/runtime/boot":
		return "apply", "Автозапуск", "Сохранение настроек автозапуска"
	case "PUT /api/dns":
		return "dns", "DNS", "Сохранение настроек DNS"
	case "POST /api/dns/test":
		return "dns", "DNS", "Запрос диагностики DNS"
	case "POST /api/geoip/update":
		return "update", "Геоданные", "Запрос обновления геоданных"
	}
	return "", "", ""
}

func (diagnostics *panelDiagnostics) audit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		typ, name, title := panelAuditAction(request.Method, request.URL.Path)
		if typ == "" {
			next.ServeHTTP(w, request)
			return
		}
		response := &panelAuditResponse{ResponseWriter: w}
		next.ServeHTTP(response, request)
		switch {
		case response.code >= 200 && response.code < 300:
			if typ == "apply" || typ == "rollback" || typ == "profile" {
				diagnostics.event(typ, "ok", name, title, "Модуль подтвердил изменение.")
				return
			}
			// Some API operations return a domain-level diagnostic failure with HTTP 200.
			diagnostics.event(typ, "info", name, title, "Модуль обработал запрос.")
		case response.code == http.StatusForbidden || response.code == http.StatusUnauthorized:
			// Unauthenticated users cannot fill the bounded journal.
		case response.code >= 400:
			diagnostics.event(typ, "error", name, title, "Модуль отклонил запрос. HTTP "+strconv.Itoa(response.code)+".")
		}
	})
}

type panelReportLine struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	Redacted bool   `json:"redacted,omitempty"`
}

type panelReportSection struct {
	Title string            `json:"title"`
	Lines []panelReportLine `json:"lines"`
}

func (diagnostics *panelDiagnostics) supportReport(response http.ResponseWriter, _ *http.Request) {
	config := diagnostics.editor.current().plan
	profileCounts := make(map[string]int)
	for _, entry := range config.Profiles {
		profileCounts[entry.Protocol]++
	}
	profiles := make([]panelReportLine, 0, len(profileCounts)+1)
	for _, protocol := range []string{"vless", "hysteria2", "trojan", "amneziawg"} {
		if count := profileCounts[protocol]; count != 0 {
			profiles = append(profiles, panelReportLine{Key: protocol, Value: strconv.Itoa(count)})
		}
	}
	profiles = append(profiles, panelReportLine{Key: "Параметры подключения", Value: "Скрыты", Redacted: true})
	mode := diagnostics.state.LANMode
	if mode == "" {
		mode = "Локальный SOCKS"
	}
	sections := []panelReportSection{
		{Title: "Модуль", Lines: []panelReportLine{
			{Key: "RouteHub", Value: diagnostics.state.Version},
			{Key: "Платформа", Value: runtime.GOOS + "/" + runtime.GOARCH},
			{Key: "Запуск", Value: diagnostics.state.StartedAt.Format(time.RFC3339)},
			{Key: "Сетевой режим", Value: mode},
		}},
		{Title: "Профили", Lines: profiles},
		{Title: "Политика", Lines: []panelReportLine{
			{Key: "Глобальные правила", Value: strconv.Itoa(len(config.Rules))},
			{Key: "Настроенные устройства", Value: strconv.Itoa(len(config.Devices))},
			{Key: "Назначения правил и идентификаторы устройств", Value: "Скрыты", Redacted: true},
		}},
	}
	if diagnostics.control != nil {
		selection, _ := diagnostics.control.state()
		sections = append(sections, panelReportSection{Title: "Режим работы", Lines: []panelReportLine{
			{Key: "VPN", Value: panelOnOff(selection.VPN)},
			{Key: "Zapret для YouTube", Value: panelOnOff(selection.YouTube)},
			{Key: "Zapret для Discord", Value: panelOnOff(selection.Discord)},
		}})
	}
	data, _ := json.Marshal(sections)
	sendJSON(response, http.StatusOK, object{"sections": sections, "redactedCount": 2, "sizeKb": (len(data) + 1023) / 1024})
}

func panelOnOff(enabled bool) string {
	if enabled {
		return "Включён"
	}
	return "Выключен"
}
