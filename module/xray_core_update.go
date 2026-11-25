package main

import (
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	xrayReleasesAPI = "https://api.github.com/repos/XTLS/Xray-core/releases/latest"
	xrayAssetARM64  = "Xray-linux-arm64-v8a.zip"
	maxXrayArchive  = 25 << 20
	maxXrayBinary   = 60 << 20
)

var xrayReleaseVersion = regexp.MustCompile(`^v?(\d{1,4}\.\d{1,3}\.\d{1,3})$`)

type xrayRelease struct {
	version string
	digest  [sha256.Size]byte
	size    int64
}

func readXrayRelease(ctx context.Context, client *http.Client) (xrayRelease, error) {
	data, err := readGeoResponse(ctx, client, xrayReleasesAPI, "application/vnd.github+json", 1<<20)
	if err != nil {
		return xrayRelease{}, err
	}
	return parseXrayRelease(data)
}

func parseXrayRelease(data []byte) (xrayRelease, error) {
	var release struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name   string `json:"name"`
			Digest string `json:"digest"`
			Size   int64  `json:"size"`
		} `json:"assets"`
	}
	if json.Unmarshal(data, &release) != nil || release.Draft || release.Prerelease || !strings.HasPrefix(release.Tag, "v") {
		return xrayRelease{}, errors.New("GitHub не вернул стабильный релиз Xray")
	}
	version := xrayReleaseVersion.FindStringSubmatch(release.Tag)
	if version == nil {
		return xrayRelease{}, errors.New("не распознана версия релиза Xray")
	}
	for _, asset := range release.Assets {
		if asset.Name == xrayAssetARM64 && asset.Size > 0 && asset.Size <= maxXrayArchive {
			value, ok := strings.CutPrefix(asset.Digest, "sha256:")
			digest, err := hex.DecodeString(value)
			if ok && err == nil && len(digest) == sha256.Size {
				return xrayRelease{version[1], [sha256.Size]byte(digest), asset.Size}, nil
			}
		}
	}
	return xrayRelease{}, errors.New("в релизе нет ARM64-архива с SHA-256")
}

func xrayIsNewer(candidate, current string) bool {
	candidate = strings.TrimPrefix(candidate, "v")
	current = strings.TrimPrefix(current, "v")
	if !xrayReleaseVersion.MatchString(candidate) || !xrayReleaseVersion.MatchString(current) {
		return false
	}
	a, b := strings.Split(candidate, "."), strings.Split(current, ".")
	for i := range a {
		x, _ := strconv.Atoi(a[i])
		y, _ := strconv.Atoi(b[i])
		if x != y {
			return x > y
		}
	}
	return false
}

func xrayVersion(ctx context.Context, binary string) string {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, binary, "version").Output()
	if err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 1 && fields[0] == "Xray" {
			if v := xrayReleaseVersion.FindStringSubmatch(fields[1]); v != nil {
				return v[1]
			}
		}
	}
	return ""
}

func coreDiskAvailable(dir string, bytes uint64) bool {
	var stat syscall.Statfs_t
	return syscall.Statfs(dir, &stat) == nil && uint64(stat.Bavail)*uint64(stat.Bsize) >= bytes
}

func stageXrayRelease(ctx context.Context, client *http.Client, dir string, release xrayRelease) (string, error) {
	if !coreDiskAvailable(dir, uint64(release.size)+(6<<20)) {
		return "", errors.New("не хватает временного места для архива Xray")
	}
	address := "https://github.com/XTLS/Xray-core/releases/download/v" + release.version + "/" + xrayAssetARM64
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return "", errors.New("не удалось подготовить загрузку Xray")
	}
	request.Header.Set("User-Agent", "RouteHub")
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("не удалось скачать архив Xray из GitHub Releases")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || (response.ContentLength >= 0 && response.ContentLength != release.size) {
		return "", fmt.Errorf("GitHub вернул неожиданный ответ при загрузке Xray (HTTP %d)", response.StatusCode)
	}
	archive, err := os.CreateTemp(dir, "xray-release-*.zip")
	if err != nil {
		return "", errors.New("не удалось подготовить временный архив Xray")
	}
	defer os.Remove(archive.Name())
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(archive, hash), io.LimitReader(response.Body, release.size+1))
	if errors.Join(err, archive.Close()) != nil || count != release.size || [sha256.Size]byte(hash.Sum(nil)) != release.digest {
		return "", errors.New("архив не совпадает с размером или SHA-256 в GitHub Releases")
	}
	return extractXrayBinary(archive.Name(), dir)
}

func extractXrayBinary(archive, dir string) (string, error) {
	files, err := zip.OpenReader(archive)
	if err != nil {
		return "", errors.New("не удалось открыть архив Xray")
	}
	defer files.Close()
	for _, file := range files.File {
		if file.Name != "xray" || !file.Mode().IsRegular() || file.UncompressedSize64 == 0 || file.UncompressedSize64 > maxXrayBinary {
			continue
		}
		if !coreDiskAvailable(dir, file.UncompressedSize64+(6<<20)) {
			return "", errors.New("не хватает временного места для распаковки Xray")
		}
		info, _ := os.ReadFile("/proc/meminfo")
		if len(info) > 0 && availableProbeMemory(string(info)) < int(file.UncompressedSize64>>10)+28*1024 {
			return "", errors.New("не хватает свободной памяти для распаковки и проверки Xray")
		}
		source, err := file.Open()
		if err != nil {
			return "", errors.New("не удалось извлечь исполняемый файл Xray")
		}
		defer source.Close()
		return stageCoreExecutable(source, int64(file.UncompressedSize64), dir)
	}
	return "", errors.New("в архиве нет обычного исполняемого файла Xray")
}

func stageCoreExecutable(source io.Reader, limit int64, dir string) (string, error) {
	executable, err := os.CreateTemp(dir, "xray-candidate-*")
	if err != nil {
		return "", errors.New("не удалось создать файл ядра Xray")
	}
	path := executable.Name()
	written, err := io.Copy(executable, io.LimitReader(source, limit+1))
	if errors.Join(err, executable.Close()) != nil || written == 0 || written > limit || os.Chmod(path, 0700) != nil {
		_ = os.Remove(path)
		return "", errors.New("не удалось распаковать исполняемый файл Xray")
	}
	return path, nil
}

func validateCoreArchitecture(path string) bool {
	file, err := elf.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	return runtime.GOOS == "linux" && runtime.GOARCH == "arm64" && file.Class == elf.ELFCLASS64 && file.Machine == elf.EM_AARCH64
}

func stageCompressedCore(source, store string) (string, error) {
	file, err := os.Open(source)
	if err != nil {
		return "", errors.New("кандидат Xray недоступен")
	}
	defer file.Close()
	pending, err := os.CreateTemp(filepath.Dir(store), ".xray-pending-*")
	if err != nil {
		return "", errors.New("не удалось подготовить хранилище обновления Xray")
	}
	writer, _ := gzip.NewWriterLevel(pending, gzip.BestSpeed)
	_, err = io.Copy(writer, file)
	err = errors.Join(err, writer.Close(), pending.Sync(), pending.Close())
	info, statErr := os.Stat(pending.Name())
	if err != nil || statErr != nil || info.Size() > maxXrayArchive {
		_ = os.Remove(pending.Name())
		return "", errors.New("не удалось сохранить ядро Xray. Проверьте свободное место")
	}
	return pending.Name(), nil
}

func restoreCompressedCore(store, dir string) (string, error) {
	info, err := os.Lstat(store)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > maxXrayArchive {
		return "", errors.New("сохранённое ядро Xray недоступно")
	}
	file, err := os.Open(store)
	if err != nil {
		return "", err
	}
	defer file.Close()
	source, err := gzip.NewReader(file)
	if err != nil {
		return "", err
	}
	defer source.Close()
	return stageCoreExecutable(source, maxXrayBinary, dir)
}
