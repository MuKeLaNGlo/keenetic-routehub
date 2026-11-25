package main

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"
)

const subscriptionPreviewTTL = 5 * time.Minute

type subscriptionPreviewEntry struct {
	token, revision string
	expires         time.Time
	fetchedAt       time.Time
	download        subscriptionDownload
	profiles        []profile // Prepared catalog with stable identifiers, retained for one explicit apply.
}

type panelSubscriptions struct {
	editor          *panelEditor
	control         *panelRuntime
	diagnostics     *panelDiagnostics
	fetch           func(context.Context, subscription) (subscriptionDownload, error)
	mu              sync.Mutex
	previews        map[string]subscriptionPreviewEntry
	busy            chan struct{}
	lastScheduledID string
}

func newPanelSubscriptions(editor *panelEditor, control *panelRuntime) *panelSubscriptions {
	return &panelSubscriptions{editor: editor, control: control, fetch: fetchSubscription,
		previews: make(map[string]subscriptionPreviewEntry), busy: make(chan struct{}, 1)}
}

func (panel *panelSubscriptions) register(mux *http.ServeMux, diagnostics *panelDiagnostics) {
	panel.diagnostics = diagnostics
	mux.HandleFunc("GET /api/panel/subscriptions", panel.list)
	mux.HandleFunc("PUT /api/panel/subscriptions", panel.save)
	mux.HandleFunc("DELETE /api/panel/subscriptions", panel.remove)
	mux.HandleFunc("POST /api/panel/subscriptions/preview", panel.preview)
	mux.HandleFunc("POST /api/panel/subscriptions/refresh", panel.refresh)
	if panel.control != nil {
		mux.HandleFunc("POST /api/panel/subscriptions/probe", panel.probe)
	}
}

func subscriptionIndex(config plan, id string) int {
	return slices.IndexFunc(config.Subscriptions, func(source subscription) bool { return source.ID == id })
}

func subscriptionView(active versionedPlan) object {
	statuses := make([]subscriptionStatus, 0, len(active.Subscriptions))
	for _, source := range active.Subscriptions {
		statuses = append(statuses, source.status())
	}
	return object{"subscriptions": publicSubscriptions(active.Subscriptions), "statuses": statuses, "revision": active.Revision}
}

func (panel *panelSubscriptions) list(w http.ResponseWriter, _ *http.Request) {
	sendJSON(w, http.StatusOK, subscriptionView(panel.editor.current()))
}

func (panel *panelSubscriptions) save(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision      string  `json:"revision"`
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		URL           string  `json:"url"`
		DeviceID      *string `json:"deviceId"`
		UserAgent     *string `json:"userAgent"`
		IntervalHours int     `json:"intervalHours"`
		Enabled       *bool   `json:"enabled"`
	}
	if !runtimeRequest(w, r, panel.editor, &input) {
		return
	}
	if input.Enabled == nil {
		sendJSON(w, http.StatusBadRequest, object{"error": "укажите режим автоматического обновления подписки"})
		return
	}
	panel.editor.editMutex.Lock()
	defer panel.editor.editMutex.Unlock()
	active := panel.editor.current()
	if input.Revision != active.Revision {
		subscriptionConflict(w)
		return
	}
	next := copyPanelPlan(active.plan)
	idx := subscriptionIndex(next, input.ID)
	if input.ID == "" {
		idx = len(next.Subscriptions)
		next.Subscriptions = append(next.Subscriptions, subscription{
			ID: "sub-" + newPanelRevision()[:16], Type: "vless-list", AddedAt: time.Now().UTC(),
		})
	} else if idx < 0 {
		sendJSON(w, http.StatusNotFound, object{"error": "подписка не найдена"})
		return
	}
	source := &next.Subscriptions[idx]
	if input.URL != "" {
		endpoint, err := subscriptionEndpoint(input.URL)
		if err != nil {
			sendJSON(w, http.StatusBadRequest, object{"error": err.Error()})
			return
		}
		if endpoint.String() != source.URL {
			if old, err := subscriptionEndpoint(source.URL); err == nil && old.Hostname() != endpoint.Hostname() {
				source.DeviceID = ""
				source.UserAgent = ""
			}
			source.URL = endpoint.String()
			source.ETag, source.LastModified = "", ""
			source.LastAttempt, source.LastSuccess = nil, nil
			source.AddedAt = time.Now().UTC()
		}
	}
	deviceID, userAgent := source.DeviceID, source.UserAgent
	if input.DeviceID != nil {
		source.DeviceID = *input.DeviceID
	}
	if input.UserAgent != nil {
		if !validSubscriptionUserAgent(*input.UserAgent) {
			sendJSON(w, http.StatusBadRequest, object{"error": "User-Agent должен содержать не более 128 печатных символов ASCII"})
			return
		}
		source.UserAgent = strings.TrimSpace(*input.UserAgent)
	}
	if deviceID != source.DeviceID || userAgent != source.UserAgent {
		source.ETag, source.LastModified = "", ""
		source.LastAttempt = nil
	}
	source.Name, source.IntervalHours, source.Enabled = input.Name, input.IntervalHours, *input.Enabled
	next, err := validatePlan(next)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, object{"error": err.Error()})
		return
	}
	if !reflect.DeepEqual(active.Subscriptions, next.Subscriptions) {
		if err := panel.editor.commit(r.Context(), active, next); err != nil {
			sendJSON(w, http.StatusUnprocessableEntity, object{"error": err.Error()})
			return
		}
		panel.invalidate(next.Subscriptions[idx].ID)
		panel.event("ok", "Настройки подписки сохранены")
	}
	sendJSON(w, http.StatusOK, subscriptionView(panel.editor.current()))
}

func (panel *panelSubscriptions) remove(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision string `json:"revision"`
		ID       string `json:"id"`
	}
	if !runtimeRequest(w, r, panel.editor, &input) {
		return
	}
	panel.editor.editMutex.Lock()
	defer panel.editor.editMutex.Unlock()
	active := panel.editor.current()
	if input.Revision != active.Revision {
		subscriptionConflict(w)
		return
	}
	idx := subscriptionIndex(active.plan, input.ID)
	if idx < 0 {
		sendJSON(w, http.StatusNotFound, object{"error": "подписка не найдена"})
		return
	}
	next := copyPanelPlan(active.plan)
	next.Subscriptions = slices.Delete(next.Subscriptions, idx, idx+1)
	for i := range next.Profiles {
		entry := &next.Profiles[i]
		if entry.SubscriptionID == input.ID {
			entry.SubscriptionID, entry.UpstreamName, entry.UpstreamKey = "", "", ""
			entry.SubscriptionMissing = false
		}
	}
	if err := panel.editor.commit(r.Context(), active, next); err != nil {
		sendJSON(w, http.StatusUnprocessableEntity, object{"error": err.Error()})
		return
	}
	panel.invalidate(input.ID)
	panel.event("ok", "Подписка удалена, профили сохранены")
	sendJSON(w, http.StatusOK, subscriptionView(panel.editor.current()))
}

func subscriptionConflict(w http.ResponseWriter) {
	sendJSON(w, http.StatusConflict, object{"error": "конфигурация изменилась. Обновите данные и получите новый предпросмотр"})
}

func (panel *panelSubscriptions) event(severity, title string) {
	if panel.diagnostics != nil {
		panel.diagnostics.event("subscription", severity, "Подписки", title, "")
	}
}

func (panel *panelSubscriptions) invalidate(id string) {
	panel.mu.Lock()
	delete(panel.previews, id)
	panel.mu.Unlock()
}

func (panel *panelSubscriptions) cache(id string, entry subscriptionPreviewEntry) {
	panel.mu.Lock()
	defer panel.mu.Unlock()
	for key, old := range panel.previews {
		if old.expires.Before(time.Now()) || old.revision != entry.revision {
			delete(panel.previews, key)
		}
	}
	panel.previews[id] = entry
}

func (panel *panelSubscriptions) cached(id, token string, consume bool) (subscriptionPreviewEntry, bool) {
	panel.mu.Lock()
	defer panel.mu.Unlock()
	entry, ok := panel.previews[id]
	if !ok || token == "" || token != entry.token || !entry.expires.After(time.Now()) {
		return subscriptionPreviewEntry{}, false
	}
	if consume {
		delete(panel.previews, id)
	}
	return entry, true
}

// An authenticated probe keeps the exact reviewed snapshot available for the next row.
func (panel *panelSubscriptions) keepPreview(id, token string) {
	panel.mu.Lock()
	defer panel.mu.Unlock()
	now := time.Now()
	entry, ok := panel.previews[id]
	if ok && entry.token == token && entry.expires.After(now) {
		entry.expires = now.Add(subscriptionPreviewTTL)
		panel.previews[id] = entry
	}
}

func (panel *panelSubscriptions) buildPreview(ctx context.Context, active versionedPlan, source subscription) (subscriptionPreview, subscriptionPreviewEntry) {
	preview := emptySubscriptionPreview(source.ID)
	download, err := panel.fetch(ctx, source)
	var profiles []profile
	if err == nil {
		profiles = active.Profiles
		if !download.unchanged {
			var incoming []profile
			var incompatible []incompatibleSubscriptionRow
			incoming, incompatible, err = parseSubscription(download.body)
			if incompatible != nil {
				preview.Incompatible = incompatible
			}
			if err == nil {
				profiles, err = mergeSubscriptionProfiles(active.plan, source, incoming, &preview)
			}
		}
	}
	if err != nil {
		preview.Error = err.Error()
		return preview, subscriptionPreviewEntry{}
	}
	if panel.control != nil {
		selected, settings := panel.control.state()
		for i := range preview.Missing {
			item := &preview.Missing[i]
			if item.ID == selected.Profile {
				item.UsedBy = append(item.UsedBy, "Основной профиль")
			}
			if item.ID == settings.Boot.Profile {
				item.UsedBy = append(item.UsedBy, "Автозапуск")
			}
		}
	}
	preview.OK, preview.Token = true, newPanelRevision()
	download.body = nil
	return preview, subscriptionPreviewEntry{
		token: preview.Token, revision: active.Revision, expires: time.Now().Add(subscriptionPreviewTTL),
		fetchedAt: preview.FetchedAt, profiles: profiles, download: download,
	}
}

func (panel *panelSubscriptions) preview(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID string `json:"id"`
	}
	if !runtimeRequest(w, r, panel.editor, &input) {
		return
	}
	active := panel.editor.current()
	idx := subscriptionIndex(active.plan, input.ID)
	if idx < 0 {
		sendJSON(w, http.StatusNotFound, object{"error": "подписка не найдена"})
		return
	}
	select {
	case panel.busy <- struct{}{}:
		defer func() { <-panel.busy }()
	default:
		sendJSON(w, http.StatusTooManyRequests, object{"error": "уже загружается другая подписка"})
		return
	}
	preview, entry := panel.buildPreview(r.Context(), active, active.Subscriptions[idx])
	if preview.OK {
		panel.cache(input.ID, entry)
	} else if r.Context().Err() == nil {
		panel.failAttempt(r.Context(), active.Revision, input.ID, preview.FetchedAt, preview.Error)
	}
	sendJSON(w, http.StatusOK, preview)
}

func (panel *panelSubscriptions) refresh(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if !runtimeRequest(w, r, panel.editor, &input) {
		return
	}
	entry, ok := panel.cached(input.ID, input.Token, true)
	if !ok {
		subscriptionConflict(w)
		return
	}
	revision, profiles, err := panel.applyPreview(r.Context(), input.ID, entry)
	if errors.Is(err, errSubscriptionRevision) {
		subscriptionConflict(w)
		return
	}
	if err != nil {
		if r.Context().Err() == nil {
			panel.failAttempt(r.Context(), entry.revision, input.ID, entry.fetchedAt, "не удалось применить обновление подписки")
		}
		sendJSON(w, http.StatusUnprocessableEntity, object{"error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, object{"revision": revision, "profiles": profiles})
}

var errSubscriptionRevision = errors.New("изменилась ревизия подписки")

func (panel *panelSubscriptions) applyPreview(ctx context.Context, id string, entry subscriptionPreviewEntry) (string, int, error) {
	panel.editor.editMutex.Lock()
	defer panel.editor.editMutex.Unlock()
	active := panel.editor.current()
	index := subscriptionIndex(active.plan, id)
	if active.Revision != entry.revision || index < 0 {
		return "", 0, errSubscriptionRevision
	}
	next := copyPanelPlan(active.plan)
	source := &next.Subscriptions[index]
	next.Profiles = slices.Clone(entry.profiles)
	snapshot, profiles := subscriptionSnapshot(next.Profiles, id)
	if profiles == 0 {
		return "", 0, errors.New("в подписке нет совместимых профилей")
	}
	source.LastAttempt = &subscriptionAttempt{At: entry.fetchedAt, OK: true}
	source.LastSuccess = &subscriptionSuccess{At: entry.fetchedAt, Revision: snapshot, Profiles: profiles}
	if !entry.download.unchanged {
		source.ETag, source.LastModified = entry.download.etag, entry.download.modified
	}
	next, err := validatePlan(next)
	if err != nil {
		return "", 0, err
	}
	if reflect.DeepEqual(active.Profiles, next.Profiles) {
		err = panel.persistStatus(ctx, active, next)
	} else {
		_, checkErrors := panel.editor.compareSavedChecks(active.plan, next)
		if len(checkErrors) != 0 {
			return "", 0, errors.New(checkErrors[0])
		}
		err = panel.editor.commit(ctx, active, next)
	}
	if err != nil {
		return "", 0, err
	}
	panel.event("ok", "Подписка обновлена")
	return panel.editor.current().Revision, profiles, nil
}

// The caller holds editMutex. Status lies outside the editable, public plan.
func (panel *panelSubscriptions) persistStatus(ctx context.Context, active versionedPlan, next plan) error {
	if err := panel.editor.apply(ctx, copyPanelPlan(next)); err != nil {
		return errors.New("не удалось сохранить статус обновления подписки")
	}
	panel.editor.stateMutex.Lock()
	panel.editor.active = versionedPlan{plan: next, Revision: active.Revision}
	panel.editor.stateMutex.Unlock()
	return nil
}

func (panel *panelSubscriptions) failAttempt(ctx context.Context, revision, id string, at time.Time, reason string) {
	panel.editor.editMutex.Lock()
	defer panel.editor.editMutex.Unlock()
	active := panel.editor.current()
	index := subscriptionIndex(active.plan, id)
	if active.Revision != revision || index < 0 {
		return
	}
	next := copyPanelPlan(active.plan)
	next.Subscriptions[index].LastAttempt = &subscriptionAttempt{At: at, Reason: reason}
	_ = panel.persistStatus(ctx, active, next)
	panel.event("warn", "Не удалось обновить подписку")
}

func (panel *panelSubscriptions) probe(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID        string `json:"subscriptionId"`
		Token     string `json:"previewToken"`
		ProfileID string `json:"profileId"`
	}
	if !runtimeRequest(w, r, panel.editor, &input) {
		return
	}
	entry, ok := panel.cached(input.ID, input.Token, false)
	if !ok || panel.editor.current().Revision != entry.revision {
		subscriptionConflict(w)
		return
	}
	idx := slices.IndexFunc(entry.profiles, func(candidate profile) bool {
		return candidate.SubscriptionID == input.ID && !candidate.SubscriptionMissing &&
			(candidate.UpstreamKey == input.ProfileID || candidate.ID == input.ProfileID)
	})
	if idx < 0 {
		sendJSON(w, http.StatusNotFound, object{"error": "профиль не найден в предпросмотре"})
		return
	}
	panel.keepPreview(input.ID, input.Token)
	result, err := panel.control.probeUnstoredVLESS(r.Context(), entry.profiles[idx])
	if errors.Is(err, errProfileProbeBusy) {
		sendProfileProbeBusy(w)
		return
	}
	if err != nil {
		sendJSON(w, http.StatusUnprocessableEntity, object{"error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, result)
}

func (panel *panelSubscriptions) run(ctx context.Context) {
	if !panel.editor.editable() {
		return
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			panel.refreshDue(ctx, now)
		}
	}
}

func (panel *panelSubscriptions) refreshDue(ctx context.Context, now time.Time) {
	select {
	case panel.busy <- struct{}{}:
		defer func() { <-panel.busy }()
	default:
		return
	}
	active := panel.editor.current()
	start := subscriptionIndex(active.plan, panel.lastScheduledID) + 1
	for offset := range active.Subscriptions {
		source := active.Subscriptions[(start+offset)%len(active.Subscriptions)]
		if next := source.status().NextRun; next == nil || next.After(now) {
			continue
		}
		panel.lastScheduledID = source.ID
		preview, entry := panel.buildPreview(ctx, active, source)
		if preview.OK {
			if _, _, err := panel.applyPreview(ctx, source.ID, entry); err != nil && ctx.Err() == nil {
				panel.failAttempt(ctx, active.Revision, source.ID, preview.FetchedAt, "не удалось применить обновление подписки")
			}
		} else if ctx.Err() == nil {
			panel.failAttempt(ctx, active.Revision, source.ID, preview.FetchedAt, preview.Error)
		}
		return // A single network fetch per scheduling round limits peak memory on Keenetic.
	}
}
