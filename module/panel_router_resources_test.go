package main

import "testing"

func TestRouterCPUAggregateExcludesIdleAndGuest(t *testing.T) {
	before, ok := routerCPU("cpu 20 10 5 45 15 2 2 1 10 5\ncpu0 0 0 0 0 0 0 0 0\n")
	if !ok || before.busy != 40 || before.idle != 60 {
		t.Fatalf("unexpected CPU totals: %+v", before)
	}
	after, ok := routerCPU("cpu 23 11 9 72 20 2 2 1 12 6\n")
	value := routerCPUPercent(before, after)
	if !ok || value == nil || *value != 20 {
		t.Fatalf("expected 20 percent, got %v", value)
	}
	if routerCPUPercent(after, before) != nil || routerCPUPercent(before, before) != nil {
		t.Fatal("unknown or reset counters must not become a zero-load sample")
	}
}

func TestProcKiBPreservesZeroAndRejectsMissingMetrics(t *testing.T) {
	if value, ok := readProcKiB("VmSize: 500 kB\nVmRSS: 0 kB\n", "VmRSS"); !ok || value != 0 {
		t.Fatal("zero resident memory is a valid sample")
	}
	if _, ok := readProcKiB("VmRSS: 64\n", "VmRSS"); ok {
		t.Fatal("unexpected units must not be treated as KiB")
	}
}
