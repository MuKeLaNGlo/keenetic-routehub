package main

import "syscall"

func setZapretSocketMark(network, address string, conn syscall.RawConn) error {
	return zapretSocketMark(0)(network, address, conn)
}

func zapretSocketMark(extra int) func(string, string, syscall.RawConn) error {
	return func(_, _ string, conn syscall.RawConn) error {
		var socketError error
		err := conn.Control(func(fd uintptr) {
			socketError = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK, zapretMark|zapretDiagnosticMark|extra)
		})
		if err != nil || socketError != nil {
			return errZapretMark
		}
		return nil
	}
}
