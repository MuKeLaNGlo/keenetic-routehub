package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestRuntimeGeoAssetsAreVerifiedAndIsolated(t *testing.T) {
	dir := t.TempDir()
	config := testPanelEditConfig()
	config.geoRoot = filepath.Join(dir, "cache")
	source := sampleGeoSource()
	config.GeoSources = []geoSource{source}
	config.Rules = []rule{{Name: "Example", GeoIP: "RU", GeoSource: source.ID, Target: "direct"}}
	cache := filepath.Join(config.geoRoot, source.ID+".cache")
	data := geoFixture(203)
	expected := sha256.Sum256(data)
	asset, err := parseGeoAsset(geoManifest{Repository: source.Repository, Asset: source.Asset, Version: "v1", Digest: hex.EncodeToString(expected[:])}, data)
	if err != nil {
		t.Fatal(err)
	}
	config.geoAssets = map[string]geoAsset{source.ID: asset}
	staged, err := stageGeoAsset(config.geoRoot, asset, data)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(staged, cache); err != nil {
		t.Fatal(err)
	}

	current, err := writeRuntimeXray(options{}, dir, config, false)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(current)
	if err != nil || !bytes.Contains(payload, []byte("ext:sample.dat:RU")) ||
		bytes.Contains(payload, []byte("203.0.113.0/24")) {
		t.Fatal("runtime Xray configuration did not use the external group")
	}
	currentAsset := filepath.Join(runtimeGeoDirectory(current), "sample.dat")
	got, err := os.ReadFile(currentAsset)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("staged asset differs from the verified source")
	}
	wantEnv := "XRAY_LOCATION_ASSET=" + runtimeGeoDirectory(current)
	if !slices.Contains(xrayEnvironment(current), wantEnv) {
		t.Fatal("runtime Xray asset path missing from subprocess environment")
	}

	damaged, err := os.ReadFile(cache)
	if err != nil {
		t.Fatal(err)
	}
	damaged[len(damaged)-1] ^= 1
	if err := os.WriteFile(cache, damaged, 0600); err != nil {
		t.Fatal(err)
	}
	if pending, err := writeRuntimeXray(options{}, dir, config, false); err == nil || pending != "" {
		t.Fatal("failed checksum did not stop staging")
	}
	found, err := filepath.Glob(filepath.Join(dir, "xray-*"))
	if err != nil || len(found) != 2 {
		t.Fatalf("failed replacement left config or asset files: %v, %v", found, err)
	}
	got, err = os.ReadFile(currentAsset)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("a failed replacement touched the prior generation")
	}
	removeRuntimeXray(current)
	for _, path := range []string{current, runtimeGeoDirectory(current)} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("staged path survived cleanup: %s, %v", path, err)
		}
	}
}
