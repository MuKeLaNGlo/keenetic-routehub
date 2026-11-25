package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type coreTransaction struct {
	candidate coreCandidate
	pending   string
	result    chan error
}

func coreUpdateQueue(service context.Context, updates chan<- coreTransaction) func(context.Context, coreCandidate, string) error {
	return func(request context.Context, candidate coreCandidate, pending string) error {
		update := coreTransaction{candidate, pending, make(chan error, 1)}
		select {
		case <-request.Done():
			return request.Err()
		case <-service.Done():
			return service.Err()
		case updates <- update:
		}
		// Once accepted, the runtime owns the staged files until activation or rollback ends.
		return <-update.result
	}
}

func linkCore(source, link string) error {
	if target, err := os.Readlink(source); err == nil {
		return os.Symlink(target, link)
	}
	return os.Link(source, link)
}

func startCore(ctx context.Context, binary, config, socks string) (*engine, error) {
	instance, err := startEngine(binary, config)
	if err != nil {
		return nil, err
	}
	if err := instance.waitForSOCKS(ctx, socks); err != nil {
		instance.stop()
		return nil, err
	}
	return instance, nil
}

func replaceXrayCore(ctx context.Context, opts options, current *engine, currentConfig string, config plan, selection runtimeSelection, store string, update coreTransaction) (*engine, error) {
	if err := validateXrayConfig(ctx, update.candidate.path, currentConfig); err != nil {
		return current, errors.New("новое ядро Xray отклонило действующую конфигурацию")
	}
	dir, err := os.MkdirTemp(filepath.Dir(opts.xray), "xray-switch-*")
	if err != nil {
		return current, errors.New("не удалось подготовить атомарную смену ядра")
	}
	defer os.RemoveAll(dir)
	backup, next := filepath.Join(dir, "previous"), filepath.Join(dir, "next")
	if linkCore(opts.xray, backup) != nil || linkCore(update.candidate.path, next) != nil {
		return current, errors.New("не удалось сохранить предыдущее ядро перед переключением")
	}
	if opts.allowLAN {
		if err := suspendRuntimeLAN(opts, config.Transparent); err != nil {
			return current, errors.New("не удалось приостановить правила RouteHub")
		}
	}
	current.stop()
	var active *engine
	if err = os.Rename(next, opts.xray); err == nil {
		active, err = startCore(ctx, opts.xray, currentConfig, loopback(config.SOCKSPort))
	}
	if err == nil && selection.VPN {
		entry, _ := findProfile(config, selection.Profile)
		if probe := opts.vpnHealth.checkForGroup(ctx, entry.XrayGroup != nil); probe.Status != "verified" {
			err = errors.New("контрольный HTTPS через активный VPN не прошёл")
		}
	}
	resumeAttempted := false
	if err == nil && opts.allowLAN {
		resumeAttempted = true
		err = resumeRuntimeLAN(opts, config.Transparent, active)
	}
	if err == nil {
		err = os.Rename(update.pending, store)
		if err == nil {
			return active, nil
		}
		err = errors.New("не удалось закрепить новое ядро во внутреннем хранилище")
	}
	if active != nil {
		if resumeAttempted {
			_ = suspendRuntimeLAN(opts, config.Transparent)
		}
		active.stop()
	}
	if restore := os.Rename(backup, opts.xray); restore != nil {
		return nil, errors.New("не удалось вернуть исполняемый файл прежнего ядра")
	}
	restored, rollback := startCore(context.Background(), opts.xray, currentConfig, loopback(config.SOCKSPort))
	if rollback == nil && opts.allowLAN {
		rollback = resumeRuntimeLAN(opts, config.Transparent, restored)
		if rollback != nil {
			restored.stop()
		}
	}
	if rollback != nil {
		return nil, errors.New("не удалось запустить прежнее ядро Xray после отката")
	}
	return restored, fmt.Errorf("%w: %v", errCoreRolledBack, err)
}
