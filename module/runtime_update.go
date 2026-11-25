package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

type engineUpdate struct {
	config plan
	result chan error
}

func submitUpdate(service context.Context, updates chan<- engineUpdate) func(context.Context, plan) error {
	return func(request context.Context, config plan) error {
		update := engineUpdate{config: config, result: make(chan error, 1)}
		select {
		case <-request.Done():
			return request.Err()
		case <-service.Done():
			return service.Err()
		case updates <- update:
		}
		select {
		case <-service.Done():
			return service.Err()
		case err := <-update.result:
			return err
		}
	}
}

func privateJSON(dir, name string, document any) (string, error) {
	temp, err := os.CreateTemp(dir, name)
	if err != nil {
		return "", err
	}
	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	writeErr := encoder.Encode(document)
	err = errors.Join(writeErr, temp.Sync(), temp.Close())
	path := temp.Name()
	if err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

func stageRuntimePlan(path string, next plan) (string, error) {
	pending, err := privateJSON(filepath.Dir(path), ".routehub-plan-*", next)
	if err != nil {
		return "", errors.New("не удалось записать настройки на роутер")
	}
	info, err := os.Stat(pending)
	if err != nil || info.Size() > maxPlanBytes {
		_ = os.Remove(pending)
		return "", errors.New("не удалось сохранить конфигурацию в пределах 4 МиБ")
	}
	return pending, nil
}

func replaceEngine(ctx context.Context, opts options, current *engine, path string, config plan) (*engine, string, error) {
	selection := runtimeSelection{VPN: true}
	if config.Zapret && config.ZapretServices != nil && opts.allowLAN {
		selection.YouTube, selection.Discord = config.ZapretServices.YouTube, config.ZapretServices.Discord
		selection.YouTubeStrategy, selection.DiscordStrategy = "custom", "custom"
	}
	return replaceRuntime(ctx, opts, current, path, config, config, selection, selection, true)
}

func suspendRuntimeLAN(opts options, lan *transparent) error {
	if lan.Mode == transparentRedirectTCP {
		return networkHelper(opts, "redirect-tcp", "deactivate")
	}
	return networkHelper(opts, "transparent", "stop")
}

func resumeRuntimeLAN(opts options, lan *transparent, instance *engine) error {
	if lan.Mode == transparentRedirectTCP {
		return networkHelper(opts, "redirect-tcp", "activate", strconv.Itoa(instance.process.Process.Pid))
	}
	return startTransparent(opts, lan)
}

func replaceRuntime(ctx context.Context, opts options, current *engine, currentConfig string, prior, next plan, before, after runtimeSelection, persist bool) (*engine, string, error) {
	if persist && !before.effectiveDifferent(after) &&
		(checksOnlyChange(prior, next) || subscriptionMetadataOnly(prior, next, after) || gameMetadataOnly(prior, next, opts.allowLAN)) {
		pending, err := stageRuntimePlan(opts.config, next)
		if err != nil {
			return current, currentConfig, err
		}
		defer os.Remove(pending)
		return current, currentConfig, os.Rename(pending, opts.config)
	}
	if err := checkAWG(next); err != nil {
		return current, currentConfig, err
	}
	effective := runtimePlan(next, after)
	replacement, err := writeRuntimeXray(opts, filepath.Dir(currentConfig), effective, effective.Zapret)
	if err != nil {
		return current, currentConfig, err
	}
	defer func() {
		if replacement != "" {
			removeRuntimeXray(replacement)
		}
	}()
	if err := validateXrayConfig(ctx, opts.xray, replacement); err != nil {
		return current, currentConfig, fmt.Errorf("ядро отклонило конфигурацию: %w", err)
	}
	var pending string
	if persist {
		pending, err = stageRuntimePlan(opts.config, next)
		if err != nil {
			return current, currentConfig, err
		}
		defer os.Remove(pending)
	}

	start := func(ctx context.Context, path string) (*engine, error) {
		instance, err := startEngine(opts.xray, path)
		if err != nil {
			return nil, err
		}
		if err := instance.waitForSOCKS(ctx, loopback(next.SOCKSPort)); err != nil {
			instance.stop()
			return nil, err
		}
		return instance, nil
	}
	zapretChanges := before.zapretDifferent(after)
	if zapretChanges && after.zapretEnabled() {
		if err := runRuntimeZapret(opts, after, zapretTrial{}, "check"); err != nil {
			return current, currentConfig, err
		}
	}
	if opts.allowLAN {
		if err := suspendRuntimeLAN(opts, prior.Transparent); err != nil {
			return current, currentConfig, errors.New("не удалось приостановить правила RouteHub")
		}
	}
	current.stop()
	if zapretChanges {
		if before.zapretEnabled() {
			err = networkHelper(opts, "zapret", "stop")
		}
		if err == nil && after.zapretEnabled() {
			err = startRuntimeZapret(opts, after)
		}
	}
	var nextInstance *engine
	if err == nil {
		nextInstance, err = start(ctx, replacement)
	}
	if err == nil && opts.allowLAN {
		err = resumeRuntimeLAN(opts, next.Transparent, nextInstance)
	}
	if err == nil && pending != "" {
		err = os.Rename(pending, opts.config)
	}
	if err == nil {
		removeRuntimeXray(currentConfig)
		applied := replacement
		replacement = ""
		return nextInstance, applied, nil
	}
	if nextInstance != nil {
		if opts.allowLAN {
			_ = suspendRuntimeLAN(opts, next.Transparent)
		}
		nextInstance.stop()
	}

	var rollback error
	if zapretChanges {
		rollback = networkHelper(opts, "zapret", "stop")
		if rollback == nil && before.zapretEnabled() {
			rollback = startRuntimeZapret(opts, before)
		}
	}
	var restored *engine
	if rollback == nil {
		restored, rollback = start(context.Background(), currentConfig)
	}
	if rollback == nil && opts.allowLAN {
		rollback = resumeRuntimeLAN(opts, prior.Transparent, restored)
		if rollback != nil {
			restored.stop()
		}
	}
	if rollback != nil {
		return nil, currentConfig, fmt.Errorf("ошибка применения и возврата конфигурации: %w", errors.Join(err, rollback))
	}
	return restored, currentConfig, errors.New("изменения не применились, прежняя конфигурация восстановлена")
}
