//! The release side of the updater (was `src/main/update-release.ts`). A GitHub release carries exactly two downloads
//! (`ASSETS`); their version, size and SHA-512 ride in the release notes as one HTML comment GitHub does not render:
//!
//! `<!-- ompdesk-update {"version":"0.18.0","releaseDate":"…","files":{"mac":{…},"windows":{…}}} -->`
//!
//! `.github/workflows/release.yml` writes it; this module reads and checks it. Error codes are the TypeScript's;
//! a schema problem is worded here, not as zod's issue list (PROTOCOL.md §15.8).

use serde_json::{Map, Value, json};

/// The release is unusable for updates: comment missing, malformed, or contradicting the release.
pub const METADATA_ERROR: &str = "ERR_OMPDESK_UPDATE_METADATA";
/// The release is valid but ships nothing for this platform.
pub const PLATFORM_ERROR: &str = "ERR_OMPDESK_UPDATE_PLATFORM";
/// No release yet (electron-updater's code); a failed check reads it as "up to date".
pub const NO_RELEASE_ERROR: &str = "ERR_UPDATER_LATEST_VERSION_NOT_FOUND";
/// GitHub answered the release lookup with an unexpected status or payload.
pub const LOOKUP_ERROR: &str = "ERR_OMPDESK_RELEASE_LOOKUP";
/// The release's version is no semver (electron-updater's code).
pub const INVALID_VERSION_ERROR: &str = "ERR_UPDATER_INVALID_VERSION";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
}

impl Platform {
    pub fn key(self) -> &'static str {
        match self {
            Platform::Mac => "mac",
            Platform::Windows => "windows",
        }
    }

    /// The release asset: version-free, so `/releases/latest/download/<name>` stays stable.
    pub fn asset(self) -> &'static str {
        match self {
            Platform::Mac => "ompdesk-mac-arm64.dmg",
            Platform::Windows => "ompdesk-windows-setup.exe",
        }
    }

    /// The platform this shell is built for.
    pub fn current() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Mac
        }
    }
}

/// A coded failure, as the TypeScript's `ReleaseFeedError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedError {
    pub code: &'static str,
    pub message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> FeedError {
    FeedError {
        code,
        message: message.into(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateFile {
    pub name: String,
    pub size: u64,
    pub sha512: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Metadata {
    pub version: String,
    pub release_date: String,
    pub mac: Option<UpdateFile>,
    pub windows: Option<UpdateFile>,
}

impl Metadata {
    pub fn to_json(&self) -> Value {
        let mut files = Map::new();
        for (key, file) in [("mac", &self.mac), ("windows", &self.windows)] {
            if let Some(file) = file {
                files.insert(
                    key.into(),
                    json!({ "name": file.name, "size": file.size, "sha512": file.sha512 }),
                );
            }
        }
        json!({ "version": self.version, "releaseDate": self.release_date, "files": files })
    }
}

const OPEN: &str = "<!--";
const CLOSE: &str = "-->";
const TAG: &str = "ompdesk-update";

/// Every `<!--\s*ompdesk-update\s+(…)\s*-->` in `body`: the byte range of the whole comment and its trimmed inside.
fn comments(body: &str) -> Vec<(std::ops::Range<usize>, &str)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(start) = body[from..].find(OPEN).map(|i| i + from) {
        let after_open = start + OPEN.len();
        let rest = &body[after_open..];
        let lead = rest.len() - rest.trim_start().len();
        let tagged = rest[lead..].starts_with(TAG);
        let after_tag = after_open + lead + TAG.len();
        let gap = tagged
            .then(|| &body[after_tag..])
            .map(|tail| tail.len() - tail.trim_start().len());
        match gap {
            // `\s+` needs at least one space after the tag; the lazy body runs to the first `-->`.
            Some(gap) if gap > 0 => match body[after_tag..].find(CLOSE) {
                Some(close) => {
                    let end = after_tag + close;
                    found.push((start..end + CLOSE.len(), body[after_tag..end].trim()));
                    from = end + CLOSE.len();
                }
                None => break,
            },
            _ => from = after_open,
        }
    }
    found
}

fn semver_shape(text: &str) -> bool {
    // `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`
    let allowed = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    };
    let (rest, build) = match text.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (text, None),
    };
    if build.is_some_and(|b| !allowed(b)) {
        return false;
    }
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    if pre.is_some_and(|p| !allowed(p)) {
        return false;
    }
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn leap(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// zod 3's `z.string().datetime()`: `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, a real calendar date, no offset.
fn iso_datetime(text: &str) -> bool {
    let b = text.as_bytes();
    let digits = |r: std::ops::Range<usize>| {
        b.get(r.clone())
            .is_some_and(|s| s.iter().all(u8::is_ascii_digit))
    };
    let value = |r: std::ops::Range<usize>| text[r].parse::<u32>().unwrap_or(u32::MAX);
    if b.len() < 20
        || !digits(0..4)
        || b[4] != b'-'
        || !digits(5..7)
        || b[7] != b'-'
        || !digits(8..10)
    {
        return false;
    }
    if b[10] != b'T'
        || !digits(11..13)
        || b[13] != b':'
        || !digits(14..16)
        || b[16] != b':'
        || !digits(17..19)
    {
        return false;
    }
    let (year, month, day) = (value(0..4), value(5..7), value(8..10));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap(year) => 29,
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days || value(11..13) > 23 || value(14..16) > 59 || value(17..19) > 59 {
        return false;
    }
    match &text[19..] {
        "Z" => true,
        rest => rest
            .strip_prefix('.')
            .and_then(|r| r.strip_suffix('Z'))
            .is_some_and(|f| !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit())),
    }
}

/// 64 bytes in padded base64, as electron-updater and `openssl … | base64` write it.
fn sha512_shape(text: &str) -> bool {
    text.len() == 88
        && text.ends_with("==")
        && text[..86]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// zod's wording for one field: `path: message`.
struct Issues(Vec<String>);

impl Issues {
    fn add(&mut self, path: &str, message: impl Into<String>) {
        let path = if path.is_empty() { "(root)" } else { path };
        self.0.push(format!("{path}: {}", message.into()));
    }

    fn expected(&mut self, path: &str, want: &str, got: Option<&Value>) {
        match got {
            None => self.add(path, "Required"),
            Some(value) => self.add(path, format!("Expected {want}, received {}", kind(value))),
        }
    }

    fn text(&self) -> String {
        self.0.join("; ")
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn file(value: Option<&Value>, path: &str, name: &str, issues: &mut Issues) -> Option<UpdateFile> {
    let object = match value {
        None => return None,
        Some(Value::Object(o)) => o,
        other => {
            issues.expected(path, "object", other);
            return None;
        }
    };
    let before = issues.0.len();
    match object.get("name") {
        Some(Value::String(n)) if n == name => {}
        Some(Value::String(_)) => issues.add(
            &join(path, "name"),
            format!("Invalid literal value, expected \"{name}\""),
        ),
        other => issues.expected(&join(path, "name"), "string", other),
    }
    let size = match object.get("size") {
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.fract() != 0.0 {
                issues.add(&join(path, "size"), "Expected integer, received float");
                None
            } else if f <= 0.0 {
                issues.add(&join(path, "size"), "Number must be greater than 0");
                None
            } else {
                Some(f as u64)
            }
        }
        other => {
            issues.expected(&join(path, "size"), "number", other);
            None
        }
    };
    let sha512 = match object.get("sha512") {
        Some(Value::String(s)) if sha512_shape(s) => Some(s.clone()),
        Some(Value::String(_)) => {
            issues.add(
                &join(path, "sha512"),
                "sha512 must be a base64 SHA-512 digest",
            );
            None
        }
        other => {
            issues.expected(&join(path, "sha512"), "string", other);
            None
        }
    };
    if issues.0.len() != before {
        return None;
    }
    Some(UpdateFile {
        name: name.to_string(),
        size: size?,
        sha512: sha512?,
    })
}

/// The one metadata comment in `body`; `METADATA_ERROR` when it is missing, repeated or invalid.
pub fn parse_metadata(body: Option<&str>) -> Result<Metadata, FeedError> {
    let body = body.unwrap_or("");
    let found = comments(body);
    let inside = match found.as_slice() {
        [] => {
            return Err(fail(
                METADATA_ERROR,
                "The release notes carry no ompdesk-update metadata comment",
            ));
        }
        [(_, inside)] => *inside,
        _ => {
            return Err(fail(
                METADATA_ERROR,
                "The release notes carry more than one ompdesk-update comment",
            ));
        }
    };
    let json: Value = serde_json::from_str(inside).map_err(|e| {
        fail(
            METADATA_ERROR,
            format!("The ompdesk-update comment is not JSON: {e}"),
        )
    })?;
    let mut issues = Issues(Vec::new());
    let Value::Object(object) = &json else {
        issues.expected("", "object", Some(&json));
        return Err(fail(
            METADATA_ERROR,
            format!("The ompdesk-update comment is invalid: {}", issues.text()),
        ));
    };
    let version = match object.get("version") {
        Some(Value::String(v)) if semver_shape(v) => Some(v.clone()),
        Some(Value::String(_)) => {
            issues.add("version", "version must be semver");
            None
        }
        other => {
            issues.expected("version", "string", other);
            None
        }
    };
    let release_date = match object.get("releaseDate") {
        Some(Value::String(d)) if iso_datetime(d) => Some(d.clone()),
        Some(Value::String(_)) => {
            issues.add("releaseDate", "Invalid datetime");
            None
        }
        other => {
            issues.expected("releaseDate", "string", other);
            None
        }
    };
    let (mac, windows) = match object.get("files") {
        Some(Value::Object(files)) => (
            file(
                files.get("mac"),
                "files.mac",
                Platform::Mac.asset(),
                &mut issues,
            ),
            file(
                files.get("windows"),
                "files.windows",
                Platform::Windows.asset(),
                &mut issues,
            ),
        ),
        other => {
            issues.expected("files", "object", other);
            (None, None)
        }
    };
    if !issues.0.is_empty() {
        return Err(fail(
            METADATA_ERROR,
            format!("The ompdesk-update comment is invalid: {}", issues.text()),
        ));
    }
    Ok(Metadata {
        version: version.unwrap_or_default(),
        release_date: release_date.unwrap_or_default(),
        mac,
        windows,
    })
}

/// Release notes as people read them: every metadata comment removed, the rest trimmed.
pub fn strip_metadata(body: Option<&str>) -> String {
    let body = body.unwrap_or("");
    let mut out = String::with_capacity(body.len());
    let mut last = 0;
    for (range, _) in comments(body) {
        out.push_str(&body[last..range.start]);
        last = range.end;
    }
    out.push_str(&body[last..]);
    out.trim().to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Asset {
    /// GitHub's numbers as they came (`123`, not `123.0`, when written back).
    pub id: serde_json::Number,
    pub name: String,
    pub size: serde_json::Number,
    /// The API asset endpoint: answers `application/octet-stream` with a signed CDN redirect.
    pub url: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GitHubRelease {
    pub tag_name: String,
    /// `None`: absent; `Some(None)`: `null` (zod's `nullish` keeps which).
    pub name: Option<Option<String>>,
    pub body: Option<Option<String>>,
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
}

impl GitHubRelease {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("tag_name".into(), json!(self.tag_name));
        if let Some(name) = &self.name {
            out.insert("name".into(), json!(name));
        }
        if let Some(body) = &self.body {
            out.insert("body".into(), json!(body));
        }
        out.insert("draft".into(), json!(self.draft));
        out.insert("prerelease".into(), json!(self.prerelease));
        let assets: Vec<Value> = self
            .assets
            .iter()
            .map(|a| json!({ "id": a.id, "name": a.name, "size": a.size, "url": a.url }))
            .collect();
        out.insert("assets".into(), Value::Array(assets));
        Value::Object(out)
    }
}

/// `new URL(text)` succeeds: a scheme, and for the special schemes a host after `//`.
fn url_shape(text: &str) -> bool {
    let Some((scheme, rest)) = text.split_once(':') else {
        return false;
    };
    let mut bytes = scheme.bytes();
    if !bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        || !bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return false;
    }
    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" | "ws" | "wss" | "ftp" => {
            let host = rest.trim_start_matches(['/', '\\']);
            let host = host.split(['/', '\\', '?', '#']).next().unwrap_or("");
            let host = host.rsplit('@').next().unwrap_or("");
            !host.is_empty() && !host.starts_with(':') && !host.contains(' ')
        }
        _ => true,
    }
}

fn nullish_text(
    object: &Map<String, Value>,
    key: &str,
    path: &str,
    issues: &mut Issues,
) -> Option<Option<String>> {
    match object.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        other => {
            issues.expected(&join(path, key), "string", other);
            None
        }
    }
}

fn release(value: &Value, path: &str, issues: &mut Issues) -> Option<GitHubRelease> {
    let Value::Object(object) = value else {
        issues.expected(path, "object", Some(value));
        return None;
    };
    let before = issues.0.len();
    let tag_name = match object.get("tag_name") {
        Some(Value::String(s)) => Some(s.clone()),
        other => {
            issues.expected(&join(path, "tag_name"), "string", other);
            None
        }
    };
    let name = nullish_text(object, "name", path, issues);
    let body = nullish_text(object, "body", path, issues);
    let mut flag = |key: &str| match object.get(key) {
        Some(Value::Bool(b)) => Some(*b),
        other => {
            issues.expected(&join(path, key), "boolean", other);
            None
        }
    };
    let draft = flag("draft");
    let prerelease = flag("prerelease");
    let mut assets = Vec::new();
    match object.get("assets") {
        Some(Value::Array(list)) => {
            for (i, item) in list.iter().enumerate() {
                let at = join(&join(path, "assets"), &i.to_string());
                let Value::Object(a) = item else {
                    issues.expected(&at, "object", Some(item));
                    continue;
                };
                let number = |key: &str, issues: &mut Issues| match a.get(key) {
                    Some(Value::Number(n)) => Some(n.clone()),
                    other => {
                        issues.expected(&join(&at, key), "number", other);
                        None
                    }
                };
                let id = number("id", issues);
                let name = match a.get("name") {
                    Some(Value::String(s)) => Some(s.clone()),
                    other => {
                        issues.expected(&join(&at, "name"), "string", other);
                        None
                    }
                };
                let size = number("size", issues);
                let url = match a.get("url") {
                    Some(Value::String(s)) if url_shape(s) => Some(s.clone()),
                    Some(Value::String(_)) => {
                        issues.add(&join(&at, "url"), "Invalid url");
                        None
                    }
                    other => {
                        issues.expected(&join(&at, "url"), "string", other);
                        None
                    }
                };
                if let (Some(id), Some(name), Some(size), Some(url)) = (id, name, size, url) {
                    assets.push(Asset {
                        id,
                        name,
                        size,
                        url,
                    });
                }
            }
        }
        other => issues.expected(&join(path, "assets"), "array", other),
    }
    if issues.0.len() != before {
        return None;
    }
    Some(GitHubRelease {
        tag_name: tag_name?,
        name,
        body,
        draft: draft?,
        prerelease: prerelease?,
        assets,
    })
}

/// The release a check considers: `GET /releases/latest` (one release) or, with pre-releases allowed, `GET /releases`
/// (newest first): the newest non-draft pre-release, else the newest non-draft release.
pub fn pick_release(payload: &Value, allow_prerelease: bool) -> Result<GitHubRelease, FeedError> {
    let mut issues = Issues(Vec::new());
    if !allow_prerelease {
        return release(payload, "", &mut issues).ok_or_else(|| {
            fail(
                LOOKUP_ERROR,
                format!("Unexpected release payload: {}", issues.text()),
            )
        });
    }
    let Value::Array(list) = payload else {
        issues.expected("", "array", Some(payload));
        return Err(fail(
            LOOKUP_ERROR,
            format!("Unexpected release list payload: {}", issues.text()),
        ));
    };
    let releases: Vec<Option<GitHubRelease>> = list
        .iter()
        .enumerate()
        .map(|(i, item)| release(item, &i.to_string(), &mut issues))
        .collect();
    if !issues.0.is_empty() {
        return Err(fail(
            LOOKUP_ERROR,
            format!("Unexpected release list payload: {}", issues.text()),
        ));
    }
    let candidates: Vec<GitHubRelease> = releases
        .into_iter()
        .flatten()
        .filter(|r| !r.draft)
        .collect();
    candidates
        .iter()
        .find(|r| r.prerelease)
        .or(candidates.first())
        .cloned()
        .ok_or_else(|| fail(NO_RELEASE_ERROR, "The repository has no published release"))
}

/// One platform's update, ready for the updater.
#[derive(Clone, Debug, PartialEq)]
pub struct PlatformRelease {
    pub version: String,
    pub release_date: String,
    pub release_name: String,
    /// Release notes without the metadata comment.
    pub notes: String,
    pub file: UpdateFile,
    /// API asset endpoint of `file`.
    pub asset_url: String,
}

impl PlatformRelease {
    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "releaseDate": self.release_date,
            "releaseName": self.release_name,
            "notes": self.notes,
            "file": { "name": self.file.name, "size": self.file.size, "sha512": self.file.sha512 },
            "assetUrl": self.asset_url,
        })
    }
}

/// This platform's installer in `release`, checked against the release itself: the comment names the release's own
/// version, and the file it describes is an asset of exactly that size.
pub fn resolve_platform_release(
    release: &GitHubRelease,
    platform: Platform,
) -> Result<PlatformRelease, FeedError> {
    let body = release.body.clone().flatten();
    let metadata = parse_metadata(body.as_deref())?;
    if release.tag_name != format!("v{}", metadata.version) {
        return Err(fail(
            METADATA_ERROR,
            format!(
                "The ompdesk-update comment names {}, but the release is {}",
                metadata.version, release.tag_name
            ),
        ));
    }
    let file = match platform {
        Platform::Mac => metadata.mac,
        Platform::Windows => metadata.windows,
    }
    .ok_or_else(|| {
        fail(
            PLATFORM_ERROR,
            format!("{} ships no {} installer", release.tag_name, platform.key()),
        )
    })?;
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == file.name)
        .ok_or_else(|| {
            fail(
                METADATA_ERROR,
                format!(
                    "The ompdesk-update comment lists {}, but {} has no such asset",
                    file.name, release.tag_name
                ),
            )
        })?;
    if asset.size.as_f64() != Some(file.size as f64) {
        return Err(fail(
            METADATA_ERROR,
            format!(
                "{} is {} bytes, but the ompdesk-update comment says {}",
                file.name,
                crate::updater_core::rules::js_number(asset.size.as_f64().unwrap_or(f64::NAN)),
                file.size
            ),
        ));
    }
    let name = release.name.clone().flatten().filter(|n| !n.is_empty());
    Ok(PlatformRelease {
        version: metadata.version,
        release_date: metadata.release_date,
        release_name: name.unwrap_or_else(|| release.tag_name.clone()),
        notes: strip_metadata(body.as_deref()),
        file,
        asset_url: asset.url.clone(),
    })
}
