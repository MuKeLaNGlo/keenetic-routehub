use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{self, HeaderValue};
use reqwest::{Client, StatusCode};
use url::Url;

use crate::model::Subscription;
use crate::source::{
    MAX_SUBSCRIPTION_BODY, is_public_ipv4, safe_header, subscription_endpoint, valid_device_id,
    valid_user_agent,
};

const NETWORK_ERROR: &str = "сервер подписки не ответил по HTTPS";
const OVERSIZE: &str = "ответ подписки больше 384 КиБ";
const REDIRECT_REJECTED: &str = "сервер подписки вернул неподдерживаемое перенаправление";
pub const PROFILE_PROBE_URL: &str = "https://www.gstatic.com/generate_204";

/// Checks the authenticated ephemeral SOCKS process. The control request
/// cannot fall back to a direct connection, follow a redirect or fetch a body.
pub async fn probe_socks_https(
    address: SocketAddrV4,
    username: &str,
    password: &str,
    wait_for_group: bool,
) -> Option<(u16, u128)> {
    probe_through_local_socks(address, Some((username, password)), wait_for_group).await
}

pub async fn probe_active_socks_https(
    address: SocketAddrV4,
    wait_for_group: bool,
) -> Option<(u16, u128)> {
    probe_through_local_socks(address, None, wait_for_group).await
}

async fn probe_through_local_socks(
    address: SocketAddrV4,
    credentials: Option<(&str, &str)>,
    wait_for_group: bool,
) -> Option<(u16, u128)> {
    if !address.ip().is_loopback() {
        return None;
    }
    let mut socks = Url::parse(&format!("socks5h://{address}")).ok()?;
    if let Some((username, password)) = credentials {
        socks.set_username(username).ok()?;
        socks.set_password(Some(password)).ok()?;
    }
    let proxy = reqwest::Proxy::all(socks).ok()?;
    let client = Client::builder()
        .no_proxy()
        .proxy(proxy)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .http1_only()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(7))
        .pool_max_idle_per_host(0)
        .build()
        .ok()?;
    tokio::time::timeout(Duration::from_secs(7), async {
        let until = Instant::now() + Duration::from_millis(4500);
        loop {
            let start = Instant::now();
            match client.get(PROFILE_PROBE_URL).send().await {
                Ok(response) => {
                    return Some((response.status().as_u16(), start.elapsed().as_millis()));
                }
                Err(_) if wait_for_group && Instant::now() < until => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                Err(_) => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
}

#[derive(Default)]
pub struct SubscriptionDownload {
    // Provider payload, kept private from the web panel.
    pub body: Vec<u8>,
    pub etag: String,
    pub modified: String,
    pub unchanged: bool,
}

struct PublicResolver;

static DNS_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

pub async fn lookup_public_ipv4(hostname: &str) -> io::Result<Vec<Ipv4Addr>> {
    let fqdn = format!("{}.", hostname.trim_end_matches('.'));
    let slot = DNS_SLOTS.acquire().await.map_err(io::Error::other)?;
    // A timed-out HTTP request cannot release the slot until the OS resolver
    // actually finishes, so DNS stalls cannot create unbounded worker threads.
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        Ok((fqdn.as_str(), 0)
            .to_socket_addrs()?
            .filter_map(|socket| match socket {
                SocketAddr::V4(socket) if is_public_ipv4(*socket.ip()) => Some(*socket.ip()),
                _ => None,
            })
            .take(4)
            .collect())
    })
    .await
    .map_err(io::Error::other)?
}

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addrs = lookup_public_ipv4(name.as_str()).await?;
            if addrs.is_empty() {
                return Err(std::io::Error::other(
                    "нет доступного публичного IPv4 сервера подписки",
                )
                .into());
            }
            Ok(Box::new(addrs.into_iter().map(|ip| SocketAddr::from((ip, 0)))) as Addrs)
        })
    }
}

pub async fn fetch_subscription(source: &Subscription) -> Result<SubscriptionDownload, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .http1_only()
        .dns_resolver(Arc::new(PublicResolver))
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .connect_timeout(Duration::from_secs(3))
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "не удалось подготовить сеанс подписки")?;
    tokio::time::timeout(Duration::from_secs(15), download(source, &client))
        .await
        .map_err(|_| NETWORK_ERROR.to_owned())?
}

async fn download(source: &Subscription, client: &Client) -> Result<SubscriptionDownload, String> {
    let initial = subscription_endpoint(&source.url)?;
    if !valid_user_agent(&source.user_agent) {
        return Err("некорректный User-Agent подписки".into());
    }
    if !source.device_id.is_empty() && !valid_device_id(&source.device_id) {
        return Err("некорректный идентификатор устройства подписки".into());
    }
    let mut url = initial.clone();
    let cookie_jar = Jar::default();
    let mut redirect = SubscriptionRedirects::default();
    loop {
        let sent_cookies = cookie_jar.cookies(&url);
        let mut request = client
            .get(url.clone())
            .header(
                header::ACCEPT,
                "application/json, text/plain;q=0.9, */*;q=0.1",
            )
            .header(
                header::USER_AGENT,
                if source.user_agent.is_empty() {
                    "RouteHub"
                } else {
                    &source.user_agent
                },
            );
        for (name, value) in [
            ("x-hwid", source.device_id.as_str()),
            ("if-none-match", safe_header(&source.etag)),
            ("if-modified-since", safe_header(&source.last_modified)),
        ] {
            if !value.is_empty() {
                request = request.header(name, value);
            }
        }
        if let Some(cookies) = sent_cookies.as_ref() {
            request = request.header(header::COOKIE, cookies.clone());
        }
        let mut response = request.send().await.map_err(|_| NETWORK_ERROR)?;
        if response
            .headers()
            .iter()
            .map(|(key, val)| key.as_str().len() + val.len() + 4)
            .sum::<usize>()
            > 16 << 10
        {
            return Err(NETWORK_ERROR.into());
        }
        cookie_jar.set_cookies(
            &mut response.headers().get_all(header::SET_COOKIE).iter(),
            &url,
        );
        let status = response.status();
        if status == StatusCode::NOT_MODIFIED && source.last_success.is_some() {
            return Ok(SubscriptionDownload {
                unchanged: true,
                ..Default::default()
            });
        }
        if status == StatusCode::OK {
            if response
                .content_length()
                .is_some_and(|n| n > MAX_SUBSCRIPTION_BODY as u64)
            {
                return Err(OVERSIZE.into());
            }
            let read_header = |name| {
                response
                    .headers()
                    .get(name)
                    .and_then(|header| header.to_str().ok())
                    .map(safe_header)
                    .unwrap_or_default()
                    .to_owned()
            };
            let etag = read_header(header::ETAG);
            let modified = read_header(header::LAST_MODIFIED);
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "не удалось прочитать ответ подписки")?
            {
                if chunk.len() > MAX_SUBSCRIPTION_BODY - body.len() {
                    return Err(OVERSIZE.into());
                }
                body.extend_from_slice(&chunk);
            }
            return Ok(SubscriptionDownload {
                body,
                etag,
                modified,
                unchanged: false,
            });
        }
        if status.is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|val| val.to_str().ok());
            let next_cookies = cookie_jar.cookies(&url);
            url = redirect.follow(
                status,
                location,
                &initial,
                &url,
                sent_cookies.as_ref(),
                next_cookies.as_ref(),
            )?;
            continue;
        }
        return Err("сервер подписки отклонил запрос".into());
    }
}

#[derive(Default)]
struct SubscriptionRedirects {
    visited: Vec<Url>,
    repeated_with_cookie: bool,
}

impl SubscriptionRedirects {
    fn follow(
        &mut self,
        status: StatusCode,
        location: Option<&str>,
        initial: &Url,
        current: &Url,
        sent: Option<&HeaderValue>,
        next_cookies: Option<&HeaderValue>,
    ) -> Result<Url, String> {
        if self.visited.len() >= 3 || !matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Err(REDIRECT_REJECTED.into());
        }
        let expected = || REDIRECT_REJECTED.to_owned();
        let location = location
            .filter(|url| !url.contains('\\'))
            .ok_or_else(expected)?;
        let target = if location.starts_with("https://") || location.contains("://") {
            subscription_endpoint(location).map_err(|_| expected())?
        } else {
            let target = current.join(location).map_err(|_| expected())?;
            subscription_endpoint(target.as_str()).map_err(|_| expected())?
        };
        if target.origin() != initial.origin() {
            return Err(expected());
        }
        let seen_before = self.visited.iter().any(|prior| prior == &target);
        if &target == current && !self.repeated_with_cookie && new_cookie(sent, next_cookies) {
            self.repeated_with_cookie = true;
        } else if &target == current || seen_before {
            return Err(format!(
                "сервер подписки вернул HTTP {} и снова перенаправляет на тот же адрес",
                status.as_u16()
            ));
        }
        self.visited.push(current.clone());
        Ok(target)
    }
}

fn new_cookie(previous: Option<&HeaderValue>, current: Option<&HeaderValue>) -> bool {
    let previous = previous
        .and_then(|header| header.to_str().ok())
        .unwrap_or_default();
    let current = current
        .and_then(|header| header.to_str().ok())
        .unwrap_or_default();
    current.split(';').map(str::trim).any(|pair| {
        pair.split_once('=').is_some_and(|(_, value)| {
            !value.is_empty() && !previous.split(';').map(str::trim).any(|old| old == pair)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_retry_requires_new_cookie_and_same_origin() {
        let endpoint = subscription_endpoint("https://vpn.example/subs").unwrap();
        let mut flow = SubscriptionRedirects::default();
        let cookie = HeaderValue::from_static("session=abc");
        let result = flow.follow(
            StatusCode::TEMPORARY_REDIRECT,
            Some("/subs"),
            &endpoint,
            &endpoint,
            None,
            Some(&cookie),
        );
        assert_eq!(result, Ok(endpoint.clone()));
        let another = HeaderValue::from_static("session=def");
        assert!(
            flow.follow(
                StatusCode::TEMPORARY_REDIRECT,
                Some("/subs"),
                &endpoint,
                &endpoint,
                Some(&cookie),
                Some(&another)
            )
            .is_err()
        );
        for redirect in [
            "https://evil.example/subs",
            "//evil.example/subs",
            "http://vpn.example/subs",
            "https://vpn.example:8443/subs",
            "\\evil.example/subs",
        ] {
            assert!(
                SubscriptionRedirects::default()
                    .follow(
                        StatusCode::TEMPORARY_REDIRECT,
                        Some(redirect),
                        &endpoint,
                        &endpoint,
                        None,
                        None
                    )
                    .is_err(),
                "{redirect}"
            );
        }
    }
}
