package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
)

func TestCoreEngineProcess(t *testing.T) {
	mode := os.Getenv("ROUTEHUB_TEST_CORE_MODE")
	if mode == "" {
		return
	}
	if slices.Contains(os.Args, "-test") {
		return
	}
	if mode == "fail-start" {
		os.Exit(2)
	}
	socket, err := net.Listen("tcp4", os.Getenv("ROUTEHUB_TEST_CORE_ADDR"))
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	for {
		connection, err := socket.Accept()
		if err != nil {
			t.Fatal(err)
		}
		var handshake [3]byte
		if _, err := io.ReadFull(connection, handshake[:]); err == nil {
			_, _ = connection.Write([]byte{5, 0})
		}
		connection.Close()
	}
}

func TestXrayCoreSwitchRestoresRunningEngineOnFailure(t *testing.T) {
	for _, mode := range []string{"start", "fail-start"} {
		t.Run(mode, func(t *testing.T) {
			ctx := t.Context()
			dir := t.TempDir()
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			reservation, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			address := reservation.Addr().String()
			port := uint16(reservation.Addr().(*net.TCPAddr).Port)
			reservation.Close()
			mk := func(name, mode string) string {
				path := filepath.Join(dir, name)
				command := fmt.Sprintf("#!/bin/sh\nexport ROUTEHUB_TEST_CORE_MODE=%s ROUTEHUB_TEST_CORE_ADDR=%s\nexec %s -test.run '^TestCoreEngineProcess$' -- \"$@\"\n", mode, address, strconv.Quote(executable))
				if err := os.WriteFile(path, []byte(command), 0700); err != nil {
					t.Fatal(err)
				}
				return path
			}
			old := mk("old", "start")
			candidate := mk("candidate", mode)
			active := filepath.Join(dir, "xray")
			if err := os.Symlink(old, active); err != nil {
				t.Fatal(err)
			}
			pending, store := filepath.Join(dir, "pending"), filepath.Join(dir, "saved")
			for name, data := range map[string]string{pending: "candidate", store: "previous"} {
				if err := os.WriteFile(name, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			current, err := startCore(ctx, active, "fixture.json", address)
			if err != nil {
				t.Fatal(err)
			}
			defer current.stop()
			out, err := replaceXrayCore(ctx, options{xray: active}, current, "fixture.json", plan{SOCKSPort: port}, runtimeSelection{}, store, coreTransaction{candidate: coreCandidate{path: candidate}, pending: pending})
			if out == nil {
				t.Fatalf("lost live engine: %v", err)
			}
			defer out.stop()
			want := "candidate"
			if mode == "fail-start" {
				want = "previous"
				if !errors.Is(err, errCoreRolledBack) {
					t.Fatalf("wrong rollback result: %v", err)
				}
				if original, _ := os.Readlink(active); original != old {
					t.Fatal("failed switch lost old binary reference")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if persisted, _ := os.ReadFile(store); string(persisted) != want {
				t.Fatal("persisted core disagrees with runtime outcome")
			}
		})
	}
}
