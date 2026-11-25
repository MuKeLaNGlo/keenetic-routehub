package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestDNSDoHFailoverCachingAndFilters(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.URL.Path == "/broken" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		encoded, err := io.ReadAll(request.Body)
		question := new(dns.Msg)
		if err != nil || question.Unpack(encoded) != nil || question.Id != 0 {
			t.Error("invalid DoH request")
			return
		}
		reply := new(dns.Msg).SetReply(question)
		reply.Answer = []dns.RR{&dns.A{
			Hdr: dns.RR_Header{Name: question.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 50},
			A:   net.ParseIP("192.0.2.53"),
		}}
		data, err := reply.Pack()
		if err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(data)
	}))
	defer server.Close()
	old := dnsHTTP
	dnsHTTP = server.Client()
	t.Cleanup(func() { dnsHTTP = old })
	config := dnsSettings{Protocol: "doh", Primary: server.URL + "/broken", Secondary: server.URL + "/resolve",
		Cache: true, Adblock: true, Lists: []string{"normal"}, Exceptions: []string{"ok.tracker.test"}}
	resolver := newDNSResolver(config, map[string]struct{}{"tracker.test": {}})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	blocked := resolver.resolve(ctx, new(dns.Msg).SetQuestion("sub.tracker.test.", dns.TypeA))
	if blocked.Rcode != dns.RcodeNameError || calls.Load() != 0 {
		t.Fatal("blocked hostname reached an upstream")
	}
	for _, name := range []string{"ok.tracker.test.", "a.ok.tracker.test."} {
		first := resolver.resolve(ctx, new(dns.Msg).SetQuestion(name, dns.TypeA))
		question := new(dns.Msg).SetQuestion(name, dns.TypeA)
		cached := resolver.resolve(ctx, question)
		if first.Rcode != dns.RcodeSuccess || cached.Id != question.Id || len(cached.Answer) != 1 {
			t.Fatalf("failover or cache failed for %s", name)
		}
	}
	if calls.Load() != 4 {
		t.Fatalf("expected two upstream calls per uncached name, got %d", calls.Load())
	}
}
