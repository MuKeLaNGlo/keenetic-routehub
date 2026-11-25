package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"

	"routehub/devicepolicy"
)

const (
	observationInterval     = time.Second
	observationScanLimit    = 2 << 20
	observationTrackedLimit = 512
	observationRowLimit     = 80
)

type observationRow struct {
	ID            string         `json:"id"`
	DeviceID      string         `json:"deviceId,omitempty"`
	SourceAddress string         `json:"sourceAddress"`
	Destination   string         `json:"dst"`
	Protocol      string         `json:"proto"`
	Bytes         *uint64        `json:"bytes,omitempty"`
	New           bool           `json:"new,omitempty"`
	Redirected    bool           `json:"redirected,omitempty"`
	GameMatch     *gameFlowMatch `json:"gameMatch,omitempty"`
}

type connectionObservation struct {
	Rows       []observationRow `json:"rows"`
	Seconds    int              `json:"seconds"`
	FinishedAt time.Time        `json:"finishedAt"`
	Limited    bool             `json:"limited"`
}

type trackedConnectionKey struct {
	source, destination netip.AddrPort
	protocol, zone      string
}

type trackedConnection struct {
	key         trackedConnectionKey
	replySource netip.AddrPort
	bytes       *uint64
}

type connectionTuple struct {
	source, destination         netip.Addr
	sourcePort, destinationPort uint16
	bytes                       *uint64
}

func parseTrackedConnection(line string) (trackedConnection, bool) {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return trackedConnection{}, false
	}
	if fields[0] == "ipv4" && len(fields) > 2 {
		fields = fields[2:]
	}
	protocol := fields[0]
	if protocol != "tcp" && protocol != "udp" {
		return trackedConnection{}, false
	}
	var original, reply connectionTuple
	var tuple *connectionTuple
	var zone string
	for _, field := range fields[1:] {
		key, value, hasValue := strings.Cut(field, "=")
		if !hasValue {
			continue
		}
		switch key {
		case "src":
			switch tuple {
			case nil:
				tuple = &original
			case &original:
				tuple = &reply
			default:
				continue
			}
			tuple.source, _ = netip.ParseAddr(value)
		case "dst":
			if tuple != nil {
				tuple.destination, _ = netip.ParseAddr(value)
			}
		case "sport", "dport":
			if tuple == nil {
				continue
			}
			port, err := strconv.ParseUint(value, 10, 16)
			if err != nil || port == 0 {
				return trackedConnection{}, false
			}
			if key == "sport" {
				tuple.sourcePort = uint16(port)
			} else {
				tuple.destinationPort = uint16(port)
			}
		case "bytes":
			if tuple != nil {
				if n, err := strconv.ParseUint(value, 10, 64); err == nil {
					tuple.bytes = &n
				}
			}
		case "zone":
			zone = value
		}
	}
	if !original.source.Is4() || !original.destination.Is4() || original.sourcePort == 0 || original.destinationPort == 0 ||
		!reply.source.Is4() || reply.sourcePort == 0 {
		return trackedConnection{}, false
	}
	row := trackedConnection{
		key: trackedConnectionKey{
			source:      netip.AddrPortFrom(original.source, original.sourcePort),
			destination: netip.AddrPortFrom(original.destination, original.destinationPort),
			protocol:    protocol, zone: zone,
		},
		replySource: netip.AddrPortFrom(reply.source, reply.sourcePort),
	}
	if original.bytes != nil && reply.bytes != nil && math.MaxUint64-*original.bytes >= *reply.bytes {
		total := *original.bytes + *reply.bytes
		row.bytes = &total
	}
	return row, true
}

type trackedSnapshot struct {
	rows    map[trackedConnectionKey]trackedConnection
	limited bool
}

func readConnectionTable(ctx context.Context, reader io.Reader, source netip.Prefix, router netip.Addr) (trackedSnapshot, error) {
	snapshot := trackedSnapshot{rows: make(map[trackedConnectionKey]trackedConnection)}
	bounded := &io.LimitedReader{R: reader, N: observationScanLimit}
	scanner := bufio.NewScanner(bounded)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return trackedSnapshot{}, err
		}
		row, ok := parseTrackedConnection(scanner.Text())
		if !ok || !source.Contains(row.key.source.Addr()) || row.key.source.Addr() == router ||
			!row.key.destination.Addr().IsGlobalUnicast() {
			continue
		}
		if len(snapshot.rows) >= observationTrackedLimit {
			snapshot.limited = true
			break
		}
		snapshot.rows[row.key] = row
	}
	snapshot.limited = snapshot.limited || bounded.N == 0
	return snapshot, scanner.Err()
}

func conntrackFile() string {
	for _, path := range []string{"/proc/net/nf_conntrack", "/proc/net/ip_conntrack"} {
		if file, err := os.Open(path); err == nil {
			_ = file.Close()
			return path
		}
	}
	return ""
}

func readRouterConnections(ctx context.Context, source netip.Prefix, router netip.Addr) (trackedSnapshot, error) {
	if path := conntrackFile(); path != "" {
		if file, err := os.Open(path); err == nil {
			snapshot, err := readConnectionTable(ctx, file, source, router)
			_ = file.Close()
			if err == nil || ctx.Err() != nil {
				return snapshot, err
			}
		}
	}
	readContext, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(readContext, "conntrack", "-L", "-f", "ipv4", "--orig-src", source.String())
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return trackedSnapshot{}, err
	}
	if err = cmd.Start(); err != nil {
		return trackedSnapshot{}, err
	}
	snapshot, readErr := readConnectionTable(readContext, pipe, source, router)
	if snapshot.limited || readErr != nil {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if snapshot.limited && waitErr != nil {
		waitErr = nil
	}
	return snapshot, errors.Join(readErr, waitErr, readContext.Err())
}

func observationSource(state status, config plan) (netip.Prefix, bool) {
	if !state.LAN || config.Transparent == nil {
		return netip.Prefix{}, false
	}
	prefix, err := netip.ParsePrefix(config.Transparent.Source)
	return prefix.Masked(), err == nil && prefix.Addr().Is4()
}

func observationAvailable(state status, config plan) bool {
	if _, ok := observationSource(state, config); !ok {
		return false
	}
	if conntrackFile() != "" {
		return true
	}
	_, err := exec.LookPath("conntrack")
	return err == nil
}

func observedDeviceAliases(devices []panelTopologyDevice) map[netip.Addr]string {
	aliases := make(map[netip.Addr]string)
	for _, device := range devices {
		for _, address := range device.Addresses {
			ip, err := netip.ParseAddr(address.Address)
			if err != nil {
				continue
			}
			if current, ok := aliases[ip]; ok && current != device.ID {
				aliases[ip] = ""
			} else {
				aliases[ip] = device.ID
			}
		}
	}
	return aliases
}

func observedDeviceSource(lan netip.Prefix, router netip.Addr, aliases map[netip.Addr]string, mac string) (netip.Prefix, bool) {
	var found netip.Addr
	for address, owner := range aliases {
		if owner != mac || address == router || !lan.Contains(address) {
			continue
		}
		if found.IsValid() {
			return netip.Prefix{}, false
		}
		found = address
	}
	return netip.PrefixFrom(found, 32), found.IsValid()
}

type observedSample struct {
	lastBytes *uint64
	row       observationRow
}

type observationSamples struct {
	connections      map[trackedConnectionKey]observedSample
	limited          bool
	baselineComplete bool
}

func (samples *observationSamples) record(snapshot trackedSnapshot, baseline bool, listener netip.AddrPort, devices map[netip.Addr]string) {
	if baseline {
		samples.baselineComplete = !snapshot.limited
	}
	samples.limited = samples.limited || snapshot.limited
	for key, connection := range snapshot.rows {
		sample, seen := samples.connections[key]
		if !seen {
			if len(samples.connections) >= observationTrackedLimit {
				samples.limited = true
				continue
			}
			client := key.source.Addr()
			sample.row = observationRow{
				ID:       key.protocol + "/" + key.source.String() + "/" + key.destination.String() + "/" + key.zone,
				Protocol: key.protocol, SourceAddress: client.String(), Destination: key.destination.String(),
				DeviceID: devices[client], New: !baseline && samples.baselineComplete && !samples.limited,
				Redirected: listener.IsValid() && key.protocol == "tcp" && connection.replySource == listener && key.destination != listener,
			}
			if sample.row.New {
				sample.row.Bytes = connection.bytes
			} else if connection.bytes != nil {
				zero := uint64(0)
				sample.row.Bytes = &zero
			}
		} else if sample.row.Bytes != nil && sample.lastBytes != nil && connection.bytes != nil && *connection.bytes >= *sample.lastBytes {
			delta := *connection.bytes - *sample.lastBytes
			total := *sample.row.Bytes + delta
			sample.row.Bytes = &total
		}
		sample.lastBytes = connection.bytes
		samples.connections[key] = sample
	}
}

func observedBytes(row observationRow) uint64 {
	if row.Bytes == nil {
		return 0
	}
	return *row.Bytes
}

func (samples *observationSamples) result(seconds int) connectionObservation {
	rows := make([]observationRow, 0, len(samples.connections))
	for _, sample := range samples.connections {
		rows = append(rows, sample.row)
	}
	slices.SortFunc(rows, func(left, right observationRow) int {
		if lb, rb := observedBytes(left), observedBytes(right); lb != rb {
			if lb > rb {
				return -1
			}
			return 1
		}
		if left.New != right.New {
			if left.New {
				return -1
			}
			return 1
		}
		return strings.Compare(left.ID, right.ID)
	})
	limited := samples.limited || len(rows) > observationRowLimit
	return connectionObservation{Rows: rows[:min(len(rows), observationRowLimit)], Seconds: seconds, FinishedAt: time.Now().UTC(), Limited: limited}
}

type observationReader func(context.Context, netip.Prefix, netip.Addr) (trackedSnapshot, error)

func sampleConnections(ctx context.Context, seconds int, interval time.Duration, source netip.Prefix, router netip.Addr, listener netip.AddrPort, devices map[netip.Addr]string, read observationReader) (connectionObservation, error) {
	samples := observationSamples{connections: make(map[trackedConnectionKey]observedSample)}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for n := 0; n <= seconds; n++ {
		if n != 0 {
			select {
			case <-ctx.Done():
				return connectionObservation{}, ctx.Err()
			case <-ticker.C:
			}
		}
		snapshot, err := read(ctx, source, router)
		if err != nil {
			return connectionObservation{}, err
		}
		samples.record(snapshot, n == 0, listener, devices)
	}
	return samples.result(seconds), nil
}

func (diagnostics *panelDiagnostics) observeConnections(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Seconds  int    `json:"seconds"`
		DeviceID string `json:"deviceId,omitempty"`
	}
	if !runtimeRequest(response, request, diagnostics.editor, &input) {
		return
	}
	if input.Seconds < 1 || input.Seconds > 10 {
		sendJSON(response, http.StatusBadRequest, object{"error": "Длительность наблюдения должна быть от 1 до 10 секунд"})
		return
	}
	if input.DeviceID != "" {
		mac, err := devicepolicy.NormalizeMAC(input.DeviceID)
		if err != nil {
			sendJSON(response, http.StatusBadRequest, object{"error": "Укажите MAC-адрес устройства"})
			return
		}
		input.DeviceID = mac
	}
	config := diagnostics.editor.current().plan
	source, ok := observationSource(diagnostics.state, config)
	if !ok {
		sendJSON(response, http.StatusServiceUnavailable, object{"error": "Нет активной IPv4-подсети RouteHub"})
		return
	}
	select {
	case diagnostics.observation <- struct{}{}:
		defer func() { <-diagnostics.observation }()
	default:
		sendJSON(response, http.StatusTooManyRequests, object{"error": "Наблюдение уже идёт"})
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), time.Duration(input.Seconds)*time.Second+5*time.Second)
	defer cancel()
	inventoryCtx, stopInventory := context.WithTimeout(ctx, time.Second)
	devices := observedDeviceAliases(diagnostics.topologySnapshot(inventoryCtx).Devices)
	stopInventory()
	router, _ := netip.ParseAddr(config.PanelHost)
	if input.DeviceID != "" {
		source, ok = observedDeviceSource(source, router, devices, input.DeviceID)
		if !ok {
			sendJSON(response, http.StatusUnprocessableEntity, object{"error": "Не найден однозначный IPv4-адрес устройства в активной сети RouteHub"})
			return
		}
	}
	var listener netip.AddrPort
	if router.Is4() && diagnostics.state.LANMode == transparentRedirectTCP && config.Transparent.Port != 0 {
		listener = netip.AddrPortFrom(router, config.Transparent.Port)
	}
	result, err := sampleConnections(ctx, input.Seconds, observationInterval, source, router, listener, devices, diagnostics.readConnections)
	if err != nil {
		if request.Context().Err() == nil {
			sendJSON(response, http.StatusServiceUnavailable, object{"error": "Не удалось прочитать таблицу соединений Netfilter"})
		}
		return
	}
	gameMatches := gameObservationIndex(diagnostics.editor.current().Games)
	for i := range result.Rows {
		row := &result.Rows[i]
		destination, _ := netip.ParseAddrPort(row.Destination)
		key := gameFlowKey{deviceID: row.DeviceID, endpoint: gameEndpoint{destination: destination, protocol: row.Protocol}}
		if match, found := gameMatches[key]; found {
			row.GameMatch = &match
		}
	}
	sendJSON(response, http.StatusOK, result)
}
