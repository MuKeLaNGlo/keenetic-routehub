use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    path::Path,
    sync::LazyLock,
};

use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1251};
use ipnet::{IpNet, Ipv4Net};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::{
    BOM, Destination, ERR_EXPORT, Importer, MAX_RULES, ParseResult, RowOptions, csv::CsvRows,
    export_error, ext, read_port,
};

pub(crate) fn decode_text(raw: &[u8]) -> ParseResult<String> {
    let decoded = if let Some(raw) = raw.strip_prefix(&[0xff, 0xfe]) {
        UTF_16LE.decode_without_bom_handling(raw).0.into_owned()
    } else if let Some(raw) = raw.strip_prefix(&[0xfe, 0xff]) {
        UTF_16BE.decode_without_bom_handling(raw).0.into_owned()
    } else if let Ok(text) = std::str::from_utf8(raw.strip_prefix(BOM).unwrap_or(raw)) {
        text.into()
    } else {
        WINDOWS_1251.decode_without_bom_handling(raw).0.into_owned()
    };
    if decoded.contains('\0') {
        return Err("ожидается текстовый файл или выбранная бинарная база".into());
    }
    if export_error(decoded.trim().as_bytes()) {
        return Err(ERR_EXPORT.into());
    }
    Ok(decoded)
}

type FormatPattern = (&'static str, Regex);

static LINE_FORMATS: LazyLock<Vec<FormatPattern>> = LazyLock::new(|| {
    [
        ("pac", r"(?im)\bFindProxyForURL\s*\(|^\s*(?:const|let|var)\s+items\s*=\s*\["),
        ("mikrotik", r"(?im)^\s*/(?:ip|ipv6)\s+firewall\s+address-list"),
        ("switchy", r"(?im)Switchy\s*-\s*RuleList|^\s*\[Wildcard\]"),
        ("nfset", r"(?im)^\s*(?:nftset|nfset)\s*="),
        ("ipset", r"(?im)^\s*ipset(?:\s*=|\s+add\b)"),
        ("kvas", r"(?im)^\s*kvas\s+add\b"),
        ("bat", r"(?im)^\s*route\s+(?:-p\s+)?add\b"),
        ("clashx", r#"(?im)^\s*(?:-\s*)?(?:['"]?DOMAIN(?:-SUFFIX|-KEYWORD|-REGEX)?|IP-CIDR6?),|^\s*payload:"#),
    ].into_iter().map(|(name, pattern)| (name, Regex::new(pattern).unwrap())).collect()
});

pub(crate) fn detect_format(filename: &str, data: &[u8]) -> &'static str {
    if data.starts_with(b"SRS") {
        return "srs";
    }
    match ext(filename).as_str() {
        "srs" => return "srs",
        "dat" => return "dat",
        "pac" => return "pac",
        "rsc" => return "mikrotik",
        "bat" => return "bat",
        "yaml" | "yml" => return "clashx",
        "json" => return "json",
        "csv" => return "comma",
        "dlc" => return "dlc",
        _ => {}
    }
    if data.starts_with(b"\n")
        && data[1..data.len().min(120)]
            .iter()
            .any(|&b| b < b'\t' || b > b'\r' && b < b' ')
    {
        return "dat";
    }
    let content = String::from_utf8_lossy(data);
    if let Some((name, _)) = LINE_FORMATS
        .iter()
        .find(|(_, regex)| regex.is_match(&content))
    {
        return name;
    }
    let content = content.trim();
    if content.starts_with(['[', '{']) {
        return "json";
    }
    if looks_like_dlc(content) {
        return "dlc";
    }
    let name = Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.contains("keenetic-dns") || name.contains("wildcard") {
        return "wildcard";
    }
    if first_list_line(content).contains([',', ';', '\t']) {
        return "comma";
    }
    "text"
}

fn first_list_line(data: &str) -> &str {
    data.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with(['#', ';']))
        .unwrap_or("")
}

pub(crate) fn suffix_entry(host: &str) -> Destination {
    if host.starts_with("*.") || host.starts_with('.') {
        return Destination::new(
            host.strip_prefix('*')
                .unwrap_or(host)
                .strip_prefix('.')
                .unwrap(),
            "wildcard",
        );
    }
    Destination::new(host, "suffix")
}

fn masked_ipv4(addr: &str, mask: &str) -> ParseResult<String> {
    let addr = addr
        .parse::<Ipv4Addr>()
        .map_err(|_| "нужен IPv4-адрес для маски")?;
    let mask = mask
        .parse::<Ipv4Addr>()
        .map_err(|_| "некорректная маска IPv4")?;
    let mask = u32::from(mask);
    let reverse = !mask;
    if reverse & reverse.wrapping_add(1) != 0 {
        return Err("некорректная маска IPv4".into());
    }
    let network = Ipv4Net::new(addr, mask.count_ones() as u8).expect("valid mask");
    Ok(network.trunc().to_string())
}

static PAC_ITEMS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^(?:const|let|var)\s+items\s*=\s*(\[.*?\])\s*;").unwrap());
static TEMPLATE_PIECES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{(?:data|group|site|shortmask|mask)\}").unwrap());
static CSV_TARGETS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:domain|domains|hostname|host|ip|ipv4|ipv6|ip4|ip6|cidr|cidr4|cidr6|address|subnet|target|домен|подсеть|адрес|ip-адрес)$").unwrap()
});
static MIKROTIK_ADDRESS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)^(?:(?:/ip|/ipv6)\s+firewall\s+address-list\s+)?add\s+.*?\baddress=(?:"([^"]+)"|'([^']+)'|([^\s;]+))"#).unwrap()
});
static BAT_ROUTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^route\s+(?:-p\s+)?add\s+(\S+)\s+mask\s+(\S+)").unwrap());
static KVAS_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)^kvas\s+add\s+['"]?([^\s'"]+)['"]?(?:\s+(y))?\s*$"#).unwrap()
});
static SWITCHY_ROUTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\*(?:\.)?([^/*]+)/\*$").unwrap());
static DNSMASQ_SET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:ipset|nftset|nfset)\s*=\s*/(.+)/[^/]+$").unwrap());
static LEGACY_SET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:ipset\s+)?add\s+\S+\s+(\S+)").unwrap());

impl Importer<'_> {
    pub(crate) fn parse_text_format(&mut self, format: &str, data: &str) -> ParseResult<()> {
        match format {
            "dlc" => self.read_dlc(data),
            "json" | "amnezia" | "singbox" => self.alternate_json(format, data),
            "comma" => self.alternate_csv(data),
            "pac" => self.read_pac(data),
            "custom" => self.read_template(data),
            "clashx" => self.read_clash(data),
            "text" | "mikrotik" | "switchy" | "nfset" | "ipset" | "kvas" | "bat" | "wildcard" => {
                self.read_formatted_lines(format, data)
            }
            _ => Err("неизвестный формат списка маршрутов".into()),
        }
    }

    fn read_pac(&mut self, data: &str) -> ParseResult<()> {
        let matched = PAC_ITEMS
            .captures(data)
            .ok_or("в PAC не найден статический массив items из экспорта iplist")?;
        let items = serde_json::from_str::<Vec<Value>>(&matched[1])
            .map_err(|_| "не удалось прочитать статический массив PAC")?;
        for value in items {
            if let Some(value) = value.as_str() {
                if value.parse::<IpAddr>().is_ok() {
                    self.push_entry(Destination::plain(value))?;
                } else {
                    self.push_entry(suffix_entry(value))?;
                }
                continue;
            }
            let pair = value
                .as_array()
                .filter(|pair| pair.len() == 2)
                .and_then(|pair| Some((pair[0].as_str()?, pair[1].as_str()?)));
            let (address, mask) =
                pair.ok_or("PAC должен содержать домены или пары IPv4 и маска")?;
            self.push_entry(Destination::plain(masked_ipv4(address, mask)?))?;
        }
        Ok(())
    }

    fn read_template(&mut self, data: &str) -> ParseResult<()> {
        let template = self.options.template.replace("\r\n", "\n");
        if template.len() > 1000 || template.matches("{data}").count() != 1 {
            return Err("укажите шаблон iplist до 1000 символов с одним полем {data}".into());
        }
        let mut pattern = String::from("(?m)^");
        let mut last = 0;
        for matched in TEMPLATE_PIECES.find_iter(&template) {
            pattern.push_str(&regex::escape(&template[last..matched.start()]));
            if matched.as_str() == "{data}" {
                pattern.push_str(r#"([^\s"'<>]{1,512}?)"#);
            } else {
                pattern.push_str(r"[^\r\n]{0,300}?");
            }
            last = matched.end();
        }
        pattern.push_str(&regex::escape(&template[last..]));
        pattern.push_str(r"[\t ]*$");
        let regex = Regex::new(&pattern).map_err(|_| "не удалось разобрать шаблон iplist")?;
        let text = data.replace("\r\n", "\n");
        let mut end = 0;
        let invalid = "часть файла не соответствует шаблону iplist";
        for groups in regex.captures_iter(&text).take(MAX_RULES + 1) {
            let matched = groups.get(0).expect("full match");
            if !first_list_line(&text[end..matched.start()]).is_empty() {
                return Err(invalid.into());
            }
            self.push_entry(Destination::plain(&groups[1]))?;
            end = matched.end();
        }
        if !first_list_line(&text[end..]).is_empty() {
            return Err(invalid.into());
        }
        Ok(())
    }

    pub(crate) fn csv(&mut self, data: &str) -> ParseResult<()> {
        let mut rows = CsvRows::new(data, ',', false);
        let (_, header) = rows.next_row()?.ok_or("EOF")?;
        let mut columns = HashMap::new();
        for (index, name) in header.iter().enumerate() {
            let name = name.trim();
            if !matches!(name, "destination" | "target" | "name" | "network" | "port") {
                return Err(format!("неизвестная колонка CSV {name:?}"));
            }
            if columns.insert(name, index).is_some() {
                return Err(format!("дублируется колонка CSV {name:?}"));
            }
        }
        if !columns.contains_key("destination") {
            return Err("в CSV нужна колонка destination".into());
        }
        while let Some((line, row)) = rows.next_row()? {
            if row.len() != header.len() {
                return Err(format!("record on line {line}: wrong number of fields"));
            }
            let column = |label| {
                columns
                    .get(label)
                    .and_then(|i| row.get(*i))
                    .map_or("", |value| value.trim())
            };
            let result = read_port(column("port")).and_then(|port| {
                self.push(
                    column("destination"),
                    RowOptions {
                        port,
                        name: column("name"),
                        target: column("target"),
                        network: column("network"),
                        ..RowOptions::empty()
                    },
                )
            });
            result.map_err(|err| format!("строка CSV {line} — {err}"))?;
        }
        Ok(())
    }

    fn alternate_csv(&mut self, data: &str) -> ParseResult<()> {
        let line = first_list_line(data);
        let delimiter = if !line.contains(',') && line.contains(';') {
            ';'
        } else if !line.contains([',', ';']) && line.contains('\t') {
            '\t'
        } else {
            ','
        };
        let mut parser = CsvRows::new(data, delimiter, true);
        let mut rows = Vec::new();
        while let Some((_, row)) = parser
            .next_row()
            .map_err(|_| "проверьте разделители и кавычки CSV")?
        {
            rows.push(row);
        }
        let Some(header) = rows.first() else {
            return Ok(());
        };
        let mut columns = Vec::new();
        for (i, value) in header.iter().enumerate() {
            if delimiter == ',' && value.trim() == "destination" {
                return self.csv(data);
            }
            if CSV_TARGETS.is_match(value.trim()) {
                columns.push(i);
            }
        }
        let offset = usize::from(!columns.is_empty());
        for (row_index, row) in rows[offset..].iter().enumerate() {
            for (index, value) in row.iter().enumerate() {
                if (columns.is_empty() || columns.contains(&index)) && !value.trim().is_empty() {
                    self.push_entry(Destination::plain(value.trim()))
                        .map_err(|e| {
                            format!("запись CSV {}, поле {} — {e}", row_index + 1, index + 1)
                        })?;
                }
            }
        }
        Ok(())
    }

    fn read_formatted_lines(&mut self, format: &str, data: &str) -> ParseResult<()> {
        for (line, row) in data.lines().enumerate() {
            let value = row.trim();
            let lowercase = value.to_ascii_lowercase();
            if value.is_empty()
                || value.starts_with(['#', ';'])
                || lowercase.starts_with("@echo ")
                || lowercase.starts_with("rem ")
                || matches!(
                    lowercase.as_str(),
                    "[wildcard]"
                        | "[switchy-rulelist]"
                        | "/ip firewall address-list"
                        | "/ipv6 firewall address-list"
                )
            {
                continue;
            }
            let entries = formatted_line(format, value)
                .ok()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    format!(
                        "проверьте назначение по выбранному формату в строке {}",
                        line + 1
                    )
                })?;
            for row in entries {
                if row.match_kind.is_empty() && format == "text" {
                    self.text_line(&row.value, line + 1)?;
                } else {
                    self.push_entry(row)
                        .map_err(|e| format!("строка {} — {e}", line + 1))?;
                }
            }
        }
        Ok(())
    }

    fn read_clash(&mut self, data: &str) -> ParseResult<()> {
        #[derive(Default, Deserialize)]
        #[serde(default, deny_unknown_fields)]
        struct Clash {
            payload: Vec<String>,
            rules: Vec<String>,
        }
        let rows = if data.contains("payload:") || data.contains("rules:") {
            let config: Clash = serde_yaml::from_str(data)
                .map_err(|_| "проверьте YAML-список Clash в payload или rules")?;
            config
                .payload
                .into_iter()
                .chain(config.rules)
                .collect::<Vec<_>>()
        } else {
            data.lines().map(str::to_owned).collect()
        };
        for row in &rows {
            let row = row.trim();
            let row = row
                .strip_prefix("- ")
                .unwrap_or(row)
                .trim()
                .trim_matches(['\'', '"']);
            if row.is_empty() || row.starts_with('#') {
                continue;
            }
            let Some((kind, destination)) = row.split_once(',') else {
                self.push_entry(Destination::plain(row))?;
                continue;
            };
            let value = destination
                .split_once(',')
                .map_or(destination, |pair| pair.0)
                .trim();
            let entry = match kind.trim().to_ascii_uppercase().as_str() {
                "DOMAIN" => Destination::new(value, "exact"),
                "DOMAIN-SUFFIX" => suffix_entry(value),
                "DOMAIN-KEYWORD" => Destination::new(value, "keyword"),
                "DOMAIN-REGEX" => Destination::new(value, "regex"),
                "IP-CIDR" | "IP-CIDR6" => Destination::plain(value),
                _ => {
                    return Err(
                        "Clash-список содержит правило без поддерживаемого назначения".into(),
                    );
                }
            };
            self.push_entry(entry)?;
        }
        Ok(())
    }

    fn read_dlc(&mut self, data: &str) -> ParseResult<()> {
        if !matches!(self.options.kind.as_str(), "" | "auto" | "domain") {
            return Err("список v2fly содержит только доменные правила".into());
        }
        for (index, line) in data.lines().enumerate() {
            if line.len() >= 64 * 1024 {
                return Err("bufio.Scanner: token too long".into());
            }
            let (kind, value, explicit) = split_dlc_line(line);
            if kind == "suffix" && value.is_empty() && !explicit {
                continue;
            }
            dlc_entry(kind, value)
                .and_then(|row| self.push_entry(row))
                .map_err(|e| format!("строка {} списка v2fly — {e}", index + 1))?;
        }
        Ok(())
    }
}

fn line_fields(value: &str) -> impl Iterator<Item = &str> {
    value
        .split([' ', '\t', ',', ';'])
        .filter(|value| !value.is_empty())
}

fn formatted_line(format: &str, line: &str) -> ParseResult<Vec<Destination>> {
    let rows = match format {
        "mikrotik" => MIKROTIK_ADDRESS
            .captures(line)
            .and_then(|caps| {
                (1..=3).find_map(|i| caps.get(i).map(|m| Destination::plain(m.as_str())))
            })
            .into_iter()
            .collect(),
        "bat" => {
            if let Some(caps) = BAT_ROUTE.captures(line) {
                vec![Destination::plain(masked_ipv4(&caps[1], &caps[2])?)]
            } else {
                vec![]
            }
        }
        "kvas" => KVAS_ROUTE
            .captures(line)
            .map(|caps| {
                if caps.get(2).is_some() {
                    suffix_entry(&caps[1])
                } else {
                    Destination::plain(&caps[1])
                }
            })
            .into_iter()
            .collect(),
        "switchy" => SWITCHY_ROUTE
            .captures(line)
            .map(|caps| suffix_entry(&caps[1]))
            .into_iter()
            .collect(),
        "nfset" | "ipset" => {
            if let Some(caps) = DNSMASQ_SET.captures(line) {
                let dest = &caps[1];
                if dest.parse::<IpNet>().is_ok() || dest.parse::<IpAddr>().is_ok() {
                    vec![Destination::plain(format!("ip:{dest}"))]
                } else {
                    dest.split('/').map(suffix_entry).collect()
                }
            } else {
                LEGACY_SET
                    .captures(line)
                    .map(|caps| Destination::plain(&caps[1]))
                    .into_iter()
                    .collect()
            }
        }
        "wildcard" => line_fields(line).map(suffix_entry).collect(),
        "text" if line.contains('>') => vec![Destination::plain(line)],
        "text" => line_fields(line)
            .take_while(|value| !value.starts_with('#'))
            .map(Destination::plain)
            .collect(),
        _ => vec![],
    };
    Ok(rows)
}

fn split_dlc_line(line: &str) -> (&'static str, &str, bool) {
    let body = line.split_once('#').map_or(line, |pair| pair.0).trim();
    let Some((kind, value)) = body.split_once(':') else {
        return ("suffix", body, false);
    };
    let kind = match kind.trim().to_ascii_lowercase().as_str() {
        "domain" | "suffix" => "suffix",
        "full" | "exact" => "exact",
        "keyword" => "keyword",
        "regexp" | "regex" => "regex",
        "include" => "include",
        _ => "",
    };
    (kind, value, true)
}

fn looks_like_dlc(data: &str) -> bool {
    let mut marker = false;
    let mut other = false;
    for row in data.lines().take_while(|line| line.len() < 64 * 1024) {
        let (kind, value, explicit) = split_dlc_line(row);
        if kind == "include" {
            return true;
        }
        let mut fields = value.split_whitespace();
        if kind.is_empty() {
            other = true;
        } else if let Some(first) = fields.next() {
            if kind != "regex" && first.contains(['>', '/', ',', ';'])
                || kind == "suffix" && first.starts_with("*.")
                || !explicit && first.parse::<IpAddr>().is_ok()
            {
                other = true;
            }
            let mut extra_fields = false;
            for extra in fields {
                extra_fields = true;
                if !extra.starts_with(['@', '&']) {
                    other = true;
                }
            }
            let attached = row
                .split_once('#')
                .is_some_and(|(pre, _)| pre.ends_with(first) && first.contains('.'));
            marker |= explicit || extra_fields || attached;
        }
    }
    marker && !other
}

fn dlc_name(value: &str, punctuation: &str) -> bool {
    let value = value.to_lowercase();
    !value.is_empty()
        && value.len() <= 253
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || punctuation.contains(c))
}

fn dlc_entry(kind: &str, value: &str) -> ParseResult<Destination> {
    let mut fields = value.split_whitespace();
    let value = fields.next().ok_or("укажите значение правила")?;
    if kind == "include" && !dlc_name(value, "!-") {
        return Err("некорректное имя списка include".into());
    }
    for field in fields {
        if let Some(tag) = field.strip_prefix('@') {
            let tag = if kind == "include" {
                tag.strip_prefix('-').unwrap_or(tag)
            } else {
                tag
            };
            if !dlc_name(tag, "!") {
                return Err("некорректный атрибут списка v2fly".into());
            }
        } else if let Some(group) = field.strip_prefix('&') {
            if kind == "include" || !dlc_name(group, "!-") {
                return Err("некорректная метка группы списка v2fly".into());
            }
        } else {
            return Err("ожидается атрибут @ или метка группы &".into());
        }
    }
    let value = match kind {
        "include" => {
            return Err(format!(
                "список include:{value} отсутствует в загруженном файле. Загрузите развёрнутый список со всеми включёнными доменами"
            ));
        }
        "keyword" if !dlc_name(value, ".-") => {
            return Err("ключевое слово должно состоять из букв, цифр, точек и дефисов".into());
        }
        "keyword" => value.to_lowercase(),
        "suffix" | "exact" if value.contains(':') => {
            return Err("ожидается домен без URL, порта или другого префикса".into());
        }
        "suffix" | "exact" => value.into(),
        "regex" => format!("regexp:{value}"),
        _ => return Err("неизвестный тип правила списка v2fly".into()),
    };
    Ok(Destination::new(value, kind))
}
