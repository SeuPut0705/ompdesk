//! The text the shell shows itself (menus, tray, dialogs a moved module opens), in the UI language, read by every
//! module through `label` (PROTOCOL.md §15.4 rule 2). Transitional source until SX5 moves i18n into the shell: Node
//! pushes the whole table (`MAIN_TEXT`, and `TRAY_LABELS` as `tray.<key>`) for the current language with the event
//! `i18n.labels {language, text}` at start and on every language change (§15.2). SX5 then fills it from `boot_core`.

use std::collections::HashMap;
use std::sync::RwLock;

use serde_json::Value;

struct Table {
    language: String,
    text: HashMap<String, String>,
}

static TABLE: RwLock<Option<Table>> = RwLock::new(None);

/// Takes `i18n.labels`'s data; the table it replaces is dropped whole.
pub fn set(data: &Value) -> Result<(), String> {
    let language = data
        .get("language")
        .and_then(Value::as_str)
        .ok_or("i18n.labels without a language")?;
    let text = data
        .get("text")
        .and_then(Value::as_object)
        .ok_or("i18n.labels without a text table")?
        .iter()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
        .collect();
    *TABLE.write().unwrap() = Some(Table {
        language: language.to_string(),
        text,
    });
    Ok(())
}

/// The UI language of the table (`en`, `ko`); `None` before Node pushed one.
pub fn language() -> Option<String> {
    TABLE.read().unwrap().as_ref().map(|t| t.language.clone())
}

/// `key`'s text with its `{name}` placeholders filled from `params` (`fill`); `None` before Node pushed a table or for
/// a key it does not have.
pub fn label(key: &str, params: &[(&str, &str)]) -> Option<String> {
    let table = TABLE.read().unwrap();
    let template = table.as_ref()?.text.get(key)?;
    Some(fill(template, params))
}

/// JavaScript's `\s` (and what `String.prototype.trim` removes).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
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
    fn reads_the_table_node_pushed() {
        assert_eq!(label("tray.quit", &[]), None);
        set(&serde_json::json!({
            "language": "ko",
            "text": { "tray.updateDownload": "v{version} 다운로드", "n": 3 }
        }))
        .unwrap();
        assert_eq!(language().as_deref(), Some("ko"));
        assert_eq!(
            label("tray.updateDownload", &[("version", "2.0")]).as_deref(),
            Some("v2.0 다운로드")
        );
        assert_eq!(label("n", &[]), None);
        assert!(set(&serde_json::json!({ "text": {} })).is_err());
    }
}
