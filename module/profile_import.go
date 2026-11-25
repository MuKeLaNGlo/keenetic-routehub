package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxProfileFileBytes = 512 << 10
const maxProfileRequestBytes = maxProfileFileBytes + (16 << 10)

var errProfileFileSize = errors.New("размер файла профилей не должен превышать 512 КиБ")

type profileImportPreview struct {
	Profiles []profile `json:"profiles"`
	Note     string    `json:"note,omitempty"`
}

type profileUpload struct {
	data          []byte
	interfaceName string
	awgVersion    string
}

func readProfileUpload(reader *multipart.Reader) (profileUpload, error) {
	var upload profileUpload
	var hasFile, hasInterface, hasVersion bool
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return profileUpload{}, err
		}
		switch part.FormName() {
		case "file":
			if hasFile || part.FileName() == "" {
				return profileUpload{}, errors.New("загрузите один файл профилей")
			}
			hasFile = true
			upload.data, err = io.ReadAll(io.LimitReader(part, maxProfileFileBytes+1))
			if len(upload.data) > maxProfileFileBytes {
				return profileUpload{}, errProfileFileSize
			}
		case "interface":
			if hasInterface || part.FileName() != "" {
				return profileUpload{}, errors.New("укажите одно имя интерфейса WireGuard ASC")
			}
			hasInterface = true
			var value []byte
			value, err = io.ReadAll(io.LimitReader(part, 64))
			if len(value) >= 64 {
				return profileUpload{}, errors.New("слишком длинное имя интерфейса")
			}
			upload.interfaceName = strings.TrimSpace(string(value))
		case "awgVersion":
			if hasVersion || part.FileName() != "" {
				return profileUpload{}, errors.New("укажите одну версию AmneziaWG")
			}
			hasVersion = true
			var value []byte
			value, err = io.ReadAll(io.LimitReader(part, 8))
			upload.awgVersion = strings.TrimSpace(string(value))
			if len(value) >= 8 || !validAWGVersion(upload.awgVersion) {
				return profileUpload{}, errors.New("выберите AmneziaWG 2.0 или 3.1")
			}
		default:
			return profileUpload{}, errors.New("в запросе есть неизвестное поле")
		}
		if err != nil {
			return profileUpload{}, err
		}
	}
	if !hasFile {
		return profileUpload{}, errors.New("загрузите файл профилей")
	}
	return upload, nil
}

// importProfiles prepares a draft. Installation and persistence use the normal
// panel update with the plan revision.
func (editor *panelEditor) importProfiles(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if !editor.authorized(request) {
		sendJSON(response, http.StatusForbidden, object{"error": "Доступ к импорту запрещён"})
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		sendJSON(response, http.StatusUnsupportedMediaType, object{"error": "Загрузите файл через multipart/form-data"})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxProfileRequestBytes)
	reader, err := request.MultipartReader()
	if err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": "Проверьте форму загрузки файла"})
		return
	}
	upload, err := readProfileUpload(reader)
	if err != nil {
		var overflow *http.MaxBytesError
		if errors.Is(err, errProfileFileSize) || errors.As(err, &overflow) {
			sendJSON(response, http.StatusRequestEntityTooLarge, object{"error": errProfileFileSize.Error()})
		} else {
			sendJSON(response, http.StatusBadRequest, object{"error": "Загрузите один файл профилей и при необходимости укажите интерфейс WireGuard ASC"})
		}
		return
	}
	preview, err := parseProfileUpload(upload, editor.current().plan.Profiles)
	if err != nil {
		sendJSON(response, http.StatusBadRequest, object{"error": err.Error()})
		return
	}
	sendJSON(response, http.StatusOK, preview)
}

type uploadLine struct {
	value  string
	number int
}

func parseProfileUpload(upload profileUpload, existing []profile) (profileImportPreview, error) {
	if !utf8.Valid(upload.data) || bytes.IndexByte(upload.data, 0) >= 0 {
		return profileImportPreview{}, errors.New("выберите текстовый файл в кодировке UTF-8")
	}
	data := bytes.TrimPrefix(upload.data, []byte{0xef, 0xbb, 0xbf})
	var lines []uploadLine
	for index, row := range strings.Split(strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(string(data)), "\n") {
		value := strings.TrimSpace(row)
		if value != "" && !strings.HasPrefix(value, "#") && !strings.HasPrefix(value, ";") {
			lines = append(lines, uploadLine{value: value, number: index + 1})
		}
	}
	var preview profileImportPreview
	var err error
	var first string
	if len(lines) > 0 {
		first = strings.ToLower(lines[0].value)
	}
	switch {
	case first == "" && upload.interfaceName != "":
		if upload.awgVersion != "" || !interfaceName(upload.interfaceName) {
			return profileImportPreview{}, errors.New("укажите имя уже настроенного интерфейса WireGuard ASC")
		}
		preview = profileImportPreview{
			Profiles: []profile{{Protocol: "amneziawg", Interface: upload.interfaceName}},
			Note:     "Интерфейс WireGuard ASC будет проверен при применении.",
		}
	case first == "":
		return profileImportPreview{}, errors.New("в файле нет профилей")
	case strings.HasPrefix(first, "[interface]") || strings.HasPrefix(first, "[peer]"):
		if upload.interfaceName != "" {
			preview, err = parseAWGProfile(lines, upload.interfaceName)
		} else {
			preview, err = parseManagedAWGPreview(string(data), upload.awgVersion)
		}
	case upload.interfaceName != "" || upload.awgVersion != "":
		return profileImportPreview{}, errors.New("параметры WireGuard указываются для файла AmneziaWG")
	case first == "[internetshortcut]":
		preview, err = parseURLShortcut(lines)
	case strings.HasPrefix(first, "{") || strings.HasPrefix(first, "[") || strings.HasPrefix(first, "//") || strings.HasPrefix(first, "/*"):
		preview, err = parseXrayProfiles(data)
	case strings.Contains(first, "://") && !strings.Contains(strings.SplitN(first, "://", 2)[0], ":") || strings.HasPrefix(first, "url="):
		preview, err = parseProfileLinks(lines)
	case strings.Contains(first, ":") || strings.HasPrefix(first, "- ") || strings.HasPrefix(first, "---"):
		preview, err = parseYAMLProfiles(data)
	default:
		return profileImportPreview{}, errors.New("выберите ссылки VLESS, Hysteria2 или Trojan, JSON, YAML либо файл AmneziaWG .conf")
	}
	if err != nil {
		return profileImportPreview{}, err
	}
	used := make(map[string]bool, len(existing)+len(preview.Profiles))
	for _, entry := range existing {
		used[entry.ID] = true
	}
	serial := make(map[string]int)
	for i, entry := range preview.Profiles {
		for {
			serial[entry.Protocol]++
			entry.ID = entry.Protocol + "-" + strconv.Itoa(serial[entry.Protocol])
			if !used[entry.ID] {
				break
			}
		}
		used[entry.ID] = true
		entry.Server = profileServer(entry)
		preview.Profiles[i] = entry
	}
	return preview, nil
}

func parseURLShortcut(lines []uploadLine) (profileImportPreview, error) {
	for _, row := range lines[1:] {
		key, value, ok := strings.Cut(row.value, "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "URL") {
			return parseProfileLinks([]uploadLine{{value: strings.TrimSpace(value), number: row.number}})
		}
	}
	return profileImportPreview{}, errors.New("в файле URL нет ссылки VPN")
}

func parseProfileLinks(lines []uploadLine) (profileImportPreview, error) {
	profiles := make([]profile, 0, len(lines))
	for _, line := range lines {
		value := line.value
		if key, data, ok := strings.Cut(value, "="); ok && strings.EqualFold(strings.TrimSpace(key), "URL") {
			value = strings.TrimSpace(data)
		}
		uri, fragment, _ := strings.Cut(value, "#")
		uri = strings.TrimSpace(uri)
		scheme, _, hasDelimiter := strings.Cut(uri, "://")
		if !hasDelimiter {
			return profileImportPreview{}, fmt.Errorf("проверьте ссылку в строке %d", line.number)
		}
		protocol := strings.ToLower(scheme)
		switch protocol {
		case "hy2":
			protocol = "hysteria2"
		case "vless", "hysteria2", "trojan":
		case "vpn":
			return profileImportPreview{}, errors.New("для AmneziaWG экспортируйте файл .conf из AmneziaVPN")
		default:
			return profileImportPreview{}, fmt.Errorf("в строке %d поддерживаются ссылки VLESS, Hysteria2 и Trojan", line.number)
		}
		label, _ := url.PathUnescape(fragment)
		entry := profile{Protocol: protocol, URI: uri, Label: importedLabel(label)}
		if _, err := profileOutbound(entry); err != nil {
			return profileImportPreview{}, fmt.Errorf("проверьте адрес, порт и транспорт ссылки в строке %d. Для нестандартного транспорта загрузите JSON Xray", line.number)
		}
		profiles = append(profiles, entry)
	}
	return profileImportPreview{Profiles: profiles}, nil
}

func parseAWGProfile(lines []uploadLine, name string) (profileImportPreview, error) {
	var section string
	var hasPrivateKey, hasPeerKey, hasObfuscation bool
	var peerLine int
	for _, line := range lines {
		value, _, _ := strings.Cut(line.value, "#")
		value, _, _ = strings.Cut(value, ";")
		value = strings.TrimSpace(value)
		switch strings.ToLower(value) {
		case "[interface]":
			if section != "" {
				return profileImportPreview{}, fmt.Errorf("в файле AmneziaWG нужна одна секция [Interface], повтор в строке %d", line.number)
			}
			section = "interface"
			continue
		case "[peer]":
			if section == "" {
				return profileImportPreview{}, errors.New("начните конфигурацию AmneziaWG с секции [Interface]")
			}
			if peerLine != 0 && !hasPeerKey {
				return profileImportPreview{}, fmt.Errorf("добавьте PublicKey в секцию [Peer] со строки %d", peerLine)
			}
			section, peerLine, hasPeerKey = "peer", line.number, false
			continue
		}
		key, field, ok := strings.Cut(value, "=")
		key = strings.ToLower(strings.TrimSpace(key))
		if section == "" || !ok || key == "" || strings.TrimSpace(field) == "" {
			return profileImportPreview{}, fmt.Errorf("проверьте запись .conf в строке %d", line.number)
		}
		if section == "interface" {
			hasPrivateKey = hasPrivateKey || key == "privatekey"
			switch key {
			case "jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5":
				hasObfuscation = true
			}
		} else {
			hasPeerKey = hasPeerKey || key == "publickey"
		}
	}
	if !hasObfuscation {
		return profileImportPreview{}, errors.New("найден WireGuard. Для AmneziaWG нужен файл .conf с параметрами обфускации в секции [Interface]")
	}
	if !hasPrivateKey || peerLine == 0 || !hasPeerKey {
		return profileImportPreview{}, errors.New("проверьте PrivateKey в [Interface] и PublicKey в каждой секции [Peer]")
	}
	entry := profile{Protocol: "amneziawg", Interface: name}
	if name != "" {
		if !interfaceName(name) {
			return profileImportPreview{}, errors.New("укажите имя интерфейса WireGuard ASC на Keenetic")
		}
		if _, err := profileOutbound(profile{ID: "amneziawg", Protocol: entry.Protocol, Interface: name}); err != nil {
			return profileImportPreview{}, errors.New("укажите имя интерфейса WireGuard ASC на Keenetic")
		}
	}
	return profileImportPreview{
		Profiles: []profile{entry},
		Note:     "В RouteHub указывается имя уже настроенного интерфейса WireGuard ASC. Импортируйте файл AmneziaWG в KeeneticOS перед применением профиля.",
	}, nil
}

func parseXrayProfiles(data []byte) (profileImportPreview, error) {
	data, err := removeXrayComments(data)
	if err != nil {
		return profileImportPreview{}, err
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return profileImportPreview{}, errors.New("в файле нет профилей Xray")
	}
	var entries []json.RawMessage
	if data[0] == '{' {
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(data, &envelope); err != nil {
			return profileImportPreview{}, errors.New("проверьте синтаксис JSON Xray")
		}
		if proxies, ok := envelope["proxies"]; ok {
			return parseExternalProfiles(proxies)
		}
		if outbounds, ok := envelope["outbounds"]; ok {
			if raw := bytes.TrimSpace(outbounds); len(raw) == 0 || raw[0] != '[' {
				return profileImportPreview{}, errors.New("поле outbounds в JSON Xray должно быть массивом")
			}
			data = outbounds
		} else if envelope["server"] != nil || envelope["type"] != nil && envelope["protocol"] == nil {
			return parseExternalProfiles(data)
		} else {
			entries = []json.RawMessage{data}
		}
	}
	if entries == nil {
		if err := json.Unmarshal(data, &entries); err != nil {
			return profileImportPreview{}, errors.New("проверьте синтаксис массива outbounds Xray")
		}
	}

	preview := profileImportPreview{Profiles: make([]profile, 0, len(entries))}
	for index, entry := range entries {
		parsed, err := parseXrayOutbound(entry, index+1)
		if err != nil {
			return profileImportPreview{}, err
		}
		if parsed.Protocol == "" {
			preview.Note = "В предпросмотр включены VPN-профили. Служебные выходы Xray для прямого доступа, блокировки и DNS пропущены."
			continue
		}
		preview.Profiles = append(preview.Profiles, parsed)
	}
	if len(preview.Profiles) == 0 {
		return profileImportPreview{}, errors.New("в JSON Xray нет выходов VLESS, Hysteria2 или Trojan")
	}
	return preview, nil
}

// Xray accepts line and block comments. Preserve JSON strings verbatim and
// replace comment bytes with whitespace so tokens cannot accidentally merge.
func removeXrayComments(data []byte) ([]byte, error) {
	clean := bytes.Clone(data)
	var quoted bool
	for i := 0; i < len(data); i++ {
		if quoted {
			switch data[i] {
			case '\\':
				i++
			case '"':
				quoted = false
			}
			continue
		}
		if data[i] == '"' {
			quoted = true
			continue
		}
		if data[i] != '/' || i+1 >= len(data) {
			continue
		}
		end := len(data)
		switch data[i+1] {
		case '/':
			if offset := bytes.IndexAny(data[i+2:], "\r\n"); offset >= 0 {
				end = i + 2 + offset
			}
		case '*':
			offset := bytes.Index(data[i+2:], []byte("*/"))
			if offset < 0 {
				return nil, errors.New("закройте комментарий в JSON Xray")
			}
			end = i + 4 + offset
		default:
			continue
		}
		for j := i; j < end; j++ {
			if clean[j] != '\n' && clean[j] != '\r' {
				clean[j] = ' '
			}
		}
		i = end - 1
	}
	return clean, nil
}

type xrayImportedServer struct {
	Address  string `json:"address"`
	Port     uint16 `json:"port"`
	ID       string `json:"id"`
	Password string `json:"password"`
	Users    []struct {
		ID string `json:"id"`
	} `json:"users"`
}

type xrayImportedSettings struct {
	xrayImportedServer
	Version uint8                `json:"version"`
	VNext   []xrayImportedServer `json:"vnext"`
	Servers []xrayImportedServer `json:"servers"`
}

func parseXrayOutbound(raw []byte, number int) (profile, error) {
	var shape struct {
		Protocol      string          `json:"protocol"`
		Type          string          `json:"type"`
		Tag           string          `json:"tag"`
		Settings      json.RawMessage `json:"settings"`
		ProxySettings struct {
			Tag string `json:"tag"`
		} `json:"proxySettings"`
		StreamSettings struct {
			Network string `json:"network"`
			Sockopt struct {
				DialerProxy string `json:"dialerProxy"`
			} `json:"sockopt"`
			Hysteria struct {
				Version uint8 `json:"version"`
			} `json:"hysteriaSettings"`
		} `json:"streamSettings"`
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &shape) != nil {
		return profile{}, fmt.Errorf("проверьте объект outbound %d в JSON Xray", number)
	}
	if shape.Protocol == "" && shape.Type != "" {
		return parseExternalOutbound(raw, number)
	}
	protocol := shape.Protocol
	switch shape.Protocol {
	case "freedom", "blackhole", "dns":
		return profile{}, nil
	case "vless", "trojan":
	case "hysteria":
		protocol = "hysteria2"
	default:
		return profile{}, fmt.Errorf("для outbound %d поддерживаются протоколы Xray VLESS, Hysteria2 и Trojan", number)
	}
	if shape.ProxySettings.Tag != "" || shape.StreamSettings.Sockopt.DialerProxy != "" {
		return profile{}, fmt.Errorf("outbound %d ссылается на другой выход. Экспортируйте самостоятельный VPN-профиль", number)
	}
	var settings xrayImportedSettings
	if err := json.Unmarshal(shape.Settings, &settings); err != nil || !validXraySettings(protocol, settings) {
		return profile{}, fmt.Errorf("проверьте адрес, порт и данные подключения в settings для outbound %d", number)
	}
	if protocol == "hysteria2" && (settings.Version != 2 || shape.StreamSettings.Network != "hysteria" || shape.StreamSettings.Hysteria.Version != 2) {
		return profile{}, fmt.Errorf("для Hysteria2 в outbound %d укажите версию 2 и параметры транспорта hysteria", number)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return profile{}, fmt.Errorf("проверьте объект outbound %d в JSON Xray", number)
	}
	delete(fields, "tag")
	outbound, err := json.Marshal(fields)
	if err != nil {
		return profile{}, fmt.Errorf("проверьте объект outbound %d в JSON Xray", number)
	}
	return profile{Protocol: protocol, Outbound: outbound, Label: importedLabel(shape.Tag)}, nil
}

func validXraySettings(protocol string, settings xrayImportedSettings) bool {
	switch protocol {
	case "vless":
		if len(settings.VNext) == 0 {
			return validXrayServer(settings.xrayImportedServer) && strings.TrimSpace(settings.ID) != ""
		}
		for _, server := range settings.VNext {
			if !validXrayServer(server) || len(server.Users) == 0 {
				return false
			}
			for _, user := range server.Users {
				if strings.TrimSpace(user.ID) == "" {
					return false
				}
			}
		}
		return true
	case "trojan":
		servers := settings.Servers
		if len(servers) == 0 {
			servers = []xrayImportedServer{settings.xrayImportedServer}
		}
		for _, server := range servers {
			if !validXrayServer(server) || server.Password == "" {
				return false
			}
		}
		return true
	default:
		return validXrayServer(settings.xrayImportedServer)
	}
}

func validXrayServer(server xrayImportedServer) bool {
	address, _ := netip.ParseAddr(server.Address)
	return server.Port != 0 && server.Address == strings.TrimSpace(server.Address) && address.Zone() == "" &&
		(address.IsValid() || validDomain(normalizeHost(server.Address)))
}
