//! The rules of OMPdesk's own ssh runs (were `src/main/ssh/options.ts` and the checks of `service.ts`): what a saved
//! host may be and the arguments it becomes, the config every run reads, the listening ports in a server's listing,
//! what an askpass question asks for, why an ssh ended, and the names its host keys are saved under. No I/O here.
//!
//! Nothing the page sent can become an option. The guards, each kept from the TypeScript and pinned by
//! `hostile_targets_never_become_options`:
//! 1. a host is 1 to 255 UTF-16 units and never starts with `-`;
//! 2. a user is at most 100 units and never starts with `-`;
//! 3. a key path is at most 1 000 units and never starts with `-`;
//! 4. a port (the host's, a forward's local and remote one) is a whole number from 1 to 65535, so it is spelled in
//!    digits;
//! 5. a user, a port and a key path are each the value of their own flag (`-l`, `-p`, `-i`), one argument each;
//! 6. the host comes last, after `--`, where ssh reads no option;
//! 7. no argument passes a shell: the process is started with its argument list.
//!
//! Added with the port: a path written into the config may hold no `"` and no line break (`config_text`), which would
//! end its quoted value; and the remote loop's sleep is a number by its type.

use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};

use crate::fs::order::{is_js_space, js_trim};
use crate::git::parse::js_number;
use crate::server::Fault;

/// What ends a line for a JavaScript regular expression (`.` and `$` with the `m` flag).
const LINE_ENDS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];
/// What a server's port listing ends with (`WATCH_MARKER`).
pub const LISTING_END: &str = "__ompdesk_ports__";
/// Shorter answers are not replaced in a message: `***` in place of every `a` would mangle the text and spell the
/// answer out by where it stands.
const SHORTEST_SECRET: usize = 4;

/// What the page sent is no saved host, port or answer. The text is fixed: it never repeats a value.
pub fn refused(what: &'static str) -> Fault {
    Fault::new("invalid_request", what)
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A value that must be there when its key is: `null` is refused, as the TypeScript's schema refused it.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// A saved host as the page sent it (`SshTarget`). Unchecked: only `destination` makes arguments of it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    name: String,
    host: String,
    #[serde(default, deserialize_with = "present")]
    username: Option<String>,
    #[serde(default, deserialize_with = "present")]
    port: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    key_path: Option<String>,
}

/// A port the page sent: a whole number from 1 to 65535.
pub fn port(value: f64) -> Result<u16, Fault> {
    if value.fract() == 0.0 && (1.0..=65535.0).contains(&value) {
        Ok(value as u16)
    } else {
        Err(refused("Invalid port"))
    }
}

/// A saved host that passed every guard.
pub struct Destination {
    /// The host's alias in Settings: what a question is asked on behalf of.
    pub name: String,
    host: String,
    username: Option<String>,
    port: Option<u16>,
    key_path: Option<String>,
}

impl Target {
    pub fn destination(self) -> Result<Destination, Fault> {
        if !(1..=200).contains(&units(&self.name)) {
            return Err(refused("Invalid name"));
        }
        if !(1..=255).contains(&units(&self.host)) || self.host.starts_with('-') {
            return Err(refused("Invalid host"));
        }
        if let Some(user) = &self.username
            && (units(user) > 100 || user.starts_with('-'))
        {
            return Err(refused("Invalid user"));
        }
        if let Some(key) = &self.key_path
            && (units(key) > 1000 || key.starts_with('-'))
        {
            return Err(refused("Invalid key path"));
        }
        Ok(Destination {
            name: self.name,
            host: self.host,
            username: self.username,
            port: self.port.map(port).transpose()?,
            key_path: self.key_path,
        })
    }
}

impl Destination {
    /// The destination arguments (`targetArgs`): each value behind its own flag, the host last, after `--`.
    pub fn args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = self.port {
            args.extend(["-p".to_owned(), port.to_string()]);
        }
        if let Some(user) = self.username.as_deref().filter(|user| !user.is_empty()) {
            args.extend(["-l".to_owned(), user.to_owned()]);
        }
        if let Some(key) = self.key_path.as_deref().filter(|key| !key.is_empty()) {
            args.extend(["-i".to_owned(), key.to_owned()]);
        }
        args.extend(["--".to_owned(), self.host.clone()]);
        args
    }

    /// `ssh -N -L`: this computer's `local` port to the server's `remote` one, both on loopback.
    pub fn forward_args(&self, local: u16, remote: u16) -> Vec<String> {
        let mut args: Vec<String> = ["-N", "-o", "ExitOnForwardFailure=yes", "-L"]
            .map(String::from)
            .to_vec();
        args.push(format!("127.0.0.1:{local}:127.0.0.1:{remote}"));
        args.extend(self.args());
        args
    }

    /// The server's listening ports, listed again every `poll_seconds` and each listing closed by `LISTING_END`.
    pub fn watch_args(&self, poll_seconds: u32) -> Vec<String> {
        let listing = "(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null)";
        let mut args = self.args();
        args.extend([
            "sh".to_owned(),
            "-c".to_owned(),
            format!("'while :; do {listing}; echo {LISTING_END}; sleep {poll_seconds}; done'"),
        ]);
        args
    }

    /// `ssh -G`: what ssh would use for this host, without connecting.
    pub fn resolve_args(&self) -> Vec<String> {
        let mut args = vec!["-G".to_owned()];
        args.extend(self.args());
        args
    }

    /// The host as the page named it: what its key is saved under when `ssh -G` names no other.
    pub fn host(&self) -> &str {
        &self.host
    }
}

/// The config every run reads with `-F`: its first `Host *` block pins OMPdesk's own known_hosts with
/// `StrictHostKeyChecking ask` and no connection sharing, then the person's own config is included. OpenSSH keeps the
/// first value it reads, so that file cannot loosen these, and hands `-F` to the ssh of every ProxyJump hop.
pub fn config_text(known_hosts: &str, user_config: &str) -> Result<String, Fault> {
    // ssh_config reads a backslash as an escape, so a Windows path is written with forward slashes.
    let quote = |path: &str| {
        if path.contains(['"', '\n', '\r']) {
            return Err(Fault::new(
                "invalid_path",
                "A folder with a quote or a line break in its name cannot be written into ssh's config",
            ));
        }
        Ok(format!("\"{}\"", path.replace('\\', "/")))
    };
    let known_hosts = quote(known_hosts)?;
    Ok([
        "# Written by OMPdesk for its own port forwards; edits are overwritten.",
        "Host *",
        &format!("  UserKnownHostsFile {known_hosts}"),
        &format!("  GlobalKnownHostsFile {known_hosts}"),
        "  StrictHostKeyChecking ask",
        "  UpdateHostKeys no",
        "  ControlMaster no",
        "  ControlPath none",
        "  ServerAliveInterval 15",
        "  ServerAliveCountMax 3",
        "  ConnectTimeout 15",
        "  NumberOfPasswordPrompts 3",
        &format!("Include {}", quote(user_config)?),
        "",
    ]
    .join("\n"))
}

/// Where `needle` (lowercase ASCII) stands in `text`, letters compared without case as a JavaScript `/i` pattern
/// without the `u` flag compares them: ASCII only.
fn find_ci(text: &str, needle: &str) -> Option<usize> {
    let needle = needle.as_bytes();
    text.as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

fn has_ci(text: &str, needle: &str) -> bool {
    find_ci(text, needle).is_some()
}

/// `/first.*last/i`: `last` after `first` on the same line.
fn spans_ci(text: &str, first: &str, last: &str) -> bool {
    let mut from = 0;
    while let Some(at) = find_ci(&text[from..], first) {
        let rest = &text[from + at + first.len()..];
        let line = rest.split(LINE_ENDS).next().unwrap_or("");
        if has_ci(line, last) {
            return true;
        }
        from += at + 1;
    }
    false
}

/// `\w`.
fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// A line of column titles (`/^(Proto|Active|COMMAND|State|Netid)\b/i`).
fn is_heading(line: &str) -> bool {
    ["proto", "active", "command", "state", "netid"]
        .iter()
        .any(|word| {
            let bytes = line.as_bytes();
            bytes.len() >= word.len()
                && bytes[..word.len()].eq_ignore_ascii_case(word.as_bytes())
                && bytes.get(word.len()).is_none_or(|next| !is_word(*next))
        })
}

/// The port a listing's address column names (`/^(?:\[[^\]]*\]|[\w.*%-]*)[:.](\d{1,5})$/`): `127.0.0.1:631`,
/// `[::]:3000`, `*.5000`.
fn address_port(token: &str) -> Option<u32> {
    let bytes = token.as_bytes();
    (1..=5.min(bytes.len().saturating_sub(1))).find_map(|digits| {
        let (head, port) = bytes.split_at(bytes.len() - digits);
        let (separator, address) = head.split_last()?;
        let bracketed = address.len() >= 2
            && address[0] == b'['
            && address[address.len() - 1] == b']'
            && !address[1..address.len() - 1].contains(&b']');
        let plain = address
            .iter()
            .all(|byte| is_word(*byte) || b".*%-".contains(byte));
        (port.iter().all(u8::is_ascii_digit)
            && matches!(separator, b':' | b'.')
            && (bracketed || plain))
            .then(|| {
                port.iter()
                    .fold(0, |value, digit| value * 10 + u32::from(digit - b'0'))
            })
    })
}

/// The listening TCP ports in one `ss -ltnH` / `netstat -ltn` / `lsof -iTCP -sTCP:LISTEN` listing, ascending: each
/// line's first column that reads as an address with a port.
pub fn listening_ports(listing: &str) -> Vec<u16> {
    let mut ports = BTreeSet::new();
    for line in listing.split('\n') {
        let line = js_trim(line);
        if line.is_empty() || is_heading(line) {
            continue;
        }
        let named = line
            .split(is_js_space)
            .filter(|token| !token.is_empty())
            .find_map(address_port);
        if let Some(port) = named.and_then(|port| u16::try_from(port).ok())
            && port > 0
        {
            ports.insert(port);
        }
    }
    ports.into_iter().collect()
}

/// What one askpass question asks for (`SshPrompt`'s `kind`, `fingerprint`, `host`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Asked {
    pub kind: &'static str,
    pub fingerprint: Option<String>,
    pub host: Option<String>,
}

/// The kind of a question whose answer says yes or no to a host key: it is no secret.
pub const HOST_KEY: &str = "hostKey";

/// `/\b(SHA256:[A-Za-z0-9+/=]+|MD5(?::[0-9a-f]{2})+)/`.
fn fingerprint(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    (0..bytes.len()).find_map(|at| {
        if at > 0 && is_word(bytes[at - 1]) {
            return None;
        }
        let rest = &bytes[at..];
        if rest.starts_with(b"SHA256:") {
            let digest = rest[7..]
                .iter()
                .take_while(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(byte))
                .count();
            return (digest > 0).then(|| &text[at..at + 7 + digest]);
        }
        if rest.starts_with(b"MD5") {
            let hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
            let mut end = 3;
            while rest.len() >= end + 3
                && rest[end] == b':'
                && hex(rest[end + 1])
                && hex(rest[end + 2])
            {
                end += 3;
            }
            return (end > 3).then(|| &text[at..at + end]);
        }
        None
    })
}

/// `/authenticity of host '([^']+)'/i`.
fn asked_host(text: &str) -> Option<&str> {
    const LEAD: &str = "authenticity of host '";
    let mut from = 0;
    while let Some(at) = find_ci(&text[from..], LEAD) {
        let start = from + at + LEAD.len();
        if let Some(length) = text[start..].find('\'')
            && length > 0
        {
            return Some(&text[start..start + length]);
        }
        from += at + 1;
    }
    None
}

pub fn classify_prompt(text: &str) -> Asked {
    if has_ci(text, "authenticity of host") || has_ci(text, "continue connecting") {
        return Asked {
            kind: HOST_KEY,
            fingerprint: fingerprint(text).map(str::to_owned),
            host: asked_host(text).map(str::to_owned),
        };
    }
    let code = [
        "verification code",
        "one-time",
        "otp",
        "token",
        "authenticator",
    ];
    let kind = if has_ci(text, "passphrase") {
        "passphrase"
    } else if code.iter().any(|word| has_ci(text, word)) {
        "code"
    } else if has_ci(text, "password") {
        "password"
    } else {
        "other"
    };
    Asked {
        kind,
        fingerprint: None,
        host: None,
    }
}

/// Why an ssh ended, from its stderr: trying again cannot help with a changed key (`hostKeyChanged`) or a refused
/// login or port (`refused`); anything else is a dropped connection (`dropped`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Failure {
    pub kind: &'static str,
    pub message: String,
}

pub fn classify_failure(stderr: &str) -> Failure {
    // `/^debug\d?:/`.
    let debug = |line: &str| {
        line.strip_prefix("debug").is_some_and(|rest| {
            rest.strip_prefix(|c: char| c.is_ascii_digit())
                .unwrap_or(rest)
                .starts_with(':')
        })
    };
    let lines: Vec<&str> = stderr
        .split('\n')
        .map(js_trim)
        .filter(|line| !line.is_empty() && !line.starts_with('@') && !debug(line))
        .collect();
    let message = lines.last().copied().unwrap_or("ssh exited");
    if has_ci(stderr, "remote host identification has changed")
        || spans_ci(stderr, "host key for ", " has changed")
    {
        let named = lines.iter().find(|line| has_ci(line, "fingerprint"));
        return Failure {
            kind: "hostKeyChanged",
            message: (*named.unwrap_or(&message)).to_owned(),
        };
    }
    let refused = [
        "permission denied",
        "host key verification failed",
        "too many authentication failures",
        "cannot listen to port",
    ];
    let kind = if refused.iter().any(|words| has_ci(stderr, words))
        || spans_ci(stderr, "bind", "address already in use")
    {
        "refused"
    } else {
        "dropped"
    };
    Failure {
        kind,
        message: message.to_owned(),
    }
}

/// `text` with every answer a process was given replaced by `***`: what ssh printed never carries one into a message.
pub fn scrub(mut text: String, secrets: &[String]) -> String {
    for secret in secrets {
        if text.contains(secret.as_str()) {
            text = text.replace(secret.as_str(), "***");
        }
    }
    text
}

/// Whether an answer is replaced in messages (`scrub`).
pub fn is_secret(answer: &str) -> bool {
    answer.chars().count() >= SHORTEST_SECRET
}

/// JavaScript's `Number(text)`.
fn js_to_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, radix: u32| {
        if digits.is_empty() {
            return f64::NAN;
        }
        digits
            .chars()
            .try_fold(0.0, |value, digit| {
                digit
                    .to_digit(radix)
                    .map(|digit| value * f64::from(radix) + f64::from(digit))
            })
            .unwrap_or(f64::NAN)
    };
    for (prefix, base) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return radix(digits, base);
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // A decimal literal: digits with an optional point, or a point and digits, then an optional exponent.
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (unsigned, None),
    };
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mantissa_ok =
        digits(whole) && digits(fraction) && !(whole.is_empty() && fraction.is_empty());
    let exponent_ok = exponent.is_none_or(|exponent| {
        let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !exponent.is_empty() && digits(exponent)
    });
    if !mantissa_ok || !exponent_ok {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// `String(number)`.
fn js_spelled(value: f64) -> String {
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    js_number(value)
}

/// The value of `key` in `ssh -G`'s output (`/^key (.+)$/m`, trimmed).
fn resolved_value<'a>(resolved: &'a str, key: &str) -> Option<&'a str> {
    resolved.split(LINE_ENDS).find_map(|line| {
        let value = line.strip_prefix(key)?.strip_prefix(' ')?;
        (!value.is_empty()).then(|| js_trim(value))
    })
}

/// The names ssh saves host keys under for a host: its own `hostname` and every ProxyJump hop's, `[name]:port` when
/// the port is not 22 (`knownHostNames` and `#forgetHostKey`). `resolved` is `ssh -G`'s output; `host` is the host as
/// the page named it, used when that output names none.
pub fn known_host_names(resolved: &str, host: &str) -> Vec<String> {
    let first = resolved_value(resolved, "hostname").unwrap_or(host);
    let port = resolved_value(resolved, "port").map_or(22.0, js_to_number);
    let port = if port == 0.0 || port.is_nan() {
        22.0
    } else {
        port
    };
    let jumps = resolved_value(resolved, "proxyjump")
        .filter(|jump| !jump.is_empty() && *jump != "none")
        .into_iter()
        .flat_map(|jump| jump.split(','))
        .map(|hop| {
            let hop = js_trim(hop);
            let hop = hop.strip_prefix("ssh://").unwrap_or(hop);
            hop.split_once('@').map_or(hop, |(_, host)| host)
        });
    std::iter::once(first)
        .chain(jumps)
        .map(|entry| {
            let (name, hop_port) = if entry.contains(':') && !entry.starts_with('[') {
                let mut parts = entry.split(':');
                (parts.next().unwrap_or(entry), parts.next())
            } else {
                (entry, None)
            };
            let effective = if entry == first {
                port
            } else {
                hop_port.map_or(22.0, js_to_number)
            };
            if effective == 22.0 {
                name.to_owned()
            } else {
                format!("[{name}]:{}", js_spelled(effective))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// Rows captured from the TypeScript before it was deleted (`options.ts`'s functions, `service.ts`'s schema and
    /// its `#forgetHostKey`), on Windows.
    fn captured(table: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        all[table].as_array().unwrap().clone()
    }

    fn text(row: &Value) -> &str {
        row["text"].as_str().unwrap()
    }

    #[test]
    fn reads_listening_ports_as_the_typescript_did() {
        let rows = captured("listening");
        assert_eq!(rows.len(), 50);
        for row in rows {
            let ports: Vec<u64> = listening_ports(text(&row))
                .into_iter()
                .map(u64::from)
                .collect();
            let expected: Vec<u64> = row["ports"]
                .as_array()
                .unwrap()
                .iter()
                .map(|port| port.as_u64().unwrap())
                .collect();
            assert_eq!(ports, expected, "{:?}", text(&row));
        }
    }

    #[test]
    fn tells_questions_apart_as_the_typescript_did() {
        let rows = captured("prompts");
        assert_eq!(rows.len(), 32);
        for row in rows {
            let asked = serde_json::to_value(classify_prompt(text(&row))).unwrap();
            for key in ["kind", "fingerprint", "host"] {
                assert_eq!(asked[key], row[key], "{key} of {:?}", text(&row));
            }
        }
    }

    #[test]
    fn reads_why_an_ssh_ended_as_the_typescript_did() {
        let rows = captured("failures");
        assert_eq!(rows.len(), 32);
        for row in rows {
            let failure = serde_json::to_value(classify_failure(text(&row))).unwrap();
            for key in ["kind", "message"] {
                assert_eq!(failure[key], row[key], "{key} of {:?}", text(&row));
            }
        }
    }

    #[test]
    fn names_saved_host_keys_as_the_typescript_did() {
        let rows = captured("resolved");
        assert_eq!(rows.len(), 54);
        for row in rows {
            let names = known_host_names(text(&row), row["host"].as_str().unwrap());
            let expected: Vec<&str> = row["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect();
            assert_eq!(names, expected, "{:?}", text(&row));
        }
    }

    #[test]
    fn checks_hosts_and_ports_and_builds_arguments_as_the_typescript_did() {
        let rows = captured("targets");
        assert_eq!(rows.len(), 52);
        for row in rows {
            let args = serde_json::from_value::<Target>(row["target"].clone())
                .ok()
                .and_then(|target| target.destination().ok())
                .map(|destination| destination.args());
            let expected: Option<Vec<String>> =
                serde_json::from_value(row["args"].clone()).unwrap();
            assert_eq!(args, expected, "{}", row["target"]);
        }
        for row in captured("ports") {
            let ok = row["port"]
                .as_f64()
                .is_some_and(|value| port(value).is_ok());
            assert_eq!(ok, row["ok"].as_bool().unwrap(), "{}", row["port"]);
        }
    }

    #[test]
    fn writes_the_config_the_typescript_wrote() {
        // A root with backslashes, as the capture's was: the config spells it with forward slashes.
        let rows = captured("configs");
        assert_eq!(rows.len(), 3);
        for row in rows {
            let path = |key: &str| {
                row[key]
                    .as_str()
                    .unwrap()
                    .replace("<root>", "C:\\tmp\\root")
            };
            let config = config_text(&path("knownHosts"), &path("userConfig")).unwrap();
            assert_eq!(config, text(&row).replace("<root>", "C:/tmp/root"));
            assert!(
                config.find("StrictHostKeyChecking ask").unwrap() < config.find("Include").unwrap()
            );
        }
    }

    fn target(json: Value) -> Result<Destination, Fault> {
        serde_json::from_value::<Target>(json)
            .map_err(|_| refused("Invalid SSH tools request"))?
            .destination()
    }

    /// Every argument list a destination becomes, with the values the page controls marked: none may stand where ssh
    /// reads an option.
    fn assert_no_option(destination: &Destination, shown: &str) {
        for args in [
            destination.args(),
            destination.forward_args(8080, 80),
            destination.watch_args(5),
            destination.resolve_args(),
        ] {
            let end = args.iter().position(|arg| arg == "--").unwrap();
            assert_eq!(args[end + 1], destination.host, "{shown}: {args:?}");
            // Before `--`: flags OMPdesk wrote, each value directly behind the flag that takes one.
            let mut before = args[..end].iter();
            while let Some(arg) = before.next() {
                match arg.as_str() {
                    "-N" | "-G" => {}
                    "-o" => assert_eq!(before.next().unwrap(), "ExitOnForwardFailure=yes"),
                    "-L" => assert_eq!(before.next().unwrap(), "127.0.0.1:8080:127.0.0.1:80"),
                    "-p" | "-l" | "-i" => assert!(before.next().is_some()),
                    other => panic!("{shown}: {other:?} stands where ssh reads an option"),
                }
            }
            // After the host: nothing, or the fixed remote command.
            let after = &args[end + 2..];
            assert!(
                after.is_empty() || (after.len() == 3 && after[0] == "sh" && after[1] == "-c"),
                "{shown}: {args:?}"
            );
        }
    }

    #[test]
    fn hostile_targets_never_become_options() {
        use serde_json::json;
        let refused_targets = [
            (
                json!({"name": "box", "host": "-oProxyCommand=touch /tmp/pwned"}),
                "Invalid host",
            ),
            (
                json!({"name": "box", "host": "-F/etc/passwd"}),
                "Invalid host",
            ),
            (json!({"name": "box", "host": "--"}), "Invalid host"),
            (json!({"name": "box", "host": "-"}), "Invalid host"),
            (json!({"name": "box", "host": ""}), "Invalid host"),
            (
                json!({"name": "box", "host": "h".repeat(256)}),
                "Invalid host",
            ),
            (json!({"name": "", "host": "h"}), "Invalid name"),
            (
                json!({"name": "n".repeat(201), "host": "h"}),
                "Invalid name",
            ),
            (
                json!({"name": "box", "host": "h", "username": "-oProxyCommand=x"}),
                "Invalid user",
            ),
            (
                json!({"name": "box", "host": "h", "username": "-l"}),
                "Invalid user",
            ),
            (
                json!({"name": "box", "host": "h", "username": "u".repeat(101)}),
                "Invalid user",
            ),
            (
                json!({"name": "box", "host": "h", "keyPath": "-oIdentityAgent=/tmp/evil"}),
                "Invalid key path",
            ),
            (
                json!({"name": "box", "host": "h", "keyPath": "-i"}),
                "Invalid key path",
            ),
            (
                json!({"name": "box", "host": "h", "keyPath": "k".repeat(1001)}),
                "Invalid key path",
            ),
            (
                json!({"name": "box", "host": "h", "port": 0}),
                "Invalid port",
            ),
            (
                json!({"name": "box", "host": "h", "port": 65536}),
                "Invalid port",
            ),
            (
                json!({"name": "box", "host": "h", "port": 22.5}),
                "Invalid port",
            ),
            (
                json!({"name": "box", "host": "h", "port": -22}),
                "Invalid port",
            ),
            (
                json!({"name": "box", "host": "h", "port": "22 -oProxyCommand=x"}),
                "Invalid SSH tools request",
            ),
            (
                json!({"name": "box", "host": ["-oProxyCommand=x"]}),
                "Invalid SSH tools request",
            ),
            (
                json!({"name": "box", "host": "h", "username": null}),
                "Invalid SSH tools request",
            ),
        ];
        for (json, why) in refused_targets {
            let shown = json.to_string();
            let fault = target(json)
                .err()
                .unwrap_or_else(|| panic!("{shown} passed"));
            assert_eq!(fault.code, "invalid_request");
            assert_eq!(fault.message, why, "{shown}");
        }
        // What passes is one argument wherever it goes: no shell reads it, and it never leads an argument list.
        let passing = [
            json!({"name": "box", "host": "x -oProxyCommand=y"}),
            json!({"name": "box", "host": " -oProxyCommand=x"}),
            json!({"name": "box", "host": "a;rm -rf /"}),
            json!({"name": "box", "host": "$(id)`id`"}),
            json!({"name": "box", "host": "a\nb"}),
            json!({"name": "box", "host": "a' ; touch /tmp/pwned ; '"}),
            json!({"name": "box", "host": "\u{2212}oProxyCommand=x"}),
            json!({"name": "-n", "host": "h"}),
            json!({"name": "box", "host": "h", "username": "a -oProxyCommand=x", "port": 2222, "keyPath": "~/.ssh/id -oX=y"}),
            json!({"name": "box", "host": "h", "username": "", "keyPath": ""}),
        ];
        for json in passing {
            let shown = json.to_string();
            let destination = target(json).unwrap_or_else(|_| panic!("{shown} was refused"));
            assert_no_option(&destination, &shown);
        }
        let named = target(
            json!({"name": "box", "host": "h", "username": "me", "port": 2222, "keyPath": "/k"}),
        )
        .unwrap();
        assert_eq!(
            named.forward_args(8080, 80),
            [
                "-N",
                "-o",
                "ExitOnForwardFailure=yes",
                "-L",
                "127.0.0.1:8080:127.0.0.1:80",
                "-p",
                "2222",
                "-l",
                "me",
                "-i",
                "/k",
                "--",
                "h"
            ]
        );
        assert_eq!(
            named.watch_args(5)[8..],
            [
                "sh",
                "-c",
                "'while :; do (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null); echo __ompdesk_ports__; sleep 5; done'"
            ]
        );
        for value in [0.0, 65536.0, 1.5, -1.0, f64::NAN, f64::INFINITY, 1e21] {
            assert!(port(value).is_err(), "{value}");
        }
    }

    #[test]
    fn refuses_a_config_path_that_would_end_its_quoted_value() {
        for path in ["/home/a\"b", "/home/a\nInclude /tmp/evil", "/home/a\rb"] {
            assert_eq!(config_text(path, "/u").unwrap_err().code, "invalid_path");
            assert_eq!(config_text("/k", path).unwrap_err().code, "invalid_path");
        }
    }

    #[test]
    fn replaces_every_answer_a_process_was_given() {
        let secrets = ["hunter2".to_owned(), "correct horse".to_owned()];
        assert_eq!(
            scrub(
                "bad hunter2, correct horse hunter2\nPermission denied".into(),
                &secrets
            ),
            "bad ***, *** ***\nPermission denied"
        );
        assert_eq!(scrub("nothing".into(), &secrets), "nothing");
        assert!(is_secret("abcd") && is_secret("한글비밀") && !is_secret("yes") && !is_secret(""));
        // The message of a failure is read from the scrubbed text.
        let failure = classify_failure(&scrub(
            "me@box: Permission denied (hunter2).".into(),
            &secrets,
        ));
        assert_eq!(failure.message, "me@box: Permission denied (***).");
    }

    #[test]
    fn reads_numbers_as_javascript_does() {
        for (text, value) in [
            ("", 0.0),
            (" 22 ", 22.0),
            ("022", 22.0),
            ("0x16", 22.0),
            ("0b10110", 22.0),
            ("0o26", 22.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+23", 23.0),
            ("-0", 0.0),
        ] {
            assert_eq!(js_to_number(text), value, "{text:?}");
        }
        for text in [
            "abc", "1_0", "infinity", "nan", "1e", "0x", ".", "+", "e5", "--1", "0x1g", "1 2",
        ] {
            assert!(js_to_number(text).is_nan(), "{text:?}");
        }
        assert_eq!(js_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_spelled(f64::INFINITY), "Infinity");
        assert_eq!(js_spelled(f64::NAN), "NaN");
        assert_eq!(js_spelled(1e23), "1e+23");
    }
}
