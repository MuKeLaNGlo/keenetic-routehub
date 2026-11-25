package main

import (
	"os/exec"
	"syscall"
)

func guardParentExit(process *exec.Cmd) {
	process.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}
