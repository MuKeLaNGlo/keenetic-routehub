package main

import (
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type panelRevision struct {
	Revision  string    `json:"revision"`
	CreatedAt time.Time `json:"createdAt"`
	By        string    `json:"by"`
	Note      string    `json:"note"`
	size      int64
}

func validPanelRevision(id string) bool {
	_, err := hex.DecodeString(id)
	return len(id) == 32 && id == strings.ToLower(id) && err == nil
}

func (editor *panelEditor) archiveRevision(active versionedPlan) (string, error) {
	if editor.history == "" {
		return "", nil
	}
	if err := os.Mkdir(editor.history, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := os.Lstat(editor.history)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("некорректный каталог ревизий")
	}
	path := filepath.Join(editor.history, active.Revision+".json")
	pending, err := privateJSON(editor.history, ".revision-*", active.plan)
	if err != nil {
		return "", err
	}
	defer os.Remove(pending)
	info, err = os.Stat(pending)
	if err != nil || info.Size() > maxPlanBytes {
		return "", errors.New("ревизия превышает допустимый размер")
	}
	return path, os.Rename(pending, path)
}

func (editor *panelEditor) discardRevision(path string) {
	if path != "" {
		_ = os.Remove(path)
	}
}

func (editor *panelEditor) listRevisions() []panelRevision {
	revisions := make([]panelRevision, 0)
	if editor.history == "" {
		return revisions
	}
	entries, err := os.ReadDir(editor.history)
	if err != nil {
		return revisions
	}
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if id == entry.Name() || !validPanelRevision(id) || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.Mode().Perm()&0o077 == 0 && info.Size() <= maxPlanBytes {
			revisions = append(revisions, panelRevision{id, info.ModTime().UTC(), "RouteHub", "Сохранена перед заменой плана маршрутизации", info.Size()})
		}
	}
	sort.Slice(revisions, func(i, j int) bool {
		if revisions[i].CreatedAt.Equal(revisions[j].CreatedAt) {
			return revisions[i].Revision > revisions[j].Revision
		}
		return revisions[i].CreatedAt.After(revisions[j].CreatedAt)
	})
	return revisions
}

func (editor *panelEditor) pruneRevisions() {
	var total int64
	for index, revision := range editor.listRevisions() {
		total += revision.size
		if index >= 6 || total > 2*maxPlanBytes {
			editor.discardRevision(filepath.Join(editor.history, revision.Revision+".json"))
		}
	}
}

func (editor *panelEditor) revisionList(w http.ResponseWriter, _ *http.Request) {
	editor.editMutex.Lock()
	defer editor.editMutex.Unlock()
	sendJSON(w, http.StatusOK, editor.listRevisions())
}

func (editor *panelEditor) revisionRestore(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision     string `json:"revision"`
		BaseRevision string `json:"baseRevision"`
	}
	if !runtimeRequest(w, r, editor, &input) {
		return
	}
	if editor.history == "" || !validPanelRevision(input.Revision) || input.BaseRevision == "" {
		sendJSON(w, http.StatusBadRequest, object{"error": "Выберите сохранённую ревизию"})
		return
	}
	editor.editMutex.Lock()
	defer editor.editMutex.Unlock()
	active := editor.current()
	if input.BaseRevision != active.Revision {
		sendJSON(w, http.StatusConflict, object{"error": "Конфигурация изменилась. Загрузите текущую ревизию"})
		return
	}
	path := filepath.Join(editor.history, input.Revision+".json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		sendJSON(w, http.StatusNotFound, object{"error": "Ревизия недоступна"})
		return
	}
	saved, err := loadPlan(path)
	if err != nil {
		sendJSON(w, http.StatusUnprocessableEntity, object{"error": "Не удалось прочитать ревизию"})
		return
	}
	next := copyPanelPlan(active.plan)
	next.Profiles, next.Rules, next.Devices = saved.Profiles, saved.Rules, saved.Devices
	next.DefaultTarget, next.ZapretServices, next.GeoSources = saved.DefaultTarget, saved.ZapretServices, saved.GeoSources
	next.SavedChecks = saved.SavedChecks
	next.NamedSets = saved.NamedSets
	next.Games = saved.Games
	next.Subscriptions = saved.Subscriptions
	next.geoAssets = loadGeoAssets(next.geoRoot, next.GeoSources)
	if editor.refreshBindings {
		next.bindings = routerBindings(r.Context())
	}
	if next, err = validatePlan(next); err != nil {
		sendJSON(w, http.StatusUnprocessableEntity, object{"error": err.Error()})
		return
	}
	if err := editor.commit(r.Context(), active, next); err != nil {
		sendJSON(w, http.StatusUnprocessableEntity, object{"error": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, editor.snapshot())
}

func (editor *panelEditor) previewUpdate(w http.ResponseWriter, r *http.Request) {
	if !editor.authorized(r) {
		sendJSON(w, http.StatusForbidden, object{"error": "Доступ к изменениям запрещён"})
		return
	}
	var input panelPlanUpdate
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, maxPlanBytes), &input); err != nil || !input.validShape() {
		sendJSON(w, http.StatusBadRequest, object{"error": "Укажите ревизию и данные для сохранения"})
		return
	}
	active := editor.current()
	if input.Revision != active.Revision {
		sendJSON(w, http.StatusConflict, object{"error": "Конфигурация изменилась. Загрузите текущую ревизию"})
		return
	}
	next, err := editor.prepare(r.Context(), active.plan, input)
	if err == nil && editor.preflight != nil {
		err = editor.preflight(next)
	}
	result := object{"errors": []string{}, "warnings": []object{}, "restarts": []string{}}
	if err != nil {
		result["errors"] = []string{err.Error()}
	} else {
		checks, errors := editor.compareSavedChecks(active.plan, next)
		result["checks"], result["errors"] = checks, errors
		if !input.savedChecksOnly() && !checksOnlyChange(active.plan, next) && !gameMetadataOnly(active.plan, next, editor.refreshBindings) {
			result["restarts"] = []string{"Ядро Xray"}
			result["warnings"] = []object{{"level": "warn", "text": "Применение перезапустит ядро. Текущие соединения через RouteHub могут прерваться."}}
		}
	}
	sendJSON(w, http.StatusOK, result)
}
