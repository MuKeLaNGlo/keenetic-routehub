package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func TestNativeDNSNames(t *testing.T) {
	reverse, err := dns.ReverseAddr("fd00::5")
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name  string
		local bool
	}{
		{"printer.", true},
		{"PRINTER.HOME.ARPA.", true},
		{"_ipp._tcp.office.local.", true},
		{"printer.lan.", true},
		{"1.10.168.192.in-addr.arpa.", true},
		{"168.192.in-addr.arpa.", true},
		{"31.172.in-addr.arpa.", true},
		{"254.169.in-addr.arpa.", true},
		{reverse, true},
		{"8.e.f.ip6.arpa.", true},
		{".", false},
		{"com.", false},
		{"example.com.", false},
		{"printer.notlan.", false},
		{"private.home.arpa.example.org.", false},
		{"8.8.8.8.in-addr.arpa.", false},
		{"15.172.in-addr.arpa.", false},
		{"32.172.in-addr.arpa.", false},
		{"256.10.168.192.in-addr.arpa.", false},
		{"8.e.g.ip6.arpa.", false},
		{"b.d.0.1.0.0.2.ip6.arpa.", false},
	} {
		if got := isNativeDNSName(tt.name); got != tt.local {
			t.Errorf("isNativeDNSName(%q) = %v, want %v", tt.name, got, tt.local)
		}
	}
}

func TestNativeDNSUpstreamValidation(t *testing.T) {
	lan := netip.MustParsePrefix("192.168.10.0/24")
	owner := nativeDNSUpstream("192.168.10.1", "18955", lan)
	if want := netip.MustParseAddrPort("192.168.10.1:53"); owner != want {
		t.Fatalf("native upstream: got %v, want %v", owner, want)
	}
	for _, tt := range []struct {
		host, port string
	}{
		{"192.168.10.1", "53"},
		{"192.168.10.1", "0"},
		{"192.168.11.1", "18955"},
		{"127.0.0.1", "18955"},
		{"8.8.8.8", "18955"},
		{"fd00::1", "18955"},
		{"router.lan", "18955"},
	} {
		if got := nativeDNSUpstream(tt.host, tt.port, lan); got.IsValid() {
			t.Errorf("unexpected native upstream %v", got)
		}
	}
	if nativeDNSUpstream("8.8.8.8", "18955", netip.MustParsePrefix("8.8.8.0/24")).IsValid() {
		t.Fatal("accepted a public router address in a matching prefix")
	}
}

func TestNativeDNSForwardingAndSeparation(t *testing.T) {
	var public, udpQueries, tcpQueries atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		public.Add(1)
		msg := new(dns.Msg)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if err := msg.Unpack(body); err != nil {
			t.Error(err)
			return
		}
		if isNativeDNSName(msg.Question[0].Name) {
			t.Errorf("local name reached the public upstream: %q", msg.Question[0].Name)
		}
		reply := new(dns.Msg).SetReply(msg)
		reply.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: msg.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 15}, A: net.ParseIP("192.0.2.53")}}
		wire, err := reply.Pack()
		if err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(wire)
	}))
	t.Cleanup(upstream.Close)
	prev := dnsHTTP
	dnsHTTP = upstream.Client()
	t.Cleanup(func() { dnsHTTP = prev })

	handler := dns.HandlerFunc(func(w dns.ResponseWriter, request *dns.Msg) {
		name := request.Question[0].Name
		switch w.RemoteAddr().(type) {
		case *net.UDPAddr:
			udpQueries.Add(1)
		default:
			tcpQueries.Add(1)
		}
		reply := new(dns.Msg).SetReply(request)
		kind := request.Question[0].Qtype
		header := dns.RR_Header{Name: name, Rrtype: kind, Class: dns.ClassINET, Ttl: 30}
		switch name {
		case "printer.home.arpa.":
			reply.Answer = []dns.RR{&dns.A{Hdr: header, A: net.ParseIP("192.168.10.8")}}
		case "8.10.168.192.in-addr.arpa.":
			if _, datagram := w.RemoteAddr().(*net.UDPAddr); datagram {
				reply.Truncated = true
			} else {
				reply.Answer = []dns.RR{&dns.PTR{Hdr: header, Ptr: "printer.home.arpa."}}
			}
		case "unknown.lan.":
			reply.Rcode = dns.RcodeNameError
		case "wrong.lan.":
			reply.Question[0].Name = "different.lan."
		default:
			t.Errorf("unexpected native query for %q", name)
			reply.Rcode = dns.RcodeRefused
		}
		_ = w.WriteMsg(reply)
	})

	tcp, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tcp.Close() })
	udp, err := net.ListenPacket("udp4", tcp.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = udp.Close() })
	for _, server := range []*dns.Server{
		{Listener: tcp, Handler: handler}, {PacketConn: udp, Handler: handler},
	} {
		go func() { _ = server.ActivateAndServe() }()
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = server.ShutdownContext(ctx)
		})
	}

	settings := dnsSettings{Protocol: "doh", Primary: upstream.URL, Secondary: upstream.URL + "/fallback", Adblock: true, Cache: true}
	resolver := newDNSResolver(settings, map[string]struct{}{"home.arpa": {}})
	resolver.nativeDNS = netip.MustParseAddrPort(tcp.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 2; i++ {
		reply := resolver.resolve(ctx, new(dns.Msg).SetQuestion("printer.home.arpa.", dns.TypeA))
		if reply.Rcode != dns.RcodeSuccess || len(reply.Answer) != 1 || reply.Answer[0].(*dns.A).A.String() != "192.168.10.8" {
			t.Fatalf("native DHCP reply: %v", reply)
		}
	}
	pointer := resolver.resolve(ctx, new(dns.Msg).SetQuestion("8.10.168.192.in-addr.arpa.", dns.TypePTR))
	if len(pointer.Answer) != 1 || pointer.Answer[0].(*dns.PTR).Ptr != "printer.home.arpa." {
		t.Fatalf("native TCP PTR reply: %v", pointer)
	}
	unknown := resolver.resolve(ctx, new(dns.Msg).SetQuestion("unknown.lan.", dns.TypeA))
	if unknown.Rcode != dns.RcodeNameError {
		t.Fatalf("native NXDOMAIN reply: %v", unknown)
	}
	wrong := resolver.resolve(ctx, new(dns.Msg).SetQuestion("wrong.lan.", dns.TypeA))
	if wrong.Rcode != dns.RcodeServerFailure {
		t.Fatalf("mismatched native response was accepted: %v", wrong)
	}
	if public.Load() != 0 || udpQueries.Load() != 5 || tcpQueries.Load() != 1 {
		t.Fatalf("query split before public lookup: public=%d UDP=%d TCP=%d", public.Load(), udpQueries.Load(), tcpQueries.Load())
	}
	external := resolver.resolve(ctx, new(dns.Msg).SetQuestion("example.org.", dns.TypeA))
	if len(external.Answer) != 1 || external.Answer[0].(*dns.A).A.String() != "192.0.2.53" || public.Load() != 1 || udpQueries.Load() != 5 {
		t.Fatalf("public query did not use the public resolver: %v", external)
	}
}

func TestPanelDNSRetainsNativeForwarderOnEdit(t *testing.T) {
	settings := defaultDNS
	control := newPanelDNS(context.Background(), t.TempDir()+"/config.json", "", netip.Prefix{})
	resolver := newDNSResolver(settings, nil)
	resolver.nativeDNS = netip.MustParseAddrPort("192.168.10.1:53")
	control.resolver.Store(resolver)
	settings.Cache = !settings.Cache
	if err := control.apply(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	if got := control.resolver.Load(); got.nativeDNS != resolver.nativeDNS || got.settings.Cache != settings.Cache {
		t.Fatalf("editing settings lost native forwarding: %+v", got.nativeDNS)
	}
}
