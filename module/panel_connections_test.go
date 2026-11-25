package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

const observationFixtureTCP = "ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.10.2 dst=203.0.113.1 sport=55354 dport=443 packets=1 bytes=130 src=192.168.10.1 dst=192.168.10.2 sport=15080 dport=55354 packets=1 bytes=100 [ASSURED] mark=0 use=1"
const observationFixtureUDP = "udp 17 26 src=192.168.10.7 dst=198.51.100.4 sport=42300 dport=443 src=198.51.100.4 dst=203.0.113.5 sport=443 dport=42300 mark=0 use=1"

func TestConnectionObservationTracksCountersWithoutInferringExit(t *testing.T) {
	source := netip.MustParsePrefix("192.168.10.0/24")
	router := netip.MustParseAddr("192.168.10.1")
	listener := netip.MustParseAddrPort("192.168.10.1:15080")
	samples := []string{
		observationFixtureTCP,
		strings.Replace(observationFixtureTCP, "bytes=130", "bytes=210", 1) + "\n" + observationFixtureUDP + "\n" +
			strings.Replace(observationFixtureTCP, "src=192.168.10.2", "src=172.16.0.9", 1) + "\n" +
			strings.Replace(observationFixtureTCP, "src=192.168.10.2", "src=192.168.10.1", 1),
	}
	call := 0
	got, err := sampleConnections(context.Background(), 1, time.Millisecond, source, router, listener,
		map[netip.Addr]string{netip.MustParseAddr("192.168.10.2"): "test-client"},
		func(ctx context.Context, source netip.Prefix, router netip.Addr) (trackedSnapshot, error) {
			fixture := samples[call]
			call++
			return readConnectionTable(ctx, strings.NewReader(fixture), source, router)
		})
	if err != nil || got.Limited || call != 2 || len(got.Rows) != 2 {
		t.Fatalf("observation: %+v, samples: %d, error: %v", got, call, err)
	}
	first, second := got.Rows[0], got.Rows[1]
	if first.Destination != "203.0.113.1:443" || first.DeviceID != "test-client" || !first.Redirected ||
		first.New || first.Bytes == nil || *first.Bytes != 80 {
		t.Fatalf("TCP result: %+v", first)
	}
	if second.Protocol != "udp" || second.Destination != "198.51.100.4:443" || !second.New || second.Redirected || second.Bytes != nil {
		t.Fatalf("UDP result: %+v", second)
	}
}

func TestPanelConnectionObservationBoundaries(t *testing.T) {
	active := testPanelEditConfig()
	active.PanelHost = "192.168.10.1"
	active.Transparent = &transparent{Interface: "br0", Source: "192.168.10.0/24", Port: 15080, Mode: transparentRedirectTCP}
	editor := newPanelEditor(active, testEditKey, func(context.Context, plan) error {
		t.Error("observation attempted to apply a plan")
		return nil
	})
	diagnostics := newPanelDiagnostics(editor, status{LAN: true, LANMode: transparentRedirectTCP}, nil)
	diagnostics.readConnections = func(ctx context.Context, source netip.Prefix, router netip.Addr) (trackedSnapshot, error) {
		return readConnectionTable(ctx, strings.NewReader(observationFixtureTCP), source, router)
	}
	mux := http.NewServeMux()
	diagnostics.register(mux)
	call := func(body, origin, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, testEditOrigin+"/api/panel/connections/observe", strings.NewReader(body))
		req.Header.Set("Origin", origin)
		req.Header.Set("X-RouteHub-Key", key)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		return response
	}

	for _, test := range []struct {
		name, body, origin, key string
		status                  int
	}{
		{"no authentication", `{"seconds":1}`, testEditOrigin, "", http.StatusForbidden},
		{"different origin", `{"seconds":1}`, "http://example.invalid", testEditKey, http.StatusForbidden},
		{"too long", `{"seconds":30}`, testEditOrigin, testEditKey, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := call(test.body, test.origin, test.key); got.Code != test.status {
				t.Fatalf("HTTP %d: %s", got.Code, got.Body)
			}
		})
	}
	diagnostics.observation <- struct{}{}
	if got := call(`{"seconds":1}`, testEditOrigin, testEditKey); got.Code != http.StatusTooManyRequests {
		t.Fatalf("concurrent observation: HTTP %d", got.Code)
	}
	<-diagnostics.observation
	got := call(`{"seconds":1}`, testEditOrigin, testEditKey)
	var result connectionObservation
	if err := json.Unmarshal(got.Body.Bytes(), &result); got.Code != http.StatusOK || err != nil ||
		result.Seconds != 1 || len(result.Rows) != 1 || !result.Rows[0].Redirected || result.FinishedAt.IsZero() {
		t.Fatalf("HTTP %d: %s (%v)", got.Code, got.Body, err)
	}

	diagnostics.state.LAN = false
	if got := call(`{"seconds":1}`, testEditOrigin, testEditKey); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("unmanaged LAN observed: HTTP %d", got.Code)
	}
}
