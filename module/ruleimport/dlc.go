package ruleimport

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

func splitDLCLine(line string) (kind, value string, explicit bool) {
	line, _, _ = strings.Cut(line, "#")
	line = strings.TrimSpace(line)
	kind, value, explicit = strings.Cut(line, ":")
	if !explicit {
		return "suffix", kind, false
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "domain", "suffix":
		return "suffix", value, true
	case "full", "exact":
		return "exact", value, true
	case "keyword":
		return "keyword", value, true
	case "regexp", "regex":
		return "regex", value, true
	case "include":
		return "include", value, true
	default:
		return "", value, true
	}
}

func looksLikeDLC(data []byte) bool {
	marker, otherFormat := false, false
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		kind, value, explicit := splitDLCLine(line)
		if kind == "include" {
			return true // An unresolved source reference must never fall through.
		}
		fields := strings.Fields(value)
		if kind == "" {
			otherFormat = true
		} else if len(fields) > 0 {
			if kind != "regex" && strings.ContainsAny(fields[0], ">/,;") ||
				kind == "suffix" && strings.HasPrefix(fields[0], "*.") {
				otherFormat = true
			}
			if _, err := netip.ParseAddr(fields[0]); !explicit && err == nil {
				otherFormat = true
			}
			for _, extra := range fields[1:] {
				if !strings.HasPrefix(extra, "@") && !strings.HasPrefix(extra, "&") {
					otherFormat = true // Preserve ordinary text routes with explicit targets.
					break
				}
			}
			beforeComment, _, hasComment := strings.Cut(line, "#")
			attachedComment := hasComment && strings.HasSuffix(beforeComment, fields[0]) && strings.Contains(fields[0], ".")
			marker = marker || explicit || len(fields) > 1 || attachedComment
		}
	}
	return marker && !otherFormat
}

func dlcName(text, punctuation string) bool {
	if len(text) == 0 || len(text) > 253 {
		return false
	}
	for _, char := range strings.ToLower(text) {
		if !(char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || strings.ContainsRune(punctuation, char)) {
			return false
		}
	}
	return true
}

func dlcEntry(kind string, fields []string) (destinationEntry, error) {
	if len(fields) == 0 {
		return destinationEntry{}, errors.New("укажите значение правила")
	}
	value := fields[0]
	if kind == "include" && !dlcName(value, "!-") {
		return destinationEntry{}, errors.New("некорректное имя списка include")
	}
	for _, field := range fields[1:] {
		switch field[0] {
		case '@':
			tag := field[1:]
			if kind == "include" {
				tag = strings.TrimPrefix(tag, "-")
			}
			if !dlcName(tag, "!") {
				return destinationEntry{}, errors.New("некорректный атрибут списка v2fly")
			}
		case '&':
			if kind == "include" || !dlcName(field[1:], "!-") {
				return destinationEntry{}, errors.New("некорректная метка группы списка v2fly")
			}
		default:
			return destinationEntry{}, errors.New("ожидается атрибут @ или метка группы &")
		}
	}
	switch kind {
	case "include":
		return destinationEntry{}, fmt.Errorf("список include:%s отсутствует в загруженном файле. Загрузите развёрнутый список со всеми включёнными доменами", value)
	case "keyword":
		if !dlcName(value, ".-") {
			return destinationEntry{}, errors.New("ключевое слово должно состоять из букв, цифр, точек и дефисов")
		}
		value = strings.ToLower(value)
	case "suffix", "exact":
		if strings.Contains(value, ":") {
			return destinationEntry{}, errors.New("ожидается домен без URL, порта или другого префикса")
		}
	case "regex":
		value = "regexp:" + value
	default:
		return destinationEntry{}, errors.New("неизвестный тип правила списка v2fly")
	}
	return destinationEntry{value: value, match: kind}, nil
}

func (importer *importContext) readDLC(data []byte) error {
	switch importer.options.Type {
	case "", "auto", "domain":
	default:
		return errors.New("список v2fly содержит только доменные правила")
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	for line := 1; scanner.Scan(); line++ {
		kind, value, explicit := splitDLCLine(scanner.Text())
		if kind == "suffix" && value == "" && !explicit {
			continue
		}
		entry, err := dlcEntry(kind, strings.Fields(value))
		if err == nil {
			err = importer.appendEntry(entry)
		}
		if err != nil {
			return fmt.Errorf("строка %d списка v2fly — %w", line, err)
		}
	}
	return scanner.Err()
}
