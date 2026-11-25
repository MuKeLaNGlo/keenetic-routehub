package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
)

func requestZapretCheck(handler http.HandlerFunc, key, origin, mediaType, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, testEditOrigin+"/api/zapret/check", strings.NewReader(body))
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", mediaType)
	request.Header.Set("X-RouteHub-Key", key)
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func assertZapretResponse(t *testing.T, response *httptest.ResponseRecorder, want string) zapretCheckResponse {
	t.Helper()
	var result zapretCheckResponse
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Status != want || result.Message == "" {
		t.Fatalf("want diagnostic status %q, got %d %s", want, response.Code, response.Body)
	}
	return result
}

func newZapretTestEditor(t *testing.T, enabled bool, services *zapretServices) *panelEditor {
	t.Helper()
	return newPanelEditor(plan{Zapret: enabled, ZapretServices: services}, testEditKey,
		func(context.Context, plan) error {
			t.Error("diagnostic changed routing config")
			return nil
		})
}

func TestZapretCheckAuthAndScope(t *testing.T) {
	editor := newZapretTestEditor(t, true, &zapretServices{YouTube: true})
	handler := editor.zapretCheckHandler(true, zapretProbe{})
	for _, tc := range []struct {
		name, key, origin, mediaType, body string
		want                               int
	}{
		{"bad key", "wrong", testEditOrigin, "application/json", `{"service":"youtube"}`, http.StatusForbidden},
		{"bad origin", testEditKey, "http://other.invalid", "application/json", `{"service":"youtube"}`, http.StatusForbidden},
		{"bad MIME", testEditKey, testEditOrigin, "text/plain", `{"service":"youtube"}`, http.StatusUnsupportedMediaType},
		{"extra host", testEditKey, testEditOrigin, "application/json", `{"service":"youtube","host":"example.net"}`, http.StatusBadRequest},
		{"unexpected service", testEditKey, testEditOrigin, "application/json", `{"service":"https://example.net"}`, http.StatusBadRequest},
		{"oversized", testEditKey, testEditOrigin, "application/json", `{"service":"youtube"}` + strings.Repeat(" ", 280), http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := requestZapretCheck(handler, tc.key, tc.origin, tc.mediaType, tc.body)
			if got.Code != tc.want {
				t.Fatalf("got %d, want %d: %s", got.Code, tc.want, got.Body)
			}
		})
	}
	discordOff := requestZapretCheck(handler, testEditKey, testEditOrigin, "application/json", `{"service":"discord"}`)
	if got := assertZapretResponse(t, discordOff, "disabled"); got.Service != "discord" || got.HTTPStatus != 0 {
		t.Fatalf("unexpected disabled result %+v", got)
	}
	runtimeOff := editor.zapretCheckHandler(false, zapretProbe{})
	assertZapretResponse(t, requestZapretCheck(runtimeOff, testEditKey, testEditOrigin, "application/json",
		`{"service":"youtube"}`), "disabled")
	configOff := newZapretTestEditor(t, false, &zapretServices{YouTube: true}).zapretCheckHandler(true, zapretProbe{})
	assertZapretResponse(t, requestZapretCheck(configOff, testEditKey, testEditOrigin, "application/json",
		`{"service":"youtube"}`), "disabled")
}

func TestZapretCheckRequiresOwnQueueEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, want    string
		queueAfter    zapretRuntimeSample
		queueError    error
		before, after zapretQueueSample
		status        int
		httpError     error
	}{
		{"all evidence", "verified", zapretRuntimeSample{314, 11}, nil, zapretQueueSample{282, 172}, zapretQueueSample{282, 173}, 200, nil},
		{"shared counter only", "unverified", zapretRuntimeSample{314, 10}, nil, zapretQueueSample{282, 172}, zapretQueueSample{282, 173}, 200, nil},
		{"queue rebind", "unverified", zapretRuntimeSample{314, 11}, nil, zapretQueueSample{282, 172}, zapretQueueSample{283, 173}, 200, nil},
		{"queue disappeared", "unverified", zapretRuntimeSample{}, errZapretRuntime, zapretQueueSample{282, 172}, zapretQueueSample{}, 200, nil},
		{"queue stalled", "unverified", zapretRuntimeSample{314, 11}, nil, zapretQueueSample{282, 172}, zapretQueueSample{282, 172}, 200, nil},
		{"endpoint redirects", "failed", zapretRuntimeSample{}, nil, zapretQueueSample{282, 172}, zapretQueueSample{}, 302, nil},
		{"mark unavailable", "unavailable", zapretRuntimeSample{}, nil, zapretQueueSample{282, 172}, zapretQueueSample{}, 0, errZapretMark},
		{"network error", "failed", zapretRuntimeSample{}, nil, zapretQueueSample{282, 172}, zapretQueueSample{}, 0, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtimeSamples, queueSamples := 0, 0
			probe := zapretProbe{
				runtime: func(context.Context) (zapretRuntimeSample, error) {
					runtimeSamples++
					if runtimeSamples == 1 {
						return zapretRuntimeSample{314, 10}, nil
					}
					return tc.queueAfter, tc.queueError
				},
				queue: func(queue uint16) (zapretQueueSample, bool) {
					if queue != 314 {
						t.Errorf("unexpected NFQUEUE number %d", queue)
					}
					queueSamples++
					sample := tc.before
					if queueSamples > 1 {
						sample = tc.after
					}
					return sample, sample.peer != 0
				},
				https: func(_ context.Context, address string) (int, error) {
					if address != discordCheckURL {
						t.Errorf("expected fixed Discord URL, got %q", address)
					}
					return tc.status, tc.httpError
				},
			}
			editor := newZapretTestEditor(t, true, &zapretServices{Discord: true})
			result := assertZapretResponse(t, requestZapretCheck(editor.zapretCheckHandler(true, probe), testEditKey,
				testEditOrigin, "application/json", `{"service":"discord"}`), tc.want)
			if result.Service != "discord" || result.HTTPStatus != tc.status || result.LatencyMS == nil {
				t.Fatalf("diagnostic metadata lost: %+v", result)
			}
		})
	}
}

func TestZapretCheckSkipsNetworkWhenHelperInactive(t *testing.T) {
	editor := newZapretTestEditor(t, true, &zapretServices{YouTube: true})
	probe := zapretProbe{runtime: func(context.Context) (zapretRuntimeSample, error) {
		return zapretRuntimeSample{}, errZapretRuntime
	}}
	result := assertZapretResponse(t, requestZapretCheck(editor.zapretCheckHandler(true, probe), testEditKey,
		testEditOrigin, "application/json", `{"service":"youtube"}`), "unavailable")
	if result.LatencyMS != nil {
		t.Fatal("runtime failure should not launch an HTTPS request")
	}
}

func TestZapretCheckSerializesSingleDiagnosticMark(t *testing.T) {
	started := make(chan struct{})
	done := make(chan struct{})
	probe := zapretProbe{
		runtime: func(context.Context) (zapretRuntimeSample, error) {
			return zapretRuntimeSample{314, 1}, nil
		},
		queue: func(uint16) (zapretQueueSample, bool) {
			return zapretQueueSample{282, 172}, true
		},
		https: func(ctx context.Context, endpoint string) (int, error) {
			if endpoint != youtubeCheckURL {
				t.Error("unexpected YouTube destination")
			}
			close(started)
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-done:
				return 200, nil
			}
		},
	}
	editor := newZapretTestEditor(t, true, &zapretServices{YouTube: true})
	handler := editor.zapretCheckHandler(true, probe)
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response <- requestZapretCheck(handler, testEditKey, testEditOrigin, "application/json", `{"service":"youtube"}`)
	}()
	<-started
	concurrent := requestZapretCheck(handler, testEditKey, testEditOrigin, "application/json", `{"service":"youtube"}`)
	close(done)
	if concurrent.Code != http.StatusTooManyRequests {
		t.Fatalf("concurrent probe not rejected: %d", concurrent.Code)
	}
	assertZapretResponse(t, <-response, "unverified")
}

func TestZapretDiagnosticParsers(t *testing.T) {
	got, err := parseZapretRuntime("running queue=314 packets=6564896\n")
	if err != nil || got != (zapretRuntimeSample{314, 6564896}) {
		t.Fatalf("runtime counters not parsed: %+v, %v", got, err)
	}
	for _, value := range []string{"inactive", "degraded queue=314 packets=10", "running queue=314 ipv6=0",
		"running queue=65536 packets=10", "running queue=314 packets=-1", "running queue=314 packets=0 extra"} {
		if _, err := parseZapretRuntime(value); !errors.Is(err, errZapretRuntime) {
			t.Fatalf("non-diagnostic or invalid output accepted: %q", value)
		}
	}
	text := "  313   28257   0  2 65531  0  0        7  1\n  314   31723   0  2 65531  0  0       16  1\n"
	sample, found := parseZapretQueue(strings.NewReader(text), 314)
	if !found || sample != (zapretQueueSample{31723, 16}) {
		t.Fatalf("bad NFQUEUE sample: %+v", sample)
	}
	if _, found := parseZapretQueue(strings.NewReader(text), 315); found {
		t.Fatal("read a different queue as evidence")
	}
}

func TestZapretOutboundDoesNotUseRedirectsOrPrivateAddresses(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.20.30.40", "100.64.1.2", "169.254.2.3",
		"::ffff:127.0.0.1", "192.0.2.2", "198.18.1.2", "240.0.0.5", "::1"} {
		if isZapretPublicIPv4(netip.MustParseAddr(address)) {
			t.Errorf("accepted non-public address %s", address)
		}
	}
	if !isZapretPublicIPv4(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("globally routable IPv4 was incorrectly excluded")
	}
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestCount.Add(1)
		http.Redirect(response, request, "/second", http.StatusFound)
	}))
	defer server.Close()
	client := newZapretHTTPClient((&net.Dialer{}).DialContext)
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusFound || requestCount.Load() != 1 {
		t.Fatalf("redirect followed: status=%d requests=%d", response.StatusCode, requestCount.Load())
	}
}
