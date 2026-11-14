//! Test-only capture of the required src/main/i18n-text.ts MAIN_TEXT entries; no boot tree or
//! production translation implementation is needed to exercise notification policy.
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Deserialize)]
struct Translation {
    en: String,
    ko: String,
}
static TEXT: LazyLock<HashMap<String, Translation>> =
    LazyLock::new(|| serde_json::from_str(include_str!("notification-text-capture.json")).unwrap());
pub fn text(key: &str, language: &str, params: &[(&str, String)]) -> String {
    let label = TEXT
        .get(key)
        .unwrap_or_else(|| panic!("uncaptured notification key {key}"));
    let mut text = match language {
        "en" => &label.en,
        "ko" => &label.ko,
        _ => panic!("unsupported fixture language {language}"),
    }
    .clone();
    for (key, value) in params {
        text = text.replace(&format!("{{{key}}}"), value);
    }
    text
}
