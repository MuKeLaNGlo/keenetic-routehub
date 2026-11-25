//go:build !linux

package main

import "os/exec"

func guardParentExit(process *exec.Cmd) {}
