package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	trafficInterval = 5 * time.Second
	trafficHistory  = time.Hour
)

type wanCounters struct {
	interfaceName string
	receiveBytes  uint64
	sendBytes     uint64
	linkMbit      uint64
}

type trafficSample struct {
	At          time.Time `json:"at"`
	ReceiveMbit float64   `json:"receiveMbit"`
	SendMbit    float64   `json:"sendMbit"`
}

type trafficSnapshot struct {
	Interface string          `json:"interface,omitempty"`
	StartedAt *time.Time      `json:"startedAt,omitempty"`
	LinkMbit  uint64          `json:"linkMbit,omitempty"`
	Samples   []trafficSample `json:"samples"`
}

type trafficMonitor struct {
	mu       sync.Mutex
	previous wanCounters
	last     time.Time
	snapshot trafficSnapshot
}

func (monitor *trafficMonitor) record(now time.Time, next wanCounters, available bool) {
	monitor.mu.Lock()
	defer monitor.mu.Unlock()

	if !available {
		monitor.last = time.Time{}
		monitor.snapshot = trafficSnapshot{}
		return
	}
	previous := monitor.previous
	if monitor.last.IsZero() || next.interfaceName != previous.interfaceName ||
		next.receiveBytes < previous.receiveBytes || next.sendBytes < previous.sendBytes {
		monitor.snapshot = trafficSnapshot{Interface: next.interfaceName, StartedAt: &now}
	} else if seconds := now.Sub(monitor.last).Seconds(); seconds > 0 {
		const megabit = 1_000_000
		monitor.snapshot.Samples = append(monitor.snapshot.Samples, trafficSample{
			At:          now,
			ReceiveMbit: float64(next.receiveBytes-previous.receiveBytes) * 8 / (seconds * megabit),
			SendMbit:    float64(next.sendBytes-previous.sendBytes) * 8 / (seconds * megabit),
		})
		cutoff := now.Add(-trafficHistory)
		for len(monitor.snapshot.Samples) > 0 && monitor.snapshot.Samples[0].At.Before(cutoff) {
			monitor.snapshot.Samples = monitor.snapshot.Samples[1:]
		}
	}
	monitor.snapshot.LinkMbit = next.linkMbit
	monitor.previous, monitor.last = next, now
}

func (monitor *trafficMonitor) serveHTTP(response http.ResponseWriter, _ *http.Request) {
	monitor.mu.Lock()
	snapshot := monitor.snapshot
	snapshot.Samples = append(make([]trafficSample, 0, len(snapshot.Samples)), snapshot.Samples...)
	monitor.mu.Unlock()
	sendJSON(response, http.StatusOK, snapshot)
}

func (monitor *trafficMonitor) run(ctx context.Context) {
	ticker := time.NewTicker(trafficInterval)
	defer ticker.Stop()
	for {
		counters, available := readWANCounters()
		monitor.record(time.Now(), counters, available)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func defaultWAN(reader io.Reader) string {
	var selected string
	var metric uint64
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 8 || fields[1] != "00000000" || fields[7] != "00000000" ||
			!interfaceName(fields[0]) || fields[0] == "lo" {
			continue
		}
		flags, flagErr := strconv.ParseUint(fields[3], 16, 16)
		priority, metricErr := strconv.ParseUint(fields[6], 10, 32)
		if flagErr == nil && metricErr == nil && flags&0x201 == 1 && (selected == "" || priority < metric) {
			selected, metric = fields[0], priority
		}
	}
	return selected
}

func interfaceCounters(reader io.Reader, name string) (wanCounters, bool) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		iface, values, present := strings.Cut(scanner.Text(), ":")
		if !present || strings.TrimSpace(iface) != name {
			continue
		}
		fields := strings.Fields(values)
		if len(fields) < 16 {
			return wanCounters{}, false
		}
		receive, receiveErr := strconv.ParseUint(fields[0], 10, 64)
		send, sendErr := strconv.ParseUint(fields[8], 10, 64)
		return wanCounters{interfaceName: name, receiveBytes: receive, sendBytes: send}, receiveErr == nil && sendErr == nil
	}
	return wanCounters{}, false
}

func readWANCounters() (wanCounters, bool) {
	routes, err := os.Open("/proc/net/route")
	if err != nil {
		return wanCounters{}, false
	}
	defer routes.Close()
	iface := defaultWAN(routes)
	if iface == "" {
		return wanCounters{}, false
	}
	devices, err := os.Open("/proc/net/dev")
	if err != nil {
		return wanCounters{}, false
	}
	defer devices.Close()
	counters, found := interfaceCounters(devices, iface)
	if found {
		speed, err := os.ReadFile(filepath.Join("/sys/class/net", iface, "speed"))
		if err == nil {
			counters.linkMbit, _ = strconv.ParseUint(strings.TrimSpace(string(speed)), 10, 32)
		}
	}
	return counters, found
}
