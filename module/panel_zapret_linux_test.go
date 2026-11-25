package main

import (
	"errors"
	"net"
	"syscall"
	"testing"
	"time"
)

func TestZapretDiagnosticSocketCarriesBothMarks(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	dialer := net.Dialer{Timeout: time.Second, Control: setZapretSocketMark}
	connection, err := dialer.Dial("tcp4", listener.Addr().String())
	if errors.Is(err, errZapretMark) {
		t.Skip("setting SO_MARK requires CAP_NET_ADMIN or CAP_NET_RAW on newer kernels")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	socket, err := connection.(*net.TCPConn).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var mark int
	var socketError error
	if err := socket.Control(func(fd uintptr) {
		mark, socketError = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK)
	}); err != nil || socketError != nil || mark != zapretMark|zapretDiagnosticMark {
		t.Fatalf("diagnostic socket mark %#x, control error %v, socket error %v", mark, err, socketError)
	}
}
