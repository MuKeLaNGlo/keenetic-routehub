use chrono::DateTime;
use routehub_subscriptions::{
    CatalogReferences, Subscription, SubscriptionPreview, merge_subscription_profiles,
    parse_subscription, public_subscriptions, subscription_snapshot, validate_subscriptions,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Case {
    name: String,
    stdin: String,
    sha256: String,
}

#[test]
fn subscription_operations_match_recorded_results() {
    for line in include_str!("recorded_subscriptions.jsonl").lines() {
        let case: Case = serde_json::from_str(line).unwrap();
        let input = serde_json::from_str(&case.stdin).unwrap();
        let response = serde_json::to_string(&evaluate(&input)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(response.as_bytes())),
            case.sha256,
            "{}: {response}",
            case.name,
        );
    }
}

fn evaluate(payload: &Value) -> Value {
    match payload["op"].as_str() {
        Some("sources") => {
            let sources: Vec<Subscription> =
                serde_json::from_value(payload["sources"].clone()).unwrap();
            match validate_subscriptions(&sources) {
                Ok(sources) => json!({
                    "private": sources,
                    "public": public_subscriptions(&sources),
                    "statuses": sources.iter().map(Subscription::status).collect::<Vec<_>>(),
                }),
                Err(error) => json!({"error":error}),
            }
        }
        Some("merge") => {
            let timestamp = DateTime::UNIX_EPOCH;
            let source = Subscription {
                id: "example".to_owned(),
                ..Default::default()
            };
            let initial = parse_subscription(payload["initial"].as_str().unwrap().as_bytes())
                .unwrap_or_else(|e| panic!("{e}"));
            let fresh = parse_subscription(payload["fresh"].as_str().unwrap().as_bytes())
                .unwrap_or_else(|e| panic!("{e}"));
            let mut old = merge_subscription_profiles(
                &[],
                &source,
                &initial.profiles,
                &Default::default(),
                &mut SubscriptionPreview::new(&source.id, timestamp),
            )
            .unwrap();
            old[0].label = "Псевдоним".into();
            let refs = CatalogReferences {
                default_target: &old[1].id,
                ..Default::default()
            };
            let mut preview = SubscriptionPreview::new(&source.id, timestamp);
            let new =
                merge_subscription_profiles(&old, &source, &fresh.profiles, &refs, &mut preview)
                    .unwrap();
            let (revision, count) = subscription_snapshot(&new, &source.id);
            json!({"profiles":new,"preview":preview,"revision":revision,"count":count})
        }
        _ => match parse_subscription(payload["body"].as_str().unwrap().as_bytes()) {
            Ok(result) => serde_json::to_value(result).unwrap(),
            Err(error) => json!({"error":error.error,"incompatible":error.incompatible}),
        },
    }
}
