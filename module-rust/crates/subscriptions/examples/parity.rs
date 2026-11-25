use std::io::{self, Read};

use chrono::DateTime;
use routehub_subscriptions::{
    CatalogReferences, Subscription, SubscriptionPreview, merge_subscription_profiles,
    parse_subscription, public_subscriptions, subscription_snapshot, validate_subscriptions,
};
use serde_json::{Value, json};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let payload: Value = serde_json::from_str(&input).unwrap();
    let response = match payload["op"].as_str() {
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
    };
    println!("{response}");
}
