// Binary used by rust-anything to compare the original Go importer with Rust.
use std::{collections::HashSet, io::Read};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use routehub_imports::{FileOptions, parse_preview, parse_profile_upload};
use serde_json::json;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("fixture");
    let data = STANDARD
        .decode(raw.replace(['\r', '\n'], ""))
        .expect("fixture base64");
    if args.len() == 5 && args[1] == "profiles" {
        let used = args[4]
            .split(',')
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect();
        let result = match parse_profile_upload(&data, &args[2], &args[3], &used) {
            Ok(preview) => json!({"preview": preview}),
            Err(error) => json!({"error": error}),
        };
        println!("{result}");
        return;
    }
    if args.len() != 8 || args[1] != "preview" {
        println!("usage: preview filename format type match template geoSource; stdin is base64");
        return;
    }
    let options = FileOptions {
        format: args[3].clone(),
        kind: args[4].clone(),
        domain_match: args[5].clone(),
        template: args[6].clone(),
        geo_source: args[7].clone(),
    };
    let targets = ["@vpn", "direct", "zapret"]
        .into_iter()
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let result = match parse_preview(&args[2], &data, "@vpn", &targets, &options) {
        Ok(rules) => json!({"rules": rules}),
        Err(error) => json!({"error": error}),
    };
    println!("{result}");
}
