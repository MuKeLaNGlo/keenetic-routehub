use crate::address::{go_lower, mapped, normalize_routing_domain, parse_prefix};
use crate::types::{NamedSet, Rule};
use ipnet::IpNet;
use regex::{Regex, RegexBuilder};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, OnceLock};

#[derive(Clone, Debug)]
pub(crate) enum DomainKind {
    Exact(String),
    Suffix(String),
    Wildcard(String),
    Keyword(String),
    Regex(Regex),
}

#[derive(Clone, Debug)]
pub(crate) struct DomainMatch {
    pub token: String,
    pub kind: DomainKind,
}

pub(crate) fn domain_match(rule: &Rule) -> Result<DomainMatch, String> {
    let raw = rule.domain.trim();
    let mode = rule.match_kind.trim().to_lowercase();
    let mode = match mode.as_str() {
        "" | "auto" if rule.exact => "exact",
        "" | "auto" if raw.starts_with("*.") => "wildcard",
        "" | "auto" => "suffix",
        other => other,
    };
    if matches!(mode, "regex" | "keyword") {
        if raw.is_empty() || raw.len() > 2048 || raw.contains(['\0', '\r', '\n']) {
            return Err("проверьте выражение или ключевое слово домена".into());
        }
        return if mode == "regex" {
            Ok(DomainMatch {
                token: format!("regexp:{raw}"),
                kind: DomainKind::Regex(compile_regex(raw)?),
            })
        } else {
            let keyword = go_lower(raw);
            Ok(DomainMatch {
                token: format!("keyword:{keyword}"),
                kind: DomainKind::Keyword(keyword),
            })
        };
    }
    let raw = if mode == "wildcard" {
        raw.strip_prefix("*.").unwrap_or(raw)
    } else {
        raw
    };
    let domain = normalize_routing_domain(raw).ok_or("некорректный домен")?;
    match mode {
        "exact" => Ok(DomainMatch {
            token: format!("full:{domain}"),
            kind: DomainKind::Exact(domain),
        }),
        "suffix" => Ok(DomainMatch {
            token: format!("domain:{domain}"),
            kind: DomainKind::Suffix(domain),
        }),
        "wildcard" => Ok(DomainMatch {
            token: format!(r"regexp:^.+\.{}$", domain.replace('.', r"\.")),
            kind: DomainKind::Wildcard(domain),
        }),
        _ => Err("неизвестный тип совпадения домена".into()),
    }
}

fn compile_regex(raw: &str) -> Result<Regex, String> {
    // Go's RE2 front-end accepts `\Q...\E` literal quoting. Never change the
    // expression emitted to Xray; normalize only the Rust matching engine.
    let mut adapted = String::with_capacity(raw.len());
    let mut remaining = raw;
    while let Some(index) = remaining.find('\\') {
        adapted.push_str(&remaining[..index]);
        remaining = &remaining[index + 1..];
        match remaining.chars().next() {
            Some('Q') => {
                remaining = &remaining[1..];
                let (literal, tail) = remaining.split_once(r"\E").unwrap_or((remaining, ""));
                adapted.push_str(&regex::escape(literal));
                remaining = tail;
            }
            Some(character) => {
                adapted.push('\\');
                adapted.push(character);
                remaining = &remaining[character.len_utf8()..];
            }
            None => adapted.push('\\'),
        }
    }
    adapted.push_str(remaining);
    RegexBuilder::new(&adapted)
        .octal(true)
        .build()
        .map_err(|_| "некорректное регулярное выражение RE2".into())
}

fn subdomain(host: &str, suffix: &str) -> bool {
    host.strip_suffix(suffix)
        .is_some_and(|head| head.ends_with('.'))
}

impl DomainKind {
    pub fn matches(&self, host: &str) -> bool {
        match self {
            Self::Exact(domain) => host == domain,
            Self::Suffix(domain) => host == domain || subdomain(host, domain),
            Self::Wildcard(domain) => subdomain(host, domain),
            Self::Keyword(keyword) => host.contains(keyword),
            Self::Regex(pattern) => pattern.is_match(host),
        }
    }
}

#[derive(Debug, Default)]
struct DomainIndex {
    exact: Vec<(u32, usize)>,
    suffix: Vec<(u32, usize)>,
}

/// One immutable GeoSite category or reusable domain list. The wire tokens own
/// the text. A compact lookup index is built only at the first evaluation.
#[derive(Debug, Default)]
pub struct DomainSet {
    tokens: Vec<String>,
    supplemental: Vec<DomainKind>,
    index: OnceLock<DomainIndex>,
}

impl DomainSet {
    pub fn add(&mut self, domain: &str, match_kind: &str) -> Result<(), String> {
        let parsed = domain_match(&Rule {
            domain: domain.into(),
            match_kind: match_kind.into(),
            ..Rule::default()
        })?;
        if !matches!(parsed.kind, DomainKind::Exact(_) | DomainKind::Suffix(_)) {
            self.supplemental.push(parsed.kind);
        }
        self.tokens.push(parsed.token);
        self.index.take();
        Ok(())
    }

    pub fn tokens(&self) -> &[String] {
        &self.tokens
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    pub fn matches(&self, host: &str) -> bool {
        let index = self.index.get_or_init(|| {
            let mut index = DomainIndex::default();
            for (position, token) in self.tokens.iter().enumerate() {
                let (kind, value) = token.split_once(':').unwrap_or_default();
                match kind {
                    "full" => index.exact.push((domain_hash(value), position)),
                    "domain" => index.suffix.push((domain_hash(value), position)),
                    _ => {}
                }
            }
            index.exact.sort_unstable();
            index.suffix.sort_unstable();
            index
        });
        let contains = |fragment: &str, candidates: &[(u32, usize)]| {
            let hash = domain_hash(fragment);
            let start = candidates.partition_point(|indexed| indexed.0 < hash);
            candidates[start..]
                .iter()
                .take_while(|indexed| indexed.0 == hash)
                .any(|&(_, position)| token_value(&self.tokens[position]) == fragment)
        };
        contains(host, &index.exact)
            || (!index.suffix.is_empty()
                && std::iter::successors(Some(host), |fragment| {
                    fragment.split_once('.').map(|(_, next)| next)
                })
                .any(|fragment| contains(fragment, &index.suffix)))
            || self.supplemental.iter().any(|domain| domain.matches(host))
    }
}

fn token_value(token: &str) -> &str {
    token.split_once(':').map_or(token, |(_, value)| value)
}

fn domain_hash(domain: &str) -> u32 {
    domain.bytes().fold(2_166_136_261, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
    })
}

/// Canonical uppercase category for a publisher's GeoIP or GeoSite database.
pub fn geo_tag(raw: &str) -> Option<String> {
    let tag: String = raw
        .trim()
        .chars()
        .map(|c| {
            let mut uppercase = c.to_uppercase();
            match (uppercase.next(), uppercase.next()) {
                (Some(mapped), None) => mapped,
                _ => c,
            }
        })
        .collect();
    let mut chars = tag.bytes();
    let alnum = |byte: u8| byte.is_ascii_uppercase() || byte.is_ascii_digit();
    (tag.len() <= 128
        && chars.next().is_some_and(alnum)
        && chars.all(|byte| alnum(byte) || matches!(byte, b'-' | b'_' | b'.')))
    .then_some(tag)
}

#[derive(Clone, Debug)]
pub(crate) enum Group {
    Ip(Arc<[IpNet]>),
    Domains(Arc<DomainSet>),
}

impl Group {
    pub fn is_empty(&self) -> bool {
        match self {
            Self::Ip(values) => values.is_empty(),
            Self::Domains(values) => values.is_empty(),
        }
    }
}

pub(crate) fn compile_named_sets(sets: &[NamedSet]) -> Result<HashMap<&str, Group>, String> {
    let mut compiled = HashMap::with_capacity(sets.len());
    for set in sets {
        let mut id = set.id.bytes();
        if set.id.len() > 64
            || !id.next().is_some_and(|byte| byte.is_ascii_alphanumeric())
            || !id.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || compiled.contains_key(set.id.as_str())
        {
            return Err(format!(
                "некорректный или повторяющийся идентификатор набора {:?}",
                set.id
            ));
        }
        let name = set.name.trim();
        if name.is_empty() || name.chars().count() > 128 || name.contains(['\r', '\n', '\0']) {
            return Err(format!(
                "имя набора {:?} должно содержать от 1 до 128 символов",
                set.id
            ));
        }
        let group = match set.kind.as_str() {
            "domains" => {
                let mut domains = DomainSet::default();
                for (index, value) in set.entries.iter().enumerate() {
                    domains.add(value, "suffix").map_err(|err| {
                        format!("набор {:?}, запись {}: {err}", set.name, index + 1)
                    })?;
                }
                Group::Domains(Arc::new(domains))
            }
            "cidrs" => {
                let mut prefixes = Vec::with_capacity(set.entries.len());
                for (index, value) in set.entries.iter().enumerate() {
                    let value = value.trim();
                    let parsed = value
                        .parse::<IpAddr>()
                        .ok()
                        .filter(|ip| !mapped(*ip))
                        .map(IpNet::from)
                        .or_else(|| parse_prefix(value));
                    prefixes.push(parsed.ok_or_else(|| format!(
                        "набор {:?}, запись {}: укажите IP-адрес или адрес сети с длиной префикса (например, 192.0.2.0/24)",
                        set.name, index + 1,
                    ))?);
                }
                Group::Ip(prefixes.into())
            }
            _ => return Err(format!("неизвестный тип набора {:?}", set.name)),
        };
        compiled.insert(set.id.as_str(), group);
    }
    Ok(compiled)
}
