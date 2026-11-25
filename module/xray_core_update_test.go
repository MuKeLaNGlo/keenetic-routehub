package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

type xrayArchiveFixture []byte

func (fixture xrayArchiveFixture) RoundTrip(_ *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(fixture)), Body: io.NopCloser(bytes.NewReader(fixture))}, nil
}

func TestXrayReleaseRequiresStableARM64Digest(t *testing.T) {
	digest := sha256.Sum256([]byte("fixture"))
	fixture := func(tag, asset, hash string, preview bool) []byte {
		return fmt.Appendf(nil, `{"tag_name":%q,"prerelease":%t,"assets":[{"name":%q,"digest":%q,"size":100}]}`, tag, preview, asset, hash)
	}
	got, err := parseXrayRelease(fixture("v26.11.9", xrayAssetARM64, fmt.Sprintf("sha256:%x", digest), false))
	if err != nil || got.version != "26.11.9" || got.digest != digest || !xrayIsNewer(got.version, "26.10.29") || xrayIsNewer("26.9.9", got.version) {
		t.Fatalf("stable ARM64 release or numeric version ordering failed: %v", err)
	}
	for _, invalid := range [][]byte{
		fixture("v26.11.9", xrayAssetARM64, "", false),
		fixture("v26.11.9", xrayAssetARM64, fmt.Sprintf("sha256:%x", digest), true),
		fixture("v26.11.9", "Xray-linux-64.zip", fmt.Sprintf("sha256:%x", digest), false),
		fixture("v26.11.9/other", xrayAssetARM64, fmt.Sprintf("sha256:%x", digest), false),
	} {
		if _, err := parseXrayRelease(invalid); err == nil {
			t.Fatal("accepted a release without a stable ARM64 binary and digest")
		}
	}
}

func TestXrayDownloadChecksDigestBeforeExtracting(t *testing.T) {
	var raw bytes.Buffer
	archive := zip.NewWriter(&raw)
	writer, err := archive.Create("xray")
	if err != nil {
		t.Fatal(err)
	}
	const binary = "verified fixture binary"
	if _, err := io.WriteString(writer, binary); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	client := &http.Client{Transport: xrayArchiveFixture(raw.Bytes())}
	release := xrayRelease{version: "26.11.9", size: int64(raw.Len())}
	if _, err := stageXrayRelease(context.Background(), client, dir, release); err == nil {
		t.Fatal("archive with the wrong digest was extracted")
	}
	release.digest = sha256.Sum256(raw.Bytes())
	path, err := stageXrayRelease(context.Background(), client, dir, release)
	if err != nil {
		t.Fatal(err)
	}
	persistent, err := stageCompressedCore(path, filepath.Join(dir, "xray-managed.gz"))
	if err != nil {
		t.Fatal(err)
	}
	restored, err := restoreCompressedCore(persistent, dir)
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(restored); err != nil || string(data) != binary {
		t.Fatal("persisted core did not round trip")
	}
}
