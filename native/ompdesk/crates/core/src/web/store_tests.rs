use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::*;
use crate::web::auth::{PublicKey, verify_device_proof};
use crate::web::devices::{BlockEntry, Device};
use crate::wire::Frame;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-web-store-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The rows captured from the TypeScript stores (`testdata/web-stores-typescript.json`).
fn captured() -> Value {
    serde_json::from_str(include_str!("testdata/web-stores-typescript.json")).unwrap()
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().to_owned()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn events() -> (
    Events,
    mpsc::UnboundedSender<Frame>,
    mpsc::UnboundedReceiver<Frame>,
) {
    Events::capture()
}

fn told(frames: &mut mpsc::UnboundedReceiver<Frame>) -> Vec<(String, Value)> {
    std::iter::from_fn(|| frames.try_recv().ok())
        .map(|frame| {
            let (head, _) = frame.parts();
            let frame: Value = serde_json::from_slice(head).unwrap();
            (
                frame["event"].as_str().unwrap().to_owned(),
                frame["data"].clone(),
            )
        })
        .collect()
}

fn phone(name: &str) -> NewDevice {
    NewDevice {
        name: name.into(),
        user_agent: "Mozilla/5.0 (iPhone)".into(),
        tailscale_login: Some("me@example.com".into()),
        node_id: Some("nPHONE1".into()),
        public_key: None,
        grants: crate::web::devices::DEFAULT_GRANTS
            .iter()
            .map(|g| (*g).to_owned())
            .collect(),
    }
}

fn on_disk(dir: &Path, file: &str) -> Value {
    parse(&std::fs::read_to_string(dir.join(file)).unwrap())
}

fn verdict_json(verdict: Option<Verdict>) -> Value {
    match verdict {
        None => Value::Null,
        Some(Verdict::Unidentified) => "unidentified".into(),
        Some(Verdict::Entry(entry)) => entry.to_record(),
    }
}

mod devices_file {
    use super::*;

    #[test]
    fn a_file_the_typescript_wrote_reads_and_writes_back_byte_for_byte() {
        let fixture = captured();
        let reloaded = text(&fixture, "devices");
        let book = Book::parse(&parse(&reloaded));
        assert_eq!(book.records().len(), 3);
        assert_eq!(
            document_text(&book.document()),
            reloaded,
            "tab indent, the schema's member order, nulls, escapes, 410.5, the trailing newline"
        );
        // As the stores wrote it while they ran: the same list, its members in the order they were added.
        let written = Book::parse(&parse(&text(&fixture, "devicesWritten")));
        assert_eq!(parse(&document_text(&written.document())), parse(&reloaded));
    }

    #[test]
    fn the_captured_cookies_belong_to_the_captured_hashes() {
        let fixture = captured();
        let now = fixture["now"].as_i64().unwrap();
        let mut book = Book::parse(&parse(&text(&fixture, "devices")));
        for who in ["a", "b", "c"] {
            let cookie = text(&fixture["cookies"], who);
            let (result, _) = book.authenticate(&cookie, now);
            let AuthResult::Ok(device) = result else {
                panic!("{who}: {result:?}")
            };
            assert_eq!(device.device_id, text(&fixture["ids"], who));
            let secret = cookie.split_once('.').unwrap().1;
            assert!(!document_text(&book.document()).contains(secret));
        }
        let wrong = format!("{}.x", text(&fixture["ids"], "a"));
        assert_eq!(book.authenticate(&wrong, now).0, AuthResult::Mismatch);
    }

    #[test]
    fn replaying_the_typescripts_changes_gives_its_records() {
        let fixture = captured();
        let reloaded = text(&fixture, "devices");
        let mut book = Book::parse(&parse(&reloaded));
        let (a, b, c) = (
            text(&fixture["ids"], "a"),
            text(&fixture["ids"], "b"),
            text(&fixture["ids"], "c"),
        );
        let push = book.get(&a).unwrap().push.clone().unwrap();
        assert!(book.set_push(&a, push).0);
        let prefs = book.get(&b).unwrap().ui_prefs.clone();
        assert!(book.set_ui_prefs(&b, prefs).0);
        let patch = |limits, usage| {
            let mut object = Map::new();
            object.insert("limits".into(), limits);
            object.insert("usage".into(), usage);
            Patch::from_json(&object).unwrap()
        };
        assert!(
            book.update(
                &a,
                patch(
                    json!({"requestsPerDay": 5}),
                    json!({"day": "2026-11-12", "requests": 2, "tokens": 900})
                )
            )
            .0
        );
        // Written as the quota writes it: members in the order the caller built them.
        assert!(
            book.update(
                &c,
                patch(
                    json!({"tokensPerDay": 100000, "requestsPerDay": 0}),
                    json!(null)
                )
            )
            .0
        );
        assert_eq!(book.get(&c).unwrap().usage, None, "null removes a member");
        assert!(book.rename(&c, "  Studio Mac\u{a0}").0);
        assert!(
            book.set_grants(
                &c,
                &[
                    "device-self".into(),
                    "workspace".into(),
                    "pairing-admin".into()
                ]
            )
            .0
        );
        assert_eq!(document_text(&book.document()), reloaded);
    }

    #[test]
    fn an_entry_that_does_not_read_is_dropped_alone() {
        let good = |id: &str| -> Value {
            json!({"deviceId": id, "name": "n", "userAgent": "u", "tailscaleLogin": null, "nodeId": "n1",
                "secretSha256": "0".repeat(64), "publicKeyJwk": null, "grants": ["workspace"], "uiPrefs": {},
                "createdAt": 1})
        };
        let with = |key: &str, value: Value| {
            let mut entry = good("x");
            entry[key] = value;
            entry
        };
        let without = |key: &str| {
            let mut entry = good("x");
            entry.as_object_mut().unwrap().remove(key);
            entry
        };
        for (why, entry) in [
            ("an empty id", with("deviceId", json!(""))),
            ("a number as the name", with("name", json!(1))),
            ("no login member at all", without("tailscaleLogin")),
            ("a number as the node", with("nodeId", json!(7))),
            (
                "a hash in capitals",
                with("secretSha256", json!("A".repeat(64))),
            ),
            ("a short hash", with("secretSha256", json!("0".repeat(63)))),
            ("no key member", without("publicKeyJwk")),
            ("a key that is a string", with("publicKeyJwk", json!("jwk"))),
            (
                "a grant that is none",
                with("grants", json!(["workspace", "root"])),
            ),
            (
                "grants that are no list",
                with("grants", json!("workspace")),
            ),
            ("prefs that are a list", with("uiPrefs", json!([]))),
            ("no creation time", without("createdAt")),
            ("a time that is text", with("createdAt", json!("1"))),
            ("a last seen that is text", with("lastSeenAt", json!("1"))),
            (
                "a negative limit",
                with("limits", json!({"requestsPerDay": -1})),
            ),
            (
                "a fractional limit",
                with("limits", json!({"tokensPerDay": 1.5})),
            ),
            ("limits that are null", with("limits", json!(null))),
            (
                "usage without a day",
                with("usage", json!({"requests": 1, "tokens": 1})),
            ),
            ("an entry that is no object", json!("device")),
        ] {
            let document = json!({"v": 1, "devices": [good("first"), entry, good("last")]});
            let book = Book::parse(&document);
            let ids: Vec<String> = book
                .records()
                .iter()
                .map(|r| r["deviceId"].as_str().unwrap().to_owned())
                .collect();
            assert_eq!(ids, ["first", "last"], "{why}");
        }
        // What is kept: a pairing the file spells with no node member, and the `pairing-admin` a hand wrote.
        let named = |id: &str, mut entry: Value| {
            entry["deviceId"] = json!(id);
            entry
        };
        let kept = Book::parse(&json!({"v": 1, "devices": [
            named("a", without("nodeId")),
            named("b", with("grants", json!(["pairing-admin"]))),
            named("c", with("lastSeenAt", json!(5))),
            named("a", with("name", json!("again")))]}));
        let ids: Vec<_> = kept
            .records()
            .iter()
            .map(|r| r["deviceId"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            ids,
            ["a", "b", "c"],
            "a second entry of one id replaces the first where it stood"
        );
        assert_eq!(kept.get("a").unwrap().name, "again");
        assert_eq!(kept.get("c").unwrap().last_seen_at, Some(5));
        assert_eq!(
            kept.get("b").unwrap().grants,
            ["pairing-admin"],
            "grants are read as stored, not sanitised"
        );
        // A document that is not a version-1 list holds no devices.
        for document in [
            json!(null),
            json!([]),
            json!({"devices": [good("a")]}),
            json!({"v": 2, "devices": [good("a")]}),
            json!({"v": 1, "devices": {"a": good("a")}}),
        ] {
            assert!(Book::parse(&document).records().is_empty(), "{document}");
        }
    }

    #[test]
    fn a_damaged_push_block_costs_the_device_only_its_notification_settings() {
        let entry = |push: Value| {
            json!({"v": 1, "devices": [{"deviceId": "d", "name": "n", "userAgent": "u", "tailscaleLogin": null,
                "secretSha256": "0".repeat(64), "publicKeyJwk": null, "grants": [], "uiPrefs": {},
                "createdAt": 1, "push": push}]})
        };
        for damaged in [
            json!({"subscription": {"endpoint": 1}, "hideContent": "x"}),
            json!({"subscription": {"endpoint": "", "keys": {"p256dh": "p", "auth": "a"}}, "hideContent": false, "categories": []}),
            json!({"subscription": null, "hideContent": false, "categories": ["ask", "news"]}),
            json!({"hideContent": false, "categories": []}),
            json!(null),
            json!("push"),
        ] {
            let book = Book::parse(&entry(damaged.clone()));
            let device = book.get("d").unwrap_or_else(|| panic!("kept: {damaged}"));
            assert_eq!(device.push, None, "{damaged}");
        }
        let book = Book::parse(&entry(
            json!({"subscription": {"endpoint": "https://push.example.com/a", "keys": {"p256dh": "p", "auth": "a", "extra": 1}},
                "hideContent": true, "categories": ["error"], "more": 1}),
        ));
        let push = book.get("d").unwrap().push.clone().unwrap();
        assert!(push.hide_content);
        assert_eq!(push.subscription.unwrap().auth, "a");
        assert_eq!(
            book.records()[0]["push"],
            json!({"subscription": {"endpoint": "https://push.example.com/a", "keys": {"p256dh": "p", "auth": "a"}},
                "hideContent": true, "categories": ["error"]}),
            "members the schema does not name are not kept"
        );
    }

    #[test]
    fn a_stored_key_that_is_no_p256_key_is_never_read_as_no_key() {
        let record = |jwk: Value| {
            json!({"v": 1, "devices": [{"deviceId": "d", "name": "n", "userAgent": "u", "tailscaleLogin": null,
                "secretSha256": "0".repeat(64), "publicKeyJwk": jwk, "grants": [], "uiPrefs": {}, "createdAt": 1}]})
        };
        let key = |jwk: Value| {
            Book::parse(&record(jwk))
                .get("d")
                .unwrap()
                .public_key
                .clone()
        };
        assert_eq!(key(json!(null)), None);
        let good = json!({"kty": "EC", "crv": "P-256", "x": "A".repeat(43), "y": "B".repeat(43), "ext": true});
        assert_eq!(
            key(good.clone()),
            Some(PublicKey {
                x: "A".repeat(43),
                y: "B".repeat(43)
            })
        );
        for broken in [
            json!({}),
            json!({"kty": "oct", "k": "x"}),
            json!({"kty": "EC", "crv": "P-256", "x": "short", "y": "B"}),
        ] {
            let unusable = key(broken.clone()).unwrap_or_else(|| panic!("{broken}"));
            assert!(
                !verify_device_proof(&unusable, "nonce", &"A".repeat(86)),
                "{broken}: the device cannot sign in, as verifyDeviceProof said false for it"
            );
        }
        // The record keeps the key as it was written, extra members and all.
        assert_eq!(
            Book::parse(&record(good.clone())).records()[0]["publicKeyJwk"],
            good
        );
    }

    #[test]
    fn a_new_device_keeps_the_key_it_paired_with() {
        let mut book = Book::default();
        let key = PublicKey {
            x: "A".repeat(43),
            y: "B".repeat(43),
        };
        let ((device, cookie), effect) = book.create(
            NewDevice {
                public_key: Some(key.clone()),
                ..phone("  iPhone ")
            },
            9,
        );
        assert_eq!(
            effect,
            Effect {
                saved: true,
                announce: true,
                revoked: None
            }
        );
        assert_eq!(device.name, "iPhone");
        assert_eq!(device.public_key, Some(key));
        assert_eq!(
            book.records()[0]["publicKeyJwk"],
            json!({"kty": "EC", "crv": "P-256", "x": "A".repeat(43), "y": "B".repeat(43)})
        );
        assert!(cookie.starts_with(&format!("{}.", device.device_id)));
    }

    #[test]
    fn names_trim_as_javascript_trims_and_count_utf16_units() {
        let mut book = Book::default();
        let ((device, _), _) = book.create(phone(" \u{a0}\u{feff}\u{3000}Kitchen\u{2028}"), 1);
        // U+FEFF is white space to `trim()` too.
        assert_eq!(device.name, "Kitchen");
        let id = device.device_id;
        assert!(
            !book.rename(&id, " \t\n\u{a0}").0,
            "an empty name is refused"
        );
        assert!(!book.rename("ghost", "x").0);
        let long = format!("{}{}", "a".repeat(79), "\u{1F600}");
        assert!(book.rename(&id, &long).0);
        assert_eq!(
            book.get(&id).unwrap().name.chars().count(),
            79,
            "the emoji would be units 80 and 81"
        );
        assert!(book.rename(&id, &"b".repeat(90)).0);
        assert_eq!(book.get(&id).unwrap().name.len(), 80);
    }

    #[test]
    fn the_secret_is_compared_whole_and_in_constant_time() {
        // `ct_eq` over the two 64-character hashes: a secret that differs in its last character, in its first, or
        // in length is each a mismatch, and none of them is told apart from the others.
        let mut book = Book::default();
        let ((device, cookie), _) = book.create(phone("p"), 1);
        let (id, secret) = cookie.split_once('.').unwrap();
        let flipped = |at: usize| {
            let mut s = secret.to_owned().into_bytes();
            s[at] = if s[at] == b'A' { b'B' } else { b'A' };
            String::from_utf8(s).unwrap()
        };
        for wrong in [
            flipped(0),
            flipped(42),
            format!("{secret}x"),
            secret[1..].to_owned(),
            "x".into(),
        ] {
            assert_eq!(
                book.authenticate(&format!("{id}.{wrong}"), 2).0,
                AuthResult::Mismatch,
                "{wrong}"
            );
        }
        assert!(matches!(book.authenticate(&cookie, 2).0, AuthResult::Ok(_)));
        assert_eq!(device.secret_sha256.len(), 64);
    }

    #[test]
    fn a_touch_is_written_at_most_once_a_minute_and_expiry_removes_the_record() {
        let mut book = Book::default();
        let ((device, cookie), _) = book.create(phone("p"), 1_000);
        let at = |book: &mut Book, now: i64| book.authenticate(&cookie, now);
        assert_eq!(
            at(&mut book, 1_000 + 59_999).1,
            Effect::default(),
            "inside the minute: nothing to write"
        );
        let (result, effect) = at(&mut book, 1_000 + 60_000);
        assert!(matches!(&result, AuthResult::Ok(d) if d.last_seen_at == Some(61_000)));
        assert_eq!(
            effect,
            Effect {
                saved: true,
                announce: false,
                revoked: None
            },
            "a touch is written, never announced"
        );
        assert_eq!(at(&mut book, 61_000 + 59_999).1, Effect::default());
        // Sliding: 14 days since the last request.
        let (result, effect) = at(&mut book, 61_000 + 14 * DAY + 1);
        assert_eq!(result, AuthResult::Expired);
        assert_eq!(
            effect,
            Effect {
                saved: true,
                announce: true,
                revoked: Some(device.device_id.clone())
            }
        );
        assert_eq!(at(&mut book, 61_000).0, AuthResult::Unknown);
        // Absolute: 90 days since pairing, however recently it was used.
        let ((_, cookie), _) = book.create(phone("busy"), 0);
        let mut seen = 0;
        while seen < 90 * DAY {
            seen += 10 * DAY;
            let (result, _) = book.authenticate(&cookie, seen.min(90 * DAY));
            assert!(matches!(result, AuthResult::Ok(_)), "day {}", seen / DAY);
        }
        assert_eq!(
            book.authenticate(&cookie, 90 * DAY + 1).0,
            AuthResult::Expired
        );
    }
}

mod devices_store {
    use super::*;

    /// A store over a folder of its own, as `stores()` makes it but outside the process's registry.
    fn store(dir: &Path) -> Stores {
        Stores::load(dir)
    }

    #[tokio::test]
    async fn the_file_is_owner_only_holds_only_the_hash_and_loads_again() {
        let dir = scratch("file");
        let first = store(&dir);
        let (device, cookie) = first.devices.create(phone("iPhone"), 1_700_000_000_000);
        first.devices.flush().await.unwrap();
        let file = dir.join(DEVICES_FILE);
        let written = std::fs::read_to_string(&file).unwrap();
        let secret = cookie.split_once('.').unwrap().1;
        assert!(!written.contains(secret), "the secret is never on disk");
        assert!(written.contains(&device.secret_sha256));
        assert!(written.starts_with("{\n\t\"v\": 1,\n\t\"devices\": [\n\t\t{\n\t\t\t\"deviceId\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "no temp file is left: {names:?}");
        let again = store(&dir);
        assert!(matches!(
            again.devices.authenticate(&cookie, 1_700_000_001_000),
            AuthResult::Ok(d) if d.device_id == device.device_id
        ));
    }

    #[tokio::test]
    async fn the_touch_reaches_the_file_once_a_minute() {
        let dir = scratch("touch");
        let devices = store(&dir).devices;
        let (device, cookie) = devices.create(phone("p"), 1_000);
        devices.authenticate(&cookie, 1_000 + 30_000);
        devices.flush().await.unwrap();
        let seen = |dir: &Path| {
            on_disk(dir, DEVICES_FILE)["devices"][0]["lastSeenAt"]
                .as_i64()
                .unwrap()
        };
        assert_eq!(seen(&dir), 1_000);
        let before = locked(&devices.state).lane.saved;
        devices.authenticate(&cookie, 1_000 + 61_000);
        devices.authenticate(&cookie, 1_000 + 100_000);
        devices.flush().await.unwrap();
        assert_eq!(seen(&dir), 62_000);
        assert_eq!(
            locked(&devices.state).lane.saved,
            before + 1,
            "the second request wrote nothing"
        );
        // Expiry deletes the record from the file.
        assert_eq!(
            devices.authenticate(&cookie, 62_000 + 15 * DAY),
            AuthResult::Expired
        );
        devices.flush().await.unwrap();
        assert!(
            on_disk(&dir, DEVICES_FILE)["devices"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(devices.get(&device.device_id).is_none());
    }

    #[tokio::test]
    async fn writes_keep_their_order_and_the_flush_answers_after_the_last_is_on_disk() {
        let dir = scratch("order");
        let devices = store(&dir).devices;
        let (device, _) = devices.create(phone("p"), 1);
        for step in 0..300_u64 {
            devices.apply(Some(step + 1), |book| {
                book.rename(&device.device_id, &format!("name {step}"))
            });
        }
        devices.flush().await.unwrap();
        assert_eq!(
            on_disk(&dir, DEVICES_FILE)["devices"][0]["name"],
            "name 299"
        );
        // A flush with nothing queued answers at once.
        devices.flush().await.unwrap();
        // And a change made after it is written by the next one.
        devices.apply(Some(301), |book| book.rename(&device.device_id, "last"));
        devices.flush().await.unwrap();
        assert_eq!(on_disk(&dir, DEVICES_FILE)["devices"][0]["name"], "last");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_write_that_fails_is_answered_by_the_flush_that_waited_for_it() {
        let dir = scratch("failing");
        // A folder where the file belongs: the rename over it is refused.
        std::fs::create_dir_all(dir.join(DEVICES_FILE)).unwrap();
        let devices = store(&dir).devices;
        devices.create(phone("p"), 1);
        let fault = devices.flush().await.unwrap_err();
        assert_eq!(fault.code, "save_failed");
        std::fs::remove_dir_all(dir.join(DEVICES_FILE)).unwrap();
        devices.apply(Some(1), |book| book.revoke("none"));
        devices.create(phone("again"), 2);
        devices.flush().await.unwrap();
    }

    #[tokio::test]
    async fn every_change_tells_main_the_whole_list_in_order() {
        let dir = scratch("events");
        let stores = store(&dir);
        let (sink, _keep, mut frames) = events();
        stores.hub.attach("main's userData", &sink);
        let devices = &stores.devices;
        let (device, cookie) = devices.create(phone("p"), 100);
        let id = device.device_id.clone();
        let sent = told(&mut frames);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "web.devices.changed");
        assert_eq!(sent[0].1["userData"], "main's userData");
        assert_eq!(
            sent[0].1["notify"], true,
            "a device the edge paired: the settings page shows it"
        );
        assert_eq!(sent[0].1["ack"], 0);
        assert_eq!(sent[0].1["devices"][0]["deviceId"], id.as_str());
        let first_version = sent[0].1["version"].as_u64().unwrap();
        // A touch: told so main's copy has lastSeenAt, but nothing to announce.
        devices.authenticate(&cookie, 100 + 61_000);
        let sent = told(&mut frames);
        assert_eq!((sent.len(), sent[0].1["notify"].clone()), (1, json!(false)));
        // A request that changes nothing says nothing.
        devices.authenticate(&cookie, 100 + 61_001);
        devices.authenticate("ghost.x", 1);
        assert!(told(&mut frames).is_empty());
        // Main's changes: answered with the ack, even by one that changed nothing.
        devices.apply(Some(7), |book| book.rename(&id, "Kitchen"));
        devices.apply(Some(8), |book| book.rename("ghost", "x"));
        devices.apply(Some(9), |book| {
            book.set_ui_prefs(&id, json!({"theme": "dark"}))
        });
        let sent = told(&mut frames);
        let acks: Vec<_> = sent
            .iter()
            .map(|(_, d)| d["ack"].as_u64().unwrap())
            .collect();
        assert_eq!(acks, [7, 8, 9]);
        assert!(
            sent.iter()
                .all(|(e, d)| e == "web.devices.changed" && d["notify"] == false)
        );
        let versions: Vec<_> = sent
            .iter()
            .map(|(_, d)| d["version"].as_u64().unwrap())
            .collect();
        assert!(
            versions[0] > first_version && versions.windows(2).all(|w| w[0] < w[1]),
            "{versions:?}"
        );
        assert_eq!(sent[0].1["devices"][0]["name"], "Kitchen");
        assert_eq!(sent[2].1["devices"][0]["uiPrefs"], json!({"theme": "dark"}));
        assert_eq!(
            locked(&devices.state).lane.saved,
            4,
            "a change that changed nothing wrote nothing"
        );
        // A revoke by main: the removal first, then the list without it.
        devices.apply(Some(10), |book| book.revoke(&id));
        let sent = told(&mut frames);
        assert_eq!(
            sent.iter().map(|(e, _)| e.as_str()).collect::<Vec<_>>(),
            ["web.devices.revoked", "web.devices.changed"]
        );
        assert_eq!(sent[0].1["deviceId"], id.as_str());
        assert_eq!(sent[1].1["devices"], json!([]));
        assert_eq!(sent[1].1["notify"], false, "main announced its own revoke");
    }

    #[tokio::test]
    async fn an_expired_device_is_revoked_to_main_and_announced() {
        let dir = scratch("expired");
        let stores = store(&dir);
        let (sink, _keep, mut frames) = events();
        stores.hub.attach("ud", &sink);
        let (device, cookie) = stores.devices.create(phone("p"), 0);
        told(&mut frames);
        assert_eq!(
            stores.devices.authenticate(&cookie, 91 * DAY),
            AuthResult::Expired
        );
        let sent = told(&mut frames);
        assert_eq!(
            sent.iter().map(|(e, _)| e.as_str()).collect::<Vec<_>>(),
            ["web.devices.revoked", "web.devices.changed"]
        );
        assert_eq!(sent[0].1["deviceId"], device.device_id.as_str());
        assert_eq!(sent[1].1["notify"], true);
        assert_eq!(sent[1].1["devices"], json!([]));
    }

    #[tokio::test]
    async fn push_settings_forgetting_and_quota_follow_the_typescripts_rules() {
        let dir = scratch("push");
        let devices = store(&dir).devices;
        let (a, _) = devices.create(phone("a"), 1);
        let (b, _) = devices.create(phone("b"), 2);
        let (never, _) = devices.create(phone("never"), 3);
        let settings = |name: &str, hide: bool, categories: &[&str]| PushSettings {
            subscription: Some(crate::web::devices::PushSubscription {
                endpoint: format!("https://push.example.com/{name}"),
                p256dh: "p".repeat(87),
                auth: "a".repeat(22),
            }),
            hide_content: hide,
            categories: categories.iter().map(|c| (*c).to_owned()).collect(),
        };
        assert!(devices.set_push(&a.device_id, settings("old", true, &["error"])));
        assert!(devices.set_push(&a.device_id, settings("fresh", true, &["error"])));
        assert!(!devices.set_push("ghost", settings("x", false, &[])));
        // Only while it is still the endpoint the push service refused.
        assert!(!devices.apply(Some(1), |book| {
            book.forget_push(&a.device_id, "https://push.example.com/old")
        }));
        assert!(
            devices
                .get(&a.device_id)
                .unwrap()
                .push
                .unwrap()
                .subscription
                .is_some()
        );
        assert!(devices.apply(Some(2), |book| {
            book.forget_push(&a.device_id, "https://push.example.com/fresh")
        }));
        let kept = devices.get(&a.device_id).unwrap().push.unwrap();
        assert_eq!(
            (kept.subscription, kept.hide_content, kept.categories),
            (None, true, vec!["error".to_owned()])
        );
        assert!(!devices.apply(Some(3), |book| {
            book.forget_push(&a.device_id, "https://push.example.com/fresh")
        }));
        assert!(!devices.apply(Some(4), |book| book.forget_push("ghost", "x")));
        // A new VAPID key: every subscription goes, the preferences stay, a device that never subscribed stays as is.
        assert!(devices.set_push(&a.device_id, settings("a", true, &["ask"])));
        assert!(devices.set_push(&b.device_id, settings("b", false, &["error"])));
        assert_eq!(devices.apply(Some(5), |book| book.drop_all_push()), 2);
        assert_eq!(devices.apply(Some(6), |book| book.drop_all_push()), 0);
        assert_eq!(
            devices.get(&a.device_id).unwrap().push.unwrap().categories,
            ["ask"]
        );
        assert!(
            devices
                .get(&b.device_id)
                .unwrap()
                .push
                .unwrap()
                .subscription
                .is_none()
        );
        assert_eq!(devices.get(&never.device_id).unwrap().push, None);
        // Quota: limits and usage ride the record; a limit of `null` removes it.
        let update = |devices: &FileDevices, seq: u64, patch: Value| {
            let patch = Patch::from_json(patch.as_object().unwrap()).unwrap();
            devices.apply(Some(seq), |book| book.update(&b.device_id, patch))
        };
        assert!(update(
            &devices,
            7,
            json!({"limits": {"requestsPerDay": 2}, "usage": {"day": "2026-11-12", "requests": 1, "tokens": 5}})
        ));
        assert!(update(
            &devices,
            8,
            json!({"usage": {"day": "2026-11-12", "requests": 2, "tokens": 500}})
        ));
        devices.flush().await.unwrap();
        let record = on_disk(&dir, DEVICES_FILE)["devices"][1].clone();
        assert_eq!(
            record["limits"],
            json!({"requestsPerDay": 2}),
            "limits are left alone by a patch without them"
        );
        assert_eq!(
            record["usage"],
            json!({"day": "2026-11-12", "requests": 2, "tokens": 500})
        );
        assert!(update(&devices, 9, json!({"limits": null})));
        assert!(devices.get(&b.device_id).unwrap().limits.is_none());
        let unreadable = json!({"limits": {"requestsPerDay": -5}});
        assert!(Patch::from_json(unreadable.as_object().unwrap()).is_none());
        assert!(Patch::from_json(json!({"usage": {"day": 1}}).as_object().unwrap()).is_none());
        // Never `pairing-admin`, in what a device was made with and what a person grants later.
        assert!(devices.apply(Some(11), |book| book.set_grants(
            &a.device_id,
            &["pairing-admin".into(), "device-self".into()]
        )));
        assert_eq!(devices.get(&a.device_id).unwrap().grants, ["device-self"]);
    }

    #[test]
    fn the_same_folder_is_the_same_store_for_the_edge_and_for_main() {
        let dir = scratch("same");
        let devices = FileDevices::open(&dir);
        let blocks = FileBlocks::open(&dir);
        assert!(Arc::ptr_eq(&devices, &FileDevices::open(&dir)));
        assert!(Arc::ptr_eq(&devices, &stores(&dir).devices));
        assert!(Arc::ptr_eq(&blocks, &stores(&dir).blocks));
        assert!(!Arc::ptr_eq(
            &devices,
            &FileDevices::open(&scratch("other"))
        ));
        // A device the edge pairs is the one main's request sees.
        let (device, _) = devices.create(phone("p"), 1);
        assert!(stores(&dir).devices.get(&device.device_id).is_some());
    }
}

mod blocks {
    use super::*;

    #[test]
    fn the_typescripts_blocks_read_and_write_back_byte_for_byte() {
        let fixture = captured();
        let file = text(&fixture, "blocks");
        let book = BlockBook::parse(&parse(&file));
        assert_eq!(document_text(&book.document()), file);
        assert_eq!(book.records().len(), 3);
    }

    #[test]
    fn the_typescripts_verdicts_are_ours_over_a_grid_of_visitors() {
        let fixture = captured();
        let book = BlockBook::parse(&parse(&text(&fixture, "blocks")));
        let rows = fixture["verdicts"].as_array().unwrap();
        assert_eq!(rows.len(), 55);
        for row in rows {
            let node = row["nodeId"].as_str();
            let login = row["login"].as_str();
            assert_eq!(
                verdict_json(book.check(node, login)),
                row["verdict"],
                "{node:?} {login:?}"
            );
        }
    }

    #[test]
    fn adding_and_lifting_replay_the_typescripts_file() {
        let fixture = captured();
        let mut book = BlockBook::default();
        let at = |n: u64| Number::from(n);
        book.add(
            BlockScope::Node,
            "nPHONE1",
            "s25u",
            Some("Me@Example.com".into()),
            at(42),
        );
        book.add(
            BlockScope::Login,
            "  Gone@Example.com ",
            "tablet \"x\"",
            Some("gone@example.com".into()),
            at(42),
        );
        book.add(BlockScope::Node, "nOLD", "old", None, at(42));
        book.add(
            BlockScope::Node,
            "nOLD",
            "new",
            Some("kim@example.com".into()),
            at(42),
        );
        assert_eq!(document_text(&book.document()), text(&fixture, "blocks"));
        assert!(!book.remove("node:missing"));
        assert!(book.remove("node:nOLD"));
        assert!(book.remove("node:nPHONE1"));
        assert!(book.remove("login:gone@example.com"));
        assert!(!book.active());
        assert_eq!(book.check(Some("nPHONE1"), None), None);
    }

    #[test]
    fn one_entry_that_does_not_read_leaves_the_whole_file_unread() {
        let entry = |id: &str| json!({"id": id, "scope": "node", "name": "n", "tailscaleLogin": null, "blockedAt": 1});
        assert_eq!(
            BlockBook::parse(&json!({"v": 1, "blocked": [entry("node:a"), entry("node:b")]}))
                .records()
                .len(),
            2
        );
        for broken in [
            json!({"id": "", "scope": "node", "name": "n", "tailscaleLogin": null, "blockedAt": 1}),
            json!({"id": "x", "scope": "tailnet", "name": "n", "tailscaleLogin": null, "blockedAt": 1}),
            json!({"id": "x", "scope": "node", "tailscaleLogin": null, "blockedAt": 1}),
            json!({"id": "x", "scope": "node", "name": "n", "blockedAt": 1}),
            json!({"id": "x", "scope": "node", "name": "n", "tailscaleLogin": null, "blockedAt": "1"}),
            json!("entry"),
        ] {
            let book = BlockBook::parse(
                &json!({"v": 1, "blocked": [entry("node:a"), broken.clone(), entry("node:b")]}),
            );
            assert!(book.records().is_empty(), "{broken}");
            assert!(!book.active());
        }
        for document in [
            json!(null),
            json!({"v": 2, "blocked": []}),
            json!({"blocked": []}),
            json!({"v": 1, "blocked": "x"}),
        ] {
            assert!(
                BlockBook::parse(&document).records().is_empty(),
                "{document}"
            );
        }
    }

    #[tokio::test]
    async fn main_adds_and_lifts_through_the_store_and_the_edge_sees_it_at_once() {
        let dir = scratch("blocks");
        let stores = Stores::load(&dir);
        let (sink, _keep, mut frames) = events();
        stores.hub.attach("ud", &sink);
        assert!(!stores.blocks.active());
        let add = |seq: u64, key: &str, name: &str| {
            stores.blocks.apply(seq, |book| {
                (
                    book.add(
                        BlockScope::Node,
                        key,
                        name,
                        Some("me@example.com".into()),
                        Number::from(42),
                    ),
                    true,
                )
            })
        };
        let entry: BlockEntry = add(1, "nPHONE1", "old");
        assert_eq!(entry.id, "node:nPHONE1");
        add(2, "nPHONE1", "new");
        assert!(stores.blocks.active());
        assert!(matches!(
            stores.blocks.check(Some("nPHONE1"), None),
            Some(Verdict::Entry(e)) if e.name == "new"
        ));
        assert_eq!(
            stores.blocks.check(None, Some("ME@example.com")),
            Some(Verdict::Unidentified)
        );
        let sent = told(&mut frames);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1].0, "web.blocks.changed");
        assert_eq!(
            (sent[1].1["ack"].clone(), sent[1].1["userData"].clone()),
            (json!(2), json!("ud"))
        );
        assert_eq!(
            sent[1].1["blocks"].as_array().unwrap().len(),
            1,
            "the same key is replaced"
        );
        // Lifting what is not there changes nothing, and is still answered (the ack).
        assert!(!stores.blocks.apply(3, |book| {
            let removed = book.remove("node:missing");
            (removed, removed)
        }));
        assert_eq!(told(&mut frames)[0].1["ack"], 3);
        stores.blocks.flush().await.unwrap();
        assert_eq!(on_disk(&dir, BLOCKS_FILE)["blocked"][0]["name"], "new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(BLOCKS_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let again = Stores::load(&dir);
        assert!(again.blocks.active());
        assert_eq!(
            again
                .blocks
                .check(Some("nPHONE1"), None)
                .map(|v| matches!(v, Verdict::Entry(_))),
            Some(true)
        );
    }

    #[test]
    fn a_missing_or_corrupt_file_starts_empty() {
        let dir = scratch("empty");
        assert!(!Stores::load(&dir).blocks.active());
        std::fs::write(dir.join(BLOCKS_FILE), "not json").unwrap();
        std::fs::write(dir.join(DEVICES_FILE), "{").unwrap();
        let loaded = Stores::load(&dir);
        assert!(!loaded.blocks.active());
        assert!(loaded.devices.snapshot().list.is_empty());
        assert_eq!(loaded.devices.snapshot().version, 1);
    }
}

mod secret {
    use super::*;

    fn valid(secret: &str) -> bool {
        secret.len() == 43
            && secret
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }

    #[test]
    fn the_typescripts_file_is_read_and_ours_has_its_shape() {
        let fixture = captured();
        let dir = scratch("secret-ts");
        std::fs::write(dir.join(SECRET_FILE), text(&fixture, "secretFile")).unwrap();
        assert_eq!(serve_secret(&dir).unwrap(), text(&fixture, "secret"));
        let made = serve_secret(&scratch("secret-new")).unwrap();
        assert!(valid(&made), "{made}");
        // The TypeScript's own file is `JSON.stringify({v: 1, secret}, null, "\t")` and a newline.
        assert_eq!(
            text(&fixture, "secretFile"),
            format!(
                "{{\n\t\"v\": 1,\n\t\"secret\": \"{}\"\n}}\n",
                text(&fixture, "secret")
            )
        );
    }

    #[test]
    fn a_new_secret_is_256_bits_saved_before_it_is_returned_and_given_again() {
        let dir = scratch("secret");
        let secret = serve_secret(&dir).unwrap();
        assert!(valid(&secret));
        let file = dir.join(SECRET_FILE);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!("{{\n\t\"v\": 1,\n\t\"secret\": \"{secret}\"\n}}\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(serve_secret(&dir).unwrap(), secret);
        assert_ne!(
            serve_secret(&scratch("secret-other")).unwrap(),
            secret,
            "no two installs share one"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_file_that_is_unusable_makes_a_new_secret() {
        let dir = scratch("secret-bad");
        let file = dir.join(SECRET_FILE);
        let mut seen = vec![];
        for bad in [
            "not json".to_owned(),
            json!({"v": 1, "secret": "short"}).to_string(),
            json!({"v": 1, "secret": "A".repeat(44)}).to_string(),
            json!({"v": 1, "secret": format!("{}!", "A".repeat(42))}).to_string(),
            json!({"v": 1, "secret": format!("{}\n", "A".repeat(42))}).to_string(),
            json!({"v": 2, "secret": "A".repeat(43)}).to_string(),
            json!({"secret": "A".repeat(43)}).to_string(),
            json!({"v": 1}).to_string(),
        ] {
            std::fs::write(&file, &bad).unwrap();
            let made = serve_secret(&dir).unwrap();
            assert!(valid(&made) && made != "A".repeat(43), "{bad}");
            assert!(!seen.contains(&made));
            assert_eq!(
                serve_secret(&dir).unwrap(),
                made,
                "{bad}: and the new one is kept"
            );
            seen.push(made);
        }
    }

    #[test]
    fn two_first_calls_at_once_make_one_secret() {
        let dir = scratch("secret-race");
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || serve_secret(&dir).unwrap())
            })
            .collect();
        let secrets: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(secrets.iter().all(|s| *s == secrets[0]), "{secrets:?}");
        assert_eq!(serve_secret(&dir).unwrap(), secrets[0]);
    }
}

mod wire {
    use super::*;
    use tokio::io::{BufReader, DuplexStream, ReadHalf, WriteHalf};

    struct Session {
        lines: BufReader<ReadHalf<DuplexStream>>,
        input: WriteHalf<DuplexStream>,
        server: tokio::task::JoinHandle<std::io::Result<()>>,
    }

    async fn start() -> Session {
        let mut registry = Registry::default();
        register(&mut registry);
        let (client, server_io) = tokio::io::duplex(1 << 20);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(crate::server::serve(server_read, server_write, registry));
        let (client_read, input) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read);
        let mut ready = String::new();
        lines.read_line(&mut ready).await.unwrap();
        assert!(ready.contains("\"event\":\"ready\""), "{ready}");
        Session {
            lines,
            input,
            server,
        }
    }

    impl Session {
        async fn send(&mut self, line: Value) {
            self.input
                .write_all(format!("{line}\n").as_bytes())
                .await
                .unwrap();
        }

        async fn next(&mut self) -> Value {
            let mut line = String::new();
            self.lines.read_line(&mut line).await.unwrap();
            parse(&line)
        }

        async fn finish(mut self) {
            self.input.shutdown().await.unwrap();
            drop(self.input);
            self.server.await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn open_gives_the_snapshot_pushes_are_answered_with_events_and_flush_waits_for_the_disk()
    {
        let dir = scratch("wire");
        let ud = dir.to_string_lossy().into_owned();
        let fixture = captured();
        std::fs::write(dir.join(DEVICES_FILE), text(&fixture, "devices")).unwrap();
        std::fs::write(dir.join(BLOCKS_FILE), text(&fixture, "blocks")).unwrap();
        let mut session = start().await;
        session
            .send(json!({"id": 1, "method": "web.devices.open", "params": {"userData": ud}}))
            .await;
        let opened = session.next().await;
        assert_eq!(opened["id"], 1);
        let result = &opened["result"];
        assert_eq!(result["devices"]["list"].as_array().unwrap().len(), 3);
        assert_eq!(result["blocks"]["list"].as_array().unwrap().len(), 3);
        assert_eq!(
            (
                result["devices"]["ack"].clone(),
                result["blocks"]["ack"].clone()
            ),
            (json!(0), json!(0))
        );
        let a = text(&fixture["ids"], "a");
        // Pushes: no answer frame, one event each, in the order sent.
        for (seq, name) in [(1, "One"), (2, "Two")] {
            session.send(json!({"push": "web.devices.rename", "params": {"userData": ud, "seq": seq, "deviceId": a, "name": name}})).await;
        }
        session.send(json!({"push": "web.blocks.add", "params": {"userData": ud, "seq": 1, "scope": "login", "key": "Kim@Example.com", "name": "Kim", "tailscaleLogin": null, "now": 77}})).await;
        session.send(json!({"push": "web.devices.setUiPrefs", "params": {"userData": ud, "seq": 3, "deviceId": a, "uiPrefs": {"theme": "light"}}})).await;
        session
            .send(json!({"push": "web.devices.nonsense", "params": {}}))
            .await;
        session
            .send(json!({"push": "web.devices.rename", "params": {"seq": "x"}}))
            .await;
        session
            .send(json!({"id": 2, "method": "web.devices.flush", "params": {"userData": ud}}))
            .await;
        let mut told = vec![];
        let flushed = loop {
            let frame = session.next().await;
            if frame["id"] == 2 {
                break frame;
            }
            told.push(frame);
        };
        assert_eq!(flushed["ok"], true);
        assert_eq!(
            told.iter()
                .map(|f| f["event"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "web.devices.changed",
                "web.devices.changed",
                "web.blocks.changed",
                "web.devices.changed"
            ]
        );
        let acks: Vec<_> = told
            .iter()
            .map(|f| f["data"]["ack"].as_u64().unwrap())
            .collect();
        assert_eq!(acks, [1, 2, 1, 3]);
        assert!(told.iter().all(|f| f["data"]["userData"] == ud.as_str()));
        // The flush answered after the last write: the file already says so.
        let on_disk_now = on_disk(&dir, DEVICES_FILE);
        assert_eq!(on_disk_now["devices"][0]["name"], "Two");
        assert_eq!(
            on_disk_now["devices"][2]["uiPrefs"],
            json!({}),
            "only the named device changed"
        );
        assert_eq!(
            on_disk_now["devices"][0]["uiPrefs"],
            json!({"theme": "light"})
        );
        let blocked = on_disk(&dir, BLOCKS_FILE);
        assert_eq!(blocked["blocked"][3]["id"], "login:kim@example.com");
        assert_eq!(blocked["blocked"][3]["blockedAt"], 77);
        session.finish().await;
    }

    #[tokio::test]
    async fn the_input_ending_flushes_what_was_pushed_but_not_yet_written() {
        let dir = scratch("wire-eof");
        let ud = dir.to_string_lossy().into_owned();
        let fixture = captured();
        std::fs::write(dir.join(DEVICES_FILE), text(&fixture, "devices")).unwrap();
        let mut session = start().await;
        let id = text(&fixture["ids"], "b");
        for seq in 1..=50 {
            session.send(json!({"push": "web.devices.rename", "params": {"userData": ud, "seq": seq, "deviceId": id, "name": format!("n{seq}")}})).await;
        }
        session.finish().await;
        assert_eq!(on_disk(&dir, DEVICES_FILE)["devices"][1]["name"], "n50");
    }

    #[tokio::test]
    async fn the_secret_request_answers_the_secret_the_file_holds() {
        let dir = scratch("wire-secret");
        let ud = dir.to_string_lossy().into_owned();
        let mut session = start().await;
        session
            .send(json!({"id": 1, "method": "web.secret", "params": {"userData": ud}}))
            .await;
        let answer = session.next().await;
        let secret = text(&answer["result"], "secret");
        assert_eq!(
            on_disk(&dir, SECRET_FILE),
            json!({"v": 1, "secret": secret})
        );
        session
            .send(json!({"id": 2, "method": "web.secret", "params": {"userData": ud}}))
            .await;
        assert_eq!(session.next().await["result"]["secret"], secret.as_str());
        session
            .send(json!({"id": 3, "method": "web.secret", "params": {}}))
            .await;
        assert_eq!(session.next().await["error"]["code"], "invalid_params");
        session.finish().await;
    }

    #[tokio::test]
    async fn the_edge_and_main_change_one_list() {
        let dir = scratch("wire-shared");
        let ud = dir.to_string_lossy().into_owned();
        let mut session = start().await;
        session
            .send(json!({"id": 1, "method": "web.devices.open", "params": {"userData": ud}}))
            .await;
        session.next().await;
        // The edge's side, through the same objects `web.start` would hand it.
        let edge: Arc<dyn Devices> = FileDevices::open(&dir);
        let (device, _cookie): (Device, String) = edge.create(phone("Paired by the edge"), 5);
        let created = session.next().await;
        assert_eq!(created["event"], "web.devices.changed");
        assert_eq!(created["data"]["notify"], true);
        assert_eq!(
            created["data"]["devices"][0]["deviceId"],
            device.device_id.as_str()
        );
        session.send(json!({"push": "web.devices.revoke", "params": {"userData": ud, "seq": 1, "deviceId": device.device_id}})).await;
        assert_eq!(session.next().await["event"], "web.devices.revoked");
        let changed = session.next().await;
        assert_eq!(
            (
                changed["data"]["ack"].clone(),
                changed["data"]["notify"].clone()
            ),
            (json!(1), json!(false))
        );
        assert!(FileDevices::open(&dir).get(&device.device_id).is_none());
        session.finish().await;
        assert!(
            on_disk(&dir, DEVICES_FILE)["devices"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
