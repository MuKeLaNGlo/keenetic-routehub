package awg

import (
	"encoding/json"
	"testing"
)

func TestBuildOutbound(t *testing.T) {
	outbound, err := BuildOutbound("home-wg", "wg-test.0")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(outbound)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"protocol":"freedom","settings":{},"streamSettings":{"sockopt":{"interface":"wg-test.0"}},"tag":"home-wg"}`
	if string(encoded) != want {
		t.Fatalf("outbound %s, want %s", encoded, want)
	}
}

func TestInvalidInterfaceNames(t *testing.T) {
	for _, name := range []string{"", "lo", ".", "..", "wg 0", "wg0@eth0", "wg;reboot", "тест", "0123456789abcdef"} {
		t.Run(name, func(t *testing.T) {
			if _, err := BuildOutbound("test", name); err == nil {
				t.Fatalf("accepted invalid name %q", name)
			}
		})
	}
}

func TestEmptyTagAndMissingInterface(t *testing.T) {
	if _, err := BuildOutbound(" ", "wg0"); err == nil {
		t.Error("accepted an empty tag")
	}
	if err := CheckInterface("rh-awg-missing"); err == nil {
		t.Error("accepted a nonexistent interface")
	}
}
