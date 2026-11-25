package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"routehub/devicepolicy"
)

func TestPanelDiagnosticBoundaries(t *testing.T) {
	diagnostics := newPanelDiagnostics(newPanelEditor(testPanelEditConfig(), testEditKey, func(context.Context, plan) error { return nil }), status{LAN: true}, nil)
	mux := http.NewServeMux()
	diagnostics.register(mux)
	mux.HandleFunc("PUT /api/plan", func(w http.ResponseWriter, r *http.Request) {
		status := http.StatusForbidden
		if diagnostics.editor.authorized(r) {
			status = http.StatusOK
		}
		sendJSON(w, status, object{"message": testSecretURI})
	})
	handler := diagnostics.audit(mux)
	request := func(method, path, body string, authorized bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, testEditOrigin+path, strings.NewReader(body))
		if authorized {
			req.Header.Set("Origin", testEditOrigin)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-RouteHub-Key", testEditKey)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	for _, target := range []string{"127.0.0.1", "100.100.100.200", "169.254.169.254", "192.168.10.1", "203.0.113.1", "fe80::1"} {
		body := `{"source":{"type":"segment","segmentId":"br0"},"target":"` + target + `","proto":"tcp","port":443}`
		if got := request(http.MethodPost, "/api/panel/real-test", body, false); got.Code != http.StatusForbidden {
			t.Fatalf("unauthenticated request: %d", got.Code)
		}
		got := request(http.MethodPost, "/api/panel/real-test", body, true)
		if got.Code != 200 || !strings.Contains(got.Body.String(), "только публичный IPv4") {
			t.Fatalf("private route probe %s received %d %s", target, got.Code, got.Body)
		}
	}
	request(http.MethodPut, "/api/plan", "", false)
	request(http.MethodPut, "/api/plan", "", true)
	journal := request(http.MethodGet, "/api/panel/events", "", true)
	var events []panelEvent
	if err := json.Unmarshal(journal.Body.Bytes(), &events); err != nil || len(events) != 8 || events[0].Type != "apply" {
		t.Fatalf("unexpected audit trail: %s (%v)", journal.Body, err)
	}
	tasks := request(http.MethodGet, "/api/panel/tasks", "", true)
	if !strings.Contains(tasks.Body.String(), `"state":"error"`) {
		t.Fatalf("failed probes absent: %s", tasks.Body)
	}
	report := request(http.MethodGet, "/api/panel/support-report", "", true)
	for _, secret := range []string{testSecretURI, testEditKey, "example.net", "Wireguard0"} {
		if strings.Contains(journal.Body.String(), secret) || strings.Contains(report.Body.String(), secret) {
			t.Fatalf("diagnostics contains private test fixture data")
		}
	}
}

type panelTestDialer struct {
	dial func(string, string) (net.Conn, error)
}

func (d panelTestDialer) DialContext(_ context.Context, network, destination string) (net.Conn, error) {
	return d.dial(network, destination)
}

func TestPanelRouteProbePinsIPAddressAndDoesNotFollowRedirect(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	type received struct{ host, path string }
	requests := make(chan received, 1)
	go func() {
		defer server.Close()
		request, err := http.ReadRequest(bufio.NewReader(server))
		if err != nil {
			requests <- received{}
			return
		}
		requests <- received{request.Host, request.URL.Path}
		_, _ = io.WriteString(server, "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\n\r\n")
	}()
	result := &panelProbeResult{Stages: make([]panelProbeStage, 4)}
	calls := 0
	dialer := panelTestDialer{dial: func(network, address string) (net.Conn, error) {
		calls++
		if network != "tcp" || address != "1.1.1.1:80" {
			t.Fatalf("wrong destination: %s %s", network, address)
		}
		return client, nil
	}}
	duration := runProbeHTTP(context.Background(), dialer, destination{Host: "example.com", TargetIP: "1.1.1.1", Port: 80}, result, time.Now())
	if got := <-requests; got.host != "example.com" || got.path != "/" || duration == nil || result.Stages[3].Detail != "HTTP 302." || calls != 1 {
		t.Fatalf("probe response: request=%+v result=%+v calls=%d", got, result, calls)
	}
}

func TestPanelTopologyDoesNotRouteUncapturedSegments(t *testing.T) {
	config := testPanelEditConfig()
	config.PanelHost = "192.168.1.1"
	home := newNetworkSegment("br0", "bridge", "up")
	home.IPv4, home.addresses = []string{"192.168.1.0/24"}, []netip.Addr{netip.MustParseAddr("192.168.1.1")}
	guest := newNetworkSegment("br2", "bridge", "up")
	guest.IPv4, guest.addresses = []string{"10.42.0.0/24"}, []netip.Addr{netip.MustParseAddr("10.42.0.1")}
	segments := panelNetworkSegments(config, true, []devicepolicy.KeeneticSegment{
		{ID: "Bridge2", Name: "Гости", Kind: "bridge", Address: guest.addresses[0], State: "up"},
		{ID: "Bridge0", Name: "Дом", Kind: "bridge", Address: home.addresses[0], State: "up"},
	}, []panelNetworkSegment{home, guest})
	if len(segments) != 2 || segments[0].Name != "Дом" || segments[0].Routable["available"] != true || segments[1].Name != "Гости" || segments[1].Routable["available"] != false {
		t.Fatalf("unexpected captured routing boundary: %+v", segments)
	}
	devices := panelTopologyDevices([]devicepolicy.Neighbor{
		{MAC: "02:00:00:00:00:aa", Address: "192.168.1.20", Fixed: true},
		{MAC: "02:00:00:00:00:bb", Address: "10.42.0.20"},
		{MAC: "02:00:00:00:00:cc", Address: "10.42.0.1"},
		{MAC: "02:00:00:00:00:dd", Address: "172.16.1.10"},
	}, segments, time.Now())
	if len(devices) != 2 || devices[0].SegmentID != "br0" || !devices[0].Addresses[0].Confirmed || devices[1].SegmentID != "br2" || devices[1].ConnectionKnown {
		t.Fatalf("unexpected device mapping: %+v", devices)
	}
}
