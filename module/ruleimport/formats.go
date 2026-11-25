package ruleimport

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"math/bits"
	"net/netip"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
)

type FileOptions struct {
	Format      string
	Type        string
	DomainMatch string
	Template    string
	GeoSource   string
}

type destinationEntry struct {
	value string
	match string
}

func ParsePreview(filename string, input []byte, fallback string, targets map[string]bool, options FileOptions) ([]Rule, error) {
	if len(input) == 0 || len(input) > MaxFileBytes {
		return nil, errFileSize
	}
	if hasIPListError(bytes.TrimSpace(bytes.TrimPrefix(input, []byte{0xef, 0xbb, 0xbf}))) {
		return nil, errIPListExport
	}
	switch options.Type {
	case "", "auto", "domain", "ip", "cidr", "geo":
	default:
		return nil, errors.New("укажите допустимый тип назначения")
	}
	switch options.DomainMatch {
	case "", "auto", "exact", "suffix", "wildcard", "keyword", "regex":
	default:
		return nil, errors.New("укажите допустимое совпадение домена")
	}
	format := options.Format
	if format == "" || format == "auto" {
		format = detectFormat(filename, input)
	}
	importer := importContext{fallback: fallback, targets: targets, options: options}
	var err error
	switch format {
	case "srs":
		err = readSRS(input, importer.appendEntry)
	case "geoip", "geosite", "dat":
		err = readDat(input, func(_ string, entry datRow) error {
			if entry.ip.IsValid() {
				if format == "geosite" {
					return errGeodata
				}
				return importer.appendEntry(destinationEntry{value: entry.ip.String()})
			}
			if format == "geoip" {
				return errGeodata
			}
			return importer.appendEntry(destinationEntry{value: entry.domain, match: entry.match})
		})
	default:
		data, decodeErr := decodeText(input)
		if decodeErr != nil {
			return nil, decodeErr
		}
		if options.Format == "" || options.Format == "auto" {
			format = detectFormat(filename, data)
		}
		err = importer.parseTextFormat(format, data)
	}
	if err != nil {
		return nil, err
	}
	if len(importer.rules) == 0 {
		return nil, errors.New("в файле нет правил выбранного формата")
	}
	return importer.rules, nil
}

func (importer *importContext) appendEntry(entry destinationEntry) error {
	return importer.appendMatch(entry.value, "", "", "", 0, false, entry.match)
}

var errIPListExport = errors.New("файл содержит сообщение об ошибке iplist. Выберите совместимый тип данных при выгрузке")

func hasIPListError(data []byte) bool {
	const prefix = "# error:"
	return len(data) >= len(prefix) && bytes.EqualFold(data[:len(prefix)], []byte(prefix))
}

func decodeText(raw []byte) ([]byte, error) {
	var data []byte
	var err error
	switch {
	case bytes.HasPrefix(raw, []byte{0xff, 0xfe}):
		data, err = unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder().Bytes(raw[2:])
	case bytes.HasPrefix(raw, []byte{0xfe, 0xff}):
		data, err = unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder().Bytes(raw[2:])
	case utf8.Valid(raw):
		data = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	default:
		data, err = charmap.Windows1251.NewDecoder().Bytes(raw)
	}
	if err != nil || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return nil, errors.New("ожидается текстовый файл или выбранная бинарная база")
	}
	data = bytes.TrimSpace(data)
	if hasIPListError(data) {
		return nil, errIPListExport
	}
	return data, nil
}

var lineFormats = []struct {
	format string
	expr   *regexp.Regexp
}{
	{"pac", regexp.MustCompile(`(?im)\bFindProxyForURL\s*\(|^\s*(?:const|let|var)\s+items\s*=\s*\[`)},
	{"mikrotik", regexp.MustCompile(`(?im)^\s*/(?:ip|ipv6)\s+firewall\s+address-list`)},
	{"switchy", regexp.MustCompile(`(?im)Switchy\s*-\s*RuleList|^\s*\[Wildcard\]`)},
	{"nfset", regexp.MustCompile(`(?im)^\s*(?:nftset|nfset)\s*=`)},
	{"ipset", regexp.MustCompile(`(?im)^\s*ipset(?:\s*=|\s+add\b)`)},
	{"kvas", regexp.MustCompile(`(?im)^\s*kvas\s+add\b`)},
	{"bat", regexp.MustCompile(`(?im)^\s*route\s+(?:-p\s+)?add\b`)},
	{"clashx", regexp.MustCompile(`(?im)^\s*(?:-\s*)?(?:['"]?DOMAIN(?:-SUFFIX|-KEYWORD|-REGEX)?|IP-CIDR6?),|^\s*payload:`)},
}

func detectFormat(filename string, data []byte) string {
	if bytes.HasPrefix(data, []byte("SRS")) {
		return "srs"
	}
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".srs":
		return "srs"
	case ".dat":
		return "dat"
	case ".pac":
		return "pac"
	case ".rsc":
		return "mikrotik"
	case ".bat":
		return "bat"
	case ".yaml", ".yml":
		return "clashx"
	case ".json":
		return "json"
	case ".csv":
		return "comma"
	case ".dlc":
		return "dlc"
	}
	if len(data) > 0 && data[0] == '\n' && slices.ContainsFunc(data[1:min(120, len(data))], func(unit byte) bool {
		return unit < '\t' || unit > '\r' && unit < ' '
	}) {
		return "dat"
	}
	for _, candidate := range lineFormats {
		if candidate.expr.Match(data) {
			return candidate.format
		}
	}
	if first := bytes.TrimSpace(data); len(first) > 0 && (first[0] == '[' || first[0] == '{') {
		return "json"
	}
	if looksLikeDLC(data) {
		return "dlc"
	}
	if name := strings.ToLower(filepath.Base(filename)); strings.Contains(name, "keenetic-dns") || strings.Contains(name, "wildcard") {
		return "wildcard"
	}
	if line := firstListLine(data); strings.ContainsAny(line, ",;\t") {
		return "comma"
	}
	return "text"
}

func (importer *importContext) parseTextFormat(format string, data []byte) error {
	switch format {
	case "dlc":
		return importer.readDLC(data)
	case "json", "amnezia", "singbox":
		return importer.alternateJSON(format, data)
	case "comma":
		return importer.alternateCSV(data)
	case "pac":
		return importer.readPAC(data)
	case "custom":
		return importer.readTemplate(data)
	case "clashx":
		return importer.readClash(data)
	case "text", "mikrotik", "switchy", "nfset", "ipset", "kvas", "bat", "wildcard":
		return importer.readFormattedLines(format, data)
	default:
		return errors.New("неизвестный формат списка маршрутов")
	}
}

func suffixEntry(host string) destinationEntry {
	if strings.HasPrefix(host, "*.") || strings.HasPrefix(host, ".") {
		return destinationEntry{value: strings.TrimPrefix(strings.TrimPrefix(host, "*"), "."), match: "wildcard"}
	}
	return destinationEntry{value: host, match: "suffix"}
}

func maskedIPv4(address, mask string) (string, error) {
	ip, err := netip.ParseAddr(address)
	if err != nil || !ip.Is4() {
		return "", errors.New("нужен IPv4-адрес для маски")
	}
	m, err := netip.ParseAddr(mask)
	if err != nil || !m.Is4() {
		return "", errors.New("некорректная маска IPv4")
	}
	bytes := m.As4()
	value := uint32(bytes[0])<<24 | uint32(bytes[1])<<16 | uint32(bytes[2])<<8 | uint32(bytes[3])
	reversed := ^value
	if reversed&(reversed+1) != 0 {
		return "", errors.New("некорректная маска IPv4")
	}
	return netip.PrefixFrom(ip, bits.OnesCount32(value)).Masked().String(), nil
}

var pacItems = regexp.MustCompile(`(?s)^(?:const|let|var)\s+items\s*=\s*(\[.*?\])\s*;`)

func (importer *importContext) readPAC(data []byte) error {
	match := pacItems.FindSubmatch(data)
	if len(match) == 0 {
		return errors.New("в PAC не найден статический массив items из экспорта iplist")
	}
	var values []json.RawMessage
	if json.Unmarshal(match[1], &values) != nil {
		return errors.New("не удалось прочитать статический массив PAC")
	}
	for _, raw := range values {
		var value string
		if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &value) == nil {
			if _, err := netip.ParseAddr(value); err == nil {
				if err := importer.appendEntry(destinationEntry{value: value}); err != nil {
					return err
				}
				continue
			}
			if err := importer.appendEntry(suffixEntry(value)); err != nil {
				return err
			}
			continue
		}
		var pair []string
		if json.Unmarshal(raw, &pair) != nil || len(pair) != 2 {
			return errors.New("PAC должен содержать домены или пары IPv4 и маска")
		}
		prefix, err := maskedIPv4(pair[0], pair[1])
		if err != nil {
			return err
		}
		if err := importer.appendEntry(destinationEntry{value: prefix}); err != nil {
			return err
		}
	}
	return nil
}

var templatePieces = regexp.MustCompile(`\{(?:data|group|site|shortmask|mask)\}`)

func (importer *importContext) readTemplate(data []byte) error {
	template := strings.ReplaceAll(importer.options.Template, "\r\n", "\n")
	if len(template) > 1000 || strings.Count(template, "{data}") != 1 {
		return errors.New("укажите шаблон iplist до 1000 символов с одним полем {data}")
	}
	var pattern strings.Builder
	pattern.WriteString("(?m)^")
	last := 0
	for _, positions := range templatePieces.FindAllStringIndex(template, -1) {
		pattern.WriteString(regexp.QuoteMeta(template[last:positions[0]]))
		if template[positions[0]:positions[1]] == "{data}" {
			pattern.WriteString(`([^\s"'<>]{1,512}?)`)
		} else {
			pattern.WriteString(`[^\r\n]{0,300}?`)
		}
		last = positions[1]
	}
	pattern.WriteString(regexp.QuoteMeta(template[last:]))
	pattern.WriteString(`[\t ]*$`)
	matches, err := regexp.Compile(pattern.String())
	if err != nil {
		return errors.New("не удалось разобрать шаблон iplist")
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	parsedEnd := 0
	for _, match := range matches.FindAllStringSubmatchIndex(text, maxRules+1) {
		if firstListLine([]byte(text[parsedEnd:match[0]])) != "" {
			return errors.New("часть файла не соответствует шаблону iplist")
		}
		if err := importer.appendEntry(destinationEntry{value: text[match[2]:match[3]]}); err != nil {
			return err
		}
		parsedEnd = match[1]
	}
	if firstListLine([]byte(text[parsedEnd:])) != "" {
		return errors.New("часть файла не соответствует шаблону iplist")
	}
	return nil
}

var csvTargets = regexp.MustCompile(`(?i)^(?:domain|domains|hostname|host|ip|ipv4|ipv6|ip4|ip6|cidr|cidr4|cidr6|address|subnet|target|домен|подсеть|адрес|ip-адрес)$`)

func (importer *importContext) alternateCSV(data []byte) error {
	line := firstListLine(data)
	reader := csv.NewReader(bytes.NewReader(data))
	if !strings.Contains(line, ",") && strings.Contains(line, ";") {
		reader.Comma = ';'
	} else if !strings.ContainsAny(line, ",;") && strings.Contains(line, "\t") {
		reader.Comma = '\t'
	}
	reader.Comment, reader.TrimLeadingSpace, reader.FieldsPerRecord = '#', true, -1
	rows, err := reader.ReadAll()
	if err != nil {
		return errors.New("проверьте разделители и кавычки CSV")
	}
	if len(rows) == 0 {
		return nil
	}
	columns := make([]int, 0)
	for i, value := range rows[0] {
		if reader.Comma == ',' && strings.TrimSpace(value) == "destination" {
			return importer.csv(data)
		}
		if csvTargets.MatchString(strings.TrimSpace(value)) {
			columns = append(columns, i)
		}
	}
	if len(columns) != 0 {
		rows = rows[1:]
	}
	for rowIndex, row := range rows {
		for index, value := range row {
			if len(columns) > 0 {
				found := false
				for _, column := range columns {
					found = found || column == index
				}
				if !found {
					continue
				}
			}
			if value = strings.TrimSpace(value); value != "" {
				if err := importer.appendEntry(destinationEntry{value: value}); err != nil {
					return fmt.Errorf("запись CSV %d, поле %d — %w", rowIndex+1, index+1, err)
				}
			}
		}
	}
	return nil
}

func firstListLine(data []byte) string {
	for line := range bytes.SplitSeq(data, []byte{'\n'}) {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 && trimmed[0] != '#' && trimmed[0] != ';' {
			return string(trimmed)
		}
	}
	return ""
}

var (
	mikrotikAddress = regexp.MustCompile(`(?i)^(?:(?:/ip|/ipv6)\s+firewall\s+address-list\s+)?add\s+.*?\baddress=(?:"([^"]+)"|'([^']+)'|([^\s;]+))`)
	batRoute        = regexp.MustCompile(`(?i)^route\s+(?:-p\s+)?add\s+(\S+)\s+mask\s+(\S+)`)
	kvasRoute       = regexp.MustCompile(`(?i)^kvas\s+add\s+['"]?([^\s'"]+)['"]?(?:\s+(y))?\s*$`)
	switchyRoute    = regexp.MustCompile(`^\*(?:\.)?([^/*]+)/\*$`)
	dnsmasqSet      = regexp.MustCompile(`(?i)^(?:ipset|nftset|nfset)\s*=\s*/(.+)/[^/]+$`)
	legacySet       = regexp.MustCompile(`(?i)^(?:ipset\s+)?add\s+\S+\s+(\S+)`)
)

func (importer *importContext) readFormattedLines(format string, data []byte) error {
	for index, row := range strings.Split(string(data), "\n") {
		value := strings.TrimSpace(row)
		lower := strings.ToLower(value)
		if value == "" || strings.HasPrefix(value, "#") || strings.HasPrefix(value, ";") ||
			strings.HasPrefix(lower, "@echo ") || strings.HasPrefix(lower, "rem ") || lower == "[wildcard]" || lower == "[switchy-rulelist]" ||
			lower == "/ip firewall address-list" || lower == "/ipv6 firewall address-list" {
			continue
		}
		items, err := formattedLine(format, value)
		if err != nil || len(items) == 0 {
			return fmt.Errorf("проверьте назначение по выбранному формату в строке %d", index+1)
		}
		for _, item := range items {
			if item.match == "" && format == "text" {
				text, target, found := strings.Cut(item.value, ">")
				if found && strings.TrimSpace(target) == "" {
					return fmt.Errorf("строка %d — укажите маршрут после >", index+1)
				}
				err = importer.append(text, "", "", target, 0, false)
			} else {
				err = importer.appendEntry(item)
			}
			if err != nil {
				return fmt.Errorf("строка %d — %w", index+1, err)
			}
		}
	}
	return nil
}

func formattedLine(format, line string) ([]destinationEntry, error) {
	switch format {
	case "mikrotik":
		match := mikrotikAddress.FindStringSubmatch(line)
		for i := 1; i < len(match); i++ {
			if match[i] != "" {
				return []destinationEntry{{value: match[i]}}, nil
			}
		}
	case "bat":
		if match := batRoute.FindStringSubmatch(line); match != nil {
			prefix, err := maskedIPv4(match[1], match[2])
			return []destinationEntry{{value: prefix}}, err
		}
	case "kvas":
		if match := kvasRoute.FindStringSubmatch(line); match != nil {
			if match[2] != "" {
				return []destinationEntry{suffixEntry(match[1])}, nil
			}
			return []destinationEntry{{value: match[1]}}, nil
		}
	case "switchy":
		if match := switchyRoute.FindStringSubmatch(line); match != nil {
			return []destinationEntry{suffixEntry(match[1])}, nil
		}
	case "nfset", "ipset":
		if match := dnsmasqSet.FindStringSubmatch(line); match != nil {
			if _, err := netip.ParsePrefix(match[1]); err == nil {
				return []destinationEntry{{value: "cidr:" + match[1]}}, nil
			}
			if _, err := netip.ParseAddr(match[1]); err == nil {
				return []destinationEntry{{value: "ip:" + match[1]}}, nil
			}
			values := strings.Split(match[1], "/")
			items := make([]destinationEntry, 0, len(values))
			for _, value := range values {
				items = append(items, suffixEntry(value))
			}
			return items, nil
		}
		if match := legacySet.FindStringSubmatch(line); match != nil {
			return []destinationEntry{{value: match[1]}}, nil
		}
	case "wildcard":
		var items []destinationEntry
		for _, value := range strings.FieldsFunc(line, func(c rune) bool { return c == ' ' || c == '\t' || c == ',' || c == ';' }) {
			items = append(items, suffixEntry(value))
		}
		return items, nil
	case "text":
		if strings.Contains(line, ">") {
			return []destinationEntry{{value: line}}, nil
		}
		values := strings.FieldsFunc(line, func(c rune) bool { return c == ' ' || c == '\t' || c == ',' || c == ';' })
		items := make([]destinationEntry, 0, len(values))
		for _, value := range values {
			if strings.HasPrefix(value, "#") {
				break
			}
			items = append(items, destinationEntry{value: value})
		}
		return items, nil
	}
	return nil, nil
}

func (importer *importContext) readClash(data []byte) error {
	var rows []string
	if bytes.Contains(data, []byte("payload:")) || bytes.Contains(data, []byte("rules:")) {
		var config struct {
			Payload []string `yaml:"payload"`
			Rules   []string `yaml:"rules"`
		}
		decoder := yaml.NewDecoder(bytes.NewReader(data))
		decoder.KnownFields(true)
		if err := decoder.Decode(&config); err != nil {
			return errors.New("проверьте YAML-список Clash в payload или rules")
		}
		rows = append(config.Payload, config.Rules...)
	} else {
		rows = strings.Split(string(data), "\n")
	}
	for _, row := range rows {
		row = strings.Trim(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(row), "- ")), `"'`)
		if row == "" || strings.HasPrefix(row, "#") {
			continue
		}
		kind, destination, found := strings.Cut(row, ",")
		if !found {
			if err := importer.appendEntry(destinationEntry{value: row}); err != nil {
				return err
			}
			continue
		}
		destination, _, _ = strings.Cut(destination, ",")
		entry := destinationEntry{value: strings.TrimSpace(destination)}
		switch strings.ToUpper(strings.TrimSpace(kind)) {
		case "DOMAIN":
			entry.match = "exact"
		case "DOMAIN-SUFFIX":
			entry = suffixEntry(entry.value)
		case "DOMAIN-KEYWORD":
			entry.match = "keyword"
		case "DOMAIN-REGEX":
			entry.match = "regex"
		case "IP-CIDR", "IP-CIDR6":
		default:
			return errors.New("Clash-список содержит правило без поддерживаемого назначения")
		}
		if err := importer.appendEntry(entry); err != nil {
			return err
		}
	}
	return nil
}
