package devicepolicy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Neighbor describes one IPv4/MAC pair. Fixed records come from KeeneticOS's
// permanent DHCP configuration. A client-list or ARP match alone is observational.
type Neighbor struct {
	MAC     string `json:"mac"`
	Address string `json:"address"`
	Label   string `json:"label"`
	Fixed   bool   `json:"fixed"`
}

const (
	hotspotCommand     = `show ip hotspot`
	reservationCommand = `show running-config | grep "^ip dhcp host "`
	bindingsCommand    = `show ip dhcp bindings`
	arpPath            = "/proc/net/arp"
	inventoryLimit     = 2 << 20
)

// ReadKeeneticInventory uses local read-only NDM queries and the kernel ARP
// table. The reservation filter executes inside KeeneticOS. On partial failure,
// available observations still identify conflicts without certifying an address.
func ReadKeeneticInventory(ctx context.Context) ([]Neighbor, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return readKeeneticInventory(ctx, readNDM, os.ReadFile)
}

func readKeeneticInventory(ctx context.Context, command func(context.Context, string) ([]byte, error), readFile func(string) ([]byte, error)) ([]Neighbor, error) {
	reservations, reservationErr := command(ctx, reservationCommand)
	hosts, hostErr := command(ctx, hotspotCommand)
	bindings, bindingErr := command(ctx, bindingsCommand)
	arp, arpErr := readFile(arpPath)
	result := make([]Neighbor, 0)
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if hostErr != nil && bindingErr != nil && arpErr != nil {
		return result, errors.New("инвентарь клиентов Keenetic недоступен")
	}
	var observed, fixed, leased, neighbors []Neighbor
	if hostErr == nil {
		observed = parseNDMClients(hosts, "host")
	}
	if reservationErr == nil {
		fixed = parseReservations(reservations)
	}
	if bindingErr == nil {
		leased = confirmedLeases(fixed, parseNDMClients(bindings, "lease"))
	}
	if arpErr == nil {
		neighbors = parseARP(arp)
	}
	return mergeNeighbors(leased, observed, neighbors), nil
}

func readNDM(ctx context.Context, query string) ([]byte, error) {
	command := exec.CommandContext(ctx, "/bin/ndmc", "-c", query)
	command.Env = []string{"PATH=/bin:/sbin:/usr/bin:/usr/sbin", "LC_ALL=C"}
	output := new(inventoryOutput)
	command.Stdout = output
	if err := command.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

type inventoryOutput struct{ bytes.Buffer }

func (output *inventoryOutput) Write(chunk []byte) (int, error) {
	if len(chunk) > inventoryLimit-output.Len() {
		return 0, io.ErrShortWrite
	}
	return output.Buffer.Write(chunk)
}

func parseNDMClients(raw []byte, group string) []Neighbor {
	var rows []Neighbor
	var host Neighbor
	var name, hostname, expires string
	var fieldColumn int
	flush := func() {
		if row, ok := normalizeNeighbor(host); ok {
			row.Fixed = group == "lease" && expires == "infinity"
			row.Label = cleanLabel(name)
			if row.Label == "" {
				row.Label = cleanLabel(hostname)
			}
			rows = append(rows, row)
		}
		host, name, hostname, expires = Neighbor{}, "", "", ""
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := scanner.Text()
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		column := len(key)
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if key == group && value == "" {
			flush()
			fieldColumn = column + 4
			continue
		}
		if fieldColumn == 0 || column != fieldColumn {
			continue
		}
		switch key {
		case "mac":
			host.MAC = value
		case "ip":
			host.Address = value
		case "name":
			name = value
		case "hostname":
			hostname = value
		case "expires":
			expires = value
		}
	}
	flush()
	return rows
}

func parseReservations(raw []byte) []Neighbor {
	var rows []Neighbor
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		columns := strings.Fields(scanner.Text())
		if len(columns) != 5 || columns[0] != "ip" || columns[1] != "dhcp" || columns[2] != "host" {
			continue
		}
		row, ok := normalizeNeighbor(Neighbor{MAC: columns[3], Address: columns[4]})
		if ok {
			rows = append(rows, row)
		}
	}
	return rows
}

func confirmedLeases(reservations, leases []Neighbor) []Neighbor {
	configured := make(map[[2]string]bool)
	for _, row := range reservations {
		configured[[2]string{row.MAC, row.Address}] = true
	}
	for i, row := range leases {
		leases[i].Fixed = row.Fixed && configured[[2]string{row.MAC, row.Address}]
	}
	return leases
}

func parseARP(raw []byte) []Neighbor {
	var rows []Neighbor
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		columns := strings.Fields(scanner.Text())
		if len(columns) != 6 || columns[1] != "0x1" {
			continue
		}
		flags, err := strconv.ParseUint(columns[2], 0, 8)
		if err != nil || flags&0x02 == 0 {
			continue
		}
		row, ok := normalizeNeighbor(Neighbor{MAC: columns[3], Address: columns[0]})
		if ok {
			rows = append(rows, row)
		}
	}
	return rows
}

func normalizeNeighbor(row Neighbor) (Neighbor, bool) {
	mac, macErr := NormalizeMAC(row.MAC)
	address, addrErr := parseClientIP(row.Address)
	if macErr != nil || addrErr != nil {
		return Neighbor{}, false
	}
	row.MAC, row.Address = mac, address.String()
	return row, true
}

func cleanLabel(label string) string {
	label = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, label)
	runes := []rune(strings.TrimSpace(label))
	if len(runes) > 128 {
		runes = runes[:128]
	}
	return string(runes)
}

func mergeNeighbors(lists ...[]Neighbor) []Neighbor {
	type pair struct{ mac, address string }
	unique := make(map[pair]Neighbor)
	labels := make(map[string]string)
	for _, rows := range lists {
		for _, row := range rows {
			key := pair{row.MAC, row.Address}
			previous := unique[key]
			row.Fixed = row.Fixed || previous.Fixed
			if row.Label == "" {
				row.Label = previous.Label
			}
			if row.Label != "" {
				labels[row.MAC] = row.Label
			}
			unique[key] = row
		}
	}
	rows := make([]Neighbor, 0, len(unique))
	for _, row := range unique {
		if row.Label == "" {
			row.Label = labels[row.MAC]
		}
		rows = append(rows, row)
	}
	slices.SortFunc(rows, func(a, b Neighbor) int {
		if cmp := strings.Compare(a.MAC, b.MAC); cmp != 0 {
			return cmp
		}
		return strings.Compare(a.Address, b.Address)
	})
	return rows
}
