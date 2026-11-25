package devicepolicy

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"net/netip"
	"strings"
	"time"
)

// KeeneticSegment identifies an actual local network reported by the firmware.
// Interface addresses permit matching a firmware ID to a kernel interface.
type KeeneticSegment struct {
	ID         string
	Name       string
	SystemName string
	Kind       string
	Address    netip.Addr
	Prefix     netip.Prefix
	State      string
	Security   string
}

func ReadKeeneticSegments(ctx context.Context) ([]KeeneticSegment, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	raw, err := readNDM(ctx, "show interface")
	if err != nil {
		return nil, err
	}
	return parseKeeneticSegments(raw), nil
}

func parseKeeneticSegments(raw []byte) []KeeneticSegment {
	var segments []KeeneticSegment
	var fields map[string]string
	flush := func() {
		if fields["id"] == "" {
			return
		}
		var kind string
		switch strings.ToLower(fields["type"]) {
		case "bridge":
			kind = "bridge"
		case "vlan", "gigabitethernetvlan", "fastethernetvlan":
			// A VLAN participating in an uplink is not a client segment.
			if fields["global"] == "no" && (fields["security-level"] == "private" || fields["security-level"] == "protected") {
				kind = "l3"
			}
		}
		if kind == "" {
			return
		}
		name := cleanLabel(fields["description"])
		if name == "" {
			name = cleanLabel(fields["interface-name"])
		}
		security := fields["security-level"]
		if security != "public" && security != "private" && security != "protected" {
			security = ""
		}
		state := "down"
		if fields["state"] == "up" && fields["link"] != "down" {
			state = "up"
		}
		address, _ := netip.ParseAddr(fields["address"])
		var prefix netip.Prefix
		if mask := net.ParseIP(fields["mask"]).To4(); address.Is4() && mask != nil {
			if bits, count := net.IPMask(mask).Size(); count == 32 && bits > 0 {
				prefix = netip.PrefixFrom(address, bits).Masked()
			}
		}
		segments = append(segments, KeeneticSegment{
			ID: cleanLabel(fields["id"]), Name: name, SystemName: fields["system-name"], Kind: kind,
			Address: address, Prefix: prefix, State: state, Security: security,
		})
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(strings.ToLower(line), "interface, name =") {
			flush()
			fields = make(map[string]string)
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok || fields == nil {
			continue
		}
		switch key {
		case "id", "type", "interface-name", "description", "system-name", "address", "mask", "state", "link", "security-level", "global":
			if _, exists := fields[key]; !exists {
				fields[key] = strings.TrimSpace(value)
			}
		}
	}
	flush()
	return segments
}
