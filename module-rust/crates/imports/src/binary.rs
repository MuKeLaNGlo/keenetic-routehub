use std::{
    collections::{BTreeMap, HashSet},
    io::Read,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

use flate2::read::ZlibDecoder;
use ipnet::IpNet;
use serde::{Deserialize, Serialize};

use crate::{Destination, MAX_RULES, ParseResult, formats::suffix_entry, normalized_domain};

pub(crate) const ERR_GEODATA: &str = "повреждённая или неподдерживаемая база v2ray .dat";
const ERR_SRS: &str = "повреждённый или неподдерживаемый список SRS";
const MAX_INFLATED_SRS: u64 = 8 << 20;

struct Input<'a> {
    content: &'a [u8],
    invalid: &'static str,
}

impl<'a> Input<'a> {
    fn new(content: &'a [u8], invalid: &'static str) -> Self {
        Self { content, invalid }
    }

    fn take(&mut self, count: usize) -> ParseResult<&'a [u8]> {
        let Some((part, rest)) = self.content.split_at_checked(count) else {
            return Err(self.invalid.into());
        };
        self.content = rest;
        Ok(part)
    }

    fn byte(&mut self) -> ParseResult<u8> {
        Ok(self.take(1)?[0])
    }

    fn uvarint(&mut self) -> ParseResult<u64> {
        let mut result = 0u64;
        for index in 0..10 {
            let byte = self.byte()?;
            if index == 9 && byte > 1 {
                return Err(self.invalid.into());
            }
            result |= u64::from(byte & 0x7f) << (index * 7);
            if byte & 0x80 == 0 {
                return Ok(result);
            }
        }
        Err(self.invalid.into())
    }

    fn count(&mut self, max: usize) -> ParseResult<usize> {
        let value = self.uvarint()?;
        usize::try_from(value)
            .ok()
            .filter(|count| *count <= max)
            .ok_or_else(|| self.invalid.into())
    }

    fn vector(&mut self) -> ParseResult<&'a [u8]> {
        let count = self.count(self.content.len())?;
        self.take(count)
    }

    fn words(&mut self) -> ParseResult<&'a [u8]> {
        let count = self.count(self.content.len() / 8)?;
        self.take(count * 8)
    }
}

enum ProtoField<'a> {
    Bytes(&'a [u8]),
    Number(u64),
    Fixed,
}

fn read_fields(
    mut input: Input<'_>,
    mut visit: impl FnMut(u64, ProtoField<'_>) -> ParseResult<()>,
) -> ParseResult<()> {
    while !input.content.is_empty() {
        let tag = input.uvarint()?;
        let number = tag >> 3;
        if number == 0 {
            return Err(input.invalid.into());
        }
        let field = match tag & 7 {
            0 => ProtoField::Number(input.uvarint()?),
            1 => {
                input.take(8)?;
                ProtoField::Fixed
            }
            2 => ProtoField::Bytes(input.vector()?),
            5 => {
                input.take(4)?;
                ProtoField::Fixed
            }
            _ => return Err(input.invalid.into()),
        };
        visit(number, field)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct GeoDomain {
    pub domain: String,
    #[serde(rename = "match")]
    pub match_kind: String,
}

pub(crate) enum DatRow {
    Ip(IpNet),
    Domain(GeoDomain),
}

fn ip_from_raw(raw: &[u8]) -> Option<IpAddr> {
    match raw.len() {
        4 => Some(IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(raw).ok()?))),
        16 => Some(IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(raw).ok()?))),
        _ => None,
    }
}

fn read_dat_row(data: &[u8]) -> ParseResult<DatRow> {
    let mut address = None;
    let mut prefix = 0;
    let mut kind = 0;
    let mut domain = String::new();
    read_fields(Input::new(data, ERR_GEODATA), |number, field| {
        match (number, field) {
            (1, ProtoField::Bytes(raw)) => {
                address = ip_from_raw(raw);
                if address.is_none()
                    || matches!(address, Some(IpAddr::V6(ip)) if ip.to_ipv4_mapped().is_some())
                {
                    return Err(ERR_GEODATA.into());
                }
            }
            (1, ProtoField::Number(value)) => kind = value,
            (2, ProtoField::Number(value)) => prefix = value,
            (2, ProtoField::Bytes(raw)) => {
                domain = std::str::from_utf8(raw).map_err(|_| ERR_GEODATA)?.into()
            }
            _ => {}
        }
        Ok(())
    })?;
    if let Some(address) = address {
        if !domain.is_empty() {
            return Err(ERR_GEODATA.into());
        }
        let prefix = u8::try_from(prefix).map_err(|_| ERR_GEODATA)?;
        let address = IpNet::new(address, prefix).map_err(|_| ERR_GEODATA)?;
        return Ok(DatRow::Ip(address.trunc()));
    }
    if domain.is_empty() || kind > 3 {
        return Err(ERR_GEODATA.into());
    }
    Ok(DatRow::Domain(GeoDomain {
        domain,
        match_kind: ["keyword", "regex", "suffix", "exact"][kind as usize].into(),
    }))
}

pub(crate) fn read_dat(
    data: &[u8],
    mut emit: impl FnMut(&str, DatRow) -> ParseResult<()>,
) -> ParseResult<()> {
    let mut found = false;
    read_fields(Input::new(data, ERR_GEODATA), |number, field| {
        let (1, ProtoField::Bytes(entry)) = (number, field) else {
            return Ok(());
        };
        let mut name = String::new();
        let mut inverse = false;
        read_fields(Input::new(entry, ERR_GEODATA), |number, field| {
            match (number, field) {
                (1, ProtoField::Bytes(value)) => {
                    name = String::from_utf8_lossy(value).to_uppercase()
                }
                (3, ProtoField::Number(value)) if value != 0 => inverse = true,
                _ => {}
            }
            Ok(())
        })?;
        if inverse {
            return Err("база .dat содержит группы с обратным совпадением".into());
        }
        read_fields(Input::new(entry, ERR_GEODATA), |number, field| {
            if let (2, ProtoField::Bytes(raw)) = (number, field) {
                let row = read_dat_row(raw)?;
                found = true;
                emit(&name, row)?;
            }
            Ok(())
        })
    })?;
    if !found {
        return Err(ERR_GEODATA.into());
    }
    Ok(())
}

fn geo_tag(raw: &str) -> Option<String> {
    let tag = raw.trim().to_uppercase();
    let ascii = |b: u8| b.is_ascii_uppercase() || b.is_ascii_digit();
    let mut bytes = tag.bytes();
    if tag.len() > 128
        || !bytes.next().is_some_and(ascii)
        || !bytes.all(|b| ascii(b) || matches!(b, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(tag)
}

pub fn geo_ip(data: &[u8]) -> ParseResult<BTreeMap<String, Vec<IpNet>>> {
    let mut groups = BTreeMap::<String, Vec<IpNet>>::new();
    read_dat(data, |key, row| {
        let DatRow::Ip(ip) = row else {
            return Err(ERR_GEODATA.into());
        };
        if let Some(tag) = geo_tag(key) {
            groups.entry(tag).or_default().push(ip);
        }
        Ok(())
    })?;
    if groups.is_empty() {
        return Err("в базе GeoIP нет допустимых тегов".into());
    }
    Ok(groups)
}

pub fn geo_site(data: &[u8]) -> ParseResult<BTreeMap<String, Vec<GeoDomain>>> {
    let mut groups = BTreeMap::<String, Vec<GeoDomain>>::new();
    read_dat(data, |key, row| {
        let DatRow::Domain(domain) = row else {
            return Err(ERR_GEODATA.into());
        };
        if let Some(tag) = geo_tag(key) {
            let raw = domain.domain.trim();
            let normalized = match domain.match_kind.as_str() {
                "regex" | "keyword"
                    if raw.is_empty() || raw.len() > 2048 || raw.contains(['\0', '\r', '\n']) =>
                {
                    None
                }
                "regex" => regex::Regex::new(raw).ok().map(|_| raw.to_owned()),
                "keyword" => Some(raw.to_lowercase()),
                "suffix" | "exact" => normalized_domain(raw),
                _ => None,
            }
            .ok_or_else(|| {
                format!("база GeoSite содержит недопустимое доменное назначение в теге {tag}")
            })?;
            groups.entry(tag).or_default().push(GeoDomain {
                domain: normalized,
                match_kind: domain.match_kind,
            });
        }
        Ok(())
    })?;
    if groups.is_empty() {
        return Err("в базе GeoSite нет допустимых тегов".into());
    }
    Ok(groups)
}

pub(crate) fn read_srs(
    data: &[u8],
    mut emit: impl FnMut(Destination) -> ParseResult<()>,
) -> ParseResult<()> {
    if data.len() < 5 || !data.starts_with(b"SRS") || !(1..=5).contains(&data[3]) {
        return Err(ERR_SRS.into());
    }
    let mut payload = Vec::new();
    ZlibDecoder::new(&data[4..])
        .take(MAX_INFLATED_SRS + 1)
        .read_to_end(&mut payload)
        .map_err(|_| ERR_SRS)?;
    if payload.len() as u64 > MAX_INFLATED_SRS {
        return Err(ERR_SRS.into());
    }
    let mut reader = Input::new(&payload, ERR_SRS);
    let count = reader.count(MAX_RULES)?;
    for _ in 0..count {
        if reader.byte()? != 0 {
            return Err("SRS содержит составные правила. Используйте список назначений".into());
        }
        read_srs_rule(&mut reader, &mut emit)?;
    }
    if !reader.content.is_empty() {
        return Err(ERR_SRS.into());
    }
    Ok(())
}

fn read_srs_rule(
    reader: &mut Input<'_>,
    emit: &mut impl FnMut(Destination) -> ParseResult<()>,
) -> ParseResult<()> {
    loop {
        match reader.byte()? {
            255 => {
                if reader.byte()? != 0 {
                    return Err("SRS с условием исключения не является списком назначений".into());
                }
                return Ok(());
            }
            2 => read_srs_domains(reader, emit)?,
            tag @ (3 | 4) => {
                let kind = if tag == 3 { "keyword" } else { "regex" };
                for _ in 0..reader.count(MAX_RULES)? {
                    let value = std::str::from_utf8(reader.vector()?).map_err(|_| ERR_SRS)?;
                    emit(Destination::new(value, kind))?;
                }
            }
            6 => read_srs_ranges(reader, emit)?,
            _ => return Err("SRS содержит условия помимо доменов или IP".into()),
        }
    }
}

fn bit(words: &[u8], index: usize) -> bool {
    let offset = index / 64 * 8 + 7 - index % 64 / 8;
    words
        .get(offset)
        .is_some_and(|byte| byte & (1 << (index % 8)) != 0)
}

fn read_srs_domains(
    reader: &mut Input<'_>,
    emit: &mut impl FnMut(Destination) -> ParseResult<()>,
) -> ParseResult<()> {
    if reader.byte()? != 0 {
        return Err(ERR_SRS.into());
    }
    let leaves = reader.words()?;
    let bitmap = reader.words()?;
    let labels = reader.vector()?;
    if labels.len() * 2 + 1 > bitmap.len() * 8 || labels.len() + 1 > leaves.len() * 8 {
        return Err(ERR_SRS.into());
    }
    let mut parents = vec![0u32; labels.len() + 1];
    let mut exact = HashSet::new();
    let mut exact_order = Vec::new();
    let mut suffixes = Vec::new();
    let mut edge = 0;
    let mut cursor = 0;
    for node in 0..=labels.len() {
        if node > edge {
            return Err(ERR_SRS.into());
        }
        if bit(leaves, node) {
            if exact_order.len() + suffixes.len() >= MAX_RULES * 2 {
                return Err(ERR_SRS.into());
            }
            let mut path = Vec::new();
            let mut i = node;
            while i > 0 {
                if path.len() == 1024 {
                    return Err(ERR_SRS.into());
                }
                path.push(labels[i - 1]);
                i = parents[i] as usize;
            }
            if path.is_empty() {
                return Err(ERR_SRS.into());
            }
            path.reverse();
            let value = std::str::from_utf8(&path)
                .map_err(|_| ERR_SRS)?
                .chars()
                .rev()
                .collect::<String>();
            if let Some(value) = value.strip_prefix(['\r', '\n']) {
                suffixes.push(value.to_owned());
            } else if exact.insert(value.clone()) {
                exact_order.push(value);
            }
        }
        while !bit(bitmap, cursor) {
            if edge == labels.len() {
                return Err(ERR_SRS.into());
            }
            edge += 1;
            parents[edge] = node as u32;
            cursor += 1;
        }
        cursor += 1;
    }
    if edge != labels.len() {
        return Err(ERR_SRS.into());
    }
    for value in suffixes {
        let mut entry = suffix_entry(&value);
        if let Some(value) = value.strip_prefix('.')
            && exact.remove(value)
        {
            entry.match_kind = "suffix".into();
        }
        emit(entry)?;
    }
    for value in exact_order {
        if exact.contains(&value) {
            emit(Destination::new(value, "exact"))?;
        }
    }
    Ok(())
}

fn read_srs_ranges(
    reader: &mut Input<'_>,
    emit: &mut impl FnMut(Destination) -> ParseResult<()>,
) -> ParseResult<()> {
    if reader.byte()? != 1 {
        return Err(ERR_SRS.into());
    }
    let count = u64::from_be_bytes(reader.take(8)?.try_into().expect("eight bytes"));
    if count > (reader.content.len() / 10) as u64 || count > MAX_RULES as u64 {
        return Err(ERR_SRS.into());
    }
    for _ in 0..count {
        let from = reader.vector()?;
        let to = reader.vector()?;
        emit_srs_range(from, to, emit)?;
    }
    Ok(())
}

fn emit_srs_range(
    from: &[u8],
    to: &[u8],
    emit: &mut impl FnMut(Destination) -> ParseResult<()>,
) -> ParseResult<()> {
    if from.len() != to.len() || !matches!(from.len(), 4 | 16) || from > to {
        return Err(ERR_SRS.into());
    }
    let to_word = |bytes: &[u8]| {
        bytes
            .iter()
            .fold(0u128, |value, byte| (value << 8) | u128::from(*byte))
    };
    let mut base = to_word(from);
    let end = to_word(to);
    let width = (from.len() * 8) as u32;
    while base <= end {
        let size = (end - base).checked_add(1);
        let bits_remaining = size.map_or(128, |size| size.ilog2());
        let host_bits = width.min(base.trailing_zeros()).min(bits_remaining);
        let addr = if width == 32 {
            IpAddr::V4(Ipv4Addr::from(base as u32))
        } else {
            IpAddr::V6(Ipv6Addr::from(base))
        };
        emit(Destination::plain(format!(
            "ip:{addr}/{}",
            width - host_bits
        )))?;
        let Some(next) = 1u128
            .checked_shl(host_bits)
            .and_then(|size| base.checked_add(size))
        else {
            break;
        };
        base = next;
    }
    Ok(())
}
