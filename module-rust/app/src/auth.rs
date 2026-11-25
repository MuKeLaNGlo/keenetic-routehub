use axum::{
    Json, body,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    net::IpAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

const COOKIE: &str = "routehub_session";
const LIFE: Duration = Duration::from_secs(12 * 3600);
const ROUNDS: u32 = 600_000;
const KEY_HEADER: &str = "x-routehub-key";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialFile {
    version: u8,
    salt: String,
    digest: String,
}

struct Credential {
    salt: [u8; 16],
    digest: [u8; 32],
}

#[derive(Clone, Copy)]
struct Attempt {
    count: u8,
    until: Instant,
}

#[derive(Default)]
struct Sessions {
    credential: Option<Credential>,
    sessions: HashMap<[u8; 32], Instant>,
    attempts: HashMap<IpAddr, Attempt>,
}

pub struct Auth {
    path: PathBuf,
    available: bool,
    key: Option<[u8; 32]>,
    state: Mutex<Sessions>,
}

fn digest(string: &str) -> [u8; 32] {
    Sha256::digest(string.as_bytes()).into()
}

fn read_credential(path: &Path) -> std::io::Result<Credential> {
    let invalid =
        || std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid panel credential");
    let file = File::open(path)?;
    let stat = file.metadata()?;
    if !stat.is_file() || stat.permissions().mode() & 0o077 != 0 || stat.len() > 1024 {
        return Err(invalid());
    }
    let disk: CredentialFile = serde_json::from_reader(file.take(1025)).map_err(|_| invalid())?;
    let salt = STANDARD
        .decode(disk.salt)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(invalid)?;
    let digest = STANDARD
        .decode(disk.digest)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(invalid)?;
    if disk.version != 1 {
        return Err(invalid());
    }
    Ok(Credential { salt, digest })
}

fn save_credential(path: &Path, value: &Credential) -> anyhow::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(
        file.as_file_mut(),
        &CredentialFile {
            version: 1,
            salt: STANDARD.encode(value.salt),
            digest: STANDARD.encode(value.digest),
        },
    )?;
    file.flush()?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}

fn token(headers: &HeaderMap) -> Option<[u8; 32]> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .filter_map(|s| s.trim().split_once('='))
        .find(|(name, value)| *name == COOKIE && value.len() == 64)
        .map(|(_, value)| digest(value))
}

pub fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}

fn session_response(status: &str, cookie: Option<String>) -> Response {
    let mut response = Json(json!({"status":status})).into_response();
    if let Some(cookie) = cookie.and_then(|s| HeaderValue::from_str(&s).ok()) {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
}

fn hash_password(password: &str, salt: &[u8; 16]) -> [u8; 32] {
    let mut output = [0; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, ROUNDS, &mut output);
    output
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct PasswordRequest {
    password: String,
    current_password: String,
    new_password: String,
}

impl Auth {
    pub fn new(path: PathBuf, initial: Option<String>) -> Self {
        let key = initial.map(|v| digest(&v));
        let (available, credential) = match read_credential(&path) {
            Ok(credential) => (true, Some(credential)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (key.is_some(), None),
            Err(_) => (false, None),
        };
        Self {
            path,
            available,
            key,
            state: Mutex::new(Sessions {
                credential,
                ..Default::default()
            }),
        }
    }

    pub fn can_edit(&self) -> bool {
        self.key.is_some()
    }

    pub fn valid(&self, headers: &HeaderMap) -> bool {
        if !self.available {
            return false;
        }
        token(headers).is_some_and(|value| {
            self.state
                .lock()
                .ok()
                .and_then(|s| s.sessions.get(&value).copied())
                .is_some_and(|expiry| expiry > Instant::now())
        })
    }

    pub fn authorized(&self, headers: &HeaderMap) -> bool {
        self.valid(headers)
            || self.key.is_some_and(|key| {
                headers
                    .get(KEY_HEADER)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|candidate| bool::from(key.ct_eq(&digest(candidate))))
            })
    }

    pub fn same_origin(headers: &HeaderMap) -> bool {
        let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
        let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
        matches!((host,origin),(Some(host),Some(origin)) if origin.strip_prefix("http://") == Some(host))
    }

    pub async fn session(self: std::sync::Arc<Self>, request: Request, peer: IpAddr) -> Response {
        if request.method() == Method::GET {
            if !self.available {
                return Json(json!({"status":"unavailable","error":"На роутере не настроен доступ к панели"})).into_response();
            }
            return session_response(
                if self.valid(request.headers()) {
                    "signed-in"
                } else {
                    "signed-out"
                },
                None,
            );
        }
        if !Self::same_origin(request.headers()) {
            return error(StatusCode::FORBIDDEN, "Запрос должен исходить из панели");
        }
        if !self.available {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "На роутере не настроен доступ к панели",
            );
        }
        let method = request.method().clone();
        let old = token(request.headers());
        if method == Method::DELETE {
            if let (Ok(mut state), Some(old)) = (self.state.lock(), old) {
                state.sessions.remove(&old);
            }
            return session_response(
                "signed-out",
                Some(format!(
                    "{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
                )),
            );
        }
        let input = body::to_bytes(request.into_body(), 4096)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PasswordRequest>(&bytes).ok());
        let Some(input) = input.filter(|p| {
            [&p.password, &p.current_password, &p.new_password]
                .iter()
                .all(|s| s.len() <= 256)
        }) else {
            return error(StatusCode::BAD_REQUEST, "Некорректный запрос пароля");
        };
        tokio::task::spawn_blocking(move || {
            self.authenticate(input, method == Method::PUT, old, peer)
        })
        .await
        .unwrap_or_else(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Не удалось создать сессию"))
    }

    fn authenticate(
        &self,
        input: PasswordRequest,
        change: bool,
        old: Option<[u8; 32]>,
        peer: IpAddr,
    ) -> Response {
        if change
            && (input.new_password.chars().count() < 8
                || input.new_password.trim().is_empty()
                || input.current_password == input.new_password)
        {
            return error(
                StatusCode::BAD_REQUEST,
                "Укажите новый пароль длиной от 8 символов",
            );
        }
        let Ok(mut state) = self.state.lock() else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Не удалось создать сессию");
        };
        let now = Instant::now();
        state.sessions.retain(|_, expiry| *expiry > now);
        if change && !old.is_some_and(|old| state.sessions.contains_key(&old)) {
            return error(StatusCode::UNAUTHORIZED, "Войдите в панель");
        }
        state.attempts.retain(|_, attempt| attempt.until > now);
        let previous = state.attempts.get(&peer).copied();
        if previous.is_some_and(|a| a.count >= 6)
            || previous.is_none() && state.attempts.len() >= 128
        {
            let mut response = error(
                StatusCode::TOO_MANY_REQUESTS,
                "Слишком много попыток. Повторите через минуту",
            );
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
            return response;
        }
        let password = if change {
            &input.current_password
        } else {
            &input.password
        };
        let verified = if let Some(credential) = &state.credential {
            bool::from(
                credential
                    .digest
                    .ct_eq(&hash_password(password, &credential.salt)),
            )
        } else {
            self.key
                .is_some_and(|key| bool::from(key.ct_eq(&digest(password))))
        };
        if !verified {
            let attempt = state.attempts.entry(peer).or_insert(Attempt {
                count: 0,
                until: now + Duration::from_secs(60),
            });
            attempt.count += 1;
            return error(StatusCode::UNAUTHORIZED, "Неверный пароль");
        }
        state.attempts.remove(&peer);
        if change {
            let mut salt = [0; 16];
            if getrandom::fill(&mut salt).is_err() {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Не удалось обновить пароль",
                );
            }
            let credential = Credential {
                salt,
                digest: hash_password(&input.new_password, &salt),
            };
            if save_credential(&self.path, &credential).is_err() {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Не удалось сохранить пароль",
                );
            }
            state.credential = Some(credential);
            state.sessions.clear();
        }
        if let Some(old) = old {
            state.sessions.remove(&old);
        }
        if state.sessions.len() >= 64 {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Не удалось создать сессию");
        }
        let mut bytes = [0; 32];
        if getrandom::fill(&mut bytes).is_err() {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Не удалось создать сессию");
        }
        let value = hex::encode(bytes);
        state.sessions.insert(digest(&value), now + LIFE);
        session_response(
            "signed-in",
            Some(format!(
                "{COOKIE}={value}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict",
                LIFE.as_secs()
            )),
        )
    }
}
