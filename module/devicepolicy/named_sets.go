package devicepolicy

import (
	"fmt"
	"net/netip"
	"regexp"
	"strings"
	"unicode/utf8"
)

// NamedSet is a reusable manual list. A domain entry matches the domain and its
// subdomains. A CIDR entry may be a subnet or an individual IP address.
type NamedSet struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Kind    string   `json:"kind"`
	Entries []string `json:"entries"`
}

type compiledNamedSet struct {
	domains  *DomainSet
	prefixes []netip.Prefix
}

var namedSetID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func compileNamedSets(sets []NamedSet) (map[string]compiledNamedSet, error) {
	compiled := make(map[string]compiledNamedSet, len(sets))
	for _, set := range sets {
		if _, exists := compiled[set.ID]; exists || !namedSetID.MatchString(set.ID) {
			return nil, fmt.Errorf("некорректный или повторяющийся идентификатор набора %q", set.ID)
		}
		if name := strings.TrimSpace(set.Name); name == "" || utf8.RuneCountInString(name) > 128 || strings.ContainsAny(name, "\r\n\x00") {
			return nil, fmt.Errorf("имя набора %q должно содержать от 1 до 128 символов", set.ID)
		}
		var entry compiledNamedSet
		switch set.Kind {
		case "domains":
			entry.domains = &DomainSet{}
		case "cidrs":
		default:
			return nil, fmt.Errorf("неизвестный тип набора %q", set.Name)
		}
		for number, value := range set.Entries {
			if entry.domains != nil {
				if err := entry.domains.Add(value, "suffix"); err != nil {
					return nil, fmt.Errorf("набор %q, запись %d: %w", set.Name, number+1, err)
				}
			} else {
				prefix, err := namedSetPrefix(value)
				if err != nil {
					return nil, fmt.Errorf("набор %q, запись %d: %w", set.Name, number+1, err)
				}
				entry.prefixes = append(entry.prefixes, prefix)
			}
		}
		compiled[set.ID] = entry
	}
	return compiled, nil
}

func namedSetPrefix(value string) (netip.Prefix, error) {
	value = strings.TrimSpace(value)
	if address, err := netip.ParseAddr(value); err == nil && address.Zone() == "" && !address.Is4In6() {
		return netip.PrefixFrom(address, address.BitLen()), nil
	}
	if prefix, err := netip.ParsePrefix(value); err == nil && prefix == prefix.Masked() && !prefix.Addr().Is4In6() {
		return prefix, nil
	}
	return netip.Prefix{}, fmt.Errorf("укажите IP-адрес или адрес сети с длиной префикса (например, 192.0.2.0/24)")
}
