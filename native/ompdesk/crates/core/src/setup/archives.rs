//! Release lookup for the archives machine setup downloads itself (was `src/main/setup/archives.ts`): the current
//! Node.js LTS and GitHub CLI releases (`archive`, macOS without Homebrew), the newest agent-desktop release
//! (`agent-desktop-archive`, macOS and Windows) and Tailscale's current stable package, each with the SHA-256 its
//! publisher lists next to the download (Node's `SHASUMS256.txt`, gh's and agent-desktop's `checksums.txt`,
//! Tailscale's `<file>.sha256`).
//!
//! Every lookup is a sequence of text pages the publisher serves; `Pages` is how a page is read, so the sequence's
//! rules (which pages, in which order, what a missing or odd answer means) run in tests without a socket. The
//! patterns the TypeScript spelled as regular expressions are written by hand with JavaScript's meaning of `\d`,
//! `\s`, `\S`, `\b` and `$` (ASCII digits, `fs::order::is_js_space`, end of text only).

use serde::Serialize;
use serde_json::Value;

use crate::fs::order::{is_js_space, js_trim};

/// How a page is read: its text, or the reason it could not be (`<url> answered 404`).
pub trait Pages {
    fn text(&self, url: &str) -> impl Future<Output = Result<String, String>> + Send;
}

/// What an archive install downloads, as `plans.ts`' `ArchiveRelease`.
#[derive(Debug, Serialize, PartialEq)]
pub struct ArchiveRelease {
    pub item: &'static str,
    pub version: String,
    pub file: String,
    pub url: String,
    pub sha256: String,
}

/// What a Tailscale install downloads, as `plans.ts`' `TailscaleRelease`.
#[derive(Debug, Serialize, PartialEq)]
pub struct TailscaleRelease {
    pub version: String,
    pub file: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Win32,
}

impl Platform {
    fn name(self) -> &'static str {
        match self {
            Platform::Darwin => "darwin",
            Platform::Win32 => "win32",
        }
    }
}

/// `/^v?\d+\.\d+\.\d+$/`.
fn is_version(text: &str) -> bool {
    let digits = text.strip_prefix('v').unwrap_or(text);
    let mut parts = digits.split('.');
    let mut count = 0;
    for part in parts.by_ref() {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        count += 1;
    }
    count == 3
}

/// REA's engines range (`reaNodeSupported`, `src/shared/builtin-mcp.ts`, which stays the one spelling main's own
/// checks use; `archives.test.ts` holds the two to the same answers). `version` is already `is_version`.
fn rea_node_supported(version: &str) -> bool {
    let number = |part: &str| part.parse::<u64>().unwrap_or(u64::MAX);
    let mut parts = version.trim_start_matches('v').split('.');
    let major = number(parts.next().unwrap_or_default());
    let minor = number(parts.next().unwrap_or_default());
    major >= 26 || (major == 22 && minor >= 19) || (major == 24 && minor >= 11)
}

/// JavaScript's truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The newest LTS in nodejs.org's `dist/index.json` that REA's engines accept, e.g. `v24.11.0`.
pub fn pick_node_lts(index: &Value) -> Option<String> {
    let Value::Array(entries) = index else {
        return None;
    };
    entries.iter().find_map(|entry| {
        let Value::Object(entry) = entry else {
            return None;
        };
        let version = entry.get("version")?.as_str()?;
        let lts = entry.get("lts")?;
        (is_version(version) && truthy(lts) && rea_node_supported(version))
            .then(|| version.to_owned())
    })
}

/// The SHA-256 for `file` in a `sha256sum`-format listing (`<hash>  <file>`), or none.
pub fn parse_shasums(listing: &str, file: &str) -> Option<String> {
    listing.split('\n').find_map(|line| {
        let line = js_trim(line.strip_suffix('\r').unwrap_or(line));
        // `^([0-9a-fA-F]{64})\s+\*?(\S+)$`
        let hash = line.get(..64)?;
        if !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let rest = &line[64..];
        let after = rest.trim_start_matches(is_js_space);
        if after.len() == rest.len() {
            return None;
        }
        // A `*` that is the whole name is the name: `\*?` gives it back when `\S+` would have nothing.
        let name = match after.strip_prefix('*') {
            Some(name) if !name.is_empty() => name,
            _ => after,
        };
        (!name.is_empty() && !name.contains(is_js_space) && name == file)
            .then(|| hash.to_ascii_lowercase())
    })
}

pub fn node_archive_file(version: &str, arch: &str) -> String {
    let arch = if arch == "arm64" { "arm64" } else { "x64" };
    format!("node-{version}-darwin-{arch}.tar.gz")
}

pub fn gh_archive_file(version: &str, arch: &str) -> String {
    let arch = if arch == "arm64" { "arm64" } else { "amd64" };
    let version = version.strip_prefix('v').unwrap_or(version);
    format!("gh_{version}_macOS_{arch}.zip")
}

fn checked(
    item: &'static str,
    version: String,
    file: String,
    url: String,
    sha: Option<String>,
) -> Result<ArchiveRelease, String> {
    match sha {
        Some(sha)
            if sha.len() == 64
                && sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Ok(ArchiveRelease {
                item,
                version,
                file,
                url,
                sha256: sha,
            })
        }
        _ => Err(format!("No published SHA-256 for {file}")),
    }
}

fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|error| error.to_string())
}

/// A GitHub `releases/latest` answer's tag when it is a plain version, else none.
fn release_tag(latest: &Value) -> Option<&str> {
    latest
        .get("tag_name")?
        .as_str()
        .filter(|tag| is_version(tag))
}

/// Looks up the release an `archive` install of `item` (`gh` or `node`) downloads.
pub async fn resolve_archive(
    pages: &impl Pages,
    item: &str,
    arch: &str,
) -> Result<ArchiveRelease, String> {
    if item == "node" {
        let index = parse(&pages.text("https://nodejs.org/dist/index.json").await?)?;
        let version = pick_node_lts(&index)
            .ok_or_else(|| "nodejs.org lists no supported LTS release".to_owned())?;
        let file = node_archive_file(&version, arch);
        let base = format!("https://nodejs.org/dist/{version}");
        let sums = pages.text(&format!("{base}/SHASUMS256.txt")).await?;
        let sha = parse_shasums(&sums, &file);
        let url = format!("{base}/{file}");
        return checked("node", version, file, url, sha);
    }
    let latest = parse(
        &pages
            .text("https://api.github.com/repos/cli/cli/releases/latest")
            .await?,
    )?;
    let tag =
        release_tag(&latest).ok_or_else(|| "GitHub lists no GitHub CLI release".to_owned())?;
    let version = tag.strip_prefix('v').unwrap_or(tag).to_owned();
    let file = gh_archive_file(&version, arch);
    let base = format!("https://github.com/cli/cli/releases/download/v{version}");
    let sums = pages
        .text(&format!("{base}/gh_{version}_checksums.txt"))
        .await?;
    let sha = parse_shasums(&sums, &file);
    let url = format!("{base}/{file}");
    checked("gh", version, file, url, sha)
}

const AGENT_DESKTOP_REPO: &str = "vercel-labs/agent-desktop";

/// The Rust target of agent-desktop's release archive for this machine; an error for one it ships none for.
fn agent_desktop_target(platform: Platform, arch: &str) -> Result<String, String> {
    let cpu = match arch {
        "arm64" => "aarch64",
        "x64" => "x86_64",
        _ => {
            return Err(format!(
                "agent-desktop has no release for {} {arch}",
                platform.name()
            ));
        }
    };
    Ok(match platform {
        Platform::Darwin => format!("{cpu}-apple-darwin"),
        Platform::Win32 => format!("{cpu}-pc-windows-msvc"),
    })
}

/// The newest stable agent-desktop release (GitHub's `releases/latest`: never a draft or pre-release) for this
/// machine, with the SHA-256 its `checksums.txt` lists. An unsupported architecture is refused before any request.
pub async fn resolve_agent_desktop(
    pages: &impl Pages,
    platform: Platform,
    arch: &str,
) -> Result<ArchiveRelease, String> {
    let target = agent_desktop_target(platform, arch)?;
    let latest = parse(
        &pages
            .text(&format!(
                "https://api.github.com/repos/{AGENT_DESKTOP_REPO}/releases/latest"
            ))
            .await?,
    )?;
    let tag =
        release_tag(&latest).ok_or_else(|| "GitHub lists no agent-desktop release".to_owned())?;
    let version = tag.strip_prefix('v').unwrap_or(tag).to_owned();
    let file = format!("agent-desktop-v{version}-{target}.tar.gz");
    let base = format!("https://github.com/{AGENT_DESKTOP_REPO}/releases/download/v{version}");
    let sums = pages.text(&format!("{base}/checksums.txt")).await?;
    let sha = parse_shasums(&sums, &file);
    let url = format!("{base}/{file}");
    checked("agent-desktop", version, file, url, sha)
}

const TAILSCALE_BASE: &str = "https://pkgs.tailscale.com/stable";

/// `/^[A-Za-z0-9][A-Za-z0-9._-]*\.(zip|msi)$/`: a plain file name of the index, no path, no query.
fn is_package_file(name: &str) -> bool {
    let plain = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-');
    let bytes = name.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.iter().copied().all(plain)
        && (name.ends_with(".zip") || name.ends_with(".msi"))
}

/// The first `/\b[0-9a-fA-F]{64}\b/` of `text`, lowercased: a run of word characters that is exactly 64 hex digits.
fn sha256_token(text: &str) -> Option<String> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.split(|c: char| !word(c))
        .find(|run| run.len() == 64 && run.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
}

fn member<'a>(table: &'a Value, key: &str) -> Option<&'a Value> {
    table.as_object()?.get(key)
}

fn index_string<'a>(table: &'a Value, key: &str) -> Option<&'a str> {
    member(table, key)?.as_str()
}

/// Tailscale's current stable package for `platform` from the official index (`?mode=json`): the macOS zip, or the
/// MSI named for `msi_arch` (`amd64`, `arm64`, `x86`), with the SHA-256 Tailscale publishes as `<file>.sha256`. The
/// index only names files; the host is always pkgs.tailscale.com.
pub async fn resolve_tailscale(
    pages: &impl Pages,
    platform: Platform,
    msi_arch: Option<&str>,
) -> Result<TailscaleRelease, String> {
    let index = parse(&pages.text(&format!("{TAILSCALE_BASE}/?mode=json")).await?)?;
    let mac = platform == Platform::Darwin;
    if !mac && msi_arch.is_none() {
        return Err("Tailscale publishes no installer for this processor".to_owned());
    }
    let file = if mac {
        member(&index, "MacZips").and_then(|zips| index_string(zips, "universal"))
    } else {
        member(&index, "MSIs").and_then(|msis| index_string(msis, msi_arch.unwrap_or_default()))
    };
    let version = index_string(&index, if mac { "MacZipsVersion" } else { "MSIsVersion" })
        .or_else(|| index_string(&index, "Version"));
    let (Some(file), Some(version)) = (file, version) else {
        return Err("pkgs.tailscale.com lists no installer for this machine".to_owned());
    };
    if !is_package_file(file) || !is_version(version) {
        return Err("pkgs.tailscale.com lists no installer for this machine".to_owned());
    }
    let url = format!("{TAILSCALE_BASE}/{file}");
    let sha = sha256_token(&pages.text(&format!("{url}.sha256")).await?)
        .ok_or_else(|| format!("No published SHA-256 for {file}"))?;
    Ok(TailscaleRelease {
        version: version.to_owned(),
        file: file.to_owned(),
        url,
        sha256: sha,
    })
}
