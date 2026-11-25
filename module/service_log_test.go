package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServiceLogRotatesWithinLimit(t *testing.T) {
	journal := &serviceLog{
		path: filepath.Join(t.TempDir(), "routehub.log"),
		disk: func(string) *resourceCapacity { return &resourceCapacity{Available: 30 << 20} },
	}
	if err := os.WriteFile(journal.path, []byte(strings.Repeat(" ", serviceLogFileBytes)+"last legacy line\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := journal.appendLine("startup"); err != nil {
		t.Fatal(err)
	}
	previous, err := os.ReadFile(journal.file(1))
	if err != nil || len(previous) != serviceLogFileBytes || !bytes.HasSuffix(previous, []byte("last legacy line\n")) {
		t.Fatalf("did not trim legacy log to its most recent bytes: %d, %v", len(previous), err)
	}
	for _, c := range []string{"a", "b", "c", "d"} {
		if err := journal.appendLine(strings.Repeat(c, serviceLogFileBytes)); err != nil {
			t.Fatal(err)
		}
	}
	for index, expected := range []byte{'d', 'c', 'b'} {
		info, err := os.Stat(journal.file(index))
		if err != nil || info.Size() != serviceLogFileBytes || info.Mode().Perm() != 0600 {
			t.Fatalf("unexpected file %d: %v, %v", index, info, err)
		}
		data, err := os.ReadFile(journal.file(index))
		if err != nil || data[0] != expected {
			t.Fatalf("incorrect rotation order for file %d: %v", index, err)
		}
	}
	if state := journal.status(); state.State != "active" || state.Bytes != serviceLogFiles*serviceLogFileBytes || state.Files != serviceLogFiles {
		t.Fatalf("incorrect storage accounting: %+v", state)
	}
}

func TestServiceLogReservesSpaceAndResumes(t *testing.T) {
	available := uint64(serviceLogReserve - 1)
	journal := &serviceLog{
		path: filepath.Join(t.TempDir(), "routehub.log"),
		disk: func(string) *resourceCapacity { return &resourceCapacity{Available: available} },
	}
	if err := journal.appendLine("skip this"); err != nil {
		t.Fatal(err)
	}
	if state := journal.status(); state.State != "paused" || state.Files != 0 {
		t.Fatalf("wrote into low-space filesystem: %+v", state)
	}
	available += 4096
	if err := journal.appendLine("record this"); err != nil {
		t.Fatal(err)
	}
	record, err := os.ReadFile(journal.path)
	if err != nil || !bytes.HasSuffix(record, []byte("record this\n")) {
		t.Fatalf("logging did not resume: %v", err)
	}
}
