//! The text the shell shows itself (menus, tray, dialogs a moved module opens), in the UI language, read by every
//! module through `label` (PROTOCOL.md §15.4 rule 2). The table is `boot_core::text`'s; the language is set by the
//! `boot` module (the stored `language` pref, else the app locale) when CEF is up and on every change Node reports.

use std::sync::RwLock;

use crate::boot_core::js_space;
use crate::boot_core::text::{self, Lang};

static LANGUAGE: RwLock<Option<Lang>> = RwLock::new(None);

/// The UI language `label` answers in from now on.
pub fn set_language(lang: Lang) {
    *LANGUAGE.write().unwrap() = Some(lang);
}

/// The UI language (`en`, `ko`); `None` before the `boot` module chose one.
pub fn language() -> Option<String> {
    LANGUAGE
        .read()
        .unwrap()
        .map(|lang| lang.as_str().to_string())
}

/// `key`'s text with its `{name}` placeholders filled from `params` (`fill`); `None` before the language was chosen or
/// for a key the table does not have.
pub fn label(key: &str, params: &[(&str, &str)]) -> Option<String> {
    let lang = (*LANGUAGE.read().unwrap())?;
    Some(fill(text::template(lang, key)?, params))
}

/// JavaScript's `Number(text)` for text that starts with a digit and holds no space.
fn js_number(text: &str) -> Option<f64> {
    let radix = |prefix: [&str; 2], radix: u32| {
        prefix
            .iter()
            .find_map(|p| text.strip_prefix(p))
            .map(|digits| u128::from_str_radix(digits, radix).ok().map(|n| n as f64))
    };
    if let Some(n) = radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
    {
        return n;
    }
    text.parse::<f64>().ok()
}

/// `src/shared/fill-text.ts` `fillText`, the one rule main's `mainT` uses: one pass, a value never re-scanned, a
/// placeholder without a value left as written, `{plural}` / `{<name>Plural}` = `"s"` unless that number is 1. A Rust
/// copy because the shell cannot call Node's; its cases are fill-text.ts's own.
pub fn fill(template: &str, params: &[(&str, &str)]) -> String {
    let mut filled: Vec<(String, String)> = params
        .iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect();
    for (name, value) in params {
        let slot = if *name == "count" {
            "plural".to_string()
        } else {
            format!("{name}Plural")
        };
        if params.iter().any(|(n, _)| *n == slot) {
            continue;
        }
        let text = value.trim_matches(js_space);
        if !text.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        let digits: String = text
            .chars()
            .filter(|&c| c != ',' && c != '\'' && !js_space(c))
            .collect();
        let plural = if js_number(&digits) == Some(1.0) {
            ""
        } else {
            "s"
        };
        filled.push((slot, plural.to_string()));
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let word_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        let name = &after[..word_len];
        let value = (word_len > 0 && after[word_len..].starts_with('}'))
            .then(|| filled.iter().find(|(n, _)| n == name))
            .flatten();
        match value {
            Some((_, value)) => {
                out.push_str(value);
                rest = &after[word_len + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_as_fill_text_does() {
        assert_eq!(fill("v{version}", &[("version", "1.2")]), "v1.2");
        assert_eq!(fill("{a} and {a}", &[("a", "x")]), "x and x");
        assert_eq!(fill("{path}", &[("path", "{path}")]), "{path}");
        assert_eq!(fill("{missing} {a}", &[("a", "$&")]), "{missing} $&");
        assert_eq!(fill("{{a}}", &[("a", "x")]), "{x}");
        assert_eq!(fill("{a-b} {}", &[("a", "x")]), "{a-b} {}");
    }

    #[test]
    fn plurals_follow_the_number() {
        let line = "{count} session{plural}";
        assert_eq!(fill(line, &[("count", "1")]), "1 session");
        assert_eq!(fill(line, &[("count", "2")]), "2 sessions");
        assert_eq!(fill(line, &[("count", "1,204")]), "1,204 sessions");
        assert_eq!(fill(line, &[("count", "1+")]), "1+ sessions");
        assert_eq!(fill(line, &[("count", " 1.0 ")]), " 1.0  session");
        assert_eq!(fill(line, &[("count", "0x1")]), "0x1 session");
        assert_eq!(fill(line, &[("count", "one")]), "one session{plural}");
        assert_eq!(
            fill("{tools} tool call{toolsPlural}", &[("tools", "3")]),
            "3 tool calls"
        );
        assert_eq!(
            fill("{count} item{plural}", &[("count", "1"), ("plural", "!")]),
            "1 item!"
        );
    }

    #[test]
    fn reads_the_table_in_the_chosen_language() {
        assert_eq!(label("tray.quit", &[]), None);
        set_language(Lang::Ko);
        assert_eq!(language().as_deref(), Some("ko"));
        assert_eq!(
            label("tray.updateDownload", &[("version", "2.0")]).as_deref(),
            Some("v2.0 다운로드")
        );
        assert_eq!(label("no.such.key", &[]), None);
    }

    /// JavaScript's `String(value)` of a captured parameter.
    fn js_string(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
                Some(f) => f.to_string(),
                None => n.to_string(),
            },
            other => other.to_string(),
        }
    }

    #[test]
    fn replays_fill_text_as_captured() {
        let captured: serde_json::Value =
            serde_json::from_str(include_str!("boot_core/captured.json")).unwrap();
        let cases = captured["fill"].as_array().unwrap();
        assert_eq!(cases.len(), 26);
        for case in cases {
            let owned: Vec<(String, String)> = case["params"]
                .as_object()
                .map(|o| o.iter().map(|(k, v)| (k.clone(), js_string(v))).collect())
                .unwrap_or_default();
            let params: Vec<(&str, &str)> = owned
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            assert_eq!(
                fill(case["template"].as_str().unwrap(), &params),
                case["out"].as_str().unwrap(),
                "{case}"
            );
        }
    }
}
