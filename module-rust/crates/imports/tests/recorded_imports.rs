use std::{collections::HashSet, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use routehub_imports::{FileOptions, parse_preview, parse_profile_upload};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Case {
    name: String,
    args: Vec<String>,
    stdin: Option<String>,
    file: Option<String>,
    sha256: String,
}

// Reference outputs were captured from the previous released implementation. Store canonical JSON digests so large rule sets are not duplicated.
#[test]
fn previews_match_recorded_results() {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let valid_targets = ["@vpn", "direct", "zapret"]
        .into_iter()
        .map(str::to_owned)
        .collect::<HashSet<_>>();

    for fixture in include_str!("recorded-imports.jsonl").lines() {
        let case: Case = serde_json::from_str(fixture).unwrap();
        let data = match (case.stdin, case.file) {
            (Some(input), None) => STANDARD.decode(input).unwrap(),
            (None, Some(file)) => std::fs::read(fixture_dir.join(file)).unwrap(),
            _ => panic!("expected one input for {}", case.name),
        };

        let args = case.args.iter().map(String::as_str).collect::<Vec<_>>();
        let result = match args.as_slice() {
            [
                "preview",
                filename,
                format,
                kind,
                domain_match,
                template,
                geo_source,
            ] => {
                let options = FileOptions {
                    format: format.to_string(),
                    kind: kind.to_string(),
                    domain_match: domain_match.to_string(),
                    template: template.to_string(),
                    geo_source: geo_source.to_string(),
                };
                match parse_preview(filename, &data, "@vpn", &valid_targets, &options) {
                    Ok(rules) => json!({ "rules": rules }),
                    Err(error) => json!({ "error": error }),
                }
            }
            ["profiles", interface, version, existing] => {
                let existing = existing
                    .split(',')
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .collect();
                match parse_profile_upload(&data, interface, version, &existing) {
                    Ok(preview) => json!({ "preview": preview }),
                    Err(error) => json!({ "error": error }),
                }
            }
            _ => panic!("unexpected arguments for {}", case.name),
        };
        let normalized = serde_json::to_string(&sort_object_keys(result)).unwrap();
        let actual = format!("{:x}", Sha256::digest(normalized.as_bytes()));
        assert_eq!(actual, case.sha256, "{}: {normalized}", case.name);
    }
}

fn sort_object_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut fields = map.into_iter().collect::<Vec<_>>();
            fields.sort_unstable_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                fields
                    .into_iter()
                    .map(|(key, child)| (key, sort_object_keys(child)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.into_iter().map(sort_object_keys).collect()),
        other => other,
    }
}
