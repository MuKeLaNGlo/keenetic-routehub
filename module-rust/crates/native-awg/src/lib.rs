//! A userspace AmneziaWG client for the RouteHub managed AWG configuration.
//! The interface, TCP and UDP sockets are virtual and do not change host routes.

use std::{
    collections::{HashSet, hash_map::RandomState},
    fmt,
    hash::BuildHasher,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use awgtun::{
    amnezia::Amnezia3Config,
    noise::{Tunn, TunnResult},
    x25519::{PublicKey, StaticSecret},
};
use futures::{SinkExt, StreamExt, channel::mpsc};
use ipnet::IpNet;
use routehub_imports::ManagedAwg;
use smoltcp::{
    iface::Config,
    wire::{HardwareAddress, IpAddress, IpCidr},
};
use tokio::{net::UdpSocket, task::JoinHandle, time::MissedTickBehavior};
use tokio_smoltcp::{BufferSize, Net, NetConfig, TcpStream, UdpSocket as VirtualUdp};

mod ipv6;
mod packet;
mod socks;
#[cfg(test)]
mod tests;

pub use socks::serve_socks;

const MAX_DATAGRAM: usize = 65536;
const PACKET_QUEUE_DEPTH: usize = 32;
const MAX_LOCAL_ADDRESSES: usize = 8;

pub struct Tunnel {
    stacks: Vec<(IpAddr, Net)>,
    allowed: Vec<IpNet>,
    dns: Vec<IpAddr>,
    transport: JoinHandle<io::Result<()>>,
    outbound: mpsc::Sender<Vec<u8>>,
    mtu: usize,
    fragment_sequence: AtomicU32,
    fragment_salt: RandomState,
}

impl Tunnel {
    /// Open the outer UDP socket and start the enclosed TCP/IP stacks.
    /// Endpoint resolution only applies to the VPN peer's outer hostname.
    pub async fn start(config: &ManagedAwg) -> io::Result<Self> {
        let socket = open_endpoint(&config.endpoint).await?;
        let (peer, allowed) = peer_from_config(config)?;
        Self::start_on(config, socket, peer, allowed)
    }

    fn start_on(
        config: &ManagedAwg,
        socket: UdpSocket,
        peer: Tunn,
        allowed: Vec<IpNet>,
    ) -> io::Result<Self> {
        let addresses = &config.addresses;
        if addresses.is_empty()
            || addresses.len() > MAX_LOCAL_ADDRESSES
            || addresses.iter().copied().collect::<HashSet<_>>().len() != addresses.len()
        {
            return Err(invalid(
                "invalid or duplicate AmneziaWG interface addresses",
            ));
        }
        let (outbound, outbound_rx) = mpsc::channel(PACKET_QUEUE_DEPTH);
        let depth = (2 * PACKET_QUEUE_DEPTH / addresses.len()).min(PACKET_QUEUE_DEPTH);
        let create_stack = |address: IpAddr| {
            let (inbound, inbound_rx) = mpsc::channel(depth);
            let device = packet::Device::new(inbound_rx, outbound.clone(), usize::from(config.mtu));
            let address_len = if address.is_ipv4() { 32 } else { 128 };
            let gateway = if address.is_ipv4() {
                IpAddr::V4(Ipv4Addr::UNSPECIFIED)
            } else {
                IpAddr::V6(Ipv6Addr::UNSPECIFIED)
            };
            let mut iface = Config::new(HardwareAddress::Ip);
            iface.random_seed = std::hash::BuildHasher::hash_one(
                &std::collections::hash_map::RandomState::new(),
                address,
            );
            let mut net_config = NetConfig::new(
                iface,
                IpCidr::new(IpAddress::from(address), address_len),
                vec![IpAddress::from(gateway)],
            );
            net_config.buffer_size = BufferSize {
                tcp_rx_size: 16 * 1024,
                tcp_tx_size: 16 * 1024,
                ..BufferSize::default()
            };
            ((address, Net::new(device, net_config)), (address, inbound))
        };
        // tokio-smoltcp fixes the source address of a TCP socket to the address
        // given at stack construction. Keep one small stack per local address.
        let (stacks, inbound) = addresses.iter().copied().map(create_stack).unzip();
        let transport = tokio::spawn(pump(
            socket,
            peer,
            outbound_rx,
            inbound,
            allowed.clone(),
            config.mtu as usize,
        ));
        Ok(Self {
            stacks,
            allowed,
            dns: config.dns.clone(),
            transport,
            outbound,
            mtu: usize::from(config.mtu),
            fragment_sequence: AtomicU32::new(0),
            fragment_salt: RandomState::new(),
        })
    }

    fn stack(&self, destination: IpAddr) -> io::Result<&(IpAddr, Net)> {
        if self.transport.is_finished() {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "AmneziaWG transport has stopped",
            ));
        }
        if !allowed_ip(&self.allowed, destination) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "destination is outside the AmneziaWG peer's AllowedIPs",
            ));
        }
        self.stacks
            .iter()
            .rev()
            .filter_map(|stack| source_rank(stack.0, destination).map(|rank| (rank, stack)))
            .max_by_key(|(rank, _)| *rank)
            .map(|(_, stack)| stack)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AddrNotAvailable,
                    "AmneziaWG profile lacks an IP address in the destination family",
                )
            })
    }

    pub async fn connect(&self, destination: SocketAddr) -> io::Result<TcpStream> {
        let (_, net) = self.stack(destination.ip())?;
        net.tcp_connect(destination).await
    }

    pub async fn udp_socket(&self, destination: IpAddr) -> io::Result<VirtualUdp> {
        let (local, net) = self.stack(destination)?;
        net.udp_bind(SocketAddr::new(*local, 0)).await
    }

    // smoltcp does not originate IPv6 fragments on an IP medium. Reserve and
    // keep the real virtual UDP socket for its source port and incoming replies.
    async fn send_udp(
        &self,
        socket: &VirtualUdp,
        destination: SocketAddr,
        payload: &[u8],
    ) -> io::Result<usize> {
        let local = socket.local_addr()?;
        let expected = self.stack(destination.ip())?.0;
        if local.ip() != expected || local.port() == 0 {
            return Err(invalid("invalid virtual UDP source"));
        }
        if let (SocketAddr::V6(local), SocketAddr::V6(destination)) = (local, destination)
            && ipv6::requires_fragmentation(payload.len(), self.mtu)
        {
            // RFC 7739's keyed offset approach keeps the counter unique for
            // each address pair without retaining a separate per-peer table.
            let offset = self.fragment_salt.hash_one((local.ip(), destination.ip())) as u32;
            let sequence = self.fragment_sequence.fetch_add(1, Ordering::Relaxed);
            let mut outbound = self.outbound.clone();
            for packet in ipv6::udp_fragments(
                local,
                destination,
                payload,
                self.mtu,
                offset.wrapping_add(sequence),
            )? {
                outbound.send(packet).await.map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::NotConnected,
                        "AmneziaWG transport has stopped",
                    )
                })?;
            }
            return Ok(payload.len());
        }
        socket.send_to(payload, destination).await
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.transport.abort();
    }
}

// For the static addresses supported by the profile importer, no address is
// deprecated or temporary and all addresses use the same virtual interface.
fn source_rank(local: IpAddr, remote: IpAddr) -> Option<(bool, bool, bool, u32)> {
    match (local, remote) {
        (IpAddr::V4(local), IpAddr::V4(remote)) => Some((
            false,
            false,
            false,
            (u32::from(local) ^ u32::from(remote)).leading_zeros(),
        )),
        (IpAddr::V6(local), IpAddr::V6(remote)) => Some((
            local == remote,
            link_local_v6(local) == link_local_v6(remote),
            ipv6_label(local) == ipv6_label(remote),
            (u128::from(local) ^ u128::from(remote)).leading_zeros(),
        )),
        _ => None,
    }
}

fn link_local_v6(address: Ipv6Addr) -> bool {
    address.is_unicast_link_local() || (address.is_multicast() && address.octets()[1] & 0x0f == 2)
}

fn ipv6_label(address: Ipv6Addr) -> u8 {
    match address.octets() {
        _ if address.is_loopback() => 0,
        _ if address.to_ipv4_mapped().is_some() => 4,
        [0x20, 0x01, 0, 0, ..] => 5,
        [0x20, 0x02, ..] => 2,
        [0xfc | 0xfd, ..] => 13,
        _ => 1,
    }
}

async fn open_endpoint(endpoint: &str) -> io::Result<UdpSocket> {
    let mut peers = tokio::net::lookup_host(endpoint).await?.collect::<Vec<_>>();
    // Match the Go adapter on dual-stack hostnames. UDP connect cannot tell us
    // whether an IPv6 address is reachable from a router with an IPv4-only WAN.
    peers.sort_by_key(SocketAddr::is_ipv6);
    let mut last_error = io::Error::new(io::ErrorKind::NotFound, "AmneziaWG endpoint not found");
    for peer in peers {
        let addr = if peer.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let socket = match UdpSocket::bind(addr).await {
            Ok(socket) => socket,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        match socket.connect(peer).await {
            Ok(()) => return Ok(socket),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn invalid(message: impl fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_string())
}

fn parse_key(key: &str, value: &str) -> io::Result<[u8; 32]> {
    let mut bytes = [0; 32];
    hex::decode_to_slice(value, &mut bytes).map_err(|_| invalid(format!("invalid {key}")))?;
    Ok(bytes)
}

fn peer_from_config(config: &ManagedAwg) -> io::Result<(Tunn, Vec<IpNet>)> {
    let mut private = None;
    let mut public = None;
    let mut psk = None;
    let mut allowed = Vec::new();
    let mut options = format!("mtu={}\n", config.mtu);
    for line in config.parameters.lines() {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| invalid("invalid AWG parameter"))?;
        match key {
            "private_key" => private = Some(StaticSecret::from(parse_key(key, value)?)),
            "public_key" => public = Some(PublicKey::from(parse_key(key, value)?)),
            "preshared_key" => psk = Some(parse_key(key, value)?),
            "allowed_ip" => allowed.push(value.parse().map_err(|_| invalid("invalid AllowedIPs"))?),
            "replace_allowed_ips" => continue,
            _ => {
                options.push_str(line);
                options.push('\n');
            }
        }
    }
    let options =
        Amnezia3Config::parse(&options).map_err(|_| invalid("invalid AmneziaWG options"))?;
    let peer = Tunn::new_with_amnezia3(
        private.ok_or_else(|| invalid("AmneziaWG private key is required"))?,
        public.ok_or_else(|| invalid("AmneziaWG peer public key is required"))?,
        psk,
        None,
        1,
        None,
        options,
    )
    .map_err(|_| invalid("invalid AmneziaWG peer configuration"))?;
    Ok((peer, allowed))
}

fn allowed_ip(allowed: &[IpNet], ip: IpAddr) -> bool {
    allowed.iter().any(|network| network.contains(&ip))
}

async fn pump(
    socket: UdpSocket,
    mut peer: Tunn,
    mut outbound: mpsc::Receiver<Vec<u8>>,
    mut inbound: Vec<(IpAddr, mpsc::Sender<Vec<u8>>)>,
    allowed: Vec<IpNet>,
    mtu: usize,
) -> io::Result<()> {
    let sender = socket.peer_addr()?.ip();
    let mut recv = vec![0; MAX_DATAGRAM];
    let mut send = vec![0; MAX_DATAGRAM];
    let mut reassembly = ipv6::Reassembly::default();
    let mut timers = tokio::time::interval(Duration::from_millis(250));
    timers.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let mut read_network = false;
        let result = tokio::select! {
            amount = socket.recv(&mut recv) => {
                let amount = match amount {
                    Ok(amount) => amount,
                    Err(error) if transient_udp_error(&error) => continue,
                    Err(error) => return Err(error),
                };
                if amount == 0 {
                    continue;
                }
                read_network = true;
                peer.decapsulate(Some(sender), &recv[..amount], &mut send)
            }
            packet = outbound.next() => {
                let Some(packet) = packet else {
                    return Ok(());
                };
                if !Tunn::dst_address(&packet).is_some_and(|ip| allowed_ip(&allowed, ip)) {
                    continue;
                }
                peer.encapsulate(&packet, &mut send)
            }
            _ = timers.tick() => {
                reassembly.expire(Instant::now());
                peer.update_timers(&mut send)
            }
        };
        // AWG sends the optional I and junk datagrams before the actual initiation.
        while let Some(datagram) = peer.poll_outgoing_packet() {
            send_datagram(&socket, &datagram).await?;
        }
        match result {
            TunnResult::Done | TunnResult::Err(_) => {}
            TunnResult::WriteToNetwork(datagram) => {
                send_datagram(&socket, datagram).await?;
                if read_network {
                    while let TunnResult::WriteToNetwork(queued) =
                        peer.decapsulate(None, &[], &mut send)
                    {
                        while let Some(datagram) = peer.poll_outgoing_packet() {
                            send_datagram(&socket, &datagram).await?;
                        }
                        send_datagram(&socket, queued).await?;
                    }
                }
            }
            TunnResult::WriteToTunnelV4(packet, source) => {
                deliver(
                    &mut inbound,
                    packet,
                    source.into(),
                    &allowed,
                    mtu,
                    &mut reassembly,
                );
            }
            TunnResult::WriteToTunnelV6(packet, source) => {
                deliver(
                    &mut inbound,
                    packet,
                    source.into(),
                    &allowed,
                    mtu,
                    &mut reassembly,
                );
            }
        }
    }
}

fn transient_udp_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::HostUnreachable
            | io::ErrorKind::NetworkUnreachable
    )
}

async fn send_datagram(socket: &UdpSocket, datagram: &[u8]) -> io::Result<()> {
    match socket.send(datagram).await {
        Ok(_) => Ok(()),
        Err(error) if transient_udp_error(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn deliver(
    inbound: &mut [(IpAddr, mpsc::Sender<Vec<u8>>)],
    packet: &[u8],
    source: IpAddr,
    allowed: &[IpNet],
    mtu: usize,
    reassembly: &mut ipv6::Reassembly,
) {
    if packet.len() > mtu || !allowed_ip(allowed, source) {
        return;
    }
    let Some(destination) = Tunn::dst_address(packet) else {
        return;
    };
    let Some((_, channel)) = inbound
        .iter_mut()
        .find(|(address, _)| *address == destination)
    else {
        return;
    };
    let packet = match destination {
        IpAddr::V4(_) => Some(packet.to_vec()),
        IpAddr::V6(_) => reassembly.receive(packet, Instant::now()),
    };
    // Congestion on one local address must not stall the peer or its timers.
    if let Some(packet) = packet {
        let _ = channel.try_send(packet);
    }
}
