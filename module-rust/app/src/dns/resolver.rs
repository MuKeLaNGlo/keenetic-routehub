use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, ensure};
use hickory_proto::{
    op::{Message, MessageType, OpCode, Query, ResponseCode},
    rr::{DNSClass, Name, RData, RecordType},
};
use ipnet::IpNet;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    time::timeout,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, crypto::ring, pki_types::ServerName, version},
};

use super::settings::{Blocklist, Settings, canonical_name};

const WIRE_LIMIT: usize = u16::MAX as usize;
const CACHE_LIMIT: usize = 1024;
const CACHE_BYTES: usize = 512 << 10;
const DNS_MEDIA_TYPE: &str = "application/dns-message";

pub(super) struct Exchange {
    pub http: reqwest::Client,
    tls: TlsConnector,
}

impl Exchange {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .pool_idle_timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(2)
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .build()?;
        let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_protocol_versions(&[&version::TLS13, &version::TLS12])?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            http,
            tls: TlsConnector::from(Arc::new(tls)),
        })
    }

    pub async fn send(
        &self,
        protocol: &str,
        endpoint: &str,
        question: &Message,
    ) -> Result<Message> {
        if protocol == "plain" {
            return plain(SocketAddr::new(endpoint.parse()?, 53), question).await;
        }
        let id = if protocol == "doh" { 0 } else { random_id()? };
        let mut out = question.clone();
        out.metadata.id = id;
        let wire = out.to_vec()?;
        let reply = match protocol {
            "dot" => {
                let (host, port) = endpoint.rsplit_once(':').unwrap_or((endpoint, "853"));
                let connection = TcpStream::connect((host, port.parse::<u16>()?)).await?;
                let mut secured = self
                    .tls
                    .connect(ServerName::try_from(host.to_owned())?, connection)
                    .await?;
                stream_exchange(&mut secured, &wire).await?
            }
            "doh" => {
                let mut response = self
                    .http
                    .post(endpoint)
                    .header(reqwest::header::ACCEPT, DNS_MEDIA_TYPE)
                    .header(reqwest::header::CONTENT_TYPE, DNS_MEDIA_TYPE)
                    .body(wire)
                    .send()
                    .await?;
                let content = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.split(';').next())
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case(DNS_MEDIA_TYPE));
                ensure!(
                    response.status() == reqwest::StatusCode::OK && content,
                    "сервер DoH не вернул DNS-сообщение"
                );
                ensure!(
                    response
                        .content_length()
                        .is_none_or(|size| size <= WIRE_LIMIT as u64),
                    "некорректный размер сообщения DoH"
                );
                let mut wire = Vec::new();
                while let Some(chunk) = response.chunk().await? {
                    ensure!(
                        chunk.len() <= WIRE_LIMIT - wire.len(),
                        "некорректный размер сообщения DoH"
                    );
                    wire.extend_from_slice(&chunk);
                }
                Message::from_vec(&wire)?
            }
            _ => return Err(anyhow!("неизвестный протокол DNS")),
        };
        checked(question, reply, id, false)
    }
}

fn random_id() -> Result<u16> {
    let mut bytes = [0; 2];
    getrandom::fill(&mut bytes).map_err(anyhow::Error::msg)?;
    Ok(u16::from_ne_bytes(bytes))
}

async fn plain(endpoint: SocketAddr, question: &Message) -> Result<Message> {
    let bind = if endpoint.is_ipv4() {
        SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))
    } else {
        SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0))
    };
    let socket = UdpSocket::bind(bind).await?;
    socket.connect(endpoint).await?;
    let id = random_id()?;
    let mut out = question.clone();
    out.metadata.id = id;
    let wire = out.to_vec()?;
    socket.send(&wire).await?;
    // Reuse a bounded buffer. TC is evaluated only for a match to this transaction.
    let mut packet = [0u8; 4096];
    let size = socket.recv(&mut packet).await?;
    let reply = checked(question, Message::from_vec(&packet[..size])?, id, true)?;
    if !reply.metadata.truncation {
        return Ok(reply);
    }
    let mut connection = TcpStream::connect(endpoint).await?;
    checked(
        question,
        stream_exchange(&mut connection, &wire).await?,
        id,
        false,
    )
}

async fn stream_exchange(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    wire: &[u8],
) -> Result<Message> {
    write_frame(stream, wire).await?;
    let response = read_frame(stream).await?;
    Ok(Message::from_vec(&response)?)
}

pub async fn read_frame(stream: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let length = stream.read_u16().await?;
    ensure!(length >= 12, "некорректный размер сообщения DNS");
    let mut buffer = vec![0; usize::from(length)];
    stream.read_exact(&mut buffer).await?;
    Ok(buffer)
}

pub async fn write_frame(stream: &mut (impl AsyncWrite + Unpin), wire: &[u8]) -> Result<()> {
    stream.write_u16(wire.len().try_into()?).await?;
    stream.write_all(wire).await?;
    Ok(())
}

fn checked(
    request: &Message,
    mut reply: Message,
    id: u16,
    allow_truncated: bool,
) -> Result<Message> {
    ensure!(
        reply.metadata.message_type == MessageType::Response
            && reply.metadata.id == id
            && reply.metadata.op_code == request.metadata.op_code
            && (!reply.metadata.truncation || allow_truncated)
            && reply.signature.is_none()
            && matches!((&request.queries[..], &reply.queries[..]), ([question], [answer])
                if question.name() == answer.name() && question.query_type() == answer.query_type()
                    && question.query_class() == answer.query_class()),
        "DNS-сервер вернул ответ на другой запрос"
    );
    reply.metadata.id = request.metadata.id;
    Ok(reply)
}

pub fn error_reply(request: &Message, code: ResponseCode) -> Message {
    let mut result = Message::error_msg(request.metadata.id, request.metadata.op_code, code);
    result.metadata.recursion_desired = request.metadata.recursion_desired;
    result.metadata.checking_disabled = request.metadata.checking_disabled;
    result
        .queries
        .extend(request.queries.iter().take(1).cloned());
    result
}

pub fn test_query() -> Result<Message> {
    let mut query = Message::new(random_id()?, MessageType::Query, OpCode::Query);
    query.metadata.recursion_desired = true;
    query.queries.push(Query::query(
        Name::from_ascii("example.org.")?,
        RecordType::A,
    ));
    Ok(query)
}

pub fn has_answer(message: &Message) -> bool {
    message.metadata.response_code == ResponseCode::NoError && !message.answers.is_empty()
}

fn suffix_match(name: &str, mut contains: impl FnMut(&str) -> bool) -> bool {
    let mut candidate = name;
    while !candidate.is_empty() {
        if contains(candidate) {
            return true;
        }
        let Some((_, suffix)) = candidate.split_once('.') else {
            break;
        };
        candidate = suffix;
    }
    false
}

fn native_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if !name.contains('.') {
        return psl::suffix(name.as_bytes())
            .is_none_or(|suffix| suffix.typ() != Some(psl::Type::Icann));
    }
    if suffix_match(name, |suffix| {
        matches!(suffix, "home.arpa" | "lan" | "local" | "localdomain")
    }) {
        return true;
    }
    static PRIVATE: OnceLock<[IpNet; 8]> = OnceLock::new();
    let networks = PRIVATE.get_or_init(|| {
        [
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
            "127.0.0.0/8",
            "fc00::/7",
            "fe80::/10",
            "::1/128",
        ]
        .map(|raw| raw.parse().expect("built-in local DNS networks"))
    });
    reverse_prefix(name).is_some_and(|prefix| {
        networks.iter().any(|network| {
            prefix.prefix_len() >= network.prefix_len() && network.contains(&prefix.addr())
        })
    })
}

fn reverse_prefix(name: &str) -> Option<IpNet> {
    if let Some(labels) = name.strip_suffix(".in-addr.arpa") {
        let mut bytes = [0u8; 4];
        let mut count = 0;
        for label in labels.rsplit('.') {
            let byte = label.parse::<u8>().ok()?;
            if label.starts_with('+') || (label.starts_with('0') && label.len() > 1) {
                return None;
            }
            *bytes.get_mut(count)? = byte;
            count += 1;
        }
        return IpNet::new(IpAddr::V4(bytes.into()), (count * 8) as u8).ok();
    }
    let labels = name.strip_suffix(".ip6.arpa")?;
    let mut bytes = [0u8; 16];
    let mut count = 0;
    for label in labels.rsplit('.') {
        if label.len() != 1 {
            return None;
        }
        let value = u8::from_str_radix(label, 16).ok()?;
        *bytes.get_mut(count / 2)? |= value << (4 * (1 - count % 2));
        count += 1;
    }
    IpNet::new(IpAddr::V6(bytes.into()), (count * 4) as u8).ok()
}

#[derive(PartialEq, Eq, Hash)]
struct CacheKey {
    name: String,
    kind: RecordType,
    dnssec: bool,
    checking: bool,
}

struct Entry {
    wire: Vec<u8>,
    stored: Instant,
    ttl: u32,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<CacheKey, Entry>,
    bytes: usize,
}

impl Cache {
    fn get(&mut self, key: &CacheKey, request: &Message, now: Instant) -> Option<Message> {
        let entry = self.entries.get(key)?;
        let age = now.saturating_duration_since(entry.stored).as_secs();
        if age >= u64::from(entry.ttl) {
            if let Some(entry) = self.entries.remove(key) {
                self.bytes -= entry.wire.len();
            }
            return None;
        }
        let mut result = Message::from_vec(&entry.wire).ok()?;
        result.metadata.id = request.metadata.id;
        result.queries.clone_from(&request.queries);
        for record in result
            .answers
            .iter_mut()
            .chain(&mut result.authorities)
            .chain(&mut result.additionals)
        {
            record.ttl = record.ttl.saturating_sub(age as u32);
        }
        Some(result)
    }

    fn insert(&mut self, key: CacheKey, message: &Message, now: Instant) {
        if !has_answer(message) {
            return;
        }
        let ttl = message
            .answers
            .iter()
            .chain(&message.authorities)
            .chain(&message.additionals)
            .map(|record| record.ttl)
            .min()
            .unwrap_or_default()
            .min(3600);
        let Ok(wire) = message.to_vec() else { return };
        if ttl == 0 || wire.len() > CACHE_BYTES {
            return;
        }
        while self.entries.len() >= CACHE_LIMIT || self.bytes + wire.len() > CACHE_BYTES {
            let Some(eviction) = self.entries.keys().next() else {
                break;
            };
            let eviction = CacheKey {
                name: eviction.name.clone(),
                kind: eviction.kind,
                dnssec: eviction.dnssec,
                checking: eviction.checking,
            };
            if let Some(removed) = self.entries.remove(&eviction) {
                self.bytes -= removed.wire.len();
            }
        }
        self.bytes += wire.len();
        if let Some(removed) = self.entries.insert(
            key,
            Entry {
                wire,
                stored: now,
                ttl,
            },
        ) {
            self.bytes -= removed.wire.len();
        }
    }
}

pub struct Resolver {
    pub settings: Settings,
    pub blocklist: Arc<Blocklist>,
    pub native: Option<SocketAddr>,
    cache: Mutex<Cache>,
}

impl Resolver {
    pub fn new(settings: Settings, blocklist: Arc<Blocklist>, native: Option<SocketAddr>) -> Self {
        Self {
            settings,
            blocklist,
            native,
            cache: Mutex::new(Cache::default()),
        }
    }

    fn excluded(&self, name: &str) -> bool {
        suffix_match(name, |suffix| {
            self.settings.exceptions.iter().any(|entry| entry == suffix)
        })
    }

    pub fn blocked(&self, name: &str) -> bool {
        self.settings.adblock
            && !self.excluded(name)
            && suffix_match(name, |suffix| self.blocklist.contains(suffix))
    }

    pub async fn resolve(&self, exchange: &Exchange, request: &Message) -> Message {
        let [question] = &request.queries[..] else {
            return error_reply(request, ResponseCode::Refused);
        };
        if request.metadata.message_type != MessageType::Query
            || request.metadata.op_code != OpCode::Query
            || question.query_class() != DNSClass::IN
            || request.signature.is_some()
        {
            return error_reply(request, ResponseCode::Refused);
        }
        let name = canonical_name(&question.name().to_ascii());
        if let Some(native) = self.native.filter(|_| native_name(&name)) {
            // Do not expose DHCP hostnames or reverse records to public resolvers.
            return timeout(Duration::from_secs(2), plain(native, request))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_else(|| error_reply(request, ResponseCode::ServFail));
        }
        if self.blocked(&name) {
            return error_reply(request, ResponseCode::NXDomain);
        }
        let use_cache = self.settings.cache
            && request.metadata.recursion_desired
            && request
                .edns
                .as_ref()
                .is_none_or(|edns| edns.options().as_ref().is_empty());
        let key = CacheKey {
            name,
            kind: question.query_type(),
            dnssec: request
                .edns
                .as_ref()
                .is_some_and(|edns| edns.flags().dnssec_ok),
            checking: request.metadata.checking_disabled,
        };
        if use_cache
            && let Some(answer) =
                self.cache
                    .lock()
                    .expect("DNS cache")
                    .get(&key, request, Instant::now())
        {
            return answer;
        }
        for endpoint in [&self.settings.primary, &self.settings.secondary] {
            if endpoint.is_empty() {
                continue;
            }
            let result = timeout(
                Duration::from_secs(2),
                exchange.send(&self.settings.protocol, endpoint, request),
            )
            .await;
            let Ok(Ok(answer)) = result else { continue };
            if matches!(
                answer.metadata.response_code,
                ResponseCode::ServFail | ResponseCode::Refused
            ) {
                continue;
            }
            if !self.excluded(&key.name) && answer.answers.iter().any(|record| {
                matches!(&record.data, RData::CNAME(name) if self.blocked(&canonical_name(&name.0.to_ascii())))
            }) {
                return error_reply(request, ResponseCode::NXDomain);
            }
            if use_cache {
                self.cache
                    .lock()
                    .expect("DNS cache")
                    .insert(key, &answer, Instant::now());
            }
            return answer;
        }
        error_reply(request, ResponseCode::ServFail)
    }
}

pub fn udp_wire(answer: &Message, request: &Message) -> Result<Vec<u8>> {
    let limit = request
        .edns
        .as_ref()
        .map_or(512, |edns| edns.max_payload().clamp(512, 1232));
    if let Ok(wire) = answer.to_vec()
        && wire.len() <= usize::from(limit)
    {
        return Ok(wire);
    }
    let mut truncated = answer.truncate();
    let wire = truncated
        .to_vec()
        .context("не удалось собрать усечённый ответ DNS")?;
    if wire.len() <= usize::from(limit) {
        return Ok(wire);
    }
    truncated.edns = None;
    Ok(truncated.to_vec()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_proto::rr::{Record, rdata::A};
    use tokio::net::TcpListener;

    fn answer_for(request: &Message, ttl: u32) -> Message {
        let mut result = error_reply(request, ResponseCode::NoError);
        result.answers.push(Record::from_rdata(
            request.queries[0].name().clone(),
            ttl,
            RData::A(A(Ipv4Addr::new(203, 0, 113, 7))),
        ));
        result
    }

    #[test]
    fn check_rejects_wrong_transaction_or_question() {
        let request = test_query().unwrap();
        let answer = answer_for(&request, 200);
        assert!(
            checked(
                &request,
                answer.clone(),
                request.metadata.id.wrapping_add(1),
                false
            )
            .is_err()
        );
        let mut wrong = answer.clone();
        wrong.queries[0] = Query::query(Name::from_ascii("other.example.").unwrap(), RecordType::A);
        assert!(checked(&request, wrong, request.metadata.id, false).is_err());
        assert!(checked(&request, answer, request.metadata.id, false).is_ok());
    }

    #[test]
    fn cache_rewrites_client_id_and_expires_by_smallest_ttl() {
        let mut request = test_query().unwrap();
        let answer = answer_for(&request, 5);
        let now = Instant::now();
        let mut cache = Cache::default();
        let new_key = || CacheKey {
            name: "example.org".into(),
            kind: RecordType::A,
            dnssec: false,
            checking: false,
        };
        cache.insert(new_key(), &answer, now);
        request.metadata.id = request.metadata.id.wrapping_add(1);
        let cached = cache
            .get(&new_key(), &request, now + Duration::from_secs(3))
            .unwrap();
        assert_eq!(cached.metadata.id, request.metadata.id);
        assert_eq!(cached.answers[0].ttl, 2);
        assert!(
            cache
                .get(&new_key(), &request, now + Duration::from_secs(5))
                .is_none()
        );
        assert_eq!(cache.bytes, 0);
    }

    #[test]
    fn local_dns_keeps_private_reverse_and_not_public_tld() {
        for name in [
            "nas",
            "box.home.arpa",
            "box.lan",
            "168.192.in-addr.arpa",
            "a.f.ip6.arpa",
            "d.f.ip6.arpa",
        ] {
            assert_eq!(native_name(name), name != "a.f.ip6.arpa", "{name}");
        }
        for name in [
            "com",
            "example.org",
            "8.8.8.8.in-addr.arpa",
            "001.10.in-addr.arpa",
        ] {
            assert!(!native_name(name), "{name}");
        }
    }

    #[tokio::test]
    async fn plain_dns_falls_back_to_tcp_after_matching_truncation() {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = tcp.local_addr().unwrap();
        let udp = UdpSocket::bind(address).await.unwrap();
        let server = tokio::spawn(async move {
            let mut buf = [0; 512];
            let (length, source) = udp.recv_from(&mut buf).await.unwrap();
            let query = Message::from_vec(&buf[..length]).unwrap();
            udp.send_to(&answer_for(&query, 20).truncate().to_vec().unwrap(), source)
                .await
                .unwrap();
            let (mut stream, _) = tcp.accept().await.unwrap();
            let query = Message::from_vec(&read_frame(&mut stream).await.unwrap()).unwrap();
            write_frame(&mut stream, &answer_for(&query, 45).to_vec().unwrap())
                .await
                .unwrap();
        });
        let request = test_query().unwrap();
        let result = timeout(Duration::from_secs(2), plain(address, &request))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.metadata.id, request.metadata.id);
        assert_eq!(result.answers[0].ttl, 45);
        server.await.unwrap();
    }
}
