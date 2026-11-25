package devicepolicy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"testing"
)

func line(column int, key, value string) string {
	return fmt.Sprintf("%*s: %s\r\n", column, key, value)
}

func TestReadKeeneticInventory(t *testing.T) {
	output := map[string][]byte{
		hotspotCommand: []byte(line(17, "host", "") +
			line(21, "mac", "02:00:00:00:00:AA") + line(21, "ip", "192.168.10.20") +
			line(21, "name", " Ноутбук ") + line(25, "name", "Home") +
			line(17, "host", "") + line(21, "mac", "02:00:00:00:00:bb") +
			line(21, "ip", "192.168.10.21") + line(21, "hostname", "phone\x07") +
			line(21, "registered", "yes") + line(25, "static", "yes") +
			line(17, "host", "") + line(21, "mac", "ff:ff:ff:ff:ff:ff") + line(21, "ip", "0.0.0.0")),
		reservationCommand: []byte(`configuration:
ip dhcp host 02-00-00-00-00-AA 192.168.10.20
ip dhcp host 02:00:00:00:00:cc 192.168.10.22
ip dhcp host 02:00:00:00:00:dd 192.168.10.23
ip dhcp host 02:00:00:00:00:ee 192.168.10.26
ip dhcp host 02:00:00:00:00:dd 192.168.10.24 extra
not-a-dhcp-record 02:00:00:00:00:ee 192.168.10.24
!`),
		bindingsCommand: []byte(line(17, "lease", "") + line(21, "mac", "02:00:00:00:00:aa") +
			line(21, "ip", "192.168.10.20") + line(21, "expires", "infinity") +
			line(17, "lease", "") + line(21, "mac", "02:00:00:00:00:cc") +
			line(21, "ip", "192.168.10.22") + line(21, "expires", "infinity") +
			line(17, "lease", "") + line(21, "mac", "02:00:00:00:00:dd") +
			line(21, "ip", "192.168.10.23") + line(21, "expires", "2400") +
			line(17, "lease", "") + line(21, "mac", "02:00:00:00:00:ee") +
			line(21, "ip", "192.168.10.27") + line(21, "expires", "infinity")),
	}
	command := func(_ context.Context, query string) ([]byte, error) {
		result, ok := output[query]
		if !ok {
			t.Fatalf("unexpected command %q", query)
		}
		return result, nil
	}
	arp := func(path string) ([]byte, error) {
		if path != arpPath {
			t.Fatalf("unexpected file %q", path)
		}
		return []byte(`IP address       HW type     Flags       HW address            Mask     Device
192.168.10.20    0x1         0x2         02:00:00:00:00:bb     *        br0
192.168.10.21    0x1         0x2         02:00:00:00:00:bb     *        br0
192.168.10.25    0x1         0x6         02:00:00:00:00:ff     *        br0
192.168.10.30    0x1         0x0         02:00:00:00:00:ee     *        br0
`), nil
	}
	got, err := readKeeneticInventory(context.Background(), command, arp)
	want := []Neighbor{
		{MAC: "02:00:00:00:00:aa", Address: "192.168.10.20", Label: "Ноутбук", Fixed: true},
		{MAC: "02:00:00:00:00:bb", Address: "192.168.10.20", Label: "phone"},
		{MAC: "02:00:00:00:00:bb", Address: "192.168.10.21", Label: "phone"},
		{MAC: "02:00:00:00:00:cc", Address: "192.168.10.22", Fixed: true},
		{MAC: "02:00:00:00:00:dd", Address: "192.168.10.23"},
		{MAC: "02:00:00:00:00:ee", Address: "192.168.10.27"},
		{MAC: "02:00:00:00:00:ff", Address: "192.168.10.25"},
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("read inventory: %+v (%v), want %+v", got, err, want)
	}
}

func TestKeeneticInventoryFallback(t *testing.T) {
	fail := errors.New("unavailable")
	command := func(_ context.Context, _ string) ([]byte, error) { return nil, fail }
	readARP := func(_ string) ([]byte, error) {
		return []byte("192.168.10.20 0x1 0x6 02:00:00:00:00:aa * br0\n"), nil
	}
	got, err := readKeeneticInventory(context.Background(), command, readARP)
	if err != nil || len(got) != 1 || got[0].Fixed {
		t.Fatalf("ARP-only fallback got %+v (%v)", got, err)
	}
	got, err = readKeeneticInventory(context.Background(), command, func(string) ([]byte, error) { return nil, fail })
	if err == nil || got == nil || len(got) != 0 {
		t.Fatalf("unavailable inventory returned %+v (%v)", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err = readKeeneticInventory(ctx, command, readARP)
	if !errors.Is(err, context.Canceled) || got == nil || len(got) != 0 {
		t.Fatalf("canceled inventory returned %+v (%v)", got, err)
	}
}

func TestNativeOutputLimit(t *testing.T) {
	var output inventoryOutput
	if _, err := output.Write(make([]byte, inventoryLimit+1)); !errors.Is(err, io.ErrShortWrite) || output.Len() != 0 {
		t.Fatalf("unexpected over-limit output result: %v, %d bytes", err, output.Len())
	}
}
