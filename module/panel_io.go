package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"

	"routehub/devicepolicy"
	"routehub/ruleimport"
)

const maxRuleFileBytes = ruleimport.MaxFileBytes
const maxRuleRequestBytes = maxRuleFileBytes + (16 << 10)

var errRuleFileSize = errors.New("размер файла правил не должен превышать 2 МиБ")

type ruleUpload struct {
	filename string
	data     []byte
	target   string
	options  ruleimport.FileOptions
}

func readRuleUpload(reader *multipart.Reader) (ruleUpload, error) {
	var upload ruleUpload
	seenFields := make(map[string]bool)
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return ruleUpload{}, err
		}
		name := part.FormName()
		switch name {
		case "file":
			if upload.filename != "" || part.FileName() == "" {
				return ruleUpload{}, errors.New("загрузите один файл правил")
			}
			upload.filename = part.FileName()
			upload.data, err = io.ReadAll(io.LimitReader(part, maxRuleFileBytes+1))
			if len(upload.data) > maxRuleFileBytes {
				return ruleUpload{}, errRuleFileSize
			}
		case "target", "format", "type", "domainMatch", "template", "geoSource":
			if seenFields[name] || part.FileName() != "" {
				return ruleUpload{}, errors.New("поле импорта продублировано")
			}
			seenFields[name] = true
			limit := 128
			if name == "template" {
				limit = 1000
			}
			var value []byte
			value, err = io.ReadAll(io.LimitReader(part, int64(limit)+1))
			if len(value) > limit {
				return ruleUpload{}, errors.New("слишком длинный параметр импорта")
			}
			field := strings.TrimSpace(string(value))
			switch name {
			case "target":
				upload.target = field
			case "format":
				upload.options.Format = field
			case "type":
				upload.options.Type = field
			case "domainMatch":
				upload.options.DomainMatch = field
			case "template":
				upload.options.Template = string(value)
			case "geoSource":
				upload.options.GeoSource = field
			}
		default:
			return ruleUpload{}, errors.New("в запросе есть неизвестное поле")
		}
		if err != nil {
			return ruleUpload{}, err
		}
	}
	if upload.filename == "" {
		return ruleUpload{}, errors.New("загрузите файл правил")
	}
	return upload, nil
}

func (editor *panelEditor) importRules(response http.ResponseWriter, request *http.Request) {
	if !editor.authorized(request) {
		sendJSON(response, http.StatusForbidden, object{"error": "Доступ к импорту запрещён"})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxRuleRequestBytes)
	reader, err := request.MultipartReader()
	if err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": "Загрузите файл через multipart/form-data"})
		return
	}
	upload, err := readRuleUpload(reader)
	if err != nil {
		var overflow *http.MaxBytesError
		if errors.Is(err, errRuleFileSize) || errors.As(err, &overflow) {
			sendJSON(response, http.StatusRequestEntityTooLarge, object{"error": errRuleFileSize.Error()})
		} else {
			sendJSON(response, http.StatusBadRequest, object{"error": "Проверьте файл и маршрут для импорта"})
		}
		return
	}

	config := editor.current().plan
	targets := map[string]bool{"direct": true, "zapret": true, "@block": true, "@vpn": true}
	for _, profile := range config.Profiles {
		targets[profile.ID] = true
	}
	target := fallback(upload.target, fallback(config.DefaultTarget, "direct"))
	if !targets[target] {
		sendJSON(response, http.StatusBadRequest, object{"error": "Выберите существующий маршрут"})
		return
	}
	rules, err := ruleimport.ParsePreview(upload.filename, upload.data, target, targets, upload.options)
	if err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": err.Error()})
		return
	}
	for _, rule := range rules {
		if rule.GeoIP == "" {
			continue
		}
		found := false
		for _, source := range config.GeoSources {
			if source.ID == rule.GeoSource {
				found = true
				break
			}
		}
		if !found {
			sendJSON(response, http.StatusBadRequest, object{"error": "Выберите настроенный источник GeoIP"})
			return
		}
	}
	sendJSON(response, http.StatusOK, object{"rules": rules})
}

func (editor *panelEditor) backup(response http.ResponseWriter, request *http.Request) {
	if !editor.authorized(request) {
		sendJSON(response, http.StatusForbidden, object{"error": "Доступ к экспорту запрещён"})
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		sendJSON(response, http.StatusUnsupportedMediaType, object{"error": "Требуется application/json"})
		return
	}
	var input struct {
		Scope     string `json:"scope"`
		DeviceMAC string `json:"deviceMAC,omitempty"`
	}
	if err := decodeJSON(http.MaxBytesReader(response, request.Body, 1024), &input); err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": "Выберите содержимое экспорта"})
		return
	}

	config := editor.current().plan
	var filename string
	var content any
	switch input.Scope {
	case "rules":
		filename = "routehub-rules.json"
		rules := config.Rules
		if input.DeviceMAC != "" {
			mac, err := devicepolicy.NormalizeMAC(input.DeviceMAC)
			if err != nil {
				sendJSON(response, http.StatusBadRequest, object{"error": "Некорректный MAC устройства"})
				return
			}
			found := false
			for _, device := range config.Devices {
				if deviceMAC, _ := devicepolicy.NormalizeMAC(device.MAC); deviceMAC == mac {
					rules, found = device.Rules, true
					break
				}
			}
			if !found {
				sendJSON(response, http.StatusNotFound, object{"error": "Устройство не найдено"})
				return
			}
		}
		if rules == nil {
			rules = []rule{}
		}
		content = object{"rules": exportPanelRules(rules, config.NamedSets)}
	case "configuration":
		if input.DeviceMAC != "" {
			sendJSON(response, http.StatusBadRequest, object{"error": "Для экспорта полной конфигурации оставьте выбор устройства пустым"})
			return
		}
		filename = "routehub-config.json"
		content = config
	default:
		sendJSON(response, http.StatusBadRequest, object{"error": "Выберите правила или полную конфигурацию"})
		return
	}
	data, err := json.MarshalIndent(content, "", "  ")
	if err != nil {
		sendJSON(response, http.StatusInternalServerError, object{"error": "Не удалось подготовить экспорт"})
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	response.Header().Set("Cache-Control", "no-store")
	_, _ = response.Write(append(data, '\n'))
}

// A rules-only backup is portable. It carries the destinations inline, while
// a full configuration retains the original set definitions and references.
func exportPanelRules(rules []rule, sets []devicepolicy.NamedSet) []any {
	byID := make(map[string]devicepolicy.NamedSet, len(sets))
	for _, set := range sets {
		byID[set.ID] = set
	}
	out := make([]any, 0, len(rules))
	for _, current := range rules {
		if current.NamedSet == "" {
			out = append(out, current)
			continue
		}
		set := byID[current.NamedSet]
		current.NamedSet = ""
		item := struct {
			rule
			Domains []string `json:"domain,omitempty"`
			IPs     []string `json:"ip,omitempty"`
		}{rule: current}
		if set.Kind == "domains" {
			for _, entry := range set.Entries {
				domain, _ := devicepolicy.NormalizeRoutingDomain(entry)
				item.Domains = append(item.Domains, "domain:"+domain)
			}
		} else {
			for _, entry := range set.Entries {
				item.IPs = append(item.IPs, strings.TrimSpace(entry))
			}
		}
		out = append(out, item)
	}
	return out
}
