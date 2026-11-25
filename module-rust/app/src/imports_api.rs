use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRequest, Multipart, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use routehub_imports::{FileOptions, parse_preview, parse_profile_upload};
use serde_json::json;

use crate::{
    auth::{Auth, error},
    server::App,
};

const RULE_LIMIT: usize = 2 << 20;
const PROFILE_LIMIT: usize = 512 << 10;
const ENVELOPE_LIMIT: usize = 16 << 10;

#[derive(Clone, Copy)]
enum UploadKind {
    Rules,
    Profiles,
}

impl UploadKind {
    fn file_limit(self) -> usize {
        match self {
            Self::Rules => RULE_LIMIT,
            Self::Profiles => PROFILE_LIMIT,
        }
    }

    fn too_large(self) -> Response {
        let message = match self {
            Self::Rules => "размер файла правил не должен превышать 2 МиБ",
            Self::Profiles => "размер файла профилей не должен превышать 512 КиБ",
        };
        error(StatusCode::PAYLOAD_TOO_LARGE, message)
    }

    fn invalid(self) -> Response {
        let message = match self {
            Self::Rules => "Проверьте файл и маршрут для импорта",
            Self::Profiles => {
                "Загрузите один файл профилей и при необходимости укажите интерфейс WireGuard ASC"
            }
        };
        error(StatusCode::BAD_REQUEST, message)
    }

    fn field_limit(self, name: &str) -> Option<usize> {
        match (self, name) {
            (Self::Rules, "target" | "format" | "type" | "domainMatch" | "geoSource") => Some(128),
            (Self::Rules, "template") => Some(1000),
            (Self::Profiles, "interface") => Some(63),
            (Self::Profiles, "awgVersion") => Some(7),
            _ => None,
        }
    }
}

type UploadResult<T> = Result<T, Box<Response>>;

struct Upload {
    filename: String,
    data: Vec<u8>,
    fields: HashMap<String, String>,
}

pub(crate) fn router() -> Router<Arc<App>> {
    Router::new()
        .route(
            "/api/import",
            post(rules).layer(DefaultBodyLimit::max(RULE_LIMIT + ENVELOPE_LIMIT)),
        )
        .route(
            "/api/profiles/import",
            post(profiles).layer(DefaultBodyLimit::max(PROFILE_LIMIT + ENVELOPE_LIMIT)),
        )
}

async fn parse_request(app: &App, request: Request, kind: UploadKind) -> UploadResult<Upload> {
    if !app.auth.can_edit()
        || !Auth::same_origin(request.headers())
        || !app.auth.authorized(request.headers())
    {
        return Err(Box::new(error(
            StatusCode::FORBIDDEN,
            "Доступ к импорту запрещён",
        )));
    }
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if matches!(kind, UploadKind::Profiles)
        && content_type
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            != Some("multipart/form-data")
    {
        return Err(Box::new(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Загрузите файл через multipart/form-data",
        )));
    }
    let bad_form = match kind {
        UploadKind::Rules => "Загрузите файл через multipart/form-data",
        UploadKind::Profiles => "Проверьте форму загрузки файла",
    };
    let mut form = Multipart::from_request(request, &())
        .await
        .map_err(|_| Box::new(error(StatusCode::BAD_REQUEST, bad_form)))?;
    let malformed = |err: axum::extract::multipart::MultipartError| {
        Box::new(if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
            kind.too_large()
        } else {
            kind.invalid()
        })
    };
    let mut file = None;
    let mut fields = HashMap::new();
    while let Some(mut field) = form.next_field().await.map_err(malformed)? {
        let name = field.name().unwrap_or_default().to_owned();
        let filename = field
            .file_name()
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
        let limit = if name == "file" {
            if file.is_some() || filename.is_none() {
                return Err(Box::new(kind.invalid()));
            }
            kind.file_limit()
        } else {
            if filename.is_some() || fields.contains_key(&name) {
                return Err(Box::new(kind.invalid()));
            }
            kind.field_limit(&name)
                .ok_or_else(|| Box::new(kind.invalid()))?
        };
        let mut data = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(malformed)? {
            if chunk.len() > limit - data.len() {
                return Err(Box::new(if name == "file" {
                    kind.too_large()
                } else {
                    kind.invalid()
                }));
            }
            data.extend_from_slice(&chunk);
        }
        if let Some(filename) = filename {
            file = Some((filename, data));
        } else {
            let text = String::from_utf8(data).map_err(|_| Box::new(kind.invalid()))?;
            let text = if name == "template" {
                text
            } else {
                text.trim().to_owned()
            };
            if name == "awgVersion" && !matches!(text.as_str(), "2.0" | "3.1") {
                return Err(Box::new(kind.invalid()));
            }
            fields.insert(name, text);
        }
    }
    let (filename, data) = file.ok_or_else(|| Box::new(kind.invalid()))?;
    Ok(Upload {
        filename,
        data,
        fields,
    })
}

async fn rules(State(app): State<Arc<App>>, request: Request) -> Response {
    let mut upload = match parse_request(&app, request, UploadKind::Rules).await {
        Ok(upload) => upload,
        Err(error) => return *error,
    };
    let current = app.snapshot();
    let mut targets: HashSet<_> = ["direct", "zapret", "@block", "@vpn"]
        .map(String::from)
        .into_iter()
        .collect();
    targets.extend(
        current
            .plan
            .profiles
            .iter()
            .map(|profile| profile.id.clone()),
    );
    let target = upload
        .fields
        .remove("target")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if current.plan.default_target.is_empty() {
                "direct".into()
            } else {
                current.plan.default_target.clone()
            }
        });
    if !targets.contains(&target) {
        return error(StatusCode::BAD_REQUEST, "Выберите существующий маршрут");
    }
    let mut option = |name| upload.fields.remove(name).unwrap_or_default();
    let options = FileOptions {
        format: option("format"),
        kind: option("type"),
        domain_match: option("domainMatch"),
        template: option("template"),
        geo_source: option("geoSource"),
    };
    let parsed = parse_preview(&upload.filename, &upload.data, &target, &targets, &options);
    match parsed {
        Ok(rules) => {
            if rules.iter().any(|rule| {
                !rule.geo_ip.is_empty()
                    && !current
                        .plan
                        .geo_sources
                        .iter()
                        .any(|source| source["id"].as_str() == Some(rule.geo_source.as_str()))
            }) {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Выберите настроенный источник GeoIP",
                );
            }
            Json(json!({"rules": rules})).into_response()
        }
        Err(message) => error(StatusCode::BAD_REQUEST, &message),
    }
}

async fn profiles(State(app): State<Arc<App>>, request: Request) -> Response {
    let upload = match parse_request(&app, request, UploadKind::Profiles).await {
        Ok(upload) => upload,
        Err(error) => return *error,
    };
    let existing = app
        .snapshot()
        .plan
        .profiles
        .iter()
        .map(|profile| profile.id.clone())
        .collect();
    let field = |name| upload.fields.get(name).map_or("", String::as_str);
    match parse_profile_upload(
        &upload.data,
        field("interface"),
        field("awgVersion"),
        &existing,
    ) {
        Ok(preview) => Json(preview).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, &message),
    }
}
