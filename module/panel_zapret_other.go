//go:build !linux

package main

import "syscall"

func setZapretSocketMark(_, _ string, _ syscall.RawConn) error {
	return errZapretMark
}

func zapretSocketMark(int) func(string, string, syscall.RawConn) error {
	return setZapretSocketMark
}
