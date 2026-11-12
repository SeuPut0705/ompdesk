//! This device's long-term remote identity (was `src/main/remote/identity.ts`): an X25519 key pair plus a random
//! 128-bit device id, kept in `<userData>/remote-identity.json` (mode 0600). A missing or damaged file mints a new
//! identity, which unpairs this device everywhere.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::crypto::{KeyPair, random_device_id};
use crate::disk::tree::write_atomic_if;

pub struct Identity {
    pub device_id: String,
    pub keys: KeyPair,
}

pub fn identity_file(user_data: &Path) -> PathBuf {
    user_data.join("remote-identity.json")
}

/// `^[0-9a-z]{26}$`.
fn is_device_id(id: &str) -> bool {
    id.len() == 26
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// What the file holds when it is a stored identity (`StoredIdentity`: `v` 1, a device id, both keys that import and
/// match); extra keys are ignored, as zod's object did.
fn stored(text: &str) -> Option<Identity> {
    let Value::Object(object) = serde_json::from_str(text).ok()? else {
        return None;
    };
    if object.get("v")?.as_f64() != Some(1.0) {
        return None;
    }
    let device_id = object
        .get("deviceId")?
        .as_str()
        .filter(|id| is_device_id(id))?;
    let keys = KeyPair::import(
        object.get("publicKey")?.as_str()?,
        object.get("privateKey")?.as_str()?,
    )
    .ok()?;
    Some(Identity {
        device_id: device_id.to_owned(),
        keys,
    })
}

/// The identity in `remote-identity.json`, or a fresh one written there (atomically, owner only).
pub fn load_or_create(user_data: &Path) -> io::Result<Identity> {
    let file = identity_file(user_data);
    if let Ok(bytes) = std::fs::read(&file)
        && let Some(identity) = stored(&String::from_utf8_lossy(&bytes))
    {
        return Ok(identity);
    }
    let identity = Identity {
        device_id: random_device_id(),
        keys: KeyPair::generate(),
    };
    // `JSON.stringify(value, null, "\t") + "\n"`: every value is base32 or base64url text.
    let text = format!(
        "{{\n\t\"v\": 1,\n\t\"deviceId\": \"{}\",\n\t\"publicKey\": \"{}\",\n\t\"privateKey\": \"{}\"\n}}\n",
        identity.device_id,
        identity.keys.public,
        identity.keys.export_private()
    );
    write_atomic_if(&file, text.as_bytes(), Some(0o600), 0o777, &|| true)
        .map_err(|fault| io::Error::other(fault.message))?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-identity-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A file the TypeScript's `writeSecureJson` wrote for the key pair of secret `[7; 32]`.
    fn typescript_file(device_id: &str, pair: &KeyPair) -> String {
        format!(
            "{{\n\t\"v\": 1,\n\t\"deviceId\": \"{device_id}\",\n\t\"publicKey\": \"{}\",\n\t\"privateKey\": \"{}\"\n}}\n",
            pair.public,
            pair.export_private()
        )
    }

    #[test]
    fn a_missing_file_makes_an_identity_that_loads_again() {
        let dir = scratch("fresh");
        let first = load_or_create(&dir).unwrap();
        assert!(is_device_id(&first.device_id));
        let text = std::fs::read_to_string(identity_file(&dir)).unwrap();
        assert_eq!(
            text,
            typescript_file(&first.device_id, &first.keys),
            "the file is JSON.stringify(value, null, \"\\t\") + \"\\n\""
        );
        let again = load_or_create(&dir).unwrap();
        assert_eq!(again.device_id, first.device_id);
        assert_eq!(again.keys.public, first.keys.public);
        assert_eq!(again.keys.export_private(), first.keys.export_private());
        // No temp file is left behind.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        load_or_create(&dir).unwrap();
        let mode = std::fs::metadata(identity_file(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_file_the_typescript_wrote_loads_unchanged_and_is_not_rewritten() {
        let dir = scratch("typescript");
        let pair = KeyPair::from_secret([7; 32]);
        let text = typescript_file("0123456789abcdefghjkmnpqrs", &pair);
        std::fs::write(identity_file(&dir), &text).unwrap();
        let loaded = load_or_create(&dir).unwrap();
        assert_eq!(loaded.device_id, "0123456789abcdefghjkmnpqrs");
        assert_eq!(loaded.keys.public, pair.public);
        assert_eq!(std::fs::read_to_string(identity_file(&dir)).unwrap(), text);
    }

    #[test]
    fn extra_keys_and_a_float_version_still_load() {
        let dir = scratch("extra");
        let pair = KeyPair::from_secret([9; 32]);
        let text = format!(
            r#"{{"v":1.0,"extra":[1,2],"deviceId":"0123456789abcdefghjkmnpqrs","publicKey":"{}","privateKey":"{}","deviceId":"zzzzzzzzzzzzzzzzzzzzzzzzzz"}}"#,
            pair.public,
            pair.export_private()
        );
        std::fs::write(identity_file(&dir), text).unwrap();
        // The last `deviceId` wins, as `JSON.parse` keeps it.
        assert_eq!(
            load_or_create(&dir).unwrap().device_id,
            "zzzzzzzzzzzzzzzzzzzzzzzzzz"
        );
    }

    #[test]
    fn a_file_that_fails_the_schema_or_the_keys_is_replaced() {
        let pair = KeyPair::from_secret([7; 32]);
        let other = KeyPair::from_secret([8; 32]);
        let good_id = "0123456789abcdefghjkmnpqrs";
        let public = &pair.public;
        let private = pair.export_private();
        let bad: Vec<String> = vec![
            String::new(),
            "not json".into(),
            "[]".into(),
            "null".into(),
            "{}".into(),
            "\u{feff}{}".into(),
            format!(
                r#"{{"v":2,"deviceId":"{good_id}","publicKey":"{public}","privateKey":"{private}"}}"#
            ),
            format!(
                r#"{{"v":"1","deviceId":"{good_id}","publicKey":"{public}","privateKey":"{private}"}}"#
            ),
            format!(
                r#"{{"deviceId":"{good_id}","publicKey":"{public}","privateKey":"{private}"}}"#
            ),
            format!(
                r#"{{"v":1,"deviceId":"{}","publicKey":"{public}","privateKey":"{private}"}}"#,
                &good_id[1..]
            ),
            format!(
                r#"{{"v":1,"deviceId":"{good_id}A","publicKey":"{public}","privateKey":"{private}"}}"#
            ),
            format!(
                r#"{{"v":1,"deviceId":"{}","publicKey":"{public}","privateKey":"{private}"}}"#,
                good_id.to_uppercase()
            ),
            format!(
                r#"{{"v":1,"deviceId":"{good_id}","publicKey":"{}","privateKey":"{private}"}}"#,
                other.public
            ),
            format!(r#"{{"v":1,"deviceId":"{good_id}","publicKey":5,"privateKey":"{private}"}}"#),
            format!(
                r#"{{"v":1,"deviceId":"{good_id}","publicKey":"{public}","privateKey":"short"}}"#
            ),
            format!(r#"{{"v":1,"deviceId":"{good_id}","publicKey":"{public}"}}"#),
        ];
        for (n, text) in bad.iter().enumerate() {
            let dir = scratch(&format!("bad{n}"));
            std::fs::write(identity_file(&dir), text).unwrap();
            let made = load_or_create(&dir).unwrap();
            assert_ne!(made.device_id, good_id, "case {n}");
            let rewritten = std::fs::read_to_string(identity_file(&dir)).unwrap();
            assert_eq!(
                rewritten,
                typescript_file(&made.device_id, &made.keys),
                "case {n}"
            );
        }
    }

    #[test]
    fn a_folder_where_the_file_belongs_is_no_identity_and_the_replace_fails() {
        let dir = scratch("dir");
        std::fs::create_dir(identity_file(&dir)).unwrap();
        // Nothing to read there, so a new identity is made, and the write over a folder fails like any write would.
        assert!(load_or_create(&dir).is_err());
    }
}
