package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSubscriptionRejectsBlockedDeviceNotice(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000003"
	first := testSubscriptionLine(id, "edge.example.net", "Device-ID")
	second := testSubscriptionLine(id, "edge.example.net", (&url.URL{Fragment: blockedDeviceLabel}).EscapedFragment())
	text := first + "\n" + second
	json := `[{"remarks":"Device-ID","outbounds":[` + testSubscriptionVLESS + `]},` +
		`{"remarks":"` + blockedDeviceLabel + `","outbounds":[` + testSubscriptionVLESS + `]}]`
	for _, input := range []string{text, base64.StdEncoding.EncodeToString([]byte(text)), json} {
		profiles, _, err := parseSubscription([]byte(input))
		if len(profiles) != 0 || !errors.Is(err, errSubscriptionDeviceBlocked) {
			t.Fatalf("blocked-device notice parsed as %d usable profiles, error = %v", len(profiles), err)
		}
	}
}

func TestSubscriptionRetryAfterCookieRedirect(t *testing.T) {
	for _, test := range []struct {
		name   string
		mode   string
		status int
		calls  int32
		agent  string
	}{
		{"accept cookie and fetch", "cookie", http.StatusOK, 2, ""},
		{"preserve a configured User-Agent", "cookie", http.StatusOK, 2, "ExampleClient/1.0 (Router)"},
		{"conditional refresh", "cached", http.StatusNotModified, 2, ""},
		{"reject repeat with changing cookies", "rotating", 0, 2, ""},
		{"reject self redirect without cookie", "none", 0, 1, ""},
		{"reject a cookie for another path", "path", 0, 1, ""},
		{"reject redirect to another origin", "origin", 0, 1, ""},
		{"reject an earlier distinct hop", "cycle", 0, 2, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			const path = "/subscription"
			const testDeviceID = "router-00000000000000000000000000000000"
			var requests atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-HWID") != testDeviceID || r.Header.Get("X-VPNUS-Router") != "" || r.UserAgent() != fallback(test.agent, "RouteHub") ||
					!strings.HasPrefix(r.Header.Get("Accept"), "application/json") {
					t.Error("subscription request must send only the configured device identity")
				}
				if requests.Add(1) == 1 {
					if r.Header.Get("Cookie") != "" {
						t.Error("cookie from previous fetch")
					}
					location := path
					cookie := &http.Cookie{Name: "session", Value: "fresh", Path: path, Secure: true}
					switch test.mode {
					case "none":
						cookie = nil
					case "path":
						cookie.Path = "/unrelated"
					case "origin":
						location = "https://elsewhere.example/"
					case "cycle":
						location = path + "/step"
					}
					if cookie != nil {
						http.SetCookie(w, cookie)
					}
					http.Redirect(w, r, location, http.StatusTemporaryRedirect)
					return
				}
				if r.Header.Get("Cookie") != "session=fresh" || r.Header.Get("Referer") != "" {
					t.Error("redirect did not send the new cookie alone")
				}
				switch test.mode {
				case "cycle", "rotating":
					http.SetCookie(w, &http.Cookie{Name: "session", Value: "rotated", Path: path, Secure: true})
					http.Redirect(w, r, path, http.StatusTemporaryRedirect)
				case "cached":
					if r.Header.Get("If-None-Match") != `"last-good"` {
						t.Error("retry did not preserve the ETag")
					}
					w.WriteHeader(http.StatusNotModified)
				default:
					w.Header().Set("ETag", `"new"`)
					fmt.Fprint(w, "subscription data")
				}
			}))
			defer server.Close()

			client := server.Client()
			client.Transport = rewriteSubscriptionTestTarget{client.Transport, server.URL}
			source := subscription{URL: "https://subscription.example" + path, DeviceID: testDeviceID, UserAgent: test.agent}
			if test.mode == "cached" {
				source.ETag = `"last-good"`
				source.LastSuccess = &subscriptionSuccess{}
			}
			got, err := downloadSubscription(context.Background(), source, client)
			if (err != nil) != (test.status == 0) || requests.Load() != test.calls {
				t.Fatalf("calls = %d, error = %v", requests.Load(), err)
			}
			if test.status == http.StatusOK && (string(got.body) != "subscription data" || got.etag != `"new"`) {
				t.Fatal("subscription payload or ETag was lost")
			}
			if test.status == http.StatusNotModified && !got.unchanged {
				t.Fatal("last good snapshot was not kept")
			}
		})
	}
}

type rewriteSubscriptionTestTarget struct {
	base http.RoundTripper
	url  string
}

func (t rewriteSubscriptionTestTarget) RoundTrip(request *http.Request) (*http.Response, error) {
	fixtureRequest, err := http.NewRequestWithContext(request.Context(), request.Method, t.url+request.URL.RequestURI(), nil)
	if err != nil {
		return nil, err
	}
	fixtureRequest.Header = request.Header
	response, err := t.base.RoundTrip(fixtureRequest)
	if err == nil {
		response.Request = request
	}
	return response, err
}

func TestSubscriptionUserAgentValidation(t *testing.T) {
	for _, value := range []string{"Bad\r\nX-HWID: 1", "client\x00", "Клиент/1", strings.Repeat("A", 129)} {
		if validSubscriptionUserAgent(value) {
			t.Fatal("unsafe User-Agent was accepted")
		}
	}
}
