//! `captured.json` replayed: every case the TypeScript answered before it was deleted, answered again here.
//! Successes compare whole; an error compares its code, and its message where the TypeScript's words were its own
//! (zod's issue lists and V8's JSON errors are worded differently here, PROTOCOL.md §15.8).

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use super::release::{self, FeedError, Platform};
use super::rules;
use super::secret;
use super::semver;
use super::status::{Access, Status};

static CAPTURED: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("captured.json")).expect("captured.json parses")
});

fn cases(section: &str) -> &'static [Value] {
    CAPTURED[section]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| panic!("no section {section}"))
}

fn text<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
    case["in"][key].as_str()
}

/// Messages this module words as the TypeScript did (not zod's or V8's).
fn own_wording(message: &str) -> bool {
    !message.starts_with("The ompdesk-update comment is invalid:")
        && !message.starts_with("The ompdesk-update comment is not JSON:")
        && !message.starts_with("Unexpected release")
}

fn check_result(section: &str, case: &Value, got: Result<Value, FeedError>) {
    match (got, case.get("error")) {
        (Ok(value), None) => assert_eq!(value, case["out"], "{section}: {}", case["in"]),
        (Err(error), Some(want)) => {
            assert_eq!(
                error.code,
                want["code"].as_str().unwrap(),
                "{section}: {}",
                case["in"]
            );
            let message = want["message"].as_str().unwrap();
            if own_wording(message) {
                assert_eq!(error.message, message, "{section}: {}", case["in"]);
            } else {
                let prefix = message.split(':').next().unwrap();
                assert!(
                    error.message.starts_with(prefix),
                    "{section}: {} → {}",
                    case["in"],
                    error.message
                );
            }
        }
        (Ok(value), Some(want)) => panic!(
            "{section}: {} answered {value}, the TypeScript threw {want}",
            case["in"]
        ),
        (Err(error), None) => panic!(
            "{section}: {} threw {error:?}, the TypeScript answered {}",
            case["in"], case["out"]
        ),
    }
}

#[test]
fn repository_access_is_classified_as_before() {
    for case in cases("classifyRepoAccess") {
        let status = case["in"]["status"].as_u64().unwrap() as u16;
        let limited = case["in"]["rateLimited"].as_bool().unwrap_or(false);
        assert_eq!(
            rules::classify_repo_access(status, limited).as_str(),
            case["out"],
            "{}",
            case["in"]
        );
    }
}

#[test]
fn a_failed_check_settles_as_before() {
    for case in cases("settleFailedUpdateCheck") {
        let access = Access::parse(text(case, "access").unwrap()).unwrap();
        let status = rules::settle_failed_check(
            access,
            text(case, "errorCode"),
            text(case, "message").unwrap(),
            text(case, "currentVersion").unwrap(),
            case["in"]["manual"].as_bool().unwrap(),
            text(case, "detail"),
        );
        assert_eq!(status.to_ts_json(), case["out"], "{}", case["in"]);
    }
}

#[test]
fn a_check_without_an_answer_settles_as_before() {
    for case in cases("settleIncompleteUpdateCheck") {
        let input = &case["in"]["status"];
        let manual = case["in"]["manual"].as_bool().unwrap();
        if input["state"] == "checking" {
            let status = rules::settle_incomplete_check(
                &Status::Checking,
                manual,
                text(case, "noResultMessage").unwrap(),
            );
            assert_eq!(status.to_ts_json(), case["out"], "{}", case["in"]);
        } else {
            // Any other state passes through unchanged.
            assert_eq!(&case["out"], input);
        }
    }
}

#[test]
fn a_resumed_download_continues_only_where_the_server_said() {
    for case in cases("planInstallerTransfer") {
        let plan = rules::plan_transfer(
            case["in"]["existingBytes"].as_u64().unwrap(),
            case["in"]["status"].as_u64().unwrap() as u16,
            text(case, "contentRange"),
        );
        assert_eq!(
            json!({ "offset": plan.offset, "append": plan.append }),
            case["out"],
            "{}",
            case["in"]
        );
    }
}

#[test]
fn the_sweep_removes_only_the_updaters_debris() {
    for case in cases("installerDebris") {
        let swept = rules::sweeps(text(case, "name").unwrap(), text(case, "activePartial"));
        assert_eq!(json!(swept), case["out"], "{}", case["in"]);
    }
}

#[test]
fn bundle_paths_and_names_are_read_as_before() {
    for case in cases("macBundlePath") {
        assert_eq!(
            json!(rules::mac_bundle_path(text(case, "execPath").unwrap())),
            case["out"],
            "{}",
            case["in"]
        );
    }
    for case in cases("isSwappableBundleLocation") {
        assert_eq!(
            json!(rules::is_swappable_location(text(case, "bundle").unwrap())),
            case["out"],
            "{}",
            case["in"]
        );
    }
    for case in cases("macDownloadName") {
        assert_eq!(
            rules::mac_download_name(text(case, "version").unwrap()),
            case["out"].as_str().unwrap()
        );
    }
    for case in cases("installerPartialPath") {
        assert_eq!(
            rules::partial_path(text(case, "destinationPath").unwrap()),
            case["out"].as_str().unwrap()
        );
    }
}

#[test]
fn github_headers_are_the_same() {
    for case in cases("githubApiHeaders") {
        let headers = rules::github_api_headers(text(case, "token"), text(case, "accept"));
        assert_eq!(rules::headers_json(&headers), case["out"], "{}", case["in"]);
    }
}

#[test]
fn release_metadata_reads_as_before() {
    for case in cases("parseUpdateMetadata") {
        let got = release::parse_metadata(text(case, "body")).map(|m| m.to_json());
        check_result("parseUpdateMetadata", case, got);
    }
    for case in cases("stripUpdateMetadata") {
        assert_eq!(
            release::strip_metadata(text(case, "body")),
            case["out"].as_str().unwrap(),
            "{}",
            case["in"]
        );
    }
}

#[test]
fn the_release_a_check_considers_is_the_same() {
    for case in cases("pickRelease") {
        let allow = case["in"]["allowPrerelease"].as_bool().unwrap_or(false);
        let got = release::pick_release(&case["in"]["payload"], allow).map(|r| r.to_json());
        check_result("pickRelease", case, got);
    }
}

#[test]
fn a_platforms_release_resolves_as_before() {
    for case in cases("resolvePlatformRelease") {
        let platform = if text(case, "platform") == Some("mac") {
            Platform::Mac
        } else {
            Platform::Windows
        };
        let got = release::pick_release(&case["in"]["release"], false)
            .and_then(|r| release::resolve_platform_release(&r, platform))
            .map(|r| r.to_json());
        check_result("resolvePlatformRelease", case, got);
    }
}

#[test]
fn versions_compare_as_node_semver_compared_them() {
    for case in cases("semverGt") {
        let latest = text(case, "latest").unwrap();
        let current = text(case, "current").unwrap();
        let parsed = semver::parse(latest).is_some();
        let gt = semver::is_newer(latest, current).unwrap_or(false);
        assert_eq!(
            json!({ "parsed": parsed, "gt": gt }),
            case["out"],
            "{}",
            case["in"]
        );
    }
}

#[test]
fn the_swap_helper_is_the_same_script() {
    assert_eq!(
        rules::SWAP_SCRIPT,
        CAPTURED["SWAP_SCRIPT"].as_str().unwrap()
    );
}

#[test]
fn a_token_encrypted_here_is_the_bytes_the_shim_wrote() {
    for case in cases("safeStorageMac") {
        let password = STANDARD
            .decode(case["passwordBase64"].as_str().unwrap())
            .unwrap();
        let plain = case["plaintext"].as_str().unwrap();
        let blob = STANDARD
            .decode(case["blobBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(secret::encrypt_cbc(&password, plain), blob, "{case}");
        assert_eq!(secret::Key::Mac(password).decrypt(&blob).unwrap(), plain);
    }
    for case in cases("safeStorageWin") {
        let key = STANDARD
            .decode(case["keyBase64"].as_str().unwrap())
            .unwrap();
        let nonce: [u8; 12] = STANDARD
            .decode(case["nonceBase64"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let plain = case["plaintext"].as_str().unwrap();
        let blob = STANDARD
            .decode(case["blobBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            secret::encrypt_gcm(&key, nonce, plain).unwrap(),
            blob,
            "{case}"
        );
        assert_eq!(secret::Key::Windows(key).decrypt(&blob).unwrap(), plain);
    }
}

#[test]
fn notes_are_cut_at_500_utf16_units() {
    let long = "가".repeat(600);
    assert_eq!(rules::notes_excerpt(&long).encode_utf16().count(), 500);
    assert_eq!(rules::notes_excerpt("short"), "short");
}

/// `update-log-core.test.ts`'s `parseStartFailure` cases: the shell reads the record Node writes.
#[test]
fn a_start_failure_record_names_its_version_or_nothing() {
    let version = |raw: &str| rules::start_failed_version(raw);
    assert_eq!(
        version(r#"{"version":"0.39.0","count":2,"at":5}"#).as_deref(),
        Some("0.39.0")
    );
    assert_eq!(
        version(r#"{"version":"0.39.0","at":5}"#).as_deref(),
        Some("0.39.0")
    );
    assert_eq!(version(r#"{"version":"0.39.0"}"#), None);
    assert_eq!(version("not json"), None);
    assert_eq!(version("null"), None);
}
