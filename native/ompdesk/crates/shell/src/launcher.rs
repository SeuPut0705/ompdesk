//! The pure parts of `ompdesk-launcher`, the macOS bundle's `CFBundleExecutable` (`Contents/MacOS/OMPdesk`): it execs the
//! real shell (`Contents/MacOS/ompdesk-shell`) and, for the first launch of a version an update installed, leaves a
//! watcher that puts the last Electron release back when the new app never reports it started. The process work is in
//! `launcher_main.rs`; what it decides and parses is here, where `cargo test` runs on every OS.

use std::io::{self, Read};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha512};

/// The GitHub repository the release comes from.
pub const REPO: &str = "SeuPut0705/ompdesk";
/// The bundle id of every OMPdesk build; a restored app must carry it.
pub const BUNDLE_ID: &str = "com.seuput.ompdesk";
/// The only macOS release asset (`UPDATE_ASSETS.mac` in `src/main/update-release.ts`).
pub const DMG_NAME: &str = "ompdesk-mac-arm64.dmg";
pub const DEFAULT_API_BASE: &str = "https://api.github.com";
pub const DEFAULT_WAIT_SECS: u64 = 120;
/// The watcher stops waiting early once the shell's pid has been gone this long.
pub const SHELL_GONE_SECS: u64 = 10;

/// Test seams that point the launcher elsewhere: honoured only beside `OMP_GUI_TEST_USER_DATA_DIR`, so no person's
/// environment can redirect a real rollback.
pub const RELEASE_URL_ENV: &str = "OMPDESK_LAUNCHER_RELEASE_URL";
pub const START_WAIT_ENV: &str = "OMPDESK_LAUNCHER_START_WAIT_S";

/// The closing lines of `<userData>/updates/swap.log` an entry ends with (the app's `SWAP_OUTCOMES` reads them).
pub const LINE_STARTED: &str = "started";
pub const LINE_SWAP_RESTORES: &str = "start failed; the swap restores";
pub const LINE_RESTORED: &str = "start failed; previous app restored";

pub fn restore_failed_line(why: &str) -> String {
    format!("start failed; restore failed: {why}")
}

/// The entry's header, shaped like the Electron swap script's `swap <date>: <src> -> <dest>`.
pub fn header(date: &str, bundle: &str) -> String {
    format!("swap {date}: start check {bundle} -> {bundle}")
}

/// `<bundle>.previous`: the folder the old app's swap script leaves until it has seen the new app start.
pub fn previous_path(bundle: &str) -> String {
    format!("{bundle}.previous")
}

/// The value of `<key>name</key><string>value</string>` in an XML property list.
pub fn plist_string(xml: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let after = &xml[xml.find(&marker)? + marker.len()..];
    let after = after.trim_start();
    let body = after.strip_prefix("<string>")?;
    let value = &body[..body.find("</string>")?];
    Some(value.trim().to_string())
}

/// The bundle's version: `CFBundleShortVersionString`, which is `app.getVersion()` in Electron.
pub fn bundle_version(info_plist: &str) -> Option<String> {
    plist_string(info_plist, "CFBundleShortVersionString").filter(|v| !v.is_empty())
}

fn string_field(text: &str, field: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value
        .get(field)?
        .as_str()
        .filter(|v| !v.is_empty())
        .map(String::from)
}

/// `to` of `<userData>/update-install.json`: the version an install was meant to produce.
pub fn install_target(update_install_json: &str) -> Option<String> {
    string_field(update_install_json, "to")
}

/// `version` of `<userData>/app-started.json` (`{version, pid, at}`, written by main once the first page loaded).
pub fn started_version(app_started_json: &str) -> Option<String> {
    string_field(app_started_json, "version")
}

/// The watcher is armed for the first launch of a version an update installed that has not reported itself started:
/// the install named this version, and the mark does not already hold it. Anything unreadable leaves it disarmed, so
/// the launcher never stands between a person and the app.
pub fn armed(bundle_version: &str, install_to: Option<&str>, started: Option<&str>) -> bool {
    install_to == Some(bundle_version) && started != Some(bundle_version)
}

/// A string test env, honoured only when the test profile seam is set too.
fn seam<'a>(value: Option<&'a str>, user_data_env: Option<&str>) -> Option<&'a str> {
    value.filter(|v| !v.is_empty() && user_data_env.is_some_and(|u| !u.is_empty()))
}

/// The GitHub API base: the stand-in feed's in a test, else GitHub's.
pub fn api_base(release_url_env: Option<&str>, user_data_env: Option<&str>) -> String {
    seam(release_url_env, user_data_env)
        .unwrap_or(DEFAULT_API_BASE)
        .trim_end_matches('/')
        .to_string()
}

/// How long the watcher waits for the mark: 120 s, or the test seam's whole seconds.
pub fn wait_secs(wait_env: Option<&str>, user_data_env: Option<&str>) -> u64 {
    seam(wait_env, user_data_env)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_WAIT_SECS)
}

/// `v0.127.0` → `0.127.0`.
pub fn tag_version(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// What the release of the last Electron app says about its macOS installer.
#[derive(Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub size: u64,
    /// Padded base64 SHA-512, as the release's metadata comment writes it.
    pub sha512: String,
    /// The API asset endpoint: answers `application/octet-stream` with a redirect to the CDN.
    pub asset_url: String,
}

/// The release's `<!-- ompdesk-update {...} -->` comment (exactly one) and its `assets` for the DMG, checked against the
/// tag that was asked for.
pub fn parse_release(json: &str, tag: &str) -> Result<Release, String> {
    let release: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("the release answer is not JSON: {e}"))?;
    if release["tag_name"].as_str() != Some(tag) {
        return Err(format!(
            "the release answer is for {:?}, not {tag}",
            release["tag_name"]
        ));
    }
    let body = release["body"].as_str().unwrap_or("");
    let comments: Vec<&str> = body
        .match_indices("<!--")
        .filter_map(|(start, _)| {
            let rest = &body[start + 4..];
            let inner = &rest[..rest.find("-->")?];
            inner.trim().strip_prefix("ompdesk-update")
        })
        .collect();
    let [comment] = comments.as_slice() else {
        return Err(format!(
            "the release notes carry {} ompdesk-update comments, not one",
            comments.len()
        ));
    };
    let meta: serde_json::Value = serde_json::from_str(comment.trim())
        .map_err(|e| format!("the ompdesk-update comment is not JSON: {e}"))?;
    let version = meta["version"].as_str().unwrap_or("").to_string();
    if version != tag_version(tag) {
        return Err(format!(
            "the release is version {version}, not {}",
            tag_version(tag)
        ));
    }
    let file = &meta["files"]["mac"];
    if file["name"].as_str() != Some(DMG_NAME) {
        return Err(format!("the release has no {DMG_NAME} for macOS"));
    }
    let size = file["size"]
        .as_u64()
        .filter(|s| *s > 0)
        .ok_or("the release's macOS file has no size")?;
    let sha512 = file["sha512"].as_str().unwrap_or("").to_string();
    if sha512.len() != 88 || !sha512.ends_with("==") {
        return Err("the release's macOS file has no SHA-512".into());
    }
    let asset_url = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str() == Some(DMG_NAME))
        .and_then(|a| a["url"].as_str())
        .ok_or_else(|| format!("the release lists no asset named {DMG_NAME}"))?
        .to_string();
    Ok(Release {
        version,
        size,
        sha512,
        asset_url,
    })
}

/// Reads `reader` to its end: its length and padded base64 SHA-512.
pub fn sha512_of(mut reader: impl Read) -> io::Result<(u64, String)> {
    let mut hasher = Sha512::new();
    let mut buffer = [0u8; 1 << 16];
    let mut length = 0u64;
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        length += n as u64;
    }
    Ok((length, STANDARD.encode(hasher.finalize())))
}

/// The downloaded file must be the size and the SHA-512 the release's comment states.
pub fn check_download(length: u64, sha512: &str, release: &Release) -> Result<(), String> {
    if length != release.size {
        return Err(format!(
            "the download is {length} bytes, the release says {}",
            release.size
        ));
    }
    if sha512 != release.sha512 {
        return Err("the download's SHA-512 is not the release's".into());
    }
    Ok(())
}

/// The pids of `ps -axo pid=,comm=` rows whose executable lies under `prefix` (a folder, with its trailing slash), but
/// not those in `skip` (the watcher itself is a binary of the bundle).
pub fn processes_under(ps_output: &str, prefix: &str, skip: &[u32]) -> Vec<u32> {
    ps_output
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, command) = line.split_once(char::is_whitespace)?;
            let pid: u32 = pid.parse().ok()?;
            (command.trim_start().starts_with(prefix) && !skip.contains(&pid)).then_some(pid)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLIST: &str = "<?xml version=\"1.0\"?>\n<plist><dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>com.seuput.ompdesk</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.128.0</string>\n</dict></plist>";

    fn release_json(body: &str, tag: &str) -> String {
        serde_json::json!({
            "tag_name": tag,
            "body": body,
            "assets": [
                { "id": 1, "name": "ompdesk-windows-setup.exe", "size": 5, "url": "https://x/win" },
                { "id": 2, "name": DMG_NAME, "size": 3, "url": "https://x/dmg" },
            ],
        })
        .to_string()
    }

    fn comment(version: &str, size: u64, sha: &str) -> String {
        format!(
            "Notes\n<!-- ompdesk-update {{\"version\":\"{version}\",\"releaseDate\":\"2026-01-01T00:00:00.000Z\",\"files\":{{\"mac\":{{\"name\":\"{DMG_NAME}\",\"size\":{size},\"sha512\":\"{sha}\"}}}}}} -->"
        )
    }

    fn sha_of(bytes: &[u8]) -> String {
        sha512_of(bytes).unwrap().1
    }

    #[test]
    fn the_version_and_ids_come_from_the_plist() {
        assert_eq!(bundle_version(PLIST).as_deref(), Some("0.128.0"));
        assert_eq!(
            plist_string(PLIST, "CFBundleIdentifier").as_deref(),
            Some(BUNDLE_ID)
        );
        assert_eq!(plist_string(PLIST, "Nope"), None);
        assert_eq!(bundle_version("<plist></plist>"), None);
    }

    #[test]
    fn the_install_and_start_files_are_read_by_their_one_field() {
        assert_eq!(
            install_target(r#"{"from":"0.127.0","to":"0.128.0","mode":"relaunch"}"#).as_deref(),
            Some("0.128.0")
        );
        assert_eq!(install_target("not json"), None);
        assert_eq!(install_target(r#"{"to":""}"#), None);
        assert_eq!(
            started_version(r#"{"version":"0.128.0","pid":4,"at":1}"#).as_deref(),
            Some("0.128.0")
        );
        assert_eq!(started_version("{}"), None);
    }

    #[test]
    fn armed_only_for_an_installed_version_that_has_not_reported_started() {
        assert!(armed("0.128.0", Some("0.128.0"), None));
        assert!(armed("0.128.0", Some("0.128.0"), Some("0.127.0")));
        assert!(
            !armed("0.128.0", Some("0.128.0"), Some("0.128.0")),
            "it already started once"
        );
        assert!(
            !armed("0.128.0", Some("0.129.0"), None),
            "the install was for another version"
        );
        assert!(!armed("0.128.0", None, None), "no install: a plain launch");
    }

    #[test]
    fn test_seams_need_the_test_profile() {
        assert_eq!(api_base(None, None), DEFAULT_API_BASE);
        assert_eq!(
            api_base(Some("http://127.0.0.1:9/"), None),
            DEFAULT_API_BASE
        );
        assert_eq!(
            api_base(Some("http://127.0.0.1:9/"), Some("")),
            DEFAULT_API_BASE
        );
        assert_eq!(
            api_base(Some("http://127.0.0.1:9/"), Some("/tmp/p")),
            "http://127.0.0.1:9"
        );
        assert_eq!(wait_secs(None, None), 120);
        assert_eq!(wait_secs(Some("3"), None), 120);
        assert_eq!(wait_secs(Some("3"), Some("/tmp/p")), 3);
        assert_eq!(wait_secs(Some("0"), Some("/tmp/p")), 120);
        assert_eq!(wait_secs(Some("soon"), Some("/tmp/p")), 120);
    }

    #[test]
    fn the_release_comment_assets_and_tag_are_all_checked() {
        let sha = sha_of(b"abc");
        let ok = parse_release(
            &release_json(&comment("0.127.0", 3, &sha), "v0.127.0"),
            "v0.127.0",
        )
        .unwrap();
        assert_eq!(
            ok,
            Release {
                version: "0.127.0".into(),
                size: 3,
                sha512: sha.clone(),
                asset_url: "https://x/dmg".into()
            }
        );
        let wrong_tag = parse_release(
            &release_json(&comment("0.127.0", 3, &sha), "v0.126.0"),
            "v0.127.0",
        );
        assert!(wrong_tag.unwrap_err().contains("not v0.127.0"));
        let wrong_version = parse_release(
            &release_json(&comment("0.126.0", 3, &sha), "v0.127.0"),
            "v0.127.0",
        );
        assert!(wrong_version.unwrap_err().contains("0.126.0"));
        let none = parse_release(&release_json("no comment", "v0.127.0"), "v0.127.0");
        assert!(none.unwrap_err().contains("0 ompdesk-update"));
        let twice = format!(
            "{}\n{}",
            comment("0.127.0", 3, &sha),
            comment("0.127.0", 3, &sha)
        );
        assert!(
            parse_release(&release_json(&twice, "v0.127.0"), "v0.127.0")
                .unwrap_err()
                .contains("2 ompdesk-update")
        );
        let bad_sha = parse_release(
            &release_json(&comment("0.127.0", 3, "abc"), "v0.127.0"),
            "v0.127.0",
        );
        assert!(bad_sha.unwrap_err().contains("SHA-512"));
        assert!(parse_release("nope", "v0.127.0").is_err());
        let other_comment = format!("<!-- something else -->\n{}", comment("0.127.0", 3, &sha));
        assert!(
            parse_release(&release_json(&other_comment, "v0.127.0"), "v0.127.0").is_ok(),
            "other comments are ignored"
        );
    }

    #[test]
    fn a_download_must_match_the_comment_in_size_and_sha512() {
        let (length, sha) = sha512_of(&b"abc"[..]).unwrap();
        assert_eq!(length, 3);
        assert_eq!(sha.len(), 88);
        let release = Release {
            version: "0.127.0".into(),
            size: 3,
            sha512: sha.clone(),
            asset_url: String::new(),
        };
        assert!(check_download(length, &sha, &release).is_ok());
        assert!(
            check_download(4, &sha, &release)
                .unwrap_err()
                .contains("4 bytes")
        );
        assert!(
            check_download(3, &sha_of(b"abd"), &release)
                .unwrap_err()
                .contains("SHA-512")
        );
    }

    #[test]
    fn the_bundles_processes_are_found_by_executable_path_but_not_the_watcher() {
        let ps = "    1 /sbin/launchd\n  201 /Applications/OMPdesk.app/Contents/MacOS/ompdesk-shell\n  202 /Applications/OMPdesk.app/Contents/Frameworks/OMPdesk Helper (GPU).app/Contents/MacOS/OMPdesk Helper (GPU)\n  203 /Applications/OMPdesk.app/Contents/MacOS/OMPdesk\n  300 /Applications/Other.app/Contents/MacOS/Other\nbad line\n";
        let found = processes_under(ps, "/Applications/OMPdesk.app/Contents/", &[203]);
        assert_eq!(found, vec![201, 202]);
    }

    #[test]
    fn the_log_lines_have_their_fixed_wording() {
        assert_eq!(
            header("Mon Jan 1", "/Applications/OMPdesk.app"),
            "swap Mon Jan 1: start check /Applications/OMPdesk.app -> /Applications/OMPdesk.app"
        );
        assert_eq!(
            previous_path("/Applications/OMPdesk.app"),
            "/Applications/OMPdesk.app.previous"
        );
        assert_eq!(
            restore_failed_line("no curl"),
            "start failed; restore failed: no curl"
        );
        assert_eq!(tag_version("v0.127.0"), "0.127.0");
        assert_eq!(tag_version("0.127.0"), "0.127.0");
    }
}
