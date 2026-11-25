use idna::uts46::{AsciiDenyList, DnsLength, Hyphens, Uts46};
use ipnet::{IpNet, Ipv4Net};
use std::fmt::Write;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::LazyLock;

/// Accept the six-byte spellings from net.ParseMAC, excluding multicast and zero.
pub fn normalize_mac(value: &str) -> Result<String, String> {
    let raw = value.trim().as_bytes();
    let parse_hex = |byte| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };
    let convert = || -> Option<[u8; 6]> {
        let mut octets = [0; 6];
        match raw {
            [_, _, delimiter @ (b':' | b'-'), ..] if raw.len() == 17 => {
                for (i, octet) in octets.iter_mut().enumerate() {
                    let start = i * 3;
                    *octet = parse_hex(raw[start])? << 4 | parse_hex(raw[start + 1])?;
                    if i != 5 && &raw[start + 2] != delimiter {
                        return None;
                    }
                }
            }
            [_, _, _, _, b'.', ..] if raw.len() == 14 && raw[9] == b'.' => {
                for (i, octet) in octets.iter_mut().enumerate() {
                    let start = i / 2 * 5 + i % 2 * 2;
                    *octet = parse_hex(raw[start])? << 4 | parse_hex(raw[start + 1])?;
                }
            }
            _ => return None,
        }
        Some(octets)
    };
    if let Some(octets) = convert()
        && octets[0] & 1 == 0
        && octets != [0; 6]
    {
        let [a, b, c, d, e, f] = octets;
        return Ok(format!("{a:02x}:{b:02x}:{c:02x}:{d:02x}:{e:02x}:{f:02x}"));
    }
    Err(format!("некорректный MAC устройства {}", go_quote(value)))
}

pub(crate) fn client_ip(value: &str) -> Result<Ipv4Addr, String> {
    match value.parse::<Ipv4Addr>() {
        Ok(address)
            if !address.is_unspecified()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_multicast()
                && !address.is_broadcast() =>
        {
            Ok(address)
        }
        _ => Err(format!("некорректный IPv4-адрес устройства {value:?}")),
    }
}

pub(crate) fn lan_host(network: Ipv4Net, address: Ipv4Addr) -> bool {
    network.contains(&address)
        && (network.prefix_len() >= 31
            || (address != network.network() && address != network.broadcast()))
}

pub(crate) fn mapped(address: IpAddr) -> bool {
    matches!(address, IpAddr::V6(ip) if ip.to_ipv4_mapped().is_some())
}

pub(crate) fn unmap(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or(address, IpAddr::V4),
        _ => address,
    }
}

pub(crate) fn parse_prefix(value: &str) -> Option<IpNet> {
    let (ip, width) = value.split_once('/')?;
    // netip.ParsePrefix accepts decimal widths without a sign or leading zero.
    if width.len() > 1 && width.starts_with('0') || !width.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let address = ip.parse().ok()?;
    let prefix = IpNet::new(address, width.parse().ok()?).ok()?;
    (prefix.addr() == prefix.network() && !mapped(prefix.addr())).then_some(prefix)
}

pub(crate) fn normalize_host(host: &str) -> String {
    let host = go_lower(host.trim());
    let host = host.strip_suffix('.').unwrap_or(&host);
    if host.is_ascii() {
        return host.to_owned();
    }
    if host.contains('_') {
        return host
            .split('.')
            .map(|label| {
                let value = label.strip_prefix('_').unwrap_or(label);
                lookup_idna(value).map_or_else(
                    |_| label.to_owned(),
                    |ascii| format!("{}{ascii}", &label[..label.len() - value.len()]),
                )
            })
            .collect::<Vec<_>>()
            .join(".");
    }
    lookup_idna(host).map_or_else(|_| host.to_owned(), |value| value.into_owned())
}

fn lookup_idna(host: &str) -> Result<std::borrow::Cow<'_, str>, idna::Errors> {
    Uts46::new().to_ascii(
        host.as_bytes(),
        AsciiDenyList::STD3,
        Hyphens::Check,
        DnsLength::Ignore,
    )
}

/// DNS routing rules also support service labels such as _domainkey.example.
pub fn normalize_routing_domain(host: &str) -> Option<String> {
    let (host, valid) = routing_domain_info(host);
    valid.then_some(host)
}

/// Preserve the normalized value even when it fails validation.
pub fn routing_domain_info(host: &str) -> (String, bool) {
    let host = normalize_host(host);
    let valid = host.parse::<IpAddr>().is_err() && valid_domain(&host);
    (host, valid)
}

pub(crate) fn go_lower(value: &str) -> String {
    value
        .chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

pub(crate) fn go_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for c in value.chars() {
        match c {
            '\x07' => quoted.push_str(r"\a"),
            '\x08' => quoted.push_str(r"\b"),
            '\x0b' => quoted.push_str(r"\v"),
            '\x0c' => quoted.push_str(r"\f"),
            '\n' => quoted.push_str(r"\n"),
            '\r' => quoted.push_str(r"\r"),
            '\t' => quoted.push_str(r"\t"),
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str(r"\\"),
            '\0'..='\x1f' | '\x7f' => {
                let _ = write!(quoted, "\\x{:02x}", u32::from(c));
            }
            _ if !go_printable(c) => {
                let code = u32::from(c);
                if code <= 0xffff {
                    let _ = write!(quoted, "\\u{code:04x}");
                } else {
                    let _ = write!(quoted, "\\U{code:08x}");
                }
            }
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

fn go_printable(character: char) -> bool {
    static GRAPHIC: LazyLock<regex::Regex> = LazyLock::new(|| {
        // This is the definition of strconv.IsPrint for non-ASCII runes.
        regex::Regex::new(r"^[\p{L}\p{M}\p{N}\p{P}\p{S}]$").expect("valid static pattern")
    });
    if character.is_ascii() {
        character == ' ' || character.is_ascii_graphic()
    } else {
        GRAPHIC.is_match(character.encode_utf8(&mut [0; 4]))
    }
}

pub(crate) fn valid_domain(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let mut labels = host.split('.').peekable();
    while let Some(raw) = labels.next() {
        if raw.len() > 63 {
            return false;
        }
        let label = if labels.peek().is_some() {
            raw.strip_prefix('_').unwrap_or(raw)
        } else {
            raw
        };
        if label.is_empty()
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return false;
        }
    }
    true
}
