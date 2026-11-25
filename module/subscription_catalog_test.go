package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const sampleSubscriptionURL = "https://subscription.example.com/secret-source-token"

func testSubscriptionLine(id, host, label string) string {
	return "vless://" + id + "@" + host + ":443?type=tcp&security=tls#" + label
}

func testSubscriptionProfiles(t *testing.T, lines ...string) []profile {
	t.Helper()
	profiles, _, err := parseSubscription([]byte(strings.Join(lines, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	return profiles
}

func TestSubscriptionSourceAcceptsBoundedPublicHTTPSAndMixedVLESSLists(t *testing.T) {
	for _, target := range []string{
		"http://example.com/list", "https://secret@example.com/list", "https://example.com:8443/list",
		"https://127.0.0.1/list", "https://169.254.169.254/list", "https://100.64.0.5/list",
		"https://[::1]/list", "https://printer.local/list", "https://example.com/path#token",
	} {
		if _, err := subscriptionEndpoint(target); err == nil {
			t.Errorf("accepted unsafe subscription address %q", target)
		}
	}
	link := testSubscriptionLine("a3333333-b333-4333-8333-a33333333333", "edge.example.net", "Berlin")
	raw := link + "\n" + link + "\r\n" + "trojan://sample@not-vless.example#safe-label"
	wrapped := base64.RawURLEncoding.EncodeToString([]byte(raw))
	for _, body := range []string{raw, wrapped, wrapped[:45] + "\r\n" + wrapped[45:]} {
		entries, incompatible, err := parseSubscription([]byte(body))
		if err != nil || len(entries) != 1 || entries[0].Label != "Berlin" || len(incompatible) != 1 {
			t.Fatalf("unexpected parse outcome: entries %d, incompatible %d, error %v", len(entries), len(incompatible), err)
		}
		if strings.Contains(incompatible[0].Name, "sample") || len(incompatible[0].Key) != 32 {
			t.Fatal("private line visible in error details")
		}
	}
	if _, _, err := parseSubscription([]byte(strings.Repeat(" ", maxSubscriptionBody+1))); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestSubscriptionRefreshKeepsRouteIdentityAliasAndMissingProfiles(t *testing.T) {
	firstID, secondID := "a3333333-b333-4333-8333-a33333333333", "b3333333-b333-4333-8333-a33333333333"
	source := subscription{ID: "subs"}
	preview := emptySubscriptionPreview(source.ID)
	old, err := mergeSubscriptionProfiles(plan{}, source, testSubscriptionProfiles(t,
		testSubscriptionLine(firstID, "de.example.net", "Berlin"),
		testSubscriptionLine(firstID, "uk.example.net", "London"),
	), &preview)
	if err != nil || len(old) != 2 || len(preview.Added) != 2 {
		t.Fatalf("initial merge failed: %v", err)
	}
	old[0].Label = "Выход для работы"
	base := plan{Profiles: old, DefaultTarget: old[1].ID}
	preview = emptySubscriptionPreview(source.ID)
	updated, err := mergeSubscriptionProfiles(base, source, testSubscriptionProfiles(t,
		testSubscriptionLine(secondID, "de.example.net", "Berlin-new"),
	), &preview)
	if err != nil || len(updated) != 2 || len(preview.Changed) != 1 || len(preview.Missing) != 1 {
		t.Fatalf("changed merge failed: %v", err)
	}
	if updated[0].ID != old[0].ID || updated[0].Label != old[0].Label || updated[0].UpstreamName != "Berlin-new" {
		t.Fatal("update lost stable ID or local alias")
	}
	if updated[1].ID != old[1].ID || !updated[1].SubscriptionMissing || len(preview.Missing[0].UsedBy) != 1 {
		t.Fatal("missing profile was not kept with its rule target")
	}
}

func TestSubscriptionCatalogOmitsUnusedOutboundsAndPreservesUsedCredentials(t *testing.T) {
	entry := testSubscriptionProfiles(t, testSubscriptionLine("a3333333-b333-4333-8333-a33333333333", "edge.example.net", "Berlin"))[0]
	entry.ID, entry.SubscriptionID = "sub-outbound", "subs"
	defaults := runtimeSelection{VPN: true}
	base := plan{PanelPort: 18952, SOCKSPort: 18953, DefaultTarget: "direct", Profiles: []profile{entry},
		Subscriptions: []subscription{{ID: "subs", URL: sampleSubscriptionURL, Name: "Provider", Type: "vless-list", IntervalHours: 24}}}
	added := copyPanelPlan(base)
	updated := testSubscriptionProfiles(t, testSubscriptionLine("b3333333-b333-4333-8333-a33333333333", "edge.example.net", "Berlin"))[0]
	added.Profiles[0].URI = updated.URI
	if !subscriptionMetadataOnly(base, added, defaults) {
		t.Fatal("unused catalog change would restart Xray")
	}
	compiled, err := compileXray(base, false, false)
	if err != nil || len(compiled["outbounds"].([]object)) != 3 {
		t.Fatal("unused subscription profile was included in active Xray config")
	}
	base.DefaultTarget, added.DefaultTarget = entry.ID, entry.ID
	if subscriptionMetadataOnly(base, added, defaults) {
		t.Fatal("credential changes to active outbound skipped Xray updates")
	}
	compiled, err = compileXray(base, false, false)
	if err != nil || len(compiled["outbounds"].([]object)) != 4 {
		t.Fatal("active subscription profile is missing from Xray config")
	}
}

func TestSubscriptionEndpointsPersistPreviewAndKeepLastGoodWhenFetchFails(t *testing.T) {
	const testDeviceID = "private-router-test-device"
	start := plan{PanelPort: 18952, SOCKSPort: 18953, PanelHost: "127.0.0.1", DefaultTarget: "direct"}
	editor := newPanelEditor(start, "test-session-key", func(_ context.Context, _ plan) error { return nil })
	manager := newPanelSubscriptions(editor, nil)
	fail := false
	manager.fetch = func(_ context.Context, sub subscription) (subscriptionDownload, error) {
		if sub.URL != sampleSubscriptionURL || sub.DeviceID != testDeviceID {
			t.Fatal("provider credentials not persisted privately")
		}
		if fail {
			return subscriptionDownload{}, errors.New("сервер подписки недоступен")
		}
		return subscriptionDownload{body: []byte(testSubscriptionLine("a3333333-b333-4333-8333-a33333333333", "edge.example.net", "Berlin"))}, nil
	}
	mux := http.NewServeMux()
	manager.register(mux, nil)
	request := func(method, suffix string, value object) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, "http://routehub.local/api/panel/subscriptions"+suffix, strings.NewReader(string(data)))
		req.Header.Set("Origin", "http://routehub.local")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-RouteHub-Key", "test-session-key")
		result := httptest.NewRecorder()
		mux.ServeHTTP(result, req)
		return result
	}
	saved := request(http.MethodPut, "", object{"revision": editor.current().Revision, "url": sampleSubscriptionURL,
		"deviceId": testDeviceID, "name": "Provider", "enabled": true, "intervalHours": 24})
	if saved.Code != http.StatusOK || strings.Contains(saved.Body.String(), "secret-source-token") ||
		strings.Contains(saved.Body.String(), testDeviceID) || !strings.Contains(saved.Body.String(), `"hasDeviceId":true`) {
		t.Fatalf("catalog save failed or leaked source: HTTP %d", saved.Code)
	}
	id := editor.current().Subscriptions[0].ID
	review := request(http.MethodPost, "/preview", object{"id": id})
	var preview subscriptionPreview
	if err := json.Unmarshal(review.Body.Bytes(), &preview); review.Code != http.StatusOK || err != nil || !preview.OK || preview.Token == "" {
		t.Fatalf("subscription preview failed: HTTP %d %v", review.Code, err)
	}
	apply := request(http.MethodPost, "/refresh", object{"id": id, "token": preview.Token})
	if apply.Code != http.StatusOK || len(editor.current().Profiles) != 1 {
		t.Fatalf("subscription apply failed: HTTP %d", apply.Code)
	}
	status := editor.current().Subscriptions[0].LastSuccess
	if status == nil || status.Profiles != 1 {
		t.Fatal("last good refresh status not saved")
	}
	rev := editor.current().Revision
	fail = true
	manager.refreshDue(context.Background(), time.Now().Add(25*time.Hour))
	current := editor.current()
	if len(current.Profiles) != 1 || current.Subscriptions[0].LastAttempt == nil ||
		current.Subscriptions[0].LastAttempt.OK || current.Subscriptions[0].LastSuccess != status || current.Revision != rev {
		t.Fatal("a failed automatic refresh replaced the working catalog")
	}
	public, err := json.Marshal(editor.snapshot())
	if err != nil || strings.Contains(string(public), "secret-source-token") || strings.Contains(string(public), testDeviceID) || strings.Contains(string(public), "a3333333-b333") {
		t.Fatal("public plan leaked subscription credentials")
	}
	update := request(http.MethodPut, "", object{"revision": editor.current().Revision, "id": id, "url": "https://new.example.net/catalog",
		"name": "Provider", "enabled": true, "intervalHours": 24})
	if update.Code != http.StatusOK || editor.current().Subscriptions[0].DeviceID != "" {
		t.Fatal("device identity migrated to an unrelated provider without being set")
	}
}

func TestSubscriptionSchedulerRotatesIfStatusCannotBeSaved(t *testing.T) {
	now := time.Now().UTC()
	base := plan{Subscriptions: []subscription{
		{ID: "first", Enabled: true, IntervalHours: 1, AddedAt: now.Add(-2 * time.Hour)},
		{ID: "second", Enabled: true, IntervalHours: 1, AddedAt: now.Add(-2 * time.Hour)},
	}}
	editor := newPanelEditor(base, "test-key", func(_ context.Context, _ plan) error {
		return errors.New("storage unavailable")
	})
	manager := newPanelSubscriptions(editor, nil)
	var attempts []string
	manager.fetch = func(_ context.Context, item subscription) (subscriptionDownload, error) {
		attempts = append(attempts, item.ID)
		return subscriptionDownload{}, errors.New("provider unavailable")
	}
	for range 3 {
		manager.refreshDue(context.Background(), now)
	}
	if got := strings.Join(attempts, ","); got != "first,second,first" {
		t.Fatalf("unexpected refresh order: %s", got)
	}
}
