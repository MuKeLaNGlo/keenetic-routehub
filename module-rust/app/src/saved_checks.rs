use std::{collections::HashSet, net::IpAddr};

use anyhow::{Result, ensure};
use ipnet::IpNet;
use routehub_policy::{Binding, Destination, Plan as Policy, normalize_mac};
use serde::{Deserialize, Serialize};

use crate::config::{self, Plan};

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SavedCheck {
    id: String,
    name: String,
    source: Source,
    target: String,
    family: String,
    proto: String,
    port: u16,
    expect: String,
    required: bool,
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    device_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    segment_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison<'a> {
    check_id: &'a str,
    name: &'a str,
    required: bool,
    live: String,
    draft: String,
    ok: bool,
    message: String,
}

pub fn normalize(checks: &mut [SavedCheck]) -> Result<()> {
    ensure!(
        checks.len() <= 64,
        "можно сохранить до 64 проверок маршрута"
    );
    let mut seen = HashSet::new();
    for (index, check) in checks.iter_mut().enumerate() {
        let index = index + 1;
        ensure!(
            !check.id.is_empty()
                && check.id.len() <= 64
                && check
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
                && seen.insert(check.id.as_str()),
            "проверьте идентификатор сохранённой проверки №{index}"
        );
        check.name = check.name.trim().to_owned();
        ensure!(
            !check.name.is_empty()
                && check.name.chars().count() <= 64
                && !check.name.chars().any(char::is_control),
            "проверьте название сохранённой проверки №{index}"
        );
        match check.source.kind.as_str() {
            "device" if check.source.segment_id.is_empty() => {
                check.source.device_id = normalize_mac(&check.source.device_id).map_err(|_| {
                    anyhow::anyhow!("проверьте источник сохранённой проверки №{index}")
                })?;
            }
            "segment"
                if check.source.device_id.is_empty()
                    && config::interface_name(&check.source.segment_id) => {}
            _ => anyhow::bail!("проверьте источник сохранённой проверки №{index}"),
        }
        check.target = check
            .target
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let family = check.family.as_str();
        let address_valid = check.target.parse::<IpAddr>().map_or_else(
            |_| config::valid_domain(&check.target),
            |addr| addr.to_canonical().is_ipv4() == (family == "v4"),
        );
        ensure!(
            matches!(family, "v4" | "v6")
                && address_valid
                && matches!(check.proto.as_str(), "tcp" | "udp")
                && check.port != 0,
            "проверьте адрес, семейство IP, протокол и порт сохранённой проверки №{index}"
        );
        ensure!(
            matches!(
                check.expect.as_str(),
                "direct" | "vpn" | "zapret" | "block" | "keenetic"
            ),
            "проверьте ожидаемый выход сохранённой проверки №{index}"
        );
    }
    Ok(())
}

pub fn compare<'a>(
    live: (&Plan, &Policy),
    draft: (&'a Plan, &Policy),
    capture: bool,
    bindings: &[Binding],
) -> (Vec<Comparison<'a>>, Vec<String>) {
    let mut rows = Vec::with_capacity(draft.0.saved_checks.len());
    let mut errors = Vec::new();
    for check in &draft.0.saved_checks {
        let (old_action, old_text) = evaluate(live, capture, bindings, check);
        let (action, text) = evaluate(draft, capture, bindings, check);
        let display = |action, text| {
            if action == "unknown" {
                format!("Недоступно · {text}")
            } else {
                String::from(text)
            }
        };
        let draft = display(action, text);
        let ok = action == check.expect;
        let message = if ok {
            "Расчёт черновика соответствует ожиданию.".into()
        } else {
            format!("Ожидается «{}».", label(&check.expect))
        };
        if check.required && !ok {
            errors.push(format!(
                "Обязательная проверка «{}»: {message} Черновик · {draft}.",
                check.name
            ));
        }
        rows.push(Comparison {
            check_id: &check.id,
            name: &check.name,
            required: check.required,
            live: display(old_action, old_text),
            draft,
            ok,
            message,
        });
    }
    (rows, errors)
}

fn evaluate(
    (plan, policy): (&Plan, &Policy),
    capture: bool,
    bindings: &[Binding],
    check: &SavedCheck,
) -> (&'static str, &'static str) {
    let Some(lan) = plan.transparent.as_ref().filter(|_| capture) else {
        return ("unknown", "перехват сегмента выключен");
    };
    if check.family != "v4" || check.proto == "udp" && lan.mode == "redirect-tcp" {
        return (
            "unknown",
            "текущий режим не перехватывает этот протокол и семейство IP",
        );
    }
    let mut destination = Destination {
        host: check.target.clone(),
        network: check.proto.clone(),
        port: check.port,
        ..Default::default()
    };
    if check.source.kind == "segment" {
        if check.source.segment_id != lan.interface {
            return ("keenetic", label("keenetic"));
        }
    } else {
        let in_scope = lan.source.parse::<IpNet>().ok().is_some_and(|scope| {
            bindings.iter().any(|entry| {
                entry.mac == check.source.device_id
                    && entry
                        .address
                        .parse::<IpAddr>()
                        .is_ok_and(|ip| scope.contains(&ip))
            })
        });
        if !in_scope {
            return (
                "unknown",
                "инвентарь Keenetic не подтвердил устройство в перехватываемом сегменте",
            );
        }
        destination.client_mac.clone_from(&check.source.device_id);
    }
    let Ok(decision) = policy.evaluate(&destination) else {
        return ("unknown", "ошибка расчёта маршрута");
    };
    let action = match decision.target.as_str() {
        "@block" => "block",
        "direct" => "direct",
        "zapret" => "zapret",
        _ => "vpn",
    };
    (action, label(action))
}

fn label(kind: &str) -> &'static str {
    match kind {
        "direct" => "Напрямую",
        "vpn" => "VPN",
        "zapret" => "Zapret",
        "block" => "Блокировка",
        "keenetic" => "Маршрутизация KeeneticOS",
        _ => "Неизвестно",
    }
}
