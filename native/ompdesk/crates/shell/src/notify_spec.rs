//! `notification.show` (PROTOCOL.md §8): the parameters and the toast document built from them. Pure, so it is tested
//! on every OS; the Windows toast and the macOS notification centre take the same spec.

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToastSpec {
    pub id: u64,
    pub title: String,
    pub body: String,
    /// A file path (Electron's `icon` is a path or an image; the shim sends the path).
    pub icon: Option<String>,
    pub silent: bool,
}

impl ToastSpec {
    /// `None` when the request carries no usable `id`.
    pub fn from_json(params: &Value) -> Option<Self> {
        let text = |key: &str| {
            params
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Some(Self {
            id: params.get("id").and_then(Value::as_u64)?,
            title: text("title"),
            body: text("body"),
            icon: params
                .get("icon")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .map(String::from),
            silent: params
                .get("silent")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// The `ToastGeneric` document. `urgency` and `timeoutType` are Linux-only in Electron and are ignored, as there.
    pub fn xml(&self) -> String {
        let mut doc = String::from("<toast><visual><binding template=\"ToastGeneric\">");
        if let Some(icon) = &self.icon {
            doc.push_str(&format!(
                "<image placement=\"appLogoOverride\" src=\"{}\"/>",
                escape_xml(&file_uri(icon))
            ));
        }
        doc.push_str(&format!(
            "<text>{}</text><text>{}</text></binding></visual>",
            escape_xml(&self.title),
            escape_xml(&self.body)
        ));
        if self.silent {
            doc.push_str("<audio silent=\"true\"/>");
        }
        doc.push_str("</toast>");
        doc
    }
}

pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 has no representation for most control characters.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// A path as the `src` of a toast image: `C:\a b\i.png` → `file:///C:/a%20b/i.png`. Things that already are URLs stay.
pub fn file_uri(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("file:")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("ms-appx:")
    {
        return path.to_string();
    }
    let slashed = path.replace('\\', "/");
    let mut out = String::from("file:///");
    let body = slashed.trim_start_matches('/');
    for byte in body.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'/'
            | b':'
            | b'!'
            | b'$'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b';'
            | b'='
            | b'@' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `ToastDismissalReason` as the `close` event's `reason`.
pub fn dismissal_reason(code: i32) -> &'static str {
    match code {
        0 => "userCanceled",
        1 => "applicationHidden",
        2 => "timedOut",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spec_needs_an_id() {
        assert!(ToastSpec::from_json(&json!({ "title": "T" })).is_none());
        let s = ToastSpec::from_json(
            &json!({ "id": 7, "title": "T", "body": "B", "silent": true, "icon": "C:\\i.png" }),
        )
        .unwrap();
        assert_eq!(
            (s.id, s.title.as_str(), s.body.as_str(), s.silent),
            (7, "T", "B", true)
        );
        assert_eq!(s.icon.as_deref(), Some("C:\\i.png"));
        assert!(
            ToastSpec::from_json(&json!({ "id": 1, "icon": "" }))
                .unwrap()
                .icon
                .is_none()
        );
    }

    #[test]
    fn xml_escapes_and_carries_icon_and_silence() {
        let s = ToastSpec {
            id: 1,
            title: "a<b".into(),
            body: "x & \"y\"".into(),
            icon: Some("C:\\my dir\\한.png".into()),
            silent: true,
        };
        assert_eq!(
            s.xml(),
            "<toast><visual><binding template=\"ToastGeneric\"><image placement=\"appLogoOverride\" src=\"file:///C:/my%20dir/%ED%95%9C.png\"/>\
             <text>a&lt;b</text><text>x &amp; &quot;y&quot;</text></binding></visual><audio silent=\"true\"/></toast>"
        );
    }

    #[test]
    fn xml_without_icon_or_silence_is_plain() {
        let s = ToastSpec {
            id: 1,
            title: "T".into(),
            body: "B".into(),
            icon: None,
            silent: false,
        };
        assert_eq!(
            s.xml(),
            "<toast><visual><binding template=\"ToastGeneric\"><text>T</text><text>B</text></binding></visual></toast>"
        );
    }

    #[test]
    fn control_characters_are_dropped_from_text() {
        assert_eq!(escape_xml("a\u{1}b\tc\n"), "ab\tc\n");
    }

    #[test]
    fn urls_are_left_alone() {
        assert_eq!(file_uri("https://x/y.png"), "https://x/y.png");
        assert_eq!(file_uri("file:///C:/a.png"), "file:///C:/a.png");
        assert_eq!(file_uri("/Users/me/a.png"), "file:///Users/me/a.png");
    }

    #[test]
    fn dismissal_reasons_are_named() {
        assert_eq!(dismissal_reason(0), "userCanceled");
        assert_eq!(dismissal_reason(1), "applicationHidden");
        assert_eq!(dismissal_reason(2), "timedOut");
        assert_eq!(dismissal_reason(9), "unknown");
    }
}
