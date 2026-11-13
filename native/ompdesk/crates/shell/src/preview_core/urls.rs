//! Which addresses a Preview page may show or go to. Copies of the page's `src/shared/preview.ts` rules
//! (`previewUrl`, `isLoopbackUrl`), which the page keeps for its address bar; `captured/urls.json` pins both to the
//! same answers. The `url` crate is the WHATWG parser `new URL` is.

use url::Url;

/// The scheme a `gui_visualize` page loads from (`VISUAL_SCHEME`).
pub const VISUAL_SCHEME: &str = "omp-visual";

/// The normalised address of an http(s) page without credentials, or None.
pub fn preview_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none())
        .then(|| url.to_string())
}

/// Whether `value` names this computer by its loopback name or address.
pub fn is_loopback_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
}

/// Which visual and version an `omp-visual:` address names (`v<N>-<16 hex>`), or None.
pub fn parse_visual_url(url: &str) -> Option<(String, u64)> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != VISUAL_SCHEME {
        return None;
    }
    let host = parsed.host_str()?;
    let (version, id) = host.strip_prefix('v')?.split_once('-')?;
    let well_formed = !version.is_empty()
        && version.bytes().all(|b| b.is_ascii_digit())
        && id.len() == 16
        && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    // A version past u64 is no version this app wrote (the TypeScript read it as a float).
    well_formed.then(|| version.parse().ok().map(|v| (id.to_owned(), v))).flatten()
}

/// Whether a page in the visual session, showing visual `shown` (None: an empty document), may go to `to` when the
/// page itself asks: only another version of the same visual, or an empty document (`about:blank`, `about:srcdoc`,
/// which keep the page's origin and policy), so nothing the page read leaves in an address.
pub fn visual_may_navigate(shown: Option<&str>, to: &str) -> bool {
    let Ok(target) = Url::parse(to) else { return false };
    if target.scheme() == "about" {
        return matches!(target.path(), "blank" | "srcdoc");
    }
    shown.is_some_and(|shown| parse_visual_url(to).is_some_and(|(id, _)| id == shown))
}

/// The relay endpoint the bridge returned, accepted only as stock's loopback relay (`http://127.0.0.1:<port>`) with a
/// token; anything else is refused, so the preview never dials elsewhere.
pub fn relay_extension_url(url: &str, token: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") {
        return None;
    }
    let port = parsed.port()?;
    let bare = parsed.path().trim_end_matches('/').is_empty()
        && parsed.query().is_none_or(str::is_empty)
        && parsed.username().is_empty()
        && parsed.password().is_none();
    let token_ok = token.len() >= 16 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    (bare && token_ok).then(|| format!("ws://127.0.0.1:{port}/ext?token={token}"))
}

/// A page's title as a file name: no separators or control characters, at most 100 UTF-16 units, else `page`.
pub fn pdf_name(title: &str) -> String {
    let separators = collapse(title, |c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    let spaced = collapse(&separators, char::is_control);
    let cut = cut_utf16(spaced.trim_matches(super::js::is_space), 100);
    if cut.is_empty() { "page".to_owned() } else { cut }
}

/// `text.replace(/[…]+/g, " ")`: each run of characters `hit` matches becomes one space.
fn collapse(text: &str, hit: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if !hit(c) {
            out.push(c);
        } else if !in_run {
            out.push(' ');
        }
        in_run = hit(c);
    }
    out
}

/// The first `units` UTF-16 code units of `text`, as `String.prototype.slice` keeps them (a cut surrogate pair keeps
/// its first half, which Rust cannot hold: that half is dropped).
fn cut_utf16(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_the_typescript_tables() {
        let table = super::super::captured("urls");
        for row in table["rows"].as_array().unwrap() {
            let url = row["url"].as_str().unwrap();
            assert_eq!(json!(preview_url(url)), row["previewUrl"], "previewUrl {url:?}");
            assert_eq!(json!(is_loopback_url(url)), row["isLoopback"], "isLoopbackUrl {url:?}");
            let visual = parse_visual_url(url).map(|(id, version)| json!({"id": id, "version": version}));
            assert_eq!(json!(visual), row["parseVisual"], "parseVisualUrl {url:?}");
            let shown = [None, Some("0123456789abcdef"), Some("fedcba9876543210")];
            let may: Vec<bool> = shown.iter().map(|s| visual_may_navigate(*s, url)).collect();
            assert_eq!(json!(may), row["mayNavigate"], "visualMayNavigate {url:?}");
        }
        for row in table["relay"].as_array().unwrap() {
            let got = relay_extension_url(row["url"].as_str().unwrap(), row["token"].as_str().unwrap());
            assert_eq!(json!(got), row["out"], "{row}");
        }
    }

    #[test]
    fn names_a_pdf_after_the_title() {
        for (title, want) in [
            ("Report: Q1/Q2 <draft>", "Report  Q1 Q2  draft"),
            ("a\u{0}\u{1}b\tc", "a b c"),
            ("  \u{feff} ", "page"),
            ("", "page"),
            ("::", "page"),
            ("x|\u{7}|y", "x   y"),
        ] {
            assert_eq!(pdf_name(title), want, "{title:?}");
        }
        assert_eq!(pdf_name(&"가".repeat(150)).chars().count(), 100);
        assert_eq!(pdf_name(&"😀".repeat(60)).chars().count(), 50);
    }
}
