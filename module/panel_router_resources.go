package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	resourceInterval = 2 * time.Second
	resourceWindow   = time.Minute
)

type resourceCapacity struct {
	Used      uint64 `json:"used"`
	Total     uint64 `json:"total"`
	Available uint64 `json:"available"`
}

type routerResourceSample struct {
	At  time.Time `json:"at"`
	CPU *float64  `json:"cpu"`
	RAM *float64  `json:"ram"`
}

type routerResourceSnapshot struct {
	At          time.Time              `json:"at"`
	WindowSec   int                    `json:"windowSec"`
	IntervalSec int                    `json:"intervalSec"`
	CPU         *float64               `json:"cpu"`
	RAM         *resourceCapacity      `json:"ram"`
	SharedRAM   *uint64                `json:"sharedRam,omitempty"`
	Disk        *resourceCapacity      `json:"disk"`
	RouteHubRSS *uint64                `json:"routeHubRss"`
	XrayRSS     *uint64                `json:"xrayRss"`
	Samples     []routerResourceSample `json:"samples"`
}

type cpuTotals struct{ busy, idle uint64 }

type routerResourceMonitor struct {
	diskPath string
	xrayPID  atomic.Int64
	mu       sync.Mutex
	snapshot routerResourceSnapshot
}

func (monitor *routerResourceMonitor) setEngine(instance *engine) {
	var pid int64
	if instance != nil {
		pid = int64(instance.process.Process.Pid)
	}
	monitor.xrayPID.Store(pid)
}

func readProcKiB(data, name string) (uint64, bool) {
	for line := range strings.SplitSeq(data, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok || key != name {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) == 2 && fields[1] == "kB" {
			amount, err := strconv.ParseUint(fields[0], 10, 64)
			return amount, err == nil && amount <= (^uint64(0)>>10)
		}
		break
	}
	return 0, false
}

func routerCPU(data string) (cpuTotals, bool) {
	line, _, _ := strings.Cut(data, "\n")
	fields := strings.Fields(line)
	if len(fields) < 9 || fields[0] != "cpu" {
		return cpuTotals{}, false
	}
	var result cpuTotals
	// Linux reports guest time inside user and nice. Count only the first eight fields.
	for i, field := range fields[1:9] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuTotals{}, false
		}
		if i == 3 || i == 4 {
			result.idle += value
		} else {
			result.busy += value
		}
	}
	return result, true
}

func routerCPUPercent(before, after cpuTotals) *float64 {
	if after.busy < before.busy || after.idle < before.idle {
		return nil
	}
	busy := float64(after.busy - before.busy)
	total := busy + float64(after.idle-before.idle)
	if total == 0 {
		return nil
	}
	percent := busy / total * 100
	return &percent
}

func routerRAM() (*resourceCapacity, *uint64) {
	data, _ := os.ReadFile("/proc/meminfo")
	info := string(data)
	total, totalOK := readProcKiB(info, "MemTotal")
	available, availableOK := readProcKiB(info, "MemAvailable")
	if !totalOK || !availableOK || total == 0 || available > total {
		return nil, nil
	}
	ram := &resourceCapacity{Used: (total - available) << 10, Total: total << 10, Available: available << 10}
	if amount, ok := readProcKiB(info, "Shmem"); ok {
		shared := amount << 10
		return ram, &shared
	}
	return ram, nil
}

func routerDisk(dir string) *resourceCapacity {
	var stat syscall.Statfs_t
	if syscall.Statfs(dir, &stat) != nil || stat.Bsize <= 0 || stat.Blocks == 0 || stat.Bfree > stat.Blocks || stat.Bavail > stat.Bfree {
		return nil
	}
	block := uint64(stat.Bsize)
	return &resourceCapacity{Used: (stat.Blocks - stat.Bfree) * block, Total: stat.Blocks * block, Available: stat.Bavail * block}
}

func processResidentMemory(id string) *uint64 {
	data, _ := os.ReadFile(filepath.Join("/proc", id, "status"))
	amount, ok := readProcKiB(string(data), "VmRSS")
	if !ok {
		return nil
	}
	bytes := amount << 10
	return &bytes
}

func (monitor *routerResourceMonitor) run(ctx context.Context) {
	ticker := time.NewTicker(resourceInterval)
	defer ticker.Stop()
	var previous cpuTotals
	var previousOK bool
	var history []routerResourceSample
	for {
		now := time.Now()
		data, _ := os.ReadFile("/proc/stat")
		next, ok := routerCPU(string(data))
		ram, shared := routerRAM()
		snapshot := routerResourceSnapshot{At: now, WindowSec: int(resourceWindow / time.Second), IntervalSec: int(resourceInterval / time.Second),
			RAM: ram, SharedRAM: shared, Disk: routerDisk(monitor.diskPath), RouteHubRSS: processResidentMemory("self")}
		if previousOK && ok {
			snapshot.CPU = routerCPUPercent(previous, next)
		}
		previous, previousOK = next, ok
		if pid := monitor.xrayPID.Load(); pid > 0 {
			rss := processResidentMemory(strconv.FormatInt(pid, 10))
			if monitor.xrayPID.Load() == pid {
				snapshot.XrayRSS = rss
			}
		}
		sample := routerResourceSample{At: now, CPU: snapshot.CPU}
		if snapshot.RAM != nil {
			percent := float64(snapshot.RAM.Used) / float64(snapshot.RAM.Total) * 100
			sample.RAM = &percent
		}
		for len(history) > 0 && now.Sub(history[0].At) > resourceWindow {
			history = history[1:]
		}
		history = append(history, sample)
		snapshot.Samples = slices.Clone(history)
		monitor.mu.Lock()
		monitor.snapshot = snapshot
		monitor.mu.Unlock()

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (monitor *routerResourceMonitor) serveHTTP(w http.ResponseWriter, _ *http.Request) {
	monitor.mu.Lock()
	snapshot := monitor.snapshot
	monitor.mu.Unlock()
	if snapshot.At.IsZero() {
		sendJSON(w, http.StatusServiceUnavailable, object{"error": "Первый замер ещё готовится"})
		return
	}
	sendJSON(w, http.StatusOK, snapshot)
}
