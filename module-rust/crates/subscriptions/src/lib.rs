#![forbid(unsafe_code)]

mod catalog;
#[cfg(feature = "http")]
mod fetch;
mod model;
mod source;
mod xray;

pub use catalog::*;
#[cfg(feature = "http")]
pub use fetch::*;
pub use model::*;
pub use source::{
    BLOCKED_DEVICE, MAX_SUBSCRIPTION_BODY, digest, is_public_ipv4, parse_subscription,
    public_subscriptions, subscription_endpoint, validate_subscriptions,
};
pub use xray::{
    clean_xray_comments, pin_profile_uri, pin_subscription_hysteria_node,
    pin_subscription_vless_node, pin_trojan_outbound, profile_uri_outbound,
    validate_subscription_hysteria_node, validate_xray_profile_group,
};
