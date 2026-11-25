package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

const (
	serviceLogFileBytes = 256 << 10
	serviceLogFiles     = 3
	serviceLogReserve   = 8 << 20
)

type serviceLogStatus struct {
	State        string `json:"state"`
	Bytes        int64  `json:"bytes"`
	Files        int    `json:"files"`
	MaxFileBytes int    `json:"maxFileBytes"`
	MaxFiles     int    `json:"maxFiles"`
	ReserveBytes int    `json:"reserveBytes"`
}

type serviceLog struct {
	path   string
	disk   func(string) *resourceCapacity
	mu     sync.Mutex
	failed bool
}

func (journal *serviceLog) file(index int) string {
	if index == 0 {
		return journal.path
	}
	return journal.path + "." + strconv.Itoa(index)
}

func logFileInfo(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err == nil && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("путь журнала не является обычным файлом")
	}
	return info, err
}

func (journal *serviceLog) fileInfo() ([serviceLogFiles]os.FileInfo, error) {
	var files [serviceLogFiles]os.FileInfo
	for i := range files {
		info, err := logFileInfo(journal.file(i))
		if err != nil {
			return files, err
		}
		files[i] = info
	}
	return files, nil
}

func (journal *serviceLog) diskAvailable(bytes int) bool {
	space := journal.disk(filepath.Dir(journal.path))
	return space != nil && space.Available >= serviceLogReserve+uint64(bytes)
}

func (journal *serviceLog) status() serviceLogStatus {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	state := serviceLogStatus{
		State: "active", MaxFileBytes: serviceLogFileBytes, MaxFiles: serviceLogFiles, ReserveBytes: serviceLogReserve,
	}
	files, err := journal.fileInfo()
	if err != nil || journal.failed {
		state.State = "error"
	} else if !journal.diskAvailable(0) {
		state.State = "paused"
	}
	for _, info := range files {
		if info != nil {
			state.Bytes += info.Size()
			state.Files++
		}
	}
	return state
}

// An update may inherit an oversized file from a service that logged without a
// limit. Keep its most recent bytes in place, without using another file.
func trimServiceLog(path string, length int64) error {
	file, err := os.OpenFile(path, os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	recent := make([]byte, serviceLogFileBytes)
	if _, err := file.ReadAt(recent, length-serviceLogFileBytes); err != nil {
		return err
	}
	if _, err := file.WriteAt(recent, 0); err != nil {
		return err
	}
	return file.Truncate(serviceLogFileBytes)
}

func (journal *serviceLog) appendLine(message string) (result error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	defer func() { journal.failed = result != nil }()
	line := time.Now().Format(time.RFC3339) + " " + message + "\n"
	if len(line) > serviceLogFileBytes {
		line = line[len(line)-serviceLogFileBytes:]
	}
	files, err := journal.fileInfo()
	if err != nil {
		return err
	}
	for index, info := range files {
		if info != nil && info.Size() > serviceLogFileBytes {
			if err := trimServiceLog(journal.file(index), info.Size()); err != nil {
				return err
			}
		}
	}
	if !journal.diskAvailable(len(line)) {
		return nil
	}
	if files[0] != nil && files[0].Size()+int64(len(line)) > serviceLogFileBytes {
		for index := len(files) - 2; index >= 0; index-- {
			if files[index] != nil {
				if err := os.Rename(journal.file(index), journal.file(index+1)); err != nil {
					return err
				}
			}
		}
	}
	file, err := os.OpenFile(journal.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Chmod(0600); err != nil {
		return err
	}
	_, err = file.WriteString(line)
	return err
}
