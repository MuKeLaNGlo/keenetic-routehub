package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"slices"
	"sync"

	"routehub/devicepolicy"
)

type versionedPlan struct {
	plan
	Revision string `json:"revision"`
}

type panelPlanUpdate struct {
	Revision       string                   `json:"revision"`
	Profiles       []panelProfile           `json:"profiles"`
	Rules          []rule                   `json:"rules"`
	DefaultTarget  *string                  `json:"defaultTarget,omitempty"`
	Devices        *[]devicepolicy.Device   `json:"devices,omitempty"`
	ZapretServices *zapretServices          `json:"zapretServices,omitempty"`
	GeoSources     *[]geoSource             `json:"geoSources,omitempty"`
	NamedSets      *[]devicepolicy.NamedSet `json:"namedSets,omitempty"`
	Games          *[]gamePreset            `json:"games,omitempty"`
	SavedChecks    *[]savedCheck            `json:"savedChecks,omitempty"`
}

func (update panelPlanUpdate) savedChecksOnly() bool {
	return update.SavedChecks != nil && update.Profiles == nil && update.Rules == nil &&
		update.DefaultTarget == nil && update.Devices == nil && update.ZapretServices == nil && update.GeoSources == nil && update.NamedSets == nil && update.Games == nil
}

func (update panelPlanUpdate) validShape() bool {
	return update.Revision != "" && (update.savedChecksOnly() || update.Profiles != nil && update.Rules != nil)
}

type panelProfile struct {
	ID          string          `json:"id"`
	Protocol    string          `json:"protocol"`
	Label       *string         `json:"label,omitempty"`
	Location    *string         `json:"location,omitempty"`
	Server      string          `json:"server,omitempty"` // Computed on read, accepted for draft round-trips.
	IsXrayGroup bool            `json:"xrayGroup,omitempty"`
	GroupSize   int             `json:"groupSize,omitempty"`
	URI         *string         `json:"uri,omitempty"`
	Outbound    json.RawMessage `json:"outbound,omitempty"`
	Interface   *string         `json:"interface,omitempty"`
	AWGVersion  *string         `json:"awgVersion,omitempty"`
	AWGConfig   *string         `json:"awgConfig,omitempty"`
}

type panelEditor struct {
	editMutex       sync.Mutex
	stateMutex      sync.RWMutex
	active          versionedPlan
	key             [sha256.Size]byte
	auth            *panelAuth
	history         string
	subscriptions   *panelSubscriptions
	preflight       func(plan) error
	apply           func(context.Context, plan) error
	enabled         bool
	refreshBindings bool
}

func copyPanelPlan(config plan) plan {
	config.Profiles = slices.Clone(config.Profiles)
	for i := range config.Profiles {
		config.Profiles[i].Outbound = slices.Clone(config.Profiles[i].Outbound)
	}
	config.Rules = slices.Clone(config.Rules)
	config.GeoSources = slices.Clone(config.GeoSources)
	config.NamedSets = slices.Clone(config.NamedSets)
	config.Games = copyGamePresets(config.Games)
	for i := range config.NamedSets {
		config.NamedSets[i].Entries = slices.Clone(config.NamedSets[i].Entries)
	}
	config.SavedChecks = slices.Clone(config.SavedChecks)
	config.Subscriptions = slices.Clone(config.Subscriptions)
	config.bindings = slices.Clone(config.bindings)
	config.Devices = slices.Clone(config.Devices)
	for index := range config.Devices {
		config.Devices[index].Addresses = slices.Clone(config.Devices[index].Addresses)
		config.Devices[index].Rules = slices.Clone(config.Devices[index].Rules)
	}
	if config.ZapretServices != nil {
		services := *config.ZapretServices
		config.ZapretServices = &services
	}
	if config.Transparent != nil {
		lan := *config.Transparent
		config.Transparent = &lan
	}
	return config
}

func newPanelRevision() string {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		panic("RouteHub could not get entropy for plan revisions")
	}
	return hex.EncodeToString(nonce[:])
}

func newPanelEditor(config plan, key string, apply func(context.Context, plan) error) *panelEditor {
	return &panelEditor{
		active:  versionedPlan{plan: copyPanelPlan(config), Revision: newPanelRevision()},
		key:     sha256.Sum256([]byte(key)),
		apply:   apply,
		enabled: key != "" && apply != nil,
	}
}

func (editor *panelEditor) editable() bool {
	return editor.enabled
}

func (editor *panelEditor) authorized(request *http.Request) bool {
	if !editor.editable() || !panelSameOrigin(request) {
		return false
	}
	key := sha256.Sum256([]byte(request.Header.Get("X-RouteHub-Key")))
	return subtle.ConstantTimeCompare(key[:], editor.key[:]) == 1 || editor.auth.valid(request)
}

func (editor *panelEditor) panelReadAuthorized(request *http.Request) bool {
	key := sha256.Sum256([]byte(request.Header.Get("X-RouteHub-Key")))
	return editor.auth.valid(request) || (editor.editable() && subtle.ConstantTimeCompare(key[:], editor.key[:]) == 1)
}

func (editor *panelEditor) current() versionedPlan {
	editor.stateMutex.RLock()
	defer editor.stateMutex.RUnlock()
	return editor.active
}

func (editor *panelEditor) snapshot() versionedPlan {
	active := editor.current()
	active.plan = copyPanelPlan(active.plan.public())
	return active
}

func (editor *panelEditor) evaluate(input destination) (decision, error) {
	return editor.current().plan.evaluate(input)
}

func mergePanelProfiles(incoming []panelProfile, stored []profile) ([]profile, error) {
	previous := make(map[string]profile, len(stored))
	for _, entry := range stored {
		previous[entry.ID] = entry
	}
	profiles := make([]profile, 0, len(incoming))
	for _, entry := range incoming {
		proposed := profile{ID: entry.ID, Protocol: entry.Protocol}
		old := previous[entry.ID]
		hasURI := entry.URI != nil
		hasOutbound := len(entry.Outbound) != 0
		if old.SubscriptionID != "" {
			if hasURI || hasOutbound || entry.Protocol != old.Protocol || entry.Interface != nil || entry.AWGConfig != nil {
				return nil, errors.New("параметры подключения профиля обновляются его подпиской")
			}
			proposed.SubscriptionID, proposed.UpstreamKey, proposed.UpstreamName = old.SubscriptionID, old.UpstreamKey, old.UpstreamName
			proposed.SubscriptionMissing = old.SubscriptionMissing
		}
		proposed.CatalogProfile = old.CatalogProfile
		if hasURI && (*entry.URI == "" || hasOutbound) ||
			hasOutbound && bytes.Equal(entry.Outbound, []byte("null")) ||
			entry.Interface != nil && *entry.Interface == "" ||
			entry.AWGConfig != nil && (*entry.AWGConfig == "" || entry.Interface != nil) {
			return nil, errors.New("проверьте способ подключения в профиле")
		}
		proposed.Label, proposed.Location = old.Label, old.Location
		if entry.Label != nil {
			proposed.Label = *entry.Label
		}
		if entry.Location != nil {
			proposed.Location = *entry.Location
		}
		switch {
		case hasURI:
			proposed.URI = *entry.URI
		case hasOutbound:
			proposed.Outbound = slices.Clone(entry.Outbound)
		case old.Protocol == entry.Protocol:
			proposed.URI = old.URI
			proposed.Outbound = slices.Clone(old.Outbound)
			proposed.XrayGroup = old.XrayGroup
		}
		switch {
		case entry.Interface != nil:
			proposed.Interface = *entry.Interface
		case entry.AWGConfig != nil:
			proposed.AWGConfig = *entry.AWGConfig
		case old.Protocol == entry.Protocol:
			proposed.Interface = old.Interface
			proposed.AWGConfig = old.AWGConfig
		}
		if entry.AWGVersion != nil {
			proposed.AWGVersion = *entry.AWGVersion
		} else if old.Protocol == entry.Protocol {
			proposed.AWGVersion = old.AWGVersion
		}
		profiles = append(profiles, proposed)
	}
	return profiles, nil
}

func (editor *panelEditor) update(response http.ResponseWriter, request *http.Request) {
	if !editor.editable() {
		sendJSON(response, http.StatusForbidden, object{"error": "Редактирование отключено"})
		return
	}
	if !editor.authorized(request) {
		sendJSON(response, http.StatusForbidden, object{"error": "Доступ к редактированию запрещён"})
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		sendJSON(response, http.StatusUnsupportedMediaType, object{"error": "Требуется application/json"})
		return
	}
	var update panelPlanUpdate
	err = decodeJSON(http.MaxBytesReader(response, request.Body, maxPlanBytes), &update)
	var oversized *http.MaxBytesError
	if errors.As(err, &oversized) {
		sendJSON(response, http.StatusRequestEntityTooLarge, object{"error": "Размер конфигурации не должен превышать 4 МиБ"})
		return
	}
	if err != nil || !update.validShape() {
		sendJSON(response, http.StatusBadRequest, object{"error": "Укажите ревизию и данные для сохранения"})
		return
	}

	editor.editMutex.Lock()
	defer editor.editMutex.Unlock()
	if request.Context().Err() != nil {
		return
	}
	active := editor.current()
	if update.Revision != active.Revision {
		sendJSON(response, http.StatusConflict, object{"error": "Правила изменились. Загрузите свежую конфигурацию"})
		return
	}
	next, err := editor.prepare(request.Context(), active.plan, update)
	if err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": err.Error()})
		return
	}
	if update.savedChecksOnly() && slices.Equal(active.SavedChecks, next.SavedChecks) {
		sendJSON(response, http.StatusOK, editor.snapshot())
		return
	}
	_, checkErrors := editor.compareSavedChecks(active.plan, next)
	if len(checkErrors) != 0 {
		sendJSON(response, http.StatusUnprocessableEntity, object{"error": checkErrors[0]})
		return
	}
	if err := editor.commit(request.Context(), active, next); err != nil {
		sendJSON(response, http.StatusUnprocessableEntity, object{"error": err.Error()})
		return
	}
	sendJSON(response, http.StatusOK, editor.snapshot())
}

func (editor *panelEditor) prepare(ctx context.Context, config plan, update panelPlanUpdate) (plan, error) {
	next := copyPanelPlan(config)
	if update.savedChecksOnly() {
		var err error
		next.SavedChecks, err = normalizeSavedChecks(*update.SavedChecks)
		return next, err
	}
	var err error
	next.Profiles, err = mergePanelProfiles(update.Profiles, config.Profiles)
	if err == nil {
		next.Rules = update.Rules
		if update.DefaultTarget != nil {
			next.DefaultTarget = *update.DefaultTarget
		}
		if update.Devices != nil {
			next.Devices = *update.Devices
		}
		if update.ZapretServices != nil {
			next.ZapretServices = update.ZapretServices
		}
		if update.SavedChecks != nil {
			next.SavedChecks = *update.SavedChecks
		}
		if update.NamedSets != nil {
			next.NamedSets = *update.NamedSets
		}
		if update.Games != nil {
			next.Games = *update.Games
		}
		if update.GeoSources != nil {
			next.GeoSources, err = validateGeoSources(*update.GeoSources)
			if err != nil {
				return plan{}, err
			}
			if next.geoRoot != "" {
				next.geoAssets = loadGeoAssets(next.geoRoot, next.GeoSources)
			}
		}
		if editor.refreshBindings {
			next.bindings = routerBindings(ctx)
		}
		next, err = validatePlan(next)
	}
	return next, err
}

// The caller holds editMutex so the archived revision is the one being replaced.
func (editor *panelEditor) commit(ctx context.Context, active versionedPlan, next plan) error {
	archive, err := editor.archiveRevision(active)
	if err != nil {
		return errors.New("Не удалось сохранить предыдущую ревизию")
	}
	published := versionedPlan{plan: next, Revision: newPanelRevision()}
	if err := editor.apply(ctx, copyPanelPlan(next)); err != nil {
		editor.discardRevision(archive)
		return errors.New("Не удалось применить конфигурацию")
	}

	editor.stateMutex.Lock()
	editor.active = published
	editor.stateMutex.Unlock()
	editor.pruneRevisions()
	return nil
}
