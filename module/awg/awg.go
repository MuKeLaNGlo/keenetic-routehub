// Package awg routes Xray connections through an existing WireGuard ASC interface.
package awg

import (
	"errors"
	"fmt"
	"net"
	"runtime"
	"strings"
)

// BuildOutbound describes an Xray Freedom outbound bound to the Linux netdev name.
// It does not create an interface or modify routing.
func BuildOutbound(tag, interfaceName string) (map[string]any, error) {
	if strings.TrimSpace(tag) == "" || strings.TrimSpace(tag) != tag {
		return nil, errors.New("an AmneziaWG outbound requires a tag without surrounding whitespace")
	}
	if err := validateInterface(interfaceName); err != nil {
		return nil, err
	}
	return map[string]any{
		"tag":      tag,
		"protocol": "freedom",
		"settings": map[string]any{},
		"streamSettings": map[string]any{
			"sockopt": map[string]any{"interface": interfaceName},
		},
	}, nil
}

// CheckInterface checks that the configured netdev exists and is up before activation.
// The caller still needs to verify its tunnel handshake and usable routes.
func CheckInterface(interfaceName string) error {
	if err := validateInterface(interfaceName); err != nil {
		return err
	}
	if runtime.GOOS != "linux" {
		return errors.New("AmneziaWG interface activation requires Linux")
	}
	device, err := net.InterfaceByName(interfaceName)
	if err != nil {
		return fmt.Errorf("AmneziaWG interface %q: %w", interfaceName, err)
	}
	if device.Flags&net.FlagUp == 0 || device.Flags&net.FlagLoopback != 0 {
		return fmt.Errorf("AmneziaWG interface %q must be up and non-loopback", interfaceName)
	}
	return nil
}

func validateInterface(name string) error {
	if name == "" || len(name) > 15 || name == "lo" || name == "." || name == ".." {
		return fmt.Errorf("invalid AmneziaWG interface name %q", name)
	}
	for _, char := range name {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.') {
			return fmt.Errorf("invalid AmneziaWG interface name %q", name)
		}
	}
	return nil
}
