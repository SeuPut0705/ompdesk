//! The updater's small rules (was `src/main/updater-state.ts` and `updater.ts`'s helpers): repository access, how a
//! failed or empty check settles, resumed downloads, which files in Downloads the updater may sweep, where a macOS
//! bundle lives, the request headers, and the macOS swap helper.

use serde_json::{Map, Value, json};

use super::status::{Access, Status};

/// The release repository's API root. A test points the unpackaged shell elsewhere (`OMP_DEV_UPDATE_API`).
pub const GITHUB_API_REPO: &str = "https://api.github.com/repos/SeuPut0705/ompdesk";

/// `GET /repos/{owner}/{repo}` status → access. GitHub answers 404 (not 403) for a private repo the caller cannot
/// see, so both mean "no access". A 403 with `x-ratelimit-remaining: 0` is the hourly limit: a network-class failure.
pub fn classify_repo_access(status: u16, rate_limited: bool) -> Access {
    match status {
        200..=299 => Access::Ok,
        401 => Access::Invalid,
        403 if rate_limited => Access::Network,
        403 | 404 => Access::Denied,
        _ => Access::Network,
    }
}

/// A failed check once repository access is known. `message` is the headline's key; `detail` the raw error.
pub fn settle_failed_check(
    access: Access,
    code: Option<&str>,
    message: &str,
    current_version: &str,
    manual: bool,
    detail: Option<&str>,
) -> Status {
    if matches!(access, Access::Invalid | Access::Denied | Access::Missing) {
        return Status::AuthRequired { reason: access };
    }
    if access == Access::Ok && code == Some(super::release::NO_RELEASE_ERROR) {
        return Status::NotAvailable {
            version: current_version.to_string(),
        };
    }
    Status::Error {
        key: message.to_string(),
        suffix: None,
        detail: detail
            .filter(|d| !d.is_empty() && *d != message)
            .map(str::to_string),
        show_in_banner: Some(manual),
    }
}

/// A check that ended without an answer never leaves the state at `checking`.
pub fn settle_incomplete_check(status: &Status, manual: bool, no_result_key: &str) -> Status {
    match status {
        Status::Checking if manual => Status::Error {
            key: no_result_key.to_string(),
            suffix: None,
            detail: None,
            show_in_banner: None,
        },
        Status::Checking => Status::Idle,
        other => other.clone(),
    }
}

/// How a resumed download continues: from `offset`, appending, or from the start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferPlan {
    pub offset: u64,
    pub append: bool,
}

/// A `Range` request is honoured only when the server answers 206 *and* starts exactly where the local file ends;
/// anything else rewrites from the top.
pub fn plan_transfer(existing: u64, status: u16, content_range: Option<&str>) -> TransferPlan {
    let restart = TransferPlan {
        offset: 0,
        append: false,
    };
    if existing == 0 || status != 206 {
        return restart;
    }
    // `/^bytes\s+(\d+)-/i`, read as `Number(...)`.
    let Some(range) = content_range else {
        return restart;
    };
    let lower = range.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("bytes") else {
        return restart;
    };
    let trimmed = rest.trim_start_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c']);
    if trimmed.len() == rest.len() {
        return restart;
    }
    let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
    let starts_here = !digits.is_empty()
        && trimmed[digits.len()..].starts_with('-')
        && digits.parse::<f64>().ok() == Some(existing as f64);
    if starts_here {
        TransferPlan {
            offset: existing,
            append: true,
        }
    } else {
        restart
    }
}

/// A download that receives nothing for this long fails as retryable; its partial stays.
pub const DOWNLOAD_IDLE_TIMEOUT_MS: u64 = 30_000;

/// The suffix of a download in flight; a deterministic name, so a quit or crash resumes it.
pub const PARTIAL_SUFFIX: &str = ".partial";

pub fn partial_path(destination: &str) -> String {
    format!("{destination}{PARTIAL_SUFFIX}")
}

/// Local name of a downloaded DMG: the version goes back into the version-free asset name.
pub fn mac_download_name(version: &str) -> String {
    format!("ompdesk-{version}-arm64.dmg")
}

/// `/^ompdesk-[\d.]+(?:-arm64)?(?: \(\d+\))?\.dmg(?:\.partial|\.download-\d+)$/`: only names the updater itself wrote.
fn is_installer_debris(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("ompdesk-") else {
        return false;
    };
    let version_len = rest
        .bytes()
        .take_while(|b| b.is_ascii_digit() || *b == b'.')
        .count();
    if version_len == 0 {
        return false;
    }
    let mut rest = &rest[version_len..];
    rest = rest.strip_prefix("-arm64").unwrap_or(rest);
    if let Some(copy) = rest.strip_prefix(" (") {
        let n = copy.bytes().take_while(u8::is_ascii_digit).count();
        match copy[n..].strip_prefix(')') {
            Some(after) if n > 0 => rest = after,
            _ => return false,
        }
    }
    let Some(tail) = rest.strip_prefix(".dmg") else {
        return false;
    };
    tail == PARTIAL_SUFFIX
        || tail
            .strip_prefix(".download-")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether a startup or download sweep removes `name` from Downloads: PID-keyed partials of older builds always; a
/// `.partial` only once a fresh download names its own (`active`), and never that one.
pub fn sweeps(name: &str, active: Option<&str>) -> bool {
    if !is_installer_debris(name) || Some(name) == active {
        return false;
    }
    !(active.is_none() && name.ends_with(PARTIAL_SUFFIX))
}

/// `/Applications/OMPdesk.app` from `/Applications/OMPdesk.app/Contents/MacOS/OMPdesk`; `None` outside a bundle.
/// POSIX path rules, as `path.posix.dirname` reads them.
pub fn mac_bundle_path(exec_path: &str) -> Option<String> {
    let mac_os = posix_dirname(exec_path);
    let bundle = posix_dirname(&posix_dirname(&mac_os));
    (bundle.ends_with(".app") && posix_basename(&mac_os) == "MacOS").then_some(bundle)
}

fn posix_dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".into();
    }
    match trimmed.rfind('/') {
        None => ".".into(),
        Some(i) => {
            let dir = trimmed[..i].trim_end_matches('/');
            if dir.is_empty() {
                "/".into()
            } else {
                dir.into()
            }
        }
    }
}

fn posix_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("")
}

/// A bundle the app may replace itself: not on a mounted disk image, not App Translocation's read-only copy.
pub fn is_swappable_location(bundle: &str) -> bool {
    !bundle.starts_with("/Volumes/") && !bundle.contains("/AppTranslocation/")
}

/// Headers for GitHub's REST API; an Authorization header only with a token.
pub fn github_api_headers(token: Option<&str>, accept: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![
        (
            "accept".to_string(),
            accept.unwrap_or("application/vnd.github+json").to_string(),
        ),
        ("x-github-api-version".to_string(), "2022-11-28".to_string()),
    ];
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        headers.push(("authorization".to_string(), format!("Bearer {token}")));
    }
    headers
}

pub fn headers_json(headers: &[(String, String)]) -> Value {
    let object: Map<String, Value> = headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    Value::Object(object)
}

/// The release-notes excerpt the banner shows: the first 500 UTF-16 units, as `String.slice(0, 500)`.
pub fn notes_excerpt(notes: &str) -> String {
    let units: Vec<u16> = notes.encode_utf16().take(500).collect();
    String::from_utf16_lossy(&units)
}

/// A number as JavaScript prints it in a message (`100`, `1.5`).
pub fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The token cut out of a text for the log (`<token>`); Node's `scrubUpdateText` takes URLs and the rest.
pub fn cut_secrets(text: &str, secrets: &[Option<&str>]) -> String {
    let mut out = text.to_string();
    for secret in secrets.iter().flatten().filter(|s| !s.is_empty()) {
        out = out.replace(secret, "<token>");
    }
    out
}

/// Detached swap run after the app exits (`bash -c SWAP_SCRIPT swap <pid> <staged.app> <dest.app> <relaunch 0|1>
/// <log> <start mark> <expected version> [relaunch args…]`): wait for the app's process, copy the verified staged
/// bundle next to the destination, then exchange them with a rollback if the final move fails. Runs once and exits;
/// never a launchd job.
///
/// Relaunch (1) keeps the old bundle as `<dest>.previous` until the new app proves it started: the helper removes a
/// stale start mark, reopens the app and polls up to `OMPDESK_SWAP_START_WAIT_S` seconds (default 120) for the mark
/// main writes once its first window's page loaded (`<userData>/app-started.json`) with the expected version. Seen:
/// `.previous` goes, `started`. Not seen (the new app died, hung, or is a different build): every process under
/// `<dest>/Contents/` is ended (TERM, KILL after 5 s), `.previous` moves back and is reopened, `start failed; previous
/// app restored` (`start failed; previous app lost` when it cannot move back). No dialog. The log's last outcome line
/// wins (`lastSwapEntry`). Without a relaunch (0, the install at an approved quit) nothing is reopened, so there is
/// nothing to start-check: `.previous` goes at once.
///
/// Orderings: the mark is removed before `open`, so a mark in the file was written by an app started after it; the
/// mark is written by rename, so a read sees none or all of it; one last look follows the wait, so a mark that lands
/// in the final tick is not lost to a rollback decision made a tick earlier.
pub const SWAP_SCRIPT: &str = r#"
pid="$1" src="$2" dest="$3" relaunch="$4" log="$5" mark="$6" expect="$7"
shift 7
exec >>"$log" 2>&1
echo "swap $(date): $src -> $dest"
for _ in $(seq 1 150); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$pid" 2>/dev/null; then echo "app still running; swap skipped"; exit 1; fi
[ -d "$src" ] || { echo "staged app missing"; exit 1; }
staging="$dest.updating" old="$dest.previous"
rm -rf "$staging" "$old"
ditto "$src" "$staging" || { rm -rf "$staging"; echo "copy failed"; exit 1; }
xattr -dr com.apple.quarantine "$staging" 2>/dev/null
if [ -e "$dest" ]; then mv "$dest" "$old" || { rm -rf "$staging"; echo "cannot move old app"; exit 1; }; fi
if ! mv "$staging" "$dest"; then
  [ -e "$old" ] && mv "$old" "$dest"
  echo "install failed; previous app restored"; exit 1
fi
rm -rf "$src"
echo "installed"
if [ "$relaunch" != "1" ]; then rm -rf "$old"; exit 0; fi
launch() { if [ "$#" -gt 0 ]; then open -n "$dest" --args "$@"; else open -n "$dest"; fi; }
started() { [ -f "$mark" ] && grep -Fq "\"version\":\"$expect\"" "$mark"; }
under_dest() { ps -axww -o pid= -o command= | while read -r p c; do case "$c" in "$dest/Contents/"*) echo "$p";; esac; done; }
wait_s="${OMPDESK_SWAP_START_WAIT_S:-120}"
case "$wait_s" in ''|*[!0-9]*) wait_s=120;; esac
rm -f "$mark"
launch "$@"
echo "waiting for the new app to start"
ticks=0
while [ "$ticks" -lt $((wait_s * 5)) ] && ! started; do sleep 0.2; ticks=$((ticks + 1)); done
if started; then rm -rf "$old"; echo "started"; exit 0; fi
pids=$(under_dest)
if [ -n "$pids" ]; then
  kill -TERM $pids 2>/dev/null
  ticks=0
  while [ "$ticks" -lt 25 ] && [ -n "$(under_dest)" ]; do sleep 0.2; ticks=$((ticks + 1)); done
  pids=$(under_dest)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
fi
if [ -d "$old" ] && rm -rf "$dest" && mv "$old" "$dest"; then
  echo "start failed; previous app restored"
  launch "$@"
else
  echo "start failed; previous app lost"
fi
"#;
