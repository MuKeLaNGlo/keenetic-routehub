package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

func runtimeGeoDirectory(path string) string {
	return path + ".assets"
}

func stageRuntimeGeoAssets(path string, config plan, assets map[string]string) error {
	if len(assets) == 0 {
		return nil
	}
	target := runtimeGeoDirectory(path)
	if err := os.Mkdir(target, 0700); err != nil {
		return err
	}
	for id, filename := range assets {
		asset := config.geoAssets[id]
		if err := copyRuntimeGeoAsset(filepath.Join(config.geoRoot, id+".cache"), filepath.Join(target, filename), asset.geoManifest); err != nil {
			return fmt.Errorf("не удалось подготовить базу %q для Xray: %w", id, err)
		}
	}
	return nil
}

func copyRuntimeGeoAsset(source, destination string, expected geoManifest) error {
	input, reader, manifest, err := openGeoCache(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if manifest.Repository != expected.Repository || manifest.Asset != expected.Asset ||
		manifest.Version != expected.Version || manifest.Digest != expected.Digest {
		return errors.New("версия файла базы изменилась")
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	sum := sha256.New()
	size, err := io.Copy(io.MultiWriter(output, sum), io.LimitReader(reader, geoMaxBytes+1))
	if err != nil || size <= 0 || size > geoMaxBytes || hex.EncodeToString(sum.Sum(nil)) != manifest.Digest {
		return errors.Join(errors.New("не совпала контрольная сумма или размер базы"), output.Close())
	}
	return errors.Join(output.Sync(), output.Close())
}

func removeRuntimeXray(path string) {
	_ = os.Remove(path)
	_ = os.RemoveAll(runtimeGeoDirectory(path))
}

func xrayEnvironment(path string) []string {
	if info, err := os.Stat(runtimeGeoDirectory(path)); err == nil && info.IsDir() {
		return append(os.Environ(), "XRAY_LOCATION_ASSET="+runtimeGeoDirectory(path))
	}
	return nil
}

func validateXrayConfig(ctx context.Context, xray, path string) error {
	ctx, cancel := context.WithTimeout(ctx, runtimeTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, xray, "run", "-test", "-c", path)
	command.Env = xrayEnvironment(path)
	err := command.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
