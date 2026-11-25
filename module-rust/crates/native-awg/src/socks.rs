use std::{
    future, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    task::Poll,
    time::Duration,
};

use hickory_proto::{
    op::{Message, MessageType, OpCode, Query},
    rr::{Name, RData, RecordType},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::Semaphore,
    task::JoinSet,
    time::{Instant, sleep, timeout},
};
use tokio_smoltcp::UdpSocket as VirtualUdp;

use crate::{Tunnel, invalid};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SOCKS_CLIENTS: usize = 64;

pub async fn serve_socks(listener: TcpListener, tunnel: Tunnel) -> io::Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(invalid("AmneziaWG SOCKS server must listen on loopback"));
    }
    let tunnel = Arc::new(tunnel);
    let permits = Arc::new(Semaphore::new(MAX_SOCKS_CLIENTS));
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            result = listener.accept() => {
                let (stream, peer) = result?;
                if let Ok(permit) = permits.clone().try_acquire_owned() {
                    let target = tunnel.clone();
                    clients.spawn(async move {
                        let _permit = permit;
                        let _ = handle_client(stream, peer, &target).await;
                    });
                }
            }
            _ = clients.join_next(), if !clients.is_empty() => {}
        }
    }
}

enum Host {
    Ip(IpAddr),
    Domain(String),
}

async fn read_request(stream: &mut TcpStream) -> io::Result<(u8, Host, u16)> {
    if stream.read_u8().await? != 5 {
        return Err(invalid("SOCKS 5 is required"));
    }
    let count = stream.read_u8().await? as usize;
    let mut methods = [0; 255];
    stream.read_exact(&mut methods[..count]).await?;
    if !methods[..count].contains(&0) {
        stream.write_all(&[5, 0xff]).await?;
        return Err(invalid("SOCKS client did not offer unauthenticated mode"));
    }
    stream.write_all(&[5, 0]).await?;

    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 5 || header[2] != 0 {
        return Err(invalid("invalid SOCKS request header"));
    }
    let mut data = [0; 259];
    data[0] = header[3];
    let host_len = match header[3] {
        1 => 4,
        4 => 16,
        3 => {
            data[1] = stream.read_u8().await?;
            data[1] as usize
        }
        _ => {
            reply(stream, 8, None).await?;
            return Err(invalid("unsupported SOCKS address type"));
        }
    };
    let start = if header[3] == 3 { 2 } else { 1 };
    let end = start + host_len + 2;
    stream.read_exact(&mut data[start..end]).await?;
    let (host, port, _) = parse_address(&data[..end])?;
    Ok((header[1], host, port))
}

fn parse_address(data: &[u8]) -> io::Result<(Host, u16, &[u8])> {
    let (&kind, tail) = data
        .split_first()
        .ok_or_else(|| invalid("empty SOCKS address"))?;
    let (host, rest) = match kind {
        1 if tail.len() >= 6 => {
            let bytes: [u8; 4] = tail[..4].try_into().expect("IPv4 size checked");
            (Host::Ip(Ipv4Addr::from(bytes).into()), &tail[4..])
        }
        4 if tail.len() >= 18 => {
            let bytes: [u8; 16] = tail[..16].try_into().expect("IPv6 size checked");
            (Host::Ip(Ipv6Addr::from(bytes).into()), &tail[16..])
        }
        3 if tail.len() >= 3 && tail[0] != 0 && tail.len() >= tail[0] as usize + 3 => {
            let end = 1 + tail[0] as usize;
            let host = std::str::from_utf8(&tail[1..end])
                .map_err(|_| invalid("invalid SOCKS domain encoding"))?;
            (Host::Domain(host.to_owned()), &tail[end..])
        }
        _ => return Err(invalid("invalid SOCKS address")),
    };
    Ok((host, u16::from_be_bytes([rest[0], rest[1]]), &rest[2..]))
}

pub(super) fn encode_address(target: SocketAddr, output: &mut Vec<u8>) {
    match target.ip() {
        IpAddr::V4(ip) => {
            output.push(1);
            output.extend(ip.octets());
        }
        IpAddr::V6(ip) => {
            output.push(4);
            output.extend(ip.octets());
        }
    }
    output.extend(target.port().to_be_bytes());
}

async fn reply(stream: &mut TcpStream, status: u8, endpoint: Option<SocketAddr>) -> io::Result<()> {
    let mut data = vec![5, status, 0];
    encode_address(
        endpoint.unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 0))),
        &mut data,
    );
    stream.write_all(&data).await
}

async fn handle_client(mut stream: TcpStream, peer: SocketAddr, tunnel: &Tunnel) -> io::Result<()> {
    let (command, host, port) = timeout(REQUEST_TIMEOUT, read_request(&mut stream)).await??;
    match command {
        1 => {
            let connection = timeout(REQUEST_TIMEOUT, connect(tunnel, host, port)).await;
            let mut connection = match connection {
                Ok(Ok(connection)) => connection,
                Ok(Err(error)) => {
                    let status = match error.kind() {
                        io::ErrorKind::PermissionDenied => 2,
                        io::ErrorKind::ConnectionRefused => 5,
                        _ => 4,
                    };
                    reply(&mut stream, status, None).await?;
                    return Err(error);
                }
                Err(error) => {
                    reply(&mut stream, 4, None).await?;
                    return Err(error.into());
                }
            };
            let endpoint = connection.local_addr().ok();
            reply(&mut stream, 0, endpoint).await?;
            tokio::io::copy_bidirectional_with_sizes(&mut stream, &mut connection, 4096, 4096)
                .await?;
            Ok(())
        }
        3 => {
            let Host::Ip(client_ip) = host else {
                reply(&mut stream, 8, None).await?;
                return Ok(());
            };
            if !client_ip.is_unspecified() && client_ip.to_canonical() != peer.ip().to_canonical() {
                reply(&mut stream, 2, None).await?;
                return Ok(());
            }
            udp_associate(stream, peer.ip(), port, tunnel).await
        }
        _ => reply(&mut stream, 7, None).await,
    }
}

async fn connect(tunnel: &Tunnel, host: Host, port: u16) -> io::Result<tokio_smoltcp::TcpStream> {
    if port == 0 {
        return Err(invalid("SOCKS CONNECT port must be nonzero"));
    }
    let addresses = resolve(tunnel, host).await?;
    let mut error = io::Error::new(io::ErrorKind::NotFound, "no AmneziaWG destination");
    for ip in addresses {
        let attempt = timeout(
            Duration::from_secs(5),
            tunnel.connect(SocketAddr::new(ip, port)),
        )
        .await;
        match attempt {
            Ok(Ok(connection)) => return Ok(connection),
            Ok(Err(err)) => error = err,
            Err(err) => error = err.into(),
        }
    }
    Err(error)
}

async fn resolve(tunnel: &Tunnel, host: Host) -> io::Result<Vec<IpAddr>> {
    let mut fqdn = match host {
        Host::Ip(ip) => return Ok(vec![ip.to_canonical()]),
        Host::Domain(host) => host,
    };
    if !fqdn.ends_with('.') {
        fqdn.push('.');
    }
    let name = Name::from_utf8(&fqdn).map_err(|_| invalid("invalid SOCKS DNS name"))?;
    for resolver in &tunnel.dns {
        let (ipv4, ipv6) = tokio::join!(
            timeout(DNS_TIMEOUT, lookup(tunnel, *resolver, &name, RecordType::A)),
            timeout(
                DNS_TIMEOUT,
                lookup(tunnel, *resolver, &name, RecordType::AAAA)
            )
        );
        let candidates = [ipv4, ipv6]
            .into_iter()
            .filter_map(|result| result.ok()?.ok())
            .flatten()
            .filter(|ip| tunnel.stack(*ip).is_ok())
            .take(8)
            .collect::<Vec<_>>();
        if !candidates.is_empty() {
            return Ok(candidates);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "tunnel DNS resolved no usable address",
    ))
}

async fn lookup(
    tunnel: &Tunnel,
    resolver: IpAddr,
    name: &Name,
    record_type: RecordType,
) -> io::Result<Vec<IpAddr>> {
    let socket = tunnel.udp_socket(resolver).await?;
    let resolver = SocketAddr::new(resolver, 53);
    let mut request = Message::query();
    request.metadata.recursion_desired = true;
    request.add_query(Query::query(name.clone(), record_type));
    let data = request.to_vec().map_err(invalid)?;
    socket.send_to(&data, resolver).await?;

    let mut buf = [0; 2048];
    loop {
        let (amount, source) = socket.recv_from(&mut buf).await?;
        if source != resolver {
            continue;
        }
        let mut response = Message::from_vec(&buf[..amount]).map_err(invalid)?;
        if !matches_query(&request, &response) {
            continue;
        }
        if response.metadata.truncation {
            response = dns_tcp(tunnel, resolver, &data).await?;
            if response.metadata.truncation || !matches_query(&request, &response) {
                return Err(invalid("invalid tunnel TCP DNS response"));
            }
        }
        return Ok(response
            .answers
            .iter()
            .filter_map(|record| match &record.data {
                RData::A(ip) => Some(ip.0.into()),
                RData::AAAA(ip) => Some(ip.0.into()),
                _ => None,
            })
            .collect());
    }
}

fn matches_query(request: &Message, response: &Message) -> bool {
    response.metadata.id == request.metadata.id
        && response.metadata.message_type == MessageType::Response
        && response.metadata.op_code == OpCode::Query
        && response.queries == request.queries
}

async fn dns_tcp(tunnel: &Tunnel, resolver: SocketAddr, request: &[u8]) -> io::Result<Message> {
    let mut stream = tunnel.connect(resolver).await?;
    let size = u16::try_from(request.len()).map_err(invalid)?;
    stream.write_u16(size).await?;
    stream.write_all(request).await?;
    let size = stream.read_u16().await? as usize;
    if size > 8192 {
        return Err(invalid("oversized tunnel TCP DNS response"));
    }
    let mut reply = vec![0; size];
    stream.read_exact(&mut reply).await?;
    Message::from_vec(&reply).map_err(invalid)
}

async fn udp_associate(
    mut stream: TcpStream,
    client_ip: IpAddr,
    client_port: u16,
    tunnel: &Tunnel,
) -> io::Result<()> {
    let loopback = stream.local_addr()?.ip();
    let socket = UdpSocket::bind(SocketAddr::new(loopback, 0)).await?;
    reply(&mut stream, 0, Some(socket.local_addr()?)).await?;
    let mut client = (client_port != 0).then(|| SocketAddr::new(client_ip, client_port));
    let mut request = vec![0; crate::ipv6::MAX_FRAGMENTED_UDP_PAYLOAD + 262];
    let mut response = vec![0; crate::ipv6::MAX_REASSEMBLED_PACKET];
    let mut reply_packet = Vec::with_capacity(2070);
    let mut virtual_sockets: Vec<(IpAddr, VirtualUdp)> = Vec::with_capacity(2);
    let idle = sleep(UDP_IDLE_TIMEOUT);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            _ = stream.read_u8() => return Ok(()),
            _ = &mut idle => return Ok(()),
            datagram = socket.recv_from(&mut request) => {
                let (amount, source) = datagram?;
                if source.ip() != client_ip || client.is_some_and(|address| address != source) {
                    continue;
                }
                if amount < 4 || request[..3] != [0, 0, 0] {
                    continue;
                }
                let Ok((host, port, payload)) = parse_address(&request[3..amount]) else {
                    continue;
                };
                if port == 0 || payload.len() > crate::ipv6::MAX_FRAGMENTED_UDP_PAYLOAD {
                    continue;
                }
                if client.is_none() {
                    client = Some(source);
                }
                let Ok(Ok(addresses)) = timeout(REQUEST_TIMEOUT, resolve(tunnel, host)).await else {
                    continue;
                };
                for address in addresses {
                    if address.is_ipv4() && payload.len() > 1500 {
                        continue;
                    }
                    let Ok((local, net)) = tunnel.stack(address) else {
                        continue;
                    };
                    let index = match virtual_sockets.iter().position(|(ip, _)| ip == local) {
                        Some(index) => index,
                        None => {
                            let Ok(socket) = net.udp_bind(SocketAddr::new(*local, 0)).await else {
                                continue;
                            };
                            virtual_sockets.push((*local, socket));
                            virtual_sockets.len() - 1
                        }
                    };
                    if matches!(timeout(
                        Duration::from_secs(1),
                        tunnel.send_udp(&virtual_sockets[index].1, SocketAddr::new(address, port), payload)
                    ).await, Ok(Ok(_))) {
                        idle.as_mut().reset(Instant::now() + UDP_IDLE_TIMEOUT);
                        break;
                    }
                }
            }
            received = receive(&virtual_sockets, &mut response) => {
                let (index, (amount, source)) = received?;
                virtual_sockets.rotate_left(index + 1);
                udp_reply(&socket, client, source, &response[..amount], &mut reply_packet).await?;
                idle.as_mut().reset(Instant::now() + UDP_IDLE_TIMEOUT);
            }
        }
    }
}

async fn receive(
    sockets: &[(IpAddr, VirtualUdp)],
    buffer: &mut [u8],
) -> io::Result<(usize, (usize, SocketAddr))> {
    future::poll_fn(|cx| {
        for (index, (_, socket)) in sockets.iter().enumerate() {
            if let Poll::Ready(result) = socket.poll_recv_from(cx, buffer) {
                return Poll::Ready(result.map(|packet| (index, packet)));
            }
        }
        Poll::Pending
    })
    .await
}

async fn udp_reply(
    local: &UdpSocket,
    client: Option<SocketAddr>,
    origin: SocketAddr,
    data: &[u8],
    output: &mut Vec<u8>,
) -> io::Result<()> {
    if let Some(client) = client {
        output.clear();
        output.extend([0, 0, 0]);
        encode_address(origin, output);
        output.extend(data);
        local.send_to(output, client).await?;
    }
    Ok(())
}
