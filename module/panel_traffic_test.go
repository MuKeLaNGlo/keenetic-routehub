package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWANTrafficCounters(t *testing.T) {
	routes := `Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
eth0 00000000 00000000 0201 0 0 0 00000000 0 0 0
eth1 00000000 00000000 0000 0 0 0 00000000 0 0 0
eth3 00000000 00000000 0003 0 0 1000 00000000 0 0 0
eth4 00000000 00000000 0003 0 0 200 00000000 0 0 0`
	name := defaultWAN(strings.NewReader(routes))
	if name != "eth4" {
		t.Fatalf("WAN = %q", name)
	}
	devices := `Inter-| Receive | Transmit
  eth3: 45 0 0 0 0 0 0 0 67 0 0 0 0 0 0 0
  eth4: 5000 1 2 3 4 5 6 7 6000 1 2 3 4 5 6 7`
	got, ok := interfaceCounters(strings.NewReader(devices), name)
	if !ok || got.receiveBytes != 5000 || got.sendBytes != 6000 {
		t.Fatalf("counters = %+v, %t", got, ok)
	}
}

func TestWANTrafficHistory(t *testing.T) {
	monitor := new(trafficMonitor)
	start := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	monitor.record(start, wanCounters{"eth3", 100, 40, 1000}, true)
	if got := monitor.snapshot.Samples; len(got) != 0 {
		t.Fatalf("invented a first rate: %+v", got)
	}
	monitor.record(start.Add(5*time.Second), wanCounters{"eth3", 5_000_100, 2_500_040, 1000}, true)
	monitor.record(start.Add(10*time.Second), wanCounters{"eth3", 10_000_100, 5_000_040, 1000}, true)
	if got := monitor.snapshot.Samples; len(got) != 2 || got[0].ReceiveMbit != 8 || got[0].SendMbit != 4 {
		t.Fatalf("samples = %+v", got)
	}
	monitor.record(start.Add(time.Hour+8*time.Second), wanCounters{"eth3", 10_000_100, 5_000_040, 1000}, true)
	if got := monitor.snapshot.Samples; len(got) != 2 || !got[0].At.Equal(start.Add(10*time.Second)) {
		t.Fatalf("old sample survived: %+v", got)
	}
	monitor.record(start.Add(time.Hour+9*time.Second), wanCounters{"ppp0", 30, 20, 0}, true)
	if got := monitor.snapshot; got.Interface != "ppp0" || len(got.Samples) != 0 || got.LinkMbit != 0 {
		t.Fatalf("mixed WAN interfaces: %+v", got)
	}
	monitor.record(start.Add(time.Hour+14*time.Second), wanCounters{"ppp0", 20, 10, 0}, true)
	if !monitor.snapshot.StartedAt.Equal(start.Add(time.Hour + 14*time.Second)) {
		t.Fatal("counter reset did not establish a new baseline")
	}
	monitor.record(start.Add(time.Hour+19*time.Second), wanCounters{}, false)
	response := httptest.NewRecorder()
	monitor.serveHTTP(response, nil)
	var data map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil || string(data["samples"]) != "[]" || len(data) != 1 {
		t.Fatalf("empty response: %s (%v)", response.Body, err)
	}
}
