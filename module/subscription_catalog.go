package main

import (
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"time"
)

type subscriptionPreview struct {
	ID           string                         `json:"subscriptionId"`
	FetchedAt    time.Time                      `json:"fetchedAt"`
	OK           bool                           `json:"ok"`
	Error        string                         `json:"error,omitempty"`
	Token        string                         `json:"token,omitempty"`
	Added        []addedSubscriptionProfile     `json:"added"`
	Changed      []changedSubscriptionProfile   `json:"changed"`
	Missing      []missingSubscriptionProfile   `json:"missing"`
	Incompatible []incompatibleSubscriptionRow  `json:"incompatible"`
	Ambiguous    []ambiguousSubscriptionProfile `json:"ambiguous"`
}

type addedSubscriptionProfile struct {
	Key       string `json:"upstreamKey"`
	Name      string `json:"name"`
	XrayGroup bool   `json:"xrayGroup,omitempty"`
	GroupSize int    `json:"groupSize,omitempty"`
}

type changedSubscriptionProfile struct {
	ID   string `json:"profileId"`
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

type missingSubscriptionProfile struct {
	ID     string   `json:"profileId"`
	Name   string   `json:"name"`
	UsedBy []string `json:"usedBy"`
}

type ambiguousSubscriptionProfile struct {
	ID         string   `json:"profileId"`
	Candidates []string `json:"candidates"`
}

func emptySubscriptionPreview(id string) subscriptionPreview {
	return subscriptionPreview{ID: id, FetchedAt: time.Now().UTC(),
		Added: []addedSubscriptionProfile{}, Changed: []changedSubscriptionProfile{}, Missing: []missingSubscriptionProfile{},
		Incompatible: []incompatibleSubscriptionRow{}, Ambiguous: []ambiguousSubscriptionProfile{}}
}

func validateSubscriptionProfiles(config plan) error {
	sources := make(map[string]bool, len(config.Subscriptions))
	for _, source := range config.Subscriptions {
		sources[source.ID] = true
	}
	keys := make(map[string]bool)
	count := 0
	for _, entry := range config.Profiles {
		if entry.CatalogProfile {
			count++
		}
		if entry.SubscriptionID == "" {
			if entry.UpstreamKey != "" || entry.UpstreamName != "" || entry.SubscriptionMissing {
				return errors.New("метаданные профиля требуют существующую подписку")
			}
			continue
		}
		key := entry.SubscriptionID + "/" + entry.UpstreamKey
		if !sources[entry.SubscriptionID] || !entry.CatalogProfile || (entry.Protocol != "vless" && entry.Protocol != "hysteria2") ||
			(entry.URI == "" && len(entry.Outbound) == 0 && entry.XrayGroup == nil) || !validPanelRevision(entry.UpstreamKey) ||
			entry.UpstreamName == "" || importedLabel(entry.UpstreamName) != entry.UpstreamName || keys[key] {
			return errors.New("проверьте происхождение профилей из подписок")
		}
		keys[key] = true
	}
	if count > maxCatalogProfiles {
		return fmt.Errorf("в каталоге подписок может быть до %d профилей", maxCatalogProfiles)
	}
	return nil
}

func subscriptionProfileReferences(config plan, id string) []string {
	refs := make([]string, 0, 4)
	if config.DefaultTarget == id {
		refs = append(refs, "Маршрут по умолчанию")
	}
	for _, rule := range config.Rules {
		if rule.Target == id {
			refs = append(refs, "Общее правило")
			break
		}
	}
	for _, device := range config.Devices {
		if device.DefaultTarget == id || slices.ContainsFunc(device.Rules, func(rule rule) bool { return rule.Target == id }) {
			refs = append(refs, "Правила устройств")
			break
		}
	}
	return refs
}

func mergeSubscriptionProfiles(base plan, source subscription, incoming []profile, preview *subscriptionPreview) ([]profile, error) {
	next := slices.Clone(base.Profiles)
	oldByKey := make(map[string]int)
	usedIDs := make(map[string]bool)
	for i, entry := range base.Profiles {
		usedIDs[entry.ID] = true
		if entry.SubscriptionID == source.ID {
			oldByKey[entry.UpstreamKey] = i
		}
	}
	matched := make(map[int]bool)
	nextToOld := make(map[int]int)
	for newIndex, candidate := range incoming {
		if i, ok := oldByKey[candidate.UpstreamKey]; ok {
			matched[i], nextToOld[newIndex] = true, i
		}
	}
	// A credential change keeps an ID only when the URL names the same endpoint and
	// the remaining rows have a unique match. Match labels before using the endpoint alone.
	matchBy := func(key func(profile) string) {
		oldGroups, newGroups := make(map[string][]int), make(map[string][]int)
		for _, i := range oldByKey {
			if !matched[i] {
				group := key(base.Profiles[i])
				oldGroups[group] = append(oldGroups[group], i)
			}
		}
		for i, entry := range incoming {
			if _, ok := nextToOld[i]; !ok {
				group := key(entry)
				newGroups[group] = append(newGroups[group], i)
			}
		}
		for group, indexes := range oldGroups {
			if peers := newGroups[group]; group != "" && len(indexes) == 1 && len(peers) == 1 {
				matched[indexes[0]], nextToOld[peers[0]] = true, indexes[0]
			}
		}
	}
	matchBy(func(entry profile) string {
		endpoint := subscriptionEndpointKey(entry)
		if endpoint == "" {
			return ""
		}
		return endpoint + "|" + entry.UpstreamName
	})
	matchBy(subscriptionEndpointKey)
	for newIndex, candidate := range incoming {
		if oldIndex, ok := nextToOld[newIndex]; ok {
			prior := base.Profiles[oldIndex]
			update := prior
			kind := ""
			if prior.UpstreamKey != candidate.UpstreamKey {
				update.URI, update.UpstreamKey, update.Protocol = candidate.URI, candidate.UpstreamKey, candidate.Protocol
				update.Outbound = slices.Clone(candidate.Outbound)
				update.XrayGroup = candidate.XrayGroup
				kind = "params"
			} else if prior.UpstreamName != candidate.UpstreamName {
				kind = "renamed"
			} else if prior.SubscriptionMissing {
				kind = "params"
			}
			update.SubscriptionMissing = false
			update.UpstreamName = candidate.UpstreamName
			if prior.Label == prior.UpstreamName || prior.Label == "" {
				update.Label = candidate.UpstreamName
			}
			if kind != "" {
				preview.Changed = append(preview.Changed, changedSubscriptionProfile{prior.ID, prior.UpstreamName, candidate.UpstreamName, kind})
			}
			next[oldIndex] = update
			continue
		}
		prefix := "sub-" + subscriptionDigest(source.ID + "/" + candidate.UpstreamKey)[:16]
		candidate.ID = prefix
		for n := 2; usedIDs[candidate.ID]; n++ {
			candidate.ID = fmt.Sprintf("%s-%d", prefix, n)
		}
		candidate.SubscriptionID = source.ID
		usedIDs[candidate.ID] = true
		next = append(next, candidate)
		preview.Added = append(preview.Added, addedSubscriptionProfile{Key: candidate.UpstreamKey, Name: candidate.UpstreamName,
			XrayGroup: candidate.XrayGroup != nil, GroupSize: groupMemberCount(candidate)})
	}
	for i, prior := range base.Profiles {
		if prior.SubscriptionID != source.ID || matched[i] || prior.SubscriptionMissing {
			continue
		}
		next[i].SubscriptionMissing = true
		preview.Missing = append(preview.Missing, missingSubscriptionProfile{prior.ID, fallback(prior.Label, prior.UpstreamName), subscriptionProfileReferences(base, prior.ID)})
		var candidates []string
		endpoint := subscriptionEndpointKey(prior)
		for newIndex, candidate := range incoming {
			if _, matched := nextToOld[newIndex]; !matched && endpoint != "" && subscriptionEndpointKey(candidate) == endpoint {
				candidates = append(candidates, candidate.UpstreamName)
			}
		}
		if len(candidates) > 0 {
			preview.Ambiguous = append(preview.Ambiguous, ambiguousSubscriptionProfile{prior.ID, candidates})
		}
	}
	catalogSize := 0
	for _, entry := range next {
		if entry.CatalogProfile {
			catalogSize++
		}
	}
	if catalogSize > maxCatalogProfiles {
		return nil, fmt.Errorf("каталог достиг лимита в %d профилей. Удалите ненужные профили и повторите", maxCatalogProfiles)
	}
	return next, nil
}

func subscriptionSnapshot(profiles []profile, id string) (string, int) {
	keys := make([]string, 0)
	for _, entry := range profiles {
		if entry.SubscriptionID == id && !entry.SubscriptionMissing {
			keys = append(keys, entry.UpstreamKey+"|"+entry.UpstreamName)
		}
	}
	slices.Sort(keys)
	return subscriptionDigest(strings.Join(keys, "\n")), len(keys)
}

func routeProfileTargets(config plan) map[string]bool {
	targets := map[string]bool{config.DefaultTarget: true}
	for _, rule := range config.Rules {
		if !rule.Disabled {
			targets[rule.Target] = true
		}
	}
	for _, device := range config.Devices {
		targets[device.DefaultTarget] = true
		for _, rule := range device.Rules {
			if !rule.Disabled {
				targets[rule.Target] = true
			}
		}
	}
	return targets
}

func engineProfiles(config plan) []profile {
	targets := routeProfileTargets(config)
	out := make([]profile, 0, len(config.Profiles))
	for _, entry := range config.Profiles {
		if !entry.CatalogProfile || targets[entry.ID] || entry.ID == config.runtimeHealthTarget {
			out = append(out, entry)
		}
	}
	return out
}

func subscriptionMetadataOnly(before, after plan, selection runtimeSelection) bool {
	if len(before.Subscriptions) == 0 && len(after.Subscriptions) == 0 {
		return false
	}
	project := func(config plan) plan {
		config.Subscriptions = nil
		config.Profiles = engineProfiles(runtimePlan(config, selection))
		for i := range config.Profiles {
			entry := &config.Profiles[i]
			if entry.CatalogProfile {
				entry.SubscriptionID, entry.UpstreamName, entry.UpstreamKey = "", "", ""
				entry.Label, entry.Location, entry.Server = "", "", ""
				entry.SubscriptionMissing = false
			}
		}
		return config
	}
	return reflect.DeepEqual(project(before), project(after))
}
