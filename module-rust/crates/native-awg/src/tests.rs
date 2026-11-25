use std::{
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use awgtun::{
    noise::{Tunn, TunnResult},
    x25519::{PublicKey, StaticSecret},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hickory_proto::{
    op::{Message, OpCode},
    rr::{RData, Record, RecordType, rdata::A},
};
use routehub_imports::parse_managed_awg;
use smoltcp::{
    phy::ChecksumCapabilities,
    wire::{UdpPacket, UdpRepr},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    time::timeout,
};

use super::{Tunnel, peer_from_config, serve_socks};

const V4_CLIENT: &str = "10.7.0.2";
const V4_SERVER: &str = "10.7.0.1";
const V4_ALT_CLIENT: &str = "10.19.0.2";
const V4_ALT_SERVER: &str = "10.19.0.1";
const V6_CLIENT: &str = "fd10:22::2";
const V6_SERVER: &str = "fd10:22::1";

async fn tunnel_pair(version: &str) -> (Tunnel, Tunnel) {
    let client_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let server_udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let client_endpoint = client_udp.local_addr().unwrap();
    let server_endpoint = server_udp.local_addr().unwrap();
    client_udp.connect(server_endpoint).await.unwrap();
    server_udp.connect(client_endpoint).await.unwrap();

    // Synthetic peer keys used exclusively on loopback.
    let client_key = [40; 32];
    let server_key = [80; 32];
    let public_key = |private| *PublicKey::from(&StaticSecret::from(private)).as_bytes();
    let options = "Jc=2\nJmin=20\nJmax=60\nS1=12\nS2=13\nS3=14\nS4=15\nH1=601-699\nH2=700-799\nH3=800-899\nH4=900-999\nI1=<b 0xdeadbeef>\n";
    let extra = if version == "3.1" {
        format!(
            "HeaderProtectionKey={}\nRandomTrailers=1\nDisableCookies=true\nRekeyAfterTime=100-130\n",
            STANDARD.encode([111; 32])
        )
    } else {
        String::new()
    };
    let config = |key, peer, endpoint, addresses: &str| {
        let private = STANDARD.encode(key);
        let public = STANDARD.encode(public_key(peer));
        parse_managed_awg(
            &format!(
                "# AmneziaWG {version}\n[Interface]\nPrivateKey={private}\nAddress={addresses}\nDNS={V4_SERVER}\n{options}{extra}[Peer]\nPublicKey={public}\nEndpoint={endpoint}\nAllowedIPs=10.7.0.0/24,10.19.0.0/24,fd10:22::/64,fd30:44::/64\nPersistentKeepalive=5\n"
            ),
            version,
        )
        .unwrap()
    };

    let client = config(
        client_key,
        server_key,
        server_endpoint,
        &format!("{V4_ALT_CLIENT}/32,fd30:44::2/128,{V4_CLIENT}/32,{V6_CLIENT}/128"),
    );
    let server = config(
        server_key,
        client_key,
        client_endpoint,
        &format!("{V4_ALT_SERVER}/32,fd30:44::1/128,{V4_SERVER}/32,{V6_SERVER}/128"),
    );
    let (client_peer, client_allowed) = peer_from_config(&client).unwrap();
    let (server_peer, server_allowed) = peer_from_config(&server).unwrap();
    (
        Tunnel::start_on(&client, client_udp, client_peer, client_allowed).unwrap(),
        Tunnel::start_on(&server, server_udp, server_peer, server_allowed).unwrap(),
    )
}

async fn handshake(socks: SocketAddr) -> TcpStream {
    let mut stream = TcpStream::connect(socks).await.unwrap();
    stream.write_all(&[5, 1, 0]).await.unwrap();
    let mut response = [0; 2];
    stream.read_exact(&mut response).await.unwrap();
    assert_eq!(response, [5, 0]);
    stream
}

async fn run_socks(version: &str) {
    let (client, server) = tunnel_pair(version).await;
    let tcp4_target = format!("{V4_SERVER}:8080").parse::<SocketAddr>().unwrap();
    let tcp6_target = format!("[{V6_SERVER}]:8081").parse::<SocketAddr>().unwrap();
    let udp_target = format!("{V4_SERVER}:8082").parse::<SocketAddr>().unwrap();
    let udp_alt_target = format!("{V4_ALT_SERVER}:8083")
        .parse::<SocketAddr>()
        .unwrap();
    let udp_v6_target = format!("[{V6_SERVER}]:8084").parse::<SocketAddr>().unwrap();

    let error = client
        .udp_socket("192.0.2.42".parse().unwrap())
        .await
        .err()
        .expect("AllowedIPs enforced");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);

    let listen = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let socks = listen.local_addr().unwrap();
    let app = tokio::spawn(serve_socks(listen, client));

    let server_v4 = &server.stack(tcp4_target.ip()).unwrap().1;
    let server_v6 = &server.stack(tcp6_target.ip()).unwrap().1;
    let resolver = SocketAddr::new(tcp4_target.ip(), 53);
    let dns_udp = server_v4.udp_bind(resolver).await.unwrap();
    let mut dns_tcp = server_v4.tcp_bind(resolver).await.unwrap();
    for (target, server_net) in [(tcp4_target, server_v4), (tcp6_target, server_v6)] {
        let mut listener = server_net.tcp_bind(target).await.unwrap();
        let request = async {
            let mut client = handshake(socks).await;
            let mut packet = vec![5, 1, 0];
            super::socks::encode_address(target, &mut packet);
            client.write_all(&packet).await.unwrap();
            let mut response = vec![0; packet.len()];
            client.read_exact(&mut response).await.unwrap();
            assert_eq!(response[1], 0);
            client.write_all(b"routehub").await.unwrap();
            let mut message = [0; 8];
            client.read_exact(&mut message).await.unwrap();
            assert_eq!(&message, b"routehub");
        };
        let echo = async {
            let (mut stream, source) = listener.accept().await.unwrap();
            let expected = if target.is_ipv4() {
                V4_CLIENT
            } else {
                V6_CLIENT
            };
            assert_eq!(source.ip(), expected.parse::<IpAddr>().unwrap());
            let mut message = [0; 8];
            stream.read_exact(&mut message).await.unwrap();
            stream.write_all(&message).await.unwrap();
            stream.flush().await.unwrap();
        };
        tokio::join!(request, echo);
    }

    let domain_lookup = async {
        let mut client = handshake(socks).await;
        let domain = b"routehub.invalid";
        let mut packet = vec![5, 1, 0, 3, domain.len() as u8];
        packet.extend(domain);
        packet.extend(tcp4_target.port().to_be_bytes());
        client.write_all(&packet).await.unwrap();
        let mut response = [0; 10];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response[..4], &[5, 0, 0, 1]);
    };
    let udp_dns = async {
        let mut packet = [0; 512];
        for _ in 0..2 {
            let (amount, source) = dns_udp.recv_from(&mut packet).await.unwrap();
            let query = Message::from_vec(&packet[..amount]).unwrap();
            assert_eq!(query.queries[0].name.to_utf8(), "routehub.invalid.");
            let mut response = Message::response(query.metadata.id, OpCode::Query);
            response.metadata.truncation = query.queries[0].query_type == RecordType::A;
            response.queries = query.queries;
            let data = response.to_vec().unwrap();
            dns_udp.send_to(&data, source).await.unwrap();
        }
    };
    let tcp_dns = async {
        let (mut stream, _) = dns_tcp.accept().await.unwrap();
        let amount = stream.read_u16().await.unwrap() as usize;
        let mut packet = vec![0; amount];
        stream.read_exact(&mut packet).await.unwrap();
        let query = Message::from_vec(&packet).unwrap();
        let mut response = Message::response(query.metadata.id, OpCode::Query);
        response.add_answer(Record::from_rdata(
            query.queries[0].name.clone(),
            60,
            RData::A(A(V4_SERVER.parse().unwrap())),
        ));
        response.queries = query.queries;
        let serialized = response.to_vec().unwrap();
        stream.write_u16(serialized.len() as u16).await.unwrap();
        stream.write_all(&serialized).await.unwrap();
        // The resolver has the complete reply and may close before the final ACK.
        let _ = stream.flush().await;
    };
    let mut target = server_v4.tcp_bind(tcp4_target).await.unwrap();
    let accept_domain = async { target.accept().await.unwrap() };
    tokio::join!(domain_lookup, udp_dns, tcp_dns, accept_domain);

    let mut control = handshake(socks).await;
    control
        .write_all(&[5, 3, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .unwrap();
    let mut response = [0; 10];
    control.read_exact(&mut response).await.unwrap();
    assert_eq!(&response[..4], &[5, 0, 0, 1]);
    let relay = SocketAddr::from((
        [response[4], response[5], response[6], response[7]],
        u16::from_be_bytes([response[8], response[9]]),
    ));
    let listener = server_v4.udp_bind(udp_target).await.unwrap();
    let second_listener = server
        .stack(udp_alt_target.ip())
        .unwrap()
        .1
        .udp_bind(udp_alt_target)
        .await
        .unwrap();
    let v6_listener = server_v6.udp_bind(udp_v6_target).await.unwrap();
    let request = async {
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        for (destination, size) in [
            (udp_target, 32),
            (udp_alt_target, 64),
            (udp_v6_target, 1600),
            (udp_target, 32),
        ] {
            let mut packet = vec![0, 0, 0];
            super::socks::encode_address(destination, &mut packet);
            packet.extend(vec![0x5a; size]);
            client.send_to(&packet, relay).await.unwrap();
            let mut echoed = [0; 2048];
            let (amount, response) = client.recv_from(&mut echoed).await.unwrap();
            assert_eq!(response, relay);
            assert_eq!(&echoed[..amount], packet);
        }
    };
    let echo = async {
        for (socket, expected) in [
            (&listener, V4_CLIENT),
            (&second_listener, V4_ALT_CLIENT),
            (&v6_listener, V6_CLIENT),
            (&listener, V4_CLIENT),
        ] {
            let mut data = [0; 2048];
            let (amount, source) = socket.recv_from(&mut data).await.unwrap();
            assert_eq!(source.ip(), expected.parse::<IpAddr>().unwrap());
            server
                .send_udp(socket, source, &data[..amount])
                .await
                .unwrap();
        }
    };
    tokio::join!(request, echo);
    app.abort();
}

#[test]
fn ipv6_scope_and_label_precede_prefix_matching() {
    use super::source_rank;
    let rank = |local: &str, remote: &str| {
        source_rank(local.parse().unwrap(), remote.parse().unwrap()).unwrap()
    };
    assert!(rank("fd12::2", "fe80::1") < rank("fe80::2", "fe80::1"));
    assert!(rank("fe80::2", "2001:db8::1") < rank("fd12::2", "2001:db8::1"));
    assert!(rank("2001::2", "2001:db8::1") < rank("2607::2", "2001:db8::1"));
    assert!(rank("2001:db8::2", "2001:db8::1") < rank("2001:db8::1", "2001:db8::1"));
}

#[test]
fn ipv6_endpoint_strips_safe_extension_chains_and_rejects_non_atomic_fragments() {
    let mut receiver = super::ipv6::Reassembly::default();
    let now = Instant::now();
    let ipv6 = |suffix: &[u8]| {
        let mut data = vec![0; 40];
        data[0] = 0x60;
        data[4..6].copy_from_slice(&(suffix.len() as u16).to_be_bytes());
        data.extend_from_slice(suffix);
        data
    };
    let mut packet = ipv6(&[
        60, 0, 1, 4, 0, 0, 0, 0, // Hop-by-Hop PadN.
        43, 0, 0, 0, 0, 0, 0, 0, // Destination Options Pad1.
        44, 0, 255, 0, 0, 0, 0, 0, // Routing with no remaining segments.
        17, 0, 0, 0, 0, 0, 0, 1, // Atomic fragment.
        1, 2, 3, 4, 0, 8, 5, 6, // UDP bytes, preserved.
    ]);
    let mut expected = ipv6(&[1, 2, 3, 4, 0, 8, 5, 6]);
    expected[6] = 17;
    assert_eq!(receiver.receive(&packet, now), Some(expected));
    packet[67] = 1; // More fragments flag.
    assert_eq!(receiver.receive(&packet, now), None);
    packet[67] = 0;
    packet[59] = 1; // Routing header still contains an active segment.
    assert_eq!(receiver.receive(&packet, now), None);
    packet[59] = 0;
    packet[42] = 0x40; // Unrecognized option with discard action.
    assert_eq!(receiver.receive(&packet, now), None);
}

#[tokio::test]
async fn awg_20_socks_tcp_ipv4_ipv6_and_udp() {
    timeout(Duration::from_secs(10), run_socks("2.0"))
        .await
        .unwrap();
}

#[tokio::test]
async fn awg_31_socks_tcp_ipv4_ipv6_and_udp() {
    timeout(Duration::from_secs(10), run_socks("3.1"))
        .await
        .unwrap();
}

#[tokio::test]
async fn reassembles_authenticated_ipv6_udp_across_tunnel_link_mtu() {
    timeout(Duration::from_secs(5), async {
        let local = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let remote = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let local_endpoint = local.local_addr().unwrap();
        let remote_endpoint = remote.local_addr().unwrap();
        local.connect(remote_endpoint).await.unwrap();
        remote.connect(local_endpoint).await.unwrap();

        let private = [51; 32];
        let peer_private = StaticSecret::from([52; 32]);
        let public = PublicKey::from(&StaticSecret::from(private));
        let peer_public = PublicKey::from(&peer_private);
        let mut peer = Tunn::new(peer_private, public, None, None, 2, None);
        let config = parse_managed_awg(
            &format!(
                "[Interface]\nPrivateKey={}\nAddress={V6_CLIENT}/128\n[Peer]\nPublicKey={}\nEndpoint={remote_endpoint}\nAllowedIPs=fd10:22::/64\n",
                STANDARD.encode(private),
                STANDARD.encode(peer_public.as_bytes())
            ),
            "2.0",
        ).unwrap();
        let (local_peer, allowed) = peer_from_config(&config).unwrap();
        let adapter = Tunnel::start_on(&config, local, local_peer, allowed).unwrap();
        let source = V6_SERVER.parse::<std::net::Ipv6Addr>().unwrap();
        let destination = V6_CLIENT.parse::<std::net::Ipv6Addr>().unwrap();
        let relay = adapter.udp_socket(source.into()).await.unwrap();
        let contents = vec![0x0f; 1600];
        let mut udp_bytes = vec![0; contents.len() + 8];
        UdpRepr { src_port: 4789, dst_port: relay.local_addr().unwrap().port() }.emit(
            &mut UdpPacket::new_unchecked(&mut udp_bytes),
            &source.into(),
            &destination.into(),
            contents.len(),
            |buffer| buffer.copy_from_slice(&contents),
            &ChecksumCapabilities::default(),
        );
        let fragment = |offset: u16, more: bool, data: &[u8]| {
            let mut packet = vec![0; 40];
            packet[0] = 0x60;
            packet[4..6].copy_from_slice(&((data.len() + 8) as u16).to_be_bytes());
            packet[6] = 44;
            packet[7] = 64;
            packet[8..24].copy_from_slice(&source.octets());
            packet[24..40].copy_from_slice(&destination.octets());
            let field = offset | u16::from(more);
            packet.extend([17, 0, field.to_be_bytes()[0], field.to_be_bytes()[1], 0, 0, 0, 1]);
            packet.extend(data);
            packet
        };
        let first = fragment(0, true, &udp_bytes[..960]);
        let last = fragment(960, false, &udp_bytes[960..]);
        let mut write = [0; 2048];
        let mut read = [0; 2048];
        let TunnResult::WriteToNetwork(init) = peer.encapsulate(&last, &mut write) else {
            panic!("expected a handshake initiation");
        };
        remote.send(init).await.unwrap();
        assert!(matches!(peer.encapsulate(&first, &mut write), TunnResult::Done));
        let amount = remote.recv(&mut read).await.unwrap();
        if let TunnResult::WriteToNetwork(confirmation) =
            peer.decapsulate(Some(local_endpoint.ip()), &read[..amount], &mut write)
        {
            remote.send(confirmation).await.unwrap();
        }
        while let TunnResult::WriteToNetwork(frame) = peer.decapsulate(None, &[], &mut write) {
            remote.send(frame).await.unwrap();
        }
        let (amount, origin) = relay.recv_from(&mut read).await.unwrap();
        assert_eq!(origin, SocketAddr::new(source.into(), 4789));
        assert_eq!(&read[..amount], contents);
    })
    .await
    .unwrap();
}
