use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::{Destination, Importer, ParseResult, RowOptions, formats::suffix_entry, read_port};

type JsonObject = Map<String, Value>;

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn strict_fields(fields: &JsonObject, allowed: &[&str]) -> ParseResult<()> {
    if let Some(key) = fields.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("json: unknown field {key:?}"));
    }
    Ok(())
}

fn field_string<'a>(row: &'a JsonObject, key: &str) -> ParseResult<&'a str> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(value)) => Ok(value),
        Some(other) => Err(format!(
            "json: cannot unmarshal {} into Go struct field entry.{key} of type string",
            value_type(other)
        )),
    }
}

fn field_bool(row: &JsonObject, key: &str) -> ParseResult<bool> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(other) => Err(format!(
            "json: cannot unmarshal {} into Go struct field entry.{key} of type bool",
            value_type(other)
        )),
    }
}

fn strings_for(value: Option<&Value>, native: bool) -> ParseResult<Vec<&str>> {
    let expected = "ожидается адрес или список адресов";
    match value {
        None => Ok(vec![]),
        Some(Value::Null) if !native => Ok(vec![]),
        Some(Value::String(value)) => Ok(vec![value]),
        Some(Value::Array(list)) => list
            .iter()
            .map(|item| {
                if native && item.is_null() {
                    return Ok("");
                }
                item.as_str().ok_or(
                    if native {
                        expected
                    } else {
                        "вместо назначения ожидалась строка"
                    }
                    .into(),
                )
            })
            .collect(),
        _ => Err(expected.into()),
    }
}

fn native_markers(value: &Value) -> bool {
    match value {
        Value::Array(rows) => rows.iter().any(native_markers),
        Value::Object(fields) => fields.iter().any(|(key, value)| match key.as_str() {
            "outboundTag"
            | "target"
            | "destination"
            | "routing"
            | "global_routing_rules"
            | "type"
            | "match"
            | "exact"
            | "geoIP"
            | "geoSource"
            | "disabled"
            | "network"
            | "port"
            | "balancerTag"
            | "source"
            | "sourceIP"
            | "sourcePort"
            | "inboundTag"
            | "localIP"
            | "localPort"
            | "process"
            | "protocol"
            | "attrs"
            | "user"
            | "domainMatcher"
            | "ruleTag"
            | "vlessRoute"
            | "webhook"
            | "localOS"
            | "invert"
            | "action" => true,
            "rules" => native_markers(value),
            _ => false,
        }),
        _ => false,
    }
}

impl Importer<'_> {
    pub(crate) fn document(&mut self, data: &str) -> ParseResult<()> {
        let value = serde_json::from_str::<Value>(data).map_err(|e| e.to_string())?;
        self.read_native_document(&value)
    }

    fn read_native_document(&mut self, value: &Value) -> ParseResult<()> {
        let rows = match value {
            Value::Array(rows) => rows.as_slice(),
            Value::Object(fields)
                if fields.contains_key("rules") || fields.contains_key("global_routing_rules") =>
            {
                strict_fields(fields, &["rules", "global_routing_rules"])?;
                let ordinary = fields.get("rules");
                let global = fields.get("global_routing_rules");
                if ordinary.is_some() == global.is_some() {
                    return Err("ожидается один массив правил JSON".into());
                }
                let (key, array) = if let Some(value) = ordinary {
                    ("rules", value)
                } else {
                    ("global_routing_rules", global.unwrap())
                };
                match array {
                    Value::Array(rows) => rows.as_slice(),
                    Value::Null => return Err("ожидается один массив правил JSON".into()),
                    other => {
                        return Err(format!(
                            "json: cannot unmarshal {} into Go struct field .{key} of type []ruleimport.entry",
                            value_type(other)
                        ));
                    }
                }
            }
            Value::Object(_) | Value::Null => std::slice::from_ref(value),
            other => {
                return Err(format!(
                    "json: cannot unmarshal {} into Go value of type map[string]json.RawMessage",
                    value_type(other)
                ));
            }
        };
        let blank = JsonObject::new();
        // Go's strict decoder checks structure before attempting route conversion.
        for row in rows {
            let fields = match row {
                Value::Object(object) => object,
                Value::Null => &blank,
                other => {
                    return Err(format!(
                        "json: cannot unmarshal {} into Go value of type ruleimport.entry",
                        value_type(other)
                    ));
                }
            };
            strict_fields(
                fields,
                &[
                    "name",
                    "destination",
                    "domain",
                    "cidr",
                    "ip",
                    "exact",
                    "match",
                    "geoIP",
                    "geoSource",
                    "disabled",
                    "network",
                    "port",
                    "target",
                    "outboundTag",
                    "type",
                ],
            )?;
            for key in [
                "name",
                "destination",
                "cidr",
                "match",
                "geoIP",
                "geoSource",
                "network",
                "target",
                "outboundTag",
                "type",
            ] {
                field_string(fields, key)?;
            }
            for key in ["exact", "disabled"] {
                field_bool(fields, key)?;
            }
        }
        for (i, row) in rows.iter().enumerate() {
            self.read_native_row(row.as_object().unwrap_or(&blank))
                .map_err(|e| format!("правило JSON {} — {e}", i + 1))?;
        }
        Ok(())
    }

    fn read_native_row(&mut self, row: &JsonObject) -> ParseResult<()> {
        let string = |key| field_string(row, key).expect("validated first");
        let kind = string("type");
        let target = string("target");
        let outbound = string("outboundTag");
        if !matches!(kind, "" | "field") || !target.is_empty() && !outbound.is_empty() {
            return Err("ожидается правило field с одним маршрутом".into());
        }
        let target = if target.is_empty() { outbound } else { target };
        let domains = strings_for(row.get("domain"), true)?;
        let addresses = strings_for(row.get("ip"), true)?;
        let destination = string("destination");
        let cidr = string("cidr");
        let country = string("geoIP");
        let count = [
            !destination.is_empty(),
            !domains.is_empty(),
            !addresses.is_empty(),
            !cidr.is_empty(),
            !country.is_empty(),
        ]
        .into_iter()
        .filter(|x| *x)
        .count();
        if count != 1 {
            return Err("у каждого правила нужен один тип назначения".into());
        }
        let port = match row.get("port") {
            Some(Value::String(value)) => read_port(value)?,
            Some(Value::Number(value)) => read_port(&value.to_string())?,
            Some(_) => return Err("укажите один порт от 1 до 65535".into()),
            None => 0,
        };
        let name = string("name");
        let meta = RowOptions {
            name,
            network: string("network"),
            target,
            port,
            exact: field_bool(row, "exact")?,
            match_kind: string("match"),
        };
        let disabled = field_bool(row, "disabled")?;
        if !country.is_empty() {
            self.push_as(
                country,
                RowOptions {
                    exact: false,
                    match_kind: "",
                    ..meta
                },
                "geo",
                string("geoSource"),
            )?;
            self.rules.last_mut().expect("appended").disabled = disabled;
            return Ok(());
        }
        let values = if !destination.is_empty() {
            vec![destination.to_owned()]
        } else if !cidr.is_empty() {
            vec![format!("cidr:{cidr}")]
        } else if !addresses.is_empty() {
            addresses
                .iter()
                .map(|address| format!("ip:{address}"))
                .collect()
        } else {
            domains
                .into_iter()
                .map(|domain| {
                    if ["full:", "domain:", "keyword:", "regexp:"]
                        .iter()
                        .any(|prefix| domain.starts_with(prefix))
                    {
                        domain.into()
                    } else {
                        format!("domain:{domain}")
                    }
                })
                .collect::<Vec<_>>()
        };
        let count = values.len();
        for (i, value) in values.into_iter().enumerate() {
            let label = if count > 1 && !name.is_empty() {
                format!("{name} {}", i + 1)
            } else {
                name.into()
            };
            self.push(
                &value,
                RowOptions {
                    name: &label,
                    ..meta
                },
            )?;
            self.rules.last_mut().expect("appended").disabled = disabled;
        }
        Ok(())
    }

    pub(crate) fn alternate_json(&mut self, format: &str, data: &str) -> ParseResult<()> {
        let json: Value = serde_json::from_str(data).map_err(|_| "некорректный JSON")?;
        if format == "singbox"
            || json.get("version").is_some_and(Value::is_number)
                && json.get("rules").is_some_and(|v| !v.is_null())
        {
            return self.read_singbox(&json);
        }
        if format != "amnezia" && data.starts_with(['{', '[']) {
            let mut native = Self::new(self.fallback, self.targets, self.options);
            match native.read_native_document(&json) {
                Ok(()) => {
                    self.rules = native.rules;
                    return Ok(());
                }
                Err(error) if native_markers(&json) => return Err(error),
                Err(_) => {}
            }
        }
        self.read_destination_json(&json, true, "")
    }

    fn read_singbox(&mut self, value: &Value) -> ParseResult<()> {
        let rules = value
            .get("rules")
            .and_then(Value::as_array)
            .ok_or("в sing-box JSON отсутствует массив rules")?;
        let extra = "в sing-box JSON есть условия помимо назначений";
        for row in rules {
            let row = row.as_object().ok_or(extra)?;
            if row
                .get("invert")
                .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
                || row
                    .get("type")
                    .is_some_and(|value| !value.is_null() && value.as_str() != Some("default"))
                || row.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "type"
                            | "invert"
                            | "domain"
                            | "domain_suffix"
                            | "domain_keyword"
                            | "domain_regex"
                            | "ip_cidr"
                    )
                })
            {
                return Err(extra.into());
            }
            let exact = strings_for(row.get("domain"), false)?;
            let suffixes = strings_for(row.get("domain_suffix"), false)?;
            let mut converted = HashSet::new();
            for value in suffixes {
                let mut entry = suffix_entry(value);
                if let Some(raw) = value.strip_prefix('.')
                    && exact.contains(&raw)
                {
                    entry.match_kind = "suffix".into();
                    converted.insert(raw);
                }
                self.push_entry(entry)?;
            }
            for value in exact {
                if !converted.contains(value) {
                    self.push_entry(Destination::new(value, "exact"))?;
                }
            }
            for (key, match_kind) in [
                ("domain_keyword", "keyword"),
                ("domain_regex", "regex"),
                ("ip_cidr", ""),
            ] {
                for value in strings_for(row.get(key), false)? {
                    let value = if key == "ip_cidr" {
                        format!("ip:{value}")
                    } else {
                        value.into()
                    };
                    self.push_entry(Destination::new(value, match_kind))?;
                }
            }
        }
        Ok(())
    }

    fn read_destination_json(&mut self, value: &Value, root: bool, field: &str) -> ParseResult<()> {
        match value {
            Value::String(value) if !value.trim().is_empty() => {
                let row = match field {
                    "domain_suffix" => suffix_entry(value),
                    "domain_keyword" => Destination::new(value, "keyword"),
                    "domain_regex" => Destination::new(value, "regex"),
                    "ip" | "ip4" | "ip6" | "ipv4" | "ipv6" | "ip_cidr" | "cidr" | "cidr4"
                    | "cidr6" | "subnet" => Destination::plain(format!("ip:{value}")),
                    _ => Destination::plain(value),
                };
                self.push_entry(row)?;
            }
            Value::Array(values) => {
                for value in values {
                    self.read_destination_json(value, false, field)?;
                }
            }
            Value::Object(fields) => {
                let mut keys = fields.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                for key in keys {
                    let child = &fields[key];
                    let field = key.to_lowercase();
                    if matches!(
                        field.as_str(),
                        "domains"
                            | "ip4"
                            | "ip6"
                            | "cidr4"
                            | "cidr6"
                            | "domain"
                            | "domain_suffix"
                            | "domain_keyword"
                            | "domain_regex"
                            | "ip_cidr"
                            | "hostname"
                            | "ip"
                            | "ipv4"
                            | "ipv6"
                            | "cidr"
                            | "address"
                            | "subnet"
                            | "payload"
                            | "entries"
                            | "items"
                            | "rules"
                    ) {
                        self.read_destination_json(child, false, &field)
                            .map_err(|e| format!("поле списка JSON — {e}"))?;
                    } else if root && matches!(child, Value::Array(_) | Value::Object(_)) {
                        self.read_destination_json(child, false, "")?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}
