use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Read},
    net::IpAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

pub const SETTINGS_LIMIT: usize = 64 << 10;
pub const BLOCKLIST_LIMIT: u64 = 16 << 20;
const MAX_DOMAINS: usize = 400_000;
const MAX_LINE: u64 = 65_536;

// Partial JSON requests start with Go-compatible zero values.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub protocol: String,
    pub primary: String,
    pub secondary: String,
    pub cache: bool,
    pub adblock: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub lan: bool,
    #[serde(deserialize_with = "null_list")]
    pub lists: Vec<String>,
    #[serde(deserialize_with = "null_list")]
    pub exceptions: Vec<String>,
}

fn is_false(flag: &bool) -> bool {
    !flag
}

fn null_list<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    Option::deserialize(deserializer).map(Option::unwrap_or_default)
}

impl Settings {
    pub fn fallback() -> Self {
        Self {
            protocol: "doh".into(),
            primary: "https://dns.quad9.net/dns-query".into(),
            secondary: "https://cloudflare-dns.com/dns-query".into(),
            cache: true,
            lists: vec!["normal".into()],
            ..Self::default()
        }
    }

    pub fn from_file(path: &Path) -> Result<Self> {
        let descriptor = match open_readonly(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::fallback()),
            Err(error) => return Err(error.into()),
        };
        let metadata = descriptor.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.permissions().mode() & 0o077 == 0
                && metadata.len() <= SETTINGS_LIMIT as u64,
            "файл настроек DNS должен быть приватным"
        );
        let mut data = Vec::new();
        descriptor
            .take(SETTINGS_LIMIT as u64 + 1)
            .read_to_end(&mut data)?;
        ensure!(
            data.len() <= SETTINGS_LIMIT,
            "файл настроек DNS должен быть приватным"
        );
        serde_json::from_slice::<Self>(&data)
            .context("некорректные сохранённые настройки DNS")?
            .validate()
    }

    pub fn validate(mut self) -> Result<Self> {
        self.primary = endpoint(&self.primary, &self.protocol)?;
        self.secondary = self.secondary.trim().to_owned();
        if !self.secondary.is_empty() {
            self.secondary = endpoint(&self.secondary, &self.protocol)?;
            ensure!(
                self.secondary != self.primary,
                "основной и резервный серверы должны различаться"
            );
        }
        if self.lists.is_empty() {
            self.lists.push("normal".into());
        }
        ensure!(
            self.lists.len() == 1 && asset(&self.lists[0]).is_some(),
            "выберите один список HaGeZi"
        );
        ensure!(
            self.exceptions.len() <= 256,
            "поддерживается до 256 исключений"
        );
        let mut exceptions = Vec::with_capacity(self.exceptions.len());
        for raw in self.exceptions {
            let domain = canonical_name(&raw);
            ensure!(
                domain.contains('.') && domain_ok(&domain),
                "укажите домен исключения без схемы, звёздочки и пути"
            );
            if !exceptions.contains(&domain) {
                exceptions.push(domain);
            }
        }
        self.exceptions = exceptions;
        Ok(self)
    }
}

fn open_readonly(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

pub fn canonical_name(value: &str) -> String {
    let value = value.trim();
    value
        .strip_suffix('.')
        .unwrap_or(value)
        .to_ascii_lowercase()
}

pub fn domain_ok(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn address_ok(address: IpAddr) -> bool {
    let address = address.to_canonical();
    !address.is_unspecified() && !address.is_multicast()
}

fn endpoint(value: &str, protocol: &str) -> Result<String> {
    let value = value.trim();
    ensure!(
        !value.is_empty() && value.len() <= 1000,
        "укажите адрес DNS-сервера"
    );
    match protocol {
        "plain" => {
            if let Ok(address) = value.trim_matches(['[', ']']).parse::<IpAddr>()
                && address_ok(address)
            {
                return Ok(address.to_canonical().to_string());
            }
        }
        "dot" => {
            let (host, port) = value.split_once(':').unwrap_or((value, "853"));
            let host = canonical_name(host);
            if port.parse::<u16>().is_ok_and(|number| number > 0)
                && host.contains('.')
                && domain_ok(&host)
            {
                return Ok(if port == "853" {
                    host
                } else {
                    format!("{host}:{port}")
                });
            }
        }
        "doh" => {
            if let Ok(endpoint) = Url::parse(value)
                && endpoint.scheme() == "https"
                && value.split_once("://").is_some_and(|(_, authority)| {
                    let host = authority.split('/').next().unwrap_or_default();
                    !host.contains('@') && authority.contains('/')
                })
                && endpoint.fragment().is_none()
                && endpoint.query().is_none()
                && endpoint.host().is_some_and(|host| match host {
                    Host::Domain(domain) => domain_ok(&canonical_name(domain)),
                    Host::Ipv4(ip) => address_ok(ip.into()),
                    Host::Ipv6(ip) => address_ok(ip.into()),
                })
            {
                return Ok(endpoint.into());
            }
        }
        _ => {}
    }
    bail!("адрес DNS-сервера не соответствует выбранному протоколу")
}

pub fn asset(id: &str) -> Option<&'static str> {
    match id {
        "normal" => Some("multi-onlydomains.txt"),
        "pro" => Some("pro.mini-onlydomains.txt"),
        "proplus" => Some("pro.plus.mini-onlydomains.txt"),
        _ => None,
    }
}

/// A sorted index into one byte buffer avoids a heap allocation per domain.
#[derive(Default)]
pub struct Blocklist {
    names: Vec<u8>,
    starts: Vec<u32>,
}

fn domain_at(names: &[u8], start: u32) -> &[u8] {
    let name = &names[start as usize..];
    &name[..name
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(name.len())]
}

impl Blocklist {
    pub fn read(path: &Path) -> Result<Self> {
        let file = open_readonly(path)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.len() <= BLOCKLIST_LIMIT,
            "некорректный локальный список DNS"
        );
        Self::parse(BufReader::new(file.take(BLOCKLIST_LIMIT + 1)))
    }

    fn parse(mut reader: impl BufRead) -> Result<Self> {
        let mut result = Self::default();
        let mut line = Vec::new();
        let mut bytes = 0;
        loop {
            line.clear();
            let size = reader
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line)?;
            if size == 0 {
                break;
            }
            bytes += size as u64;
            ensure!(
                size as u64 <= MAX_LINE && bytes <= BLOCKLIST_LIMIT,
                "неподдерживаемый размер списка DNS"
            );
            let line = std::str::from_utf8(&line).context("ответ не является списком доменов")?;
            let domain = canonical_name(line);
            if domain.is_empty() || domain.starts_with('#') {
                continue;
            }
            ensure!(
                domain.contains('.') && domain_ok(&domain),
                "ответ не является списком доменов"
            );
            result.starts.push(result.names.len() as u32);
            result.names.extend(domain.bytes());
            result.names.push(0);
        }
        let names = &result.names;
        result
            .starts
            .sort_unstable_by(|a, b| domain_at(names, *a).cmp(domain_at(names, *b)));
        result
            .starts
            .dedup_by(|a, b| domain_at(names, *a) == domain_at(names, *b));
        ensure!(
            (1000..=MAX_DOMAINS).contains(&result.starts.len()),
            "неподдерживаемый размер списка DNS"
        );
        result.names.shrink_to_fit();
        result.starts.shrink_to_fit();
        Ok(result)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.starts
            .binary_search_by(|&start| domain_at(&self.names, start).cmp(name.as_bytes()))
            .is_ok()
    }

    pub fn len(&self) -> usize {
        self.starts.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_settings_and_rejects_mismatched_protocols() {
        assert_eq!(
            endpoint(" DNS.EXAMPLE.:853 ", "dot").unwrap(),
            "dns.example"
        );
        assert_eq!(
            endpoint("[::ffff:192.0.2.3]", "plain").unwrap(),
            "192.0.2.3"
        );
        assert!(endpoint("ff02::1", "plain").is_err());
        assert!(endpoint("[::ffff:224.0.0.1]", "plain").is_err());
        assert!(endpoint("https://dns.example", "doh").is_err());
        assert!(endpoint("https://user@dns.example/q", "doh").is_err());
        assert!(endpoint("https://dns.example/q?token=1", "doh").is_err());

        let config = Settings {
            exceptions: vec!["Example.NET.".into(), "example.net".into()],
            ..Settings::fallback()
        }
        .validate()
        .unwrap();
        assert_eq!(config.exceptions, Vec::from(["example.net"]));
    }

    #[test]
    fn blocklist_index_keeps_only_unique_domains() {
        let data = (0..1000)
            .rev()
            .map(|index| format!("DNS{index}.EXAMPLE.\n"))
            .collect::<String>();
        let duplicate = data.clone() + "dns0.example\n# ignore this comment\n";
        let parsed = Blocklist::parse(duplicate.as_bytes()).unwrap();
        assert_eq!(parsed.len(), 1000);
        assert!(parsed.contains("dns0.example"));
        assert!(parsed.contains("dns999.example"));
        assert!(!parsed.contains("dns1000.example"));
    }
}
