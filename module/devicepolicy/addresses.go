package devicepolicy

import (
	"encoding/binary"
	"fmt"
	"net"
	"net/netip"
	"strings"

	"golang.org/x/net/idna"
)

// NormalizeMAC accepts the ordinary six-byte spellings of a unicast MAC.
func NormalizeMAC(value string) (string, error) {
	mac, err := net.ParseMAC(strings.TrimSpace(value))
	if err != nil || len(mac) != 6 || mac[0]&1 != 0 || mac.String() == "00:00:00:00:00:00" {
		return "", fmt.Errorf("некорректный MAC устройства %q", value)
	}
	return mac.String(), nil
}

func parseClientIP(value string) (netip.Addr, error) {
	address, err := netip.ParseAddr(value)
	if err != nil || !address.Is4() || !address.IsGlobalUnicast() {
		return netip.Addr{}, fmt.Errorf("некорректный IPv4-адрес устройства %q", value)
	}
	return address, nil
}

func lanHost(network netip.Prefix, address netip.Addr) bool {
	if !network.Contains(address) {
		return false
	}
	if network.Bits() >= 31 {
		return true
	}
	bytes := address.As4()
	hostMask := uint32(uint64(1)<<(32-network.Bits()) - 1)
	host := binary.BigEndian.Uint32(bytes[:]) & hostMask
	return host != 0 && host != hostMask
}

func inventoryOwners(bindings []Binding) (map[netip.Addr]map[string]bool, error) {
	if bindings == nil {
		return nil, nil
	}
	owners := make(map[netip.Addr]map[string]bool)
	for _, binding := range bindings {
		mac, err := NormalizeMAC(binding.MAC)
		if err != nil {
			return nil, fmt.Errorf("инвентарь: %w", err)
		}
		address, err := parseClientIP(binding.Address)
		if err != nil {
			return nil, fmt.Errorf("инвентарь: %w", err)
		}
		if owners[address] == nil {
			owners[address] = make(map[string]bool)
		}
		owners[address][mac] = owners[address][mac] || binding.Fixed
	}
	return owners, nil
}

func hasAllBindings(inventory map[netip.Addr]map[string]bool, mac string, addresses []netip.Addr) bool {
	for _, address := range addresses {
		owners := inventory[address]
		if len(owners) != 1 || !owners[mac] {
			return false
		}
	}
	return true
}

func normalizeHost(host string) string {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if strings.Contains(host, "_") {
		labels := strings.Split(host, ".")
		for index, label := range labels {
			value := strings.TrimPrefix(label, "_")
			if ascii, err := idna.Lookup.ToASCII(value); err == nil {
				labels[index] = label[:len(label)-len(value)] + ascii
			}
		}
		return strings.Join(labels, ".")
	}
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		return ascii
	}
	return host
}

// NormalizeRoutingDomain accepts DNS owner names for routing matches, including
// RFC 8552 service labels such as _domainkey. Connection endpoint validation is separate.
func NormalizeRoutingDomain(host string) (string, bool) {
	host = normalizeHost(host)
	if address, _ := netip.ParseAddr(host); address.IsValid() {
		return host, false
	}
	return host, validRoutingDomain(host)
}

func validRoutingDomain(host string) bool {
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	labels := strings.Split(host, ".")
	for index, label := range labels {
		if len(label) > 63 {
			return false
		}
		if index < len(labels)-1 {
			label = strings.TrimPrefix(label, "_")
		}
		if len(label) == 0 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-') {
				return false
			}
		}
	}
	return true
}

func validNetwork(network string) bool {
	return network == "tcp" || network == "udp"
}
