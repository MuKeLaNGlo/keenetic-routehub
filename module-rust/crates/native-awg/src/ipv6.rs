use std::{
    io,
    net::SocketAddrV6,
    time::{Duration, Instant},
};

use smoltcp::{
    phy::ChecksumCapabilities,
    wire::{IpProtocol, Ipv6Packet, Ipv6Repr, UdpPacket, UdpRepr},
};

const BASE_LEN: usize = 40;
const FRAGMENT: u8 = 44;
const FRAGMENT_LEN: usize = 8;
const UDP_LEN: usize = 8;
const MAX_SETS: usize = 8;
const MAX_PARTS: usize = 256;
pub(super) const MAX_REASSEMBLED_PACKET: usize = 8192;
pub(super) const MAX_FRAGMENTED_UDP_PAYLOAD: usize = MAX_REASSEMBLED_PACKET - BASE_LEN - UDP_LEN;
const MAX_QUEUED_BYTES: usize = 48 << 10;
const LIFETIME: Duration = Duration::from_secs(60);

pub(super) fn requires_fragmentation(payload_len: usize, mtu: usize) -> bool {
    BASE_LEN + UDP_LEN + payload_len > mtu
}

pub(super) fn udp_fragments(
    source: SocketAddrV6,
    target: SocketAddrV6,
    payload: &[u8],
    mtu: usize,
    id: u32,
) -> io::Result<impl Iterator<Item = Vec<u8>> + use<>> {
    if payload.len() > MAX_FRAGMENTED_UDP_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "IPv6 UDP payload exceeds the tunnel limit",
        ));
    }
    let size = mtu.saturating_sub(BASE_LEN + FRAGMENT_LEN) & !7;
    if size < UDP_LEN || !requires_fragmentation(payload.len(), mtu) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid IPv6 fragment MTU",
        ));
    }
    let mut message = vec![0; UDP_LEN + payload.len()];
    UdpRepr {
        src_port: source.port(),
        dst_port: target.port(),
    }
    .emit(
        &mut UdpPacket::new_unchecked(&mut message),
        &(*source.ip()).into(),
        &(*target.ip()).into(),
        payload.len(),
        |output| output.copy_from_slice(payload),
        &ChecksumCapabilities::default(),
    );
    Ok((0..message.len()).step_by(size).map(move |offset| {
        let end = (offset + size).min(message.len());
        let data = &message[offset..end];
        let mut packet = vec![0; BASE_LEN + FRAGMENT_LEN + data.len()];
        Ipv6Repr {
            src_addr: *source.ip(),
            dst_addr: *target.ip(),
            next_header: IpProtocol::Ipv6Frag,
            payload_len: FRAGMENT_LEN + data.len(),
            hop_limit: 64,
        }
        .emit(&mut Ipv6Packet::new_unchecked(&mut packet[..]));
        packet[BASE_LEN] = u8::from(IpProtocol::Udp);
        let field = offset as u16 | u16::from(end != message.len());
        packet[BASE_LEN + 2..BASE_LEN + 4].copy_from_slice(&field.to_be_bytes());
        packet[BASE_LEN + 4..BASE_LEN + FRAGMENT_LEN].copy_from_slice(&id.to_be_bytes());
        packet[BASE_LEN + FRAGMENT_LEN..].copy_from_slice(data);
        packet
    }))
}

#[derive(Default)]
pub(super) struct Reassembly {
    entries: Vec<Entry>,
}

#[derive(PartialEq, Eq)]
struct Identifier {
    addresses: [u8; 32],
    id: u32,
}

struct Entry {
    identifier: Identifier,
    expires: Instant,
    // Discarded sets keep only their identifier for the rest of the lifetime.
    pending: Option<Pending>,
}

#[derive(Default)]
struct Pending {
    first: Option<FirstFragment>,
    parts: Vec<Part>,
    bytes: usize,
    end: Option<usize>,
    ecn: u8,
}

struct FirstFragment {
    base: [u8; BASE_LEN],
    prefix_len: usize,
    after_fragment_headers_len: usize,
    protocol: u8,
}

struct Part {
    offset: usize,
    more: bool,
    data: Vec<u8>,
}

struct Fragment<'a> {
    offset: usize,
    more: bool,
    payload: &'a [u8],
}

impl Reassembly {
    pub(super) fn expire(&mut self, now: Instant) {
        self.entries.retain(|entry| now < entry.expires);
    }

    pub(super) fn receive(&mut self, packet: &[u8], now: Instant) -> Option<Vec<u8>> {
        let base: &[u8; BASE_LEN] = packet.get(..BASE_LEN)?.try_into().ok()?;
        let body = packet.get(BASE_LEN..)?;
        if usize::from(u16::from_be_bytes([base[4], base[5]])) != body.len() {
            return None;
        }
        let (protocol, prefix_len) = walk_extensions(body, base[6], true)?;
        if protocol != FRAGMENT {
            return if prefix_len == 0 {
                Some(packet.to_vec())
            } else {
                normal_packet(base, protocol, &body[prefix_len..])
            };
        }

        let fragment = body.get(prefix_len..)?;
        let header = fragment.get(..8)?;
        let offset_and_flags = u16::from_be_bytes([header[2], header[3]]);
        let fragment = Fragment {
            offset: usize::from(offset_and_flags & 0xfff8),
            more: offset_and_flags & 1 != 0,
            payload: &fragment[8..],
        };
        if fragment.offset == 0 && !fragment.more {
            // RFC 8200 treats atomic fragments independently of queued packets.
            let (protocol, offset) = walk_extensions(fragment.payload, header[0], false)?;
            let upper = &fragment.payload[offset..];
            return if fragment_transport_ok(protocol, upper) {
                normal_packet(base, protocol, upper)
            } else {
                None
            };
        }
        self.expire(now);
        let identifier = Identifier {
            addresses: base[8..40].try_into().ok()?,
            id: u32::from_be_bytes(header[4..8].try_into().ok()?),
        };
        let end = fragment.offset + fragment.payload.len();
        if fragment.payload.is_empty()
            || (fragment.more && !fragment.payload.len().is_multiple_of(8))
            || BASE_LEN + end > MAX_REASSEMBLED_PACKET
        {
            return None;
        }
        let prepared = if fragment.offset == 0 {
            let (protocol, offset) = walk_extensions(fragment.payload, header[0], false)?;
            if !fragment_transport_ok(protocol, &fragment.payload[offset..]) {
                return None;
            }
            Some(FirstFragment {
                base: *base,
                prefix_len,
                after_fragment_headers_len: offset,
                protocol,
            })
        } else {
            None
        };
        let index = match self
            .entries
            .iter()
            .position(|entry| entry.identifier == identifier)
        {
            Some(index) => index,
            None if self.entries.len() < MAX_SETS => {
                self.entries.push(Entry {
                    identifier,
                    expires: now + LIFETIME,
                    pending: Some(Pending::default()),
                });
                self.entries.len() - 1
            }
            None => return None,
        };
        let queued = self
            .entries
            .iter()
            .filter_map(|entry| entry.pending.as_ref().map(|pending| pending.bytes))
            .sum::<usize>();
        let entry = &mut self.entries[index];
        let pending = entry.pending.as_mut()?;
        match pending.add(fragment, end, prepared, (base[1] >> 4) & 3, queued) {
            Ok(false) => None,
            Ok(true) => self.entries.swap_remove(index).pending?.complete(),
            Err(()) => {
                entry.pending = None;
                None
            }
        }
    }
}

impl Pending {
    fn add(
        &mut self,
        fragment: Fragment<'_>,
        end: usize,
        first: Option<FirstFragment>,
        ecn: u8,
        queued: usize,
    ) -> Result<bool, ()> {
        // Keep a mask so ECN congestion marks survive reassembly (RFC 3168 §5.3).
        self.ecn |= 1 << ecn;
        if self.ecn & 1 != 0 && self.ecn & 8 != 0 {
            return Err(());
        }
        let position = self
            .parts
            .partition_point(|part| part.offset < fragment.offset);
        if let Some(part) = self.parts.get(position)
            && part.offset < end
        {
            let compatible_header = match (&self.first, &first) {
                (Some(previous), Some(current)) => {
                    previous.protocol == current.protocol
                        && previous.after_fragment_headers_len == current.after_fragment_headers_len
                }
                _ => true,
            };
            return if part.offset == fragment.offset
                && part.more == fragment.more
                && part.data == fragment.payload
                && compatible_header
            {
                Ok(false)
            } else {
                Err(())
            };
        }
        if position > 0 {
            let previous = &self.parts[position - 1];
            if previous.offset + previous.data.len() > fragment.offset {
                return Err(());
            }
        }
        if self
            .end
            .is_some_and(|last| end > last || (fragment.more && end >= last))
            || (!fragment.more && self.parts.get(position).is_some())
            || self.parts.len() == MAX_PARTS
            || queued + fragment.payload.len() > MAX_QUEUED_BYTES
        {
            return Err(());
        }
        if let Some(first) = first {
            self.first = Some(first);
        }
        if !fragment.more {
            self.end = Some(end);
        }
        if let Some(first) = &self.first
            && BASE_LEN + first.prefix_len + self.end.unwrap_or(end) > MAX_REASSEMBLED_PACKET
        {
            return Err(());
        }
        self.bytes += fragment.payload.len();
        self.parts.insert(
            position,
            Part {
                offset: fragment.offset,
                more: fragment.more,
                data: fragment.payload.to_vec(),
            },
        );
        Ok(self.end == Some(self.bytes) && self.first.is_some())
    }

    fn complete(self) -> Option<Vec<u8>> {
        let first = self.first?;
        let length = self.end?.checked_sub(first.after_fragment_headers_len)?;
        let mut packet = Vec::with_capacity(BASE_LEN + length);
        packet.extend_from_slice(&first.base);
        let (start, others) = self.parts.split_first()?;
        packet.extend_from_slice(start.data.get(first.after_fragment_headers_len..)?);
        for part in others {
            packet.extend_from_slice(&part.data);
        }
        patch_header(&mut packet, first.protocol, length)?;
        if self.ecn & 8 != 0 {
            packet[1] |= 0x30;
        }
        Some(packet)
    }
}

fn normal_packet(base: &[u8; BASE_LEN], protocol: u8, data: &[u8]) -> Option<Vec<u8>> {
    let mut packet = Vec::with_capacity(BASE_LEN + data.len());
    packet.extend_from_slice(base);
    packet.extend_from_slice(data);
    patch_header(&mut packet, protocol, data.len())?;
    Some(packet)
}

fn patch_header(packet: &mut [u8], protocol: u8, length: usize) -> Option<()> {
    packet[4..6].copy_from_slice(&u16::try_from(length).ok()?.to_be_bytes());
    packet[6] = protocol;
    Some(())
}

fn fragment_transport_ok(protocol: u8, upper: &[u8]) -> bool {
    match protocol {
        6 if upper.len() >= 20 => {
            let length = usize::from(upper[12] >> 4) * 4;
            (20..=upper.len()).contains(&length)
        }
        17 => upper.len() >= 8,
        58 => upper.len() >= 4 && !matches!(upper[0], 133..=137),
        _ => false,
    }
}

// smoltcp's IP medium understands an initial Hop-by-Hop header but does
// not traverse extension chains. Validate and skip inert extensions at the
// virtual endpoint. Stop immediately at the Fragment header or transport.
fn walk_extensions(packet: &[u8], mut protocol: u8, initial: bool) -> Option<(u8, usize)> {
    let mut offset = 0;
    while matches!(protocol, 0 | 43 | 60) {
        let tail = packet.get(offset..)?;
        let size = (usize::from(*tail.get(1)?) + 1) * 8;
        let extension = tail.get(..size)?;
        let valid = match protocol {
            0 => initial && offset == 0 && skippable_options(&extension[2..]),
            43 => extension[3] == 0,
            60 => skippable_options(&extension[2..]),
            _ => unreachable!(),
        };
        if !valid {
            return None;
        }
        protocol = extension[0];
        offset += size;
    }
    Some((protocol, offset))
}

fn skippable_options(mut options: &[u8]) -> bool {
    while let Some((&kind, remaining)) = options.split_first() {
        if kind == 0 {
            options = remaining;
            continue;
        }
        let Some((&length, body)) = remaining.split_first() else {
            return false;
        };
        if kind >> 6 != 0 || (kind == 5 && length != 2) {
            return false;
        }
        let Some(rest) = body.get(usize::from(length)..) else {
            return false;
        };
        options = rest;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const UDP: [u8; 16] = [1, 2, 3, 4, 0, 27, 5, 6, 1, 1, 1, 1, 1, 1, 1, 1];

    fn fragment(id: u32, offset: u16, more: bool, protocol: u8, payload: &[u8]) -> Vec<u8> {
        let mut packet = vec![0; BASE_LEN];
        packet[0] = 0x60;
        packet[6] = FRAGMENT;
        packet[7] = 64;
        packet[8..24].copy_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        packet[24..40].copy_from_slice(&std::net::Ipv6Addr::from_bits(2).octets());
        let field = offset | u16::from(more);
        packet.extend_from_slice(&[protocol, 0, field.to_be_bytes()[0], field.to_be_bytes()[1]]);
        packet.extend_from_slice(&id.to_be_bytes());
        packet.extend_from_slice(payload);
        let length = (packet.len() - BASE_LEN) as u16;
        packet[4..6].copy_from_slice(&length.to_be_bytes());
        packet
    }

    #[test]
    fn ordered_and_out_of_order_fragments_remove_fragment_and_destination_headers() {
        let mut first = vec![17, 0, 0, 0, 0, 0, 0, 0];
        first.extend_from_slice(&UDP);
        let second = [2; 8];
        let last = [3; 3];
        let fragments = [
            fragment(7, 0, true, 60, &first),
            fragment(7, 24, true, 59, &second),
            fragment(7, 32, false, 59, &last),
        ];
        let expected_data = [UDP.as_slice(), &second, &last].concat();
        let now = Instant::now();
        for order in [[0, 1, 2], [2, 1, 0]] {
            let mut queue = Reassembly::default();
            assert!(queue.receive(&fragments[order[0]], now).is_none());
            assert!(queue.receive(&fragments[order[1]], now).is_none());
            let packet = queue.receive(&fragments[order[2]], now).unwrap();
            assert_eq!(packet[6], 17);
            assert_eq!(
                usize::from(u16::from_be_bytes([packet[4], packet[5]])),
                expected_data.len()
            );
            assert_eq!(packet[BASE_LEN..], expected_data);
            assert!(queue.entries.is_empty());
        }
    }

    #[test]
    fn overlapping_and_conflicting_sets_stay_discarded_until_expiry() {
        let now = Instant::now();
        let first = fragment(9, 0, true, 17, &UDP);
        let last = fragment(9, 16, false, 17, &[3; 11]);
        let mut bytes = UDP;
        bytes[8] ^= 1;
        for conflict in [
            fragment(9, 8, false, 17, &[2; 11]),
            fragment(9, 0, true, 17, &bytes),
            fragment(9, 16, false, 17, &[3; 7]),
        ] {
            let mut queue = Reassembly::default();
            assert!(queue.receive(&first, now).is_none());
            assert!(queue.receive(&first, now).is_none()); // Exact duplicates are ignored.
            if conflict[BASE_LEN + 3] == 16 {
                let missing_middle = fragment(9, 24, false, 17, &[4; 3]);
                assert!(queue.receive(&missing_middle, now).is_none());
            }
            assert!(queue.receive(&conflict, now).is_none());
            assert!(queue.entries[0].pending.is_none());
            assert!(queue.receive(&last, now).is_none());
            assert!(queue.receive(&first, now + LIFETIME).is_none());
            assert!(queue.receive(&last, now + LIFETIME).is_some());
        }
    }

    #[test]
    fn lifetime_runs_from_first_arrival_and_atomic_fragments_are_independent() {
        let now = Instant::now();
        let mut queue = Reassembly::default();
        let first = fragment(11, 0, true, 17, &UDP);
        let middle = fragment(11, 16, true, 17, &[2; 8]);
        let last = fragment(11, 24, false, 17, &[3; 3]);
        let atomic = fragment(11, 0, false, 17, &UDP);
        assert!(queue.receive(&middle, now).is_none());
        assert!(queue.receive(&atomic, now).is_some());
        assert_eq!(queue.entries.len(), 1);
        assert!(
            queue
                .receive(&first, now + Duration::from_secs(59))
                .is_none()
        );
        assert!(queue.receive(&last, now + LIFETIME).is_none());
        assert!(queue.receive(&first, now + LIFETIME).is_none());
        assert!(queue.receive(&middle, now + LIFETIME).is_some());
        queue.receive(&first, now);
        queue.expire(now + LIFETIME);
        assert!(queue.entries.is_empty());
    }

    #[test]
    fn exhaustion_cannot_evict_an_active_set_or_increase_memory_limits() {
        let now = Instant::now();
        let mut queue = Reassembly::default();
        for id in 0..MAX_SETS as u32 {
            assert!(
                queue
                    .receive(&fragment(id, 0, true, 17, &UDP), now)
                    .is_none()
            );
        }
        let overflow = MAX_SETS as u32 + 1;
        assert!(
            queue
                .receive(&fragment(overflow, 0, true, 17, &UDP), now)
                .is_none()
        );
        assert!(
            !queue
                .entries
                .iter()
                .any(|entry| entry.identifier.id == overflow)
        );
        assert!(
            queue
                .receive(&fragment(0, 16, false, 17, &[1; 11]), now)
                .is_some()
        );

        let mut queue = Reassembly::default();
        let mut data = vec![0; 1024];
        data[..8].copy_from_slice(&UDP[..8]);
        for id in 0..7 {
            for index in 0..7 {
                queue.receive(&fragment(id, index * 1024, true, 17, &data), now);
            }
        }
        assert!(queue.entries.iter().any(|entry| entry.pending.is_none()));
        let used = queue
            .entries
            .iter()
            .filter_map(|entry| entry.pending.as_ref().map(|set| set.bytes))
            .sum::<usize>();
        assert!(used <= MAX_QUEUED_BYTES);
        assert!(
            queue
                .receive(&fragment(999, 8192, false, 17, &[1]), now)
                .is_none()
        );
        assert!(!queue.entries.iter().any(|entry| entry.identifier.id == 999));
    }

    #[test]
    fn reassembly_requires_a_full_first_header_and_preserves_congestion() {
        let now = Instant::now();
        let mut queue = Reassembly::default();
        let incomplete_tcp = fragment(15, 0, true, 6, &[0; 16]);
        assert!(queue.receive(&incomplete_tcp, now).is_none());
        assert!(queue.entries.is_empty());
        let unaligned = fragment(15, 0, true, 17, &[0; 9]);
        assert!(queue.receive(&unaligned, now).is_none());
        assert!(queue.entries.is_empty());
        let mut first = fragment(15, 0, true, 17, &UDP);
        let mut last = fragment(15, 16, false, 17, &[1; 11]);
        first[1] = 0x20; // ECT(0)
        last[1] = 0x30; // CE
        assert!(queue.receive(&first, now).is_none());
        assert_eq!((queue.receive(&last, now).unwrap()[1] >> 4) & 3, 3);
        first[1] = 0; // Not-ECT cannot be combined with a congestion mark.
        assert!(queue.receive(&first, now).is_none());
        assert!(queue.receive(&last, now).is_none());
        assert!(queue.entries[0].pending.is_none());
    }
}
