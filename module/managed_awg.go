package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun/netstack"
)

type managedAWGPool struct {
	ctx     context.Context
	mu      sync.Mutex
	proxies map[string]*managedAWGProxy
}

func newManagedAWGPool(ctx context.Context) *managedAWGPool {
	return &managedAWGPool{ctx: ctx, proxies: make(map[string]*managedAWGProxy)}
}

func (pool *managedAWGPool) prepare(config plan) (plan, func(bool), error) {
	candidate := copyPanelPlan(config)
	pool.mu.Lock()
	previous := pool.proxies
	pool.mu.Unlock()
	next := make(map[string]*managedAWGProxy)
	var added []*managedAWGProxy
	for index := range candidate.Profiles {
		profile := &candidate.Profiles[index]
		if profile.AWGConfig == "" {
			continue
		}
		proxy := previous[profile.ID]
		if proxy == nil || proxy.raw != profile.AWGConfig || proxy.config.Version != profile.AWGVersion {
			var err error
			proxy, err = startManagedAWGProxy(pool.ctx, profile.AWGConfig, profile.AWGVersion)
			if err != nil {
				for _, newProxy := range added {
					newProxy.close()
				}
				return plan{}, nil, fmt.Errorf("не удалось подготовить профиль %q: %w", profile.ID, err)
			}
			added = append(added, proxy)
		}
		next[profile.ID], profile.awgPort = proxy, proxy.port()
	}
	return candidate, func(commit bool) {
		if !commit {
			for _, proxy := range added {
				proxy.close()
			}
			return
		}
		pool.mu.Lock()
		pool.proxies = next
		pool.mu.Unlock()
		for id, proxy := range previous {
			if next[id] != proxy {
				proxy.close()
			}
		}
	}, nil
}

func (pool *managedAWGPool) probeProfile(entry profile) (profile, error) {
	if entry.AWGConfig == "" {
		return entry, nil
	}
	pool.mu.Lock()
	proxy := pool.proxies[entry.ID]
	pool.mu.Unlock()
	if proxy == nil || proxy.raw != entry.AWGConfig {
		return profile{}, errors.New("активный интерфейс профиля AmneziaWG не подготовлен")
	}
	entry.awgPort = proxy.port()
	return entry, nil
}

func (pool *managedAWGPool) close() {
	pool.mu.Lock()
	previous := pool.proxies
	pool.proxies = nil
	pool.mu.Unlock()
	for _, proxy := range previous {
		proxy.close()
	}
}

type managedAWGProxy struct {
	raw      string
	config   managedAWGConfig
	listener *net.TCPListener
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	tunnel   *device.Device
	stack    *netstack.Net
}

func startManagedAWGProxy(parent context.Context, raw, version string) (*managedAWGProxy, error) {
	config, err := parseManagedAWG(raw, version)
	if err != nil {
		return nil, err
	}
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	proxy := &managedAWGProxy{raw: raw, config: config, listener: listener, ctx: ctx, cancel: cancel}
	go proxy.serve()
	return proxy, nil
}

func (proxy *managedAWGProxy) port() uint16 { return uint16(proxy.listener.Addr().(*net.TCPAddr).Port) }

func (proxy *managedAWGProxy) close() {
	proxy.cancel()
	_ = proxy.listener.Close()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if proxy.tunnel != nil {
		proxy.tunnel.Close()
	}
}

func (proxy *managedAWGProxy) serve() {
	jobs := make(chan struct{}, 64)
	for {
		connection, err := proxy.listener.AcceptTCP()
		if err != nil {
			return
		}
		select {
		case jobs <- struct{}{}:
			go func() {
				defer func() { <-jobs }()
				proxy.handle(connection)
			}()
		default:
			_ = connection.Close()
		}
	}
}

func (proxy *managedAWGProxy) connectTunnel(ctx context.Context) (*netstack.Net, error) {
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if proxy.ctx.Err() != nil {
		return nil, proxy.ctx.Err()
	}
	if proxy.stack != nil {
		return proxy.stack, nil
	}
	host, port, _ := net.SplitHostPort(proxy.config.Endpoint)
	address, err := netip.ParseAddr(host)
	if err != nil {
		choices, lookupErr := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if lookupErr != nil || len(choices) == 0 {
			return nil, errors.New("Endpoint AmneziaWG не разрешается")
		}
		address = choices[0]
		for _, option := range choices {
			if option.Unmap().Is4() {
				address = option
				break
			}
		}
	}
	endpoint := net.JoinHostPort(address.Unmap().String(), port)
	tun, stack, err := netstack.CreateNetTUN(proxy.config.Addresses, proxy.config.DNS, proxy.config.MTU)
	if err != nil {
		return nil, err
	}
	tunnel := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	if err := tunnel.IpcSet(proxy.config.Parameters + "endpoint=" + endpoint + "\n"); err != nil {
		tunnel.Close()
		return nil, errors.New("ядро AmneziaWG отклонило параметры профиля")
	}
	if err := tunnel.Up(); err != nil {
		tunnel.Close()
		return nil, errors.New("не удалось запустить AmneziaWG")
	}
	proxy.stack, proxy.tunnel = stack, tunnel
	return stack, nil
}

func readSOCKSAddress(reader io.Reader) (string, error) {
	var kind [1]byte
	if _, err := io.ReadFull(reader, kind[:]); err != nil {
		return "", err
	}
	var size int
	switch kind[0] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(reader, length[:]); err != nil {
			return "", err
		}
		size = int(length[0])
	default:
		return "", errors.New("неизвестный тип адреса SOCKS")
	}
	if size == 0 {
		return "", errors.New("пустой адрес SOCKS")
	}
	payload := make([]byte, size+2)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return "", err
	}
	host := string(payload[:size])
	if kind[0] != 3 {
		address, _ := netip.AddrFromSlice(payload[:size])
		host = address.String()
	}
	return net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(payload[size:])))), nil
}

func sendSOCKSStatus(connection io.Writer, code byte, port uint16) error {
	_, err := connection.Write([]byte{5, code, 0, 1, 127, 0, 0, 1, byte(port >> 8), byte(port)})
	return err
}

func (proxy *managedAWGProxy) handle(connection *net.TCPConn) {
	defer connection.Close()
	stop := context.AfterFunc(proxy.ctx, func() { _ = connection.Close() })
	defer stop()
	_ = connection.SetDeadline(time.Now().Add(8 * time.Second))
	var start [2]byte
	if _, err := io.ReadFull(connection, start[:]); err != nil || start[0] != 5 || start[1] == 0 {
		return
	}
	methods := make([]byte, int(start[1]))
	if _, err := io.ReadFull(connection, methods); err != nil {
		return
	}
	if !bytes.Contains(methods, []byte{0}) {
		_, _ = connection.Write([]byte{5, 255})
		return
	}
	if _, err := connection.Write([]byte{5, 0}); err != nil {
		return
	}
	var request [3]byte
	if _, err := io.ReadFull(connection, request[:]); err != nil || request[0] != 5 || request[2] != 0 {
		return
	}
	target, err := readSOCKSAddress(connection)
	if err != nil {
		_ = sendSOCKSStatus(connection, 8, 0)
		return
	}
	if request[1] != 1 && request[1] != 3 {
		_ = sendSOCKSStatus(connection, 7, 0)
		return
	}
	budget, cancel := context.WithTimeout(proxy.ctx, 8*time.Second)
	defer cancel()
	stack, err := proxy.connectTunnel(budget)
	if err != nil {
		_ = sendSOCKSStatus(connection, 1, 0)
		return
	}
	if request[1] == 3 {
		proxy.associateUDP(connection, stack)
		return
	}
	remote, err := stack.DialContext(budget, "tcp", target)
	if err != nil {
		_ = sendSOCKSStatus(connection, 4, 0)
		return
	}
	defer remote.Close()
	if sendSOCKSStatus(connection, 0, 0) != nil {
		return
	}
	_ = connection.SetDeadline(time.Time{})
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(remote, connection)
		if pipe, ok := remote.(interface{ CloseWrite() error }); ok {
			_ = pipe.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(connection, remote)
	_ = connection.Close()
	<-done
}

func (proxy *managedAWGProxy) associateUDP(control *net.TCPConn, stack *netstack.Net) {
	packet, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		_ = sendSOCKSStatus(control, 1, 0)
		return
	}
	defer packet.Close()
	if sendSOCKSStatus(control, 0, uint16(packet.LocalAddr().(*net.UDPAddr).Port)) != nil {
		return
	}
	_ = control.SetDeadline(time.Time{})
	go func() { _, _ = io.Copy(io.Discard, control); _ = packet.Close() }()

	type flow struct{ conn net.Conn }
	flows := make(map[string]*flow)
	var lock sync.Mutex
	defer func() {
		lock.Lock()
		defer lock.Unlock()
		for _, active := range flows {
			_ = active.conn.Close()
		}
	}()
	var sender netip.AddrPort
	buffer := make([]byte, 65535)
	for {
		_ = packet.SetReadDeadline(time.Now().Add(2 * time.Minute))
		count, from, err := packet.ReadFromUDPAddrPort(buffer)
		if err != nil {
			return
		}
		if !from.Addr().IsLoopback() || (sender.IsValid() && sender != from) ||
			count <= 4 || buffer[0] != 0 || buffer[1] != 0 || buffer[2] != 0 {
			continue
		}
		sender = from
		reader := bytes.NewReader(buffer[3:count])
		target, err := readSOCKSAddress(reader)
		if err != nil || reader.Len() == 0 {
			continue
		}
		header := count - reader.Len()
		lock.Lock()
		active := flows[target]
		if active == nil && len(flows) < 32 {
			budget, cancel := context.WithTimeout(proxy.ctx, 3*time.Second)
			remote, dialErr := stack.DialContext(budget, "udp", target)
			cancel()
			if dialErr == nil {
				active = &flow{conn: remote}
				flows[target] = active
				prefix := bytes.Clone(buffer[:header])
				go func(flow *flow, destination netip.AddrPort) {
					defer flow.conn.Close()
					defer func() { lock.Lock(); delete(flows, target); lock.Unlock() }()
					datagram := make([]byte, 65535)
					copy(datagram, prefix)
					for {
						_ = flow.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
						n, e := flow.conn.Read(datagram[len(prefix):])
						if e != nil {
							return
						}
						if _, e = packet.WriteToUDPAddrPort(datagram[:len(prefix)+n], destination); e != nil {
							return
						}
					}
				}(active, sender)
			}
		}
		lock.Unlock()
		if active != nil {
			_, _ = active.conn.Write(buffer[header:count])
		}
	}
}
