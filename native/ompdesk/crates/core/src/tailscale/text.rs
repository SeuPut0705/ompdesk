//! What the CLI printed, read for the few things decisions and messages take from it (was the helpers of
//! `src/main/tailscale/cli.ts`). Decisions are only ever made from `--json` output; the human text is shown to the
//! person and searched for a `login.tailscale.com` link, nothing else.

use super::json;
use crate::fs::order::{is_js_space, js_trim};

/// The first non-empty line of what a call said (its stderr, else its stdout): what Settings shows under "Details".
pub fn first_line<'a>(stderr: &'a str, stdout: &'a str) -> Option<&'a str> {
    let said = if stderr.is_empty() { stdout } else { stderr };
    // `split(/\r?\n/)`: a `\r` left before a break goes with the trim.
    said.split('\n').map(js_trim).find(|line| !line.is_empty())
}

/// The `login.tailscale.com` link in a command's human output (sign-in, "enable HTTPS"), or none:
/// `/https:\/\/login\.tailscale\.com\/[^\s"'<>)]*/`.
pub fn login_url(text: &str) -> Option<&str> {
    const START: &str = "https://login.tailscale.com/";
    let from = text.find(START)?;
    let rest = &text[from + START.len()..];
    let end = rest
        .find(|c| is_js_space(c) || matches!(c, '"' | '\'' | '<' | '>' | ')'))
        .unwrap_or(rest.len());
    Some(&text[from..from + START.len() + end])
}

/// The sign-in link in `up --json` output: its `AuthURL`, from the first line that has one. A cut-off line (the call
/// was cut short) is passed over: the next one may be whole.
pub fn auth_url(stdout: &str) -> Option<String> {
    stdout.split('\n').find_map(|line| {
        let line = js_trim(line);
        let parsed = line.starts_with('{').then(|| json::parse(line))??;
        json::filled(parsed.as_object()?, "AuthURL").map(str::to_owned)
    })
}

/// The host of `ControlURL` in `debug prefs` JSON, as node's `URL` reads it (`new URL(url).hostname`), or none.
pub fn control_host(stdout: &str) -> Option<String> {
    let parsed = json::parse(stdout)?;
    let url = url::Url::parse(json::filled(parsed.as_object()?, "ControlURL")?).ok()?;
    Some(url.host_str().unwrap_or("").to_owned())
}

/// The version in `tailscale version` output: the first `\d+\.\d+\.\d+` of its first line.
pub fn version(stdout: &str) -> Option<&str> {
    let line = stdout.split('\n').next()?;
    let bytes = line.as_bytes();
    let digits = |from: usize| {
        let run = bytes[from..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        (run > 0).then_some(from + run)
    };
    let dotted = |from: usize| (bytes.get(from) == Some(&b'.')).then(|| digits(from + 1))?;
    (0..bytes.len()).find_map(|from| {
        let end = dotted(dotted(digits(from)?)?)?;
        Some(&line[from..end])
    })
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::super::tests::captured;
    use super::*;

    #[derive(Deserialize)]
    struct Said {
        stderr: String,
        stdout: String,
    }

    #[test]
    fn reads_what_a_command_printed_as_the_typescript_did() {
        let lines: Vec<(Said, Option<String>)> = captured("lines");
        for (said, expected) in lines {
            assert_eq!(
                first_line(&said.stderr, &said.stdout),
                expected.as_deref(),
                "{:?}",
                said.stderr
            );
        }
        let links: Vec<(String, Option<String>)> = captured("links");
        assert!(links.len() > 15);
        for (text, expected) in links {
            assert_eq!(login_url(&text), expected.as_deref(), "{text:?}");
        }
        let ups: Vec<(String, Option<String>)> = captured("ups");
        assert!(ups.len() > 10);
        for (text, expected) in ups {
            assert_eq!(auth_url(&text), expected, "{text:?}");
        }
        let prefs: Vec<(String, Option<String>)> = captured("prefs");
        assert!(prefs.len() > 15);
        for (text, expected) in prefs {
            assert_eq!(control_host(&text), expected, "{text:?}");
        }
    }

    /// `/\d+\.\d+\.\d+/.exec(stdout.split(/\r?\n/)[0])`, as setup's detection read it.
    #[test]
    fn finds_the_version_in_the_first_line() {
        for (text, expected) in [
            ("1.104.1\n  tailscale commit: fake\n", Some("1.104.1")),
            ("1.104.1-t123\r\n", Some("1.104.1")),
            ("tailscale 12.3 then 1.2.34.5", Some("1.2.34")),
            ("v0.0.0", Some("0.0.0")),
            ("1.2\n3.4.5\n", None),
            ("1..2.3", None),
            ("", None),
        ] {
            assert_eq!(version(text), expected, "{text:?}");
        }
    }
}
