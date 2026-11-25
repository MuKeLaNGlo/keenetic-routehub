package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun/netstack"
)

func wireKey(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestManagedAWGSOCKSTCPAndUDP(t *testing.T) {
	for _, version := range []string{"2.0", "3.1"} {
		t.Run(version, func(t *testing.T) {
			local, peer := wireKey(t), wireKey(t)
			tun, stack, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("192.0.2.1")}, nil, 1280)
			if err != nil {
				t.Fatal(err)
			}
			server := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
			defer server.Close()
			options := "h1=12\nh2=23\nh3=34\nh4=45\n"
			clientOptions := "H1=12\nH2=23\nH3=34\nH4=45\n"
			if version == "3.1" {
				data := wireKey(t).Bytes()
				options += fmt.Sprintf("s1=19\ns2=19\ns3=19\ns4=19\nheader_protection_key=%x\n", data)
				clientOptions += "S1=19\nS2=19\nS3=19\nS4=19\nHeaderProtectionKey=" + base64.StdEncoding.EncodeToString(data) + "\n"
			}
			rpc := fmt.Sprintf("private_key=%x\n%slisten_port=0\npublic_key=%x\nallowed_ip=192.0.2.2/32\n", peer.Bytes(), options, local.PublicKey().Bytes())
			if err := server.IpcSet(rpc); err != nil {
				t.Fatalf("server options: %v", err)
			}
			if err := server.Up(); err != nil {
				t.Fatal(err)
			}
			status, err := server.IpcGet()
			if err != nil {
				t.Fatal(err)
			}
			start := strings.Index(status, "listen_port=")
			if start < 0 {
				t.Fatal("missing listener port")
			}
			_, field, _ := strings.Cut(status[start:], "=")
			port, _, _ := strings.Cut(field, "\n")
			clientConf := fmt.Sprintf("# AmneziaWG %s\n[Interface]\nPrivateKey=%s\nAddress=192.0.2.2/32\n%s[Peer]\nPublicKey=%s\nEndpoint=127.0.0.1:%s\nAllowedIPs=192.0.2.1/32\n",
				version, base64.StdEncoding.EncodeToString(local.Bytes()), clientOptions, base64.StdEncoding.EncodeToString(peer.PublicKey().Bytes()), port)
			proxy, err := startManagedAWGProxy(context.Background(), clientConf, version)
			if err != nil {
				t.Fatal(err)
			}
			defer proxy.close()
			target := net.IPv4(192, 0, 2, 1)
			listener, err := stack.ListenTCP(&net.TCPAddr{IP: target, Port: 18080})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go func() {
				if connection, err := listener.Accept(); err == nil {
					defer connection.Close()
					request := make([]byte, 4)
					if _, err := io.ReadFull(connection, request); err == nil {
						_, _ = connection.Write(request)
					}
				}
			}()
			udp, err := stack.ListenUDP(&net.UDPAddr{IP: target, Port: 18081})
			if err != nil {
				t.Fatal(err)
			}
			defer udp.Close()
			go func() {
				ping := make([]byte, 32)
				if size, address, err := udp.ReadFrom(ping); err == nil {
					_, _ = udp.WriteTo(ping[:size], address)
				}
			}()
			socks := func(command byte, port uint16) (net.Conn, uint16) {
				socket, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(proxy.port()))))
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = socket.Close() })
				_ = socket.SetDeadline(time.Now().Add(10 * time.Second))
				if _, err := socket.Write([]byte{5, 1, 0}); err != nil {
					t.Fatal(err)
				}
				method := make([]byte, 2)
				if _, err := io.ReadFull(socket, method); err != nil || !bytes.Equal(method, []byte{5, 0}) {
					t.Fatalf("SOCKS greeting: %x %v", method, err)
				}
				request := []byte{5, command, 0, 1, 192, 0, 2, 1, byte(port >> 8), byte(port)}
				if _, err := socket.Write(request); err != nil {
					t.Fatal(err)
				}
				reply := make([]byte, 10)
				if _, err := io.ReadFull(socket, reply); err != nil || reply[1] != 0 {
					t.Fatalf("SOCKS connection: %x %v", reply, err)
				}
				return socket, binary.BigEndian.Uint16(reply[8:])
			}
			payload := []byte("pong")
			tcp, _ := socks(1, 18080)
			_, _ = tcp.Write(payload)
			got := make([]byte, len(payload))
			if _, err := io.ReadFull(tcp, got); err != nil || !bytes.Equal(got, payload) {
				t.Fatalf("AWG TCP echo: %x %v", got, err)
			}
			_, relay := socks(3, 0)
			packet, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(relay)})
			if err != nil {
				t.Fatal(err)
			}
			defer packet.Close()
			_ = packet.SetDeadline(time.Now().Add(5 * time.Second))
			header := []byte{0, 0, 0, 1, 192, 0, 2, 1, 70, 161}
			want := append(header, payload...)
			_, _ = packet.Write(want)
			received := make([]byte, 64)
			size, err := packet.Read(received)
			if err != nil || !bytes.Equal(received[:size], want) {
				t.Fatalf("AWG UDP echo: %x %v", received[:size], err)
			}
		})
	}
}
