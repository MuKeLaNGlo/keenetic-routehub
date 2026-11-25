mod awg;
mod binary;
mod csv;
mod formats;
mod json;
mod profiles;

use std::{collections::HashSet, net::IpAddr, path::Path};

use ipnet::IpNet;
use regex::Regex;
use serde::{Deserialize, Serialize};

pub use awg::{ManagedAwg, parse_managed_awg};
pub use binary::{GeoDomain, geo_ip, geo_site};
pub use profiles::{ImportedProfile, ProfilePreview, parse_profile_upload, profile_server};

pub const MAX_FILE_BYTES: usize = 2 << 20;
const MAX_RULES: usize = 20_000;
const ERR_FILE_SIZE: &str = "размер файла должен быть от 1 байта до 2 МиБ. В iplist можно выбрать отдельный портал или тип данных";
const ERR_EXPORT: &str =
    "файл содержит сообщение об ошибке iplist. Выберите совместимый тип данных при выгрузке";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct FileOptions {
    pub format: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub domain_match: String,
    pub template: String,
    pub geo_source: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Rule {
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub domain: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cidr: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub exact: bool,
    #[serde(rename = "match", skip_serializing_if = "String::is_empty")]
    pub match_kind: String,
    #[serde(rename = "geoIP", skip_serializing_if = "String::is_empty")]
    pub geo_ip: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub geo_source: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub network: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub port: u16,
    pub target: String,
}

fn is_zero(value: &u16) -> bool {
    *value == 0
}

type ParseResult<T> = Result<T, String>;
const BOM: &[u8] = b"\xef\xbb\xbf";

fn ext(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn export_error(input: &[u8]) -> bool {
    input
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"# error:"))
}

pub fn parse(
    filename: &str,
    input: &[u8],
    fallback: &str,
    targets: &HashSet<String>,
) -> ParseResult<Vec<Rule>> {
    check_size(input)?;
    let text = String::from_utf8_lossy(input.strip_prefix(BOM).unwrap_or(input));
    let text = text.trim();
    if text.is_empty() {
        return Err("файл пуст".into());
    }
    let options = FileOptions::default();
    let mut importer = Importer::new(fallback, targets, &options);
    match ext(filename).as_str() {
        "txt" => importer.text(text)?,
        "csv" => importer.csv(text)?,
        "json" => importer.document(text)?,
        _ => return Err("поддерживаемые форматы — TXT, CSV и JSON".into()),
    }
    importer.finish("в файле нет правил")
}

pub fn parse_preview(
    filename: &str,
    input: &[u8],
    fallback: &str,
    targets: &HashSet<String>,
    options: &FileOptions,
) -> ParseResult<Vec<Rule>> {
    check_size(input)?;
    if export_error(input.strip_prefix(BOM).unwrap_or(input).trim_ascii()) {
        return Err(ERR_EXPORT.into());
    }
    if !matches!(
        options.kind.as_str(),
        "" | "auto" | "domain" | "ip" | "cidr" | "geo"
    ) {
        return Err("укажите допустимый тип назначения".into());
    }
    if !matches!(
        options.domain_match.as_str(),
        "" | "auto" | "exact" | "suffix" | "wildcard" | "keyword" | "regex"
    ) {
        return Err("укажите допустимое совпадение домена".into());
    }
    let automatic = matches!(options.format.as_str(), "" | "auto");
    let format = if automatic {
        formats::detect_format(filename, input)
    } else {
        &options.format
    };
    let mut importer = Importer::new(fallback, targets, options);
    match format {
        "srs" => binary::read_srs(input, |row| importer.push_entry(row))?,
        "geoip" | "geosite" | "dat" => binary::read_dat(input, |_, row| match row {
            binary::DatRow::Ip(ip) if format != "geosite" => {
                importer.push_entry(Destination::plain(ip.to_string()))
            }
            binary::DatRow::Domain(domain) if format != "geoip" => {
                importer.push_entry(Destination::new(domain.domain, domain.match_kind))
            }
            _ => Err(binary::ERR_GEODATA.into()),
        })?,
        _ => {
            let text = formats::decode_text(input)?;
            let format = if automatic {
                formats::detect_format(filename, text.as_bytes())
            } else {
                format
            };
            importer.parse_text_format(format, text.trim())?;
        }
    }
    importer.finish("в файле нет правил выбранного формата")
}

fn check_size(input: &[u8]) -> ParseResult<()> {
    if input.is_empty() || input.len() > MAX_FILE_BYTES {
        return Err(ERR_FILE_SIZE.into());
    }
    Ok(())
}

struct Destination {
    value: String,
    match_kind: String,
}

impl Destination {
    fn new(value: impl Into<String>, match_kind: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            match_kind: match_kind.into(),
        }
    }

    fn plain(value: impl Into<String>) -> Self {
        Self::new(value, "")
    }
}

struct Importer<'a> {
    fallback: &'a str,
    targets: &'a HashSet<String>,
    rules: Vec<Rule>,
    options: &'a FileOptions,
}

struct RowOptions<'a> {
    name: &'a str,
    network: &'a str,
    target: &'a str,
    port: u16,
    exact: bool,
    match_kind: &'a str,
}

impl<'a> RowOptions<'a> {
    fn empty() -> Self {
        Self {
            name: "",
            network: "",
            target: "",
            port: 0,
            exact: false,
            match_kind: "",
        }
    }
}

impl<'a> Importer<'a> {
    fn new(fallback: &'a str, targets: &'a HashSet<String>, options: &'a FileOptions) -> Self {
        Self {
            fallback,
            targets,
            rules: Vec::new(),
            options,
        }
    }

    fn finish(self, error: &str) -> ParseResult<Vec<Rule>> {
        if self.rules.is_empty() {
            return Err(error.into());
        }
        Ok(self.rules)
    }

    fn push_entry(&mut self, entry: Destination) -> ParseResult<()> {
        self.push(
            &entry.value,
            RowOptions {
                match_kind: &entry.match_kind,
                ..RowOptions::empty()
            },
        )
    }

    fn push(&mut self, value: &str, meta: RowOptions<'_>) -> ParseResult<()> {
        self.push_as(value, meta, &self.options.kind, &self.options.geo_source)
    }

    fn push_as(
        &mut self,
        value: &str,
        meta: RowOptions<'_>,
        kind: &str,
        geo_source: &str,
    ) -> ParseResult<()> {
        if self.rules.len() >= MAX_RULES {
            return Err(format!(
                "допускается до {MAX_RULES} правил за файл. В iplist можно выбрать отдельный портал или тип данных"
            ));
        }
        let target = if meta.target.trim().is_empty() {
            self.fallback
        } else {
            meta.target.trim()
        };
        if !self.targets.contains(target) {
            return Err(format!("неизвестный маршрут {target:?}"));
        }
        let transport = meta.network.trim().to_lowercase();
        let network = match transport.as_str() {
            "tcp,udp" | "udp,tcp" | "" => "",
            "tcp" | "udp" => &transport,
            _ => return Err("допустимый транспорт — TCP или UDP".into()),
        };
        let match_kind = if meta.match_kind.is_empty() {
            &self.options.domain_match
        } else {
            meta.match_kind
        };
        let mut rule = if kind == "geo" {
            let code = value.trim().to_uppercase();
            if code.len() != 2
                || !code.bytes().all(|b| b.is_ascii_uppercase())
                || geo_source.is_empty()
            {
                return Err("для GeoIP укажите код страны и источник".into());
            }
            Rule {
                geo_ip: code,
                geo_source: geo_source.into(),
                ..Rule::default()
            }
        } else {
            parse_destination(value, meta.exact, match_kind)?
        };
        match kind {
            "domain" if rule.domain.is_empty() => {
                return Err("ожидается доменное назначение".into());
            }
            "ip" if !rule
                .cidr
                .parse::<IpNet>()
                .is_ok_and(|ip| ip.prefix_len() == ip.max_prefix_len()) =>
            {
                return Err("ожидается один IP-адрес".into());
            }
            "cidr" if rule.cidr.is_empty() || !value.contains('/') => {
                return Err("ожидается подсеть в формате CIDR".into());
            }
            _ => {}
        }
        rule.name = if meta.name.trim().is_empty() {
            format!("{}{}{}", rule.domain, rule.cidr, rule.geo_ip)
        } else {
            meta.name.trim().into()
        };
        rule.target = target.into();
        rule.network = network.into();
        rule.port = meta.port;
        self.rules.push(rule);
        Ok(())
    }

    fn text_line(&mut self, value: &str, line: usize) -> ParseResult<()> {
        let (value, target) = match value.split_once('>') {
            Some((_, target)) if target.trim().is_empty() => {
                return Err(format!("строка {line} — укажите маршрут после >"));
            }
            Some(parts) => parts,
            None => (value, ""),
        };
        self.push(
            value,
            RowOptions {
                target,
                ..RowOptions::empty()
            },
        )
        .map_err(|e| format!("строка {line} — {e}"))
    }

    fn text(&mut self, data: &str) -> ParseResult<()> {
        for (i, raw) in data.lines().enumerate() {
            if raw.len() >= 64 * 1024 {
                return Err("bufio.Scanner: token too long".into());
            }
            let text = raw.trim();
            if !text.is_empty() && !text.starts_with('#') {
                self.text_line(text, i + 1)?;
            }
        }
        Ok(())
    }
}

fn read_port(value: &str) -> ParseResult<u16> {
    if value.is_empty() {
        return Ok(0);
    }
    if !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("укажите один порт от 1 до 65535".into());
    }
    value
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| "укажите один порт от 1 до 65535".into())
}

fn mapped_prefix(network: IpNet) -> bool {
    matches!(network.addr(), IpAddr::V6(addr) if addr.to_ipv4_mapped().is_some())
}

fn normalized_ip(addr: IpAddr) -> IpAddr {
    match addr {
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(addr),
        _ => addr,
    }
}

fn normalized_domain(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_lowercase();
    let host = lowered.strip_suffix('.').unwrap_or(&lowered);
    let normalized = if host.contains('_') {
        host.split('.')
            .map(|label| {
                let core = label.strip_prefix('_').unwrap_or(label);
                let ascii = idna::domain_to_ascii(core).unwrap_or_else(|_| core.into());
                if label.starts_with('_') {
                    format!("_{ascii}")
                } else {
                    ascii
                }
            })
            .collect::<Vec<_>>()
            .join(".")
    } else {
        idna::domain_to_ascii(host).unwrap_or_else(|_| host.into())
    };
    if normalized.is_empty() || normalized.len() > 253 || normalized.parse::<IpAddr>().is_ok() {
        return None;
    }
    let labels = normalized.split('.').collect::<Vec<_>>();
    for (i, label) in labels.iter().enumerate() {
        if label.len() > 63 {
            return None;
        }
        let label = if i + 1 < labels.len() {
            label.strip_prefix('_').unwrap_or(label)
        } else {
            label
        };
        if label.is_empty()
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')
        {
            return None;
        }
    }
    Some(normalized)
}

fn parse_destination(raw: &str, mut exact: bool, mut match_kind: &str) -> ParseResult<Rule> {
    let mut value = raw.trim();
    if match_kind == "auto" {
        match_kind = "";
    }
    let mut forced_domain = exact || !match_kind.is_empty();
    let mut forced_ip = false;
    if let Some((prefix, tail)) = value.split_once(':') {
        match prefix {
            "ip" | "cidr" => {
                value = tail;
                forced_ip = true;
                forced_domain = false;
                match_kind = "";
            }
            "domain" => {
                value = tail;
                forced_domain = true;
            }
            "full" => {
                value = tail;
                forced_domain = true;
                exact = true;
                match_kind = "";
            }
            "keyword" => {
                value = tail;
                forced_domain = true;
                match_kind = "keyword";
            }
            "regexp" => {
                value = tail;
                forced_domain = true;
                match_kind = "regex";
            }
            _ => {}
        }
    }
    if !forced_domain {
        if let Ok(prefix) = value.parse::<IpNet>()
            && !mapped_prefix(prefix)
        {
            return Ok(Rule {
                cidr: prefix.trunc().to_string(),
                ..Rule::default()
            });
        }
        if let Ok(addr) = value.parse::<IpAddr>() {
            let ip = normalized_ip(addr);
            return Ok(Rule {
                cidr: format!("{ip}/{}", if ip.is_ipv4() { 32 } else { 128 }),
                ..Rule::default()
            });
        }
    }
    if forced_ip {
        return Err("некорректный IP или CIDR".into());
    }
    match match_kind {
        "regex" | "keyword" => {
            if value.is_empty() || value.len() > 2048 || value.contains(['\0', '\r', '\n']) {
                return Err("проверьте выражение или ключевое слово домена".into());
            }
            if match_kind == "regex" && Regex::new(value).is_err() {
                return Err("некорректное регулярное выражение RE2".into());
            }
            return Ok(Rule {
                domain: value.into(),
                match_kind: match_kind.into(),
                ..Rule::default()
            });
        }
        "" | "exact" | "suffix" | "wildcard" => {}
        _ => return Err("неизвестный тип совпадения домена".into()),
    }
    if matches!(match_kind, "" | "wildcard")
        && let Some(tail) = value.strip_prefix("*.")
    {
        value = tail;
        match_kind = "wildcard";
    }
    let domain = normalized_domain(value)
        .ok_or("ожидается IP, CIDR, домен или точный домен с префиксом full:")?;
    Ok(Rule {
        domain,
        exact,
        match_kind: match_kind.into(),
        ..Rule::default()
    })
}
