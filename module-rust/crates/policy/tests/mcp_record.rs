use routehub_policy::{Config, Options, geo_tag, normalize_mac, routing_domain_info};
use serde_json::{Value, json};

fn go_compile(config: &Value, options: &Value) -> Result<Value, String> {
    // The generated Go FFI recorder accepts null as the zero struct and
    // ignores unknown JSON keys. The production HTTP input is strict.
    let mut options_out = Options::default();
    if let Some(tags) = options.get("Targets") {
        options_out.targets =
            serde_json::from_value(tags.clone()).map_err(|err| err.to_string())?;
    }
    let default_target = config
        .get("defaultTarget")
        .and_then(Value::as_str)
        .unwrap_or_default();
    routehub_policy::compile(
        &Config {
            default_target: default_target.to_owned(),
            ..Config::default()
        },
        &options_out,
    )?;
    let typed: Option<Config> =
        serde_json::from_value(config.clone()).map_err(|err| err.to_string())?;
    routehub_policy::compile(&typed.unwrap_or_default(), &options_out)?;
    // Go's Plan fields are private. replay.rs covers its actual behavior.
    Ok(json!({}))
}

#[test]
fn rust_anything_go_recording_replays_in_rust() {
    let mut mismatches = Vec::new();
    for (index, line) in include_str!("fixtures/rust-anything.jsonl")
        .lines()
        .enumerate()
    {
        let case: Value = serde_json::from_str(line).unwrap();
        let function = case["fn"].as_str().unwrap();
        let arg = case["args"][0].as_str().unwrap_or_default();
        let observed = match function {
            "NormalizeMAC" => normalize_mac(arg).map(|mac| json!(mac)),
            "NormalizeRoutingDomain" => {
                let (host, valid) = routing_domain_info(arg);
                Ok(json!([host, valid]))
            }
            "GeoTag" => Ok(match geo_tag(arg) {
                Some(tag) => json!([tag, true]),
                None => json!(["", false]),
            }),
            "Compile" => go_compile(&case["args"][0], &case["args"][1]),
            function => panic!("unexpected recorded function {function}"),
        };
        let result = match observed {
            Ok(value) => json!({ "ok": value }),
            Err(err) => json!({ "error": err }),
        };
        let expected = if let Some(value) = case.get("ok") {
            json!({"ok": value})
        } else {
            json!({"error": case["error"]})
        };
        if result != expected {
            mismatches.push(format!(
                "case {} {case}\nRust {result}\nGo {expected}",
                index + 1
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
