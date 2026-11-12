//! Electron's `safeStorage` key, as Chromium's OSCrypt keeps it. The shell only finds the key; Node's shim does the
//! cipher with `node:crypto` (PROTOCOL.md §11), byte-identically, so values written by either app read in the other.
//!
//! - Windows `{kind: "win-v10", key}`: `<userData>/Local State` `os_crypt.encrypted_key` is base64 of `"DPAPI"` +
//!   the DPAPI-protected 32-byte AES key; values are `"v10"` + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag.
//! - macOS `{kind: "mac-v10-lazy"}`: reading the keychain item "ompdesk Safe Storage" at launch prompts the person
//!   (and fails on a locked or denied keychain), so `facts` does not touch it: Node's shim asks for the key when a
//!   secret is first needed, by running the shell once as `--keychain-key <userData>` (`sys_mac::keychain::cli`),
//!   which answers `{kind: "mac-v10", password}` or `{unavailable}`. Values are `"v10"` + AES-128-CBC (PKCS7, IV of
//!   16 spaces) under PBKDF2-HMAC-SHA1(password, "saltysalt", 1003 rounds); `mac_key` and `decrypt_v10_cbc` are that.
//! - `{unavailable: reason}` when the key is missing or unreadable. Never silent: the shim logs the reason.

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

const DPAPI_PREFIX: &[u8] = b"DPAPI";

/// The DPAPI-wrapped key bytes inside a `Local State` document (the `DPAPI` prefix stripped).
pub fn wrapped_key(local_state: &Value) -> Result<Vec<u8>, String> {
    let encoded = local_state["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or("Local State has no os_crypt.encrypted_key")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| format!("os_crypt.encrypted_key is not base64: {e}"))?;
    match bytes.strip_prefix(DPAPI_PREFIX) {
        Some(wrapped) if !wrapped.is_empty() => Ok(wrapped.to_vec()),
        _ => Err("os_crypt.encrypted_key lacks the DPAPI prefix".into()),
    }
}

/// `"DPAPI"` + the wrapped key, base64: the value `os_crypt.encrypted_key` holds.
pub fn encode_wrapped_key(wrapped: &[u8]) -> String {
    STANDARD.encode([DPAPI_PREFIX, wrapped].concat())
}

/// Windows OSCrypt `v10`: nonce(12) + ciphertext + tag(16).
pub fn decrypt_v10_gcm(key: &[u8], blob: &[u8]) -> Result<String, String> {
    let body = blob.strip_prefix(b"v10").ok_or_else(|| {
        format!(
            "not a v10 value (it starts {:?})",
            String::from_utf8_lossy(&blob[..blob.len().min(3)])
        )
    })?;
    if body.len() < 12 + 16 {
        return Err("a v10 value too short to hold a nonce and a tag".into());
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key)
        .map_err(|_| "the key is not 32 bytes".to_string())?;
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&body[..12]), &body[12..])
        .map_err(|_| "AES-GCM authentication failed".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

/// macOS: the AES-128 key the keychain password makes.
pub fn mac_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// macOS OSCrypt `v10`: AES-128-CBC, PKCS7, IV of 16 spaces.
pub fn decrypt_v10_cbc(password: &[u8], blob: &[u8]) -> Result<String, String> {
    use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    let body = blob.strip_prefix(b"v10").ok_or("not a v10 value")?;
    let key = mac_key(password);
    let plain = cbc::Decryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|e| format!("AES-CBC: {e}"))?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

/// macOS: no keychain read at launch (see the module docs); the key is fetched on demand by `--keychain-key`.
#[cfg(target_os = "macos")]
pub fn facts(_user_data: &Path, _log: &mut dyn FnMut(&str, Value)) -> Value {
    json!({ "kind": "mac-v10-lazy" })
}

/// What `hello` hands Node as `facts.safeStorage`, and why when there is none. Also proves the key on
/// `update-token.bin` when one exists (the GitHub update token): the line the shell logs says whether Electron's
/// own secret reads, without printing it.
#[cfg(not(target_os = "macos"))]
pub fn facts(user_data: &Path, log: &mut dyn FnMut(&str, Value)) -> Value {
    let found = platform_key(user_data);
    let token = user_data.join("update-token.bin");
    match &found {
        Ok(key) => {
            if let Ok(blob) = std::fs::read(&token) {
                let outcome = match key {
                    Key::Windows(key) => decrypt_v10_gcm(key, &blob),
                };
                match outcome {
                    Ok(plain) => log(
                        "migrate.token",
                        json!({ "ok": true, "chars": plain.chars().count() }),
                    ),
                    Err(error) => log("migrate.token", json!({ "ok": false, "error": error })),
                }
            }
            match key {
                Key::Windows(key) => json!({ "kind": "win-v10", "key": STANDARD.encode(key) }),
            }
        }
        Err(reason) => {
            log(
                "migrate.safeStorage",
                json!({ "ok": false, "error": reason }),
            );
            json!({ "unavailable": reason })
        }
    }
}

enum Key {
    Windows(Vec<u8>),
}

#[cfg(windows)]
fn platform_key(user_data: &Path) -> Result<Key, String> {
    let file = user_data.join("Local State");
    let state: Value = match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Local State: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("Local State: {e}")),
    };
    if state["os_crypt"]["encrypted_key"].is_null() {
        return create_key(&file, state).map(Key::Windows);
    }
    let wrapped = wrapped_key(&state)?;
    crate::sys::dpapi_unprotect(&wrapped).map(Key::Windows)
}

/// A clean profile (no `Local State`, or one without the key) gets the key Chromium would make, so an Electron
/// install that comes later reads what the shell encrypted.
#[cfg(windows)]
fn create_key(file: &Path, mut state: Value) -> Result<Vec<u8>, String> {
    let mut key = vec![0u8; 32];
    getrandom::fill(&mut key).map_err(|e| format!("random key: {e}"))?;
    let wrapped = crate::sys::dpapi_protect(&key)?;
    state["os_crypt"]["encrypted_key"] = Value::String(encode_wrapped_key(&wrapped));
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temp = file.with_extension("shell-tmp");
    std::fs::write(&temp, state.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, file).map_err(|e| e.to_string())?;
    Ok(key)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_key(_user_data: &Path) -> Result<Key, String> {
    Err("safeStorage is read on Windows and macOS only".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    // Vectors made with node:crypto (createCipheriv), the shim's cipher: `bun` over key 0x01..0x20, nonce 0xa0.., text
    // "ghp_exampletoken-값".
    const GCM_KEY: &str = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const GCM_BLOB: &str = "763130a0a1a2a3a4a5a6a7a8a9aaabdeb94d3998cd3b690f62c71f9eee45ea7a3d008bf602fb90a0659c96f955551307ad9271";
    const CBC_PASSWORD: &str = "5a6d3976596d4679596d463663585634"; // "Zm9vYmFyYmF6cXV4"
    const CBC_KEY: &str = "86d5ab176688dfd7718e471bb343e1d1";
    const CBC_BLOB: &str = "76313000544ab0e4d1a84dc8a082edb25eaf9936ff88e15bd0e00893e2c1b55861b991";

    #[test]
    fn a_windows_v10_value_from_node_crypto_reads() {
        assert_eq!(
            decrypt_v10_gcm(&hex(GCM_KEY), &hex(GCM_BLOB)).unwrap(),
            "ghp_exampletoken-값"
        );
    }

    #[test]
    fn a_tampered_or_foreign_windows_value_is_refused() {
        let mut blob = hex(GCM_BLOB);
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert!(
            decrypt_v10_gcm(&hex(GCM_KEY), &blob)
                .unwrap_err()
                .contains("authentication")
        );
        assert!(
            decrypt_v10_gcm(&hex(GCM_KEY), b"v11abc")
                .unwrap_err()
                .contains("not a v10")
        );
        assert!(
            decrypt_v10_gcm(&hex(GCM_KEY), b"v10short")
                .unwrap_err()
                .contains("too short")
        );
        assert!(
            decrypt_v10_gcm(&[1; 16], &hex(GCM_BLOB))
                .unwrap_err()
                .contains("32 bytes")
        );
    }

    #[test]
    fn the_mac_key_and_a_mac_v10_value_from_node_crypto_read() {
        assert_eq!(mac_key(&hex(CBC_PASSWORD)).to_vec(), hex(CBC_KEY));
        assert_eq!(
            decrypt_v10_cbc(&hex(CBC_PASSWORD), &hex(CBC_BLOB)).unwrap(),
            "smtp-password-ü"
        );
        assert!(decrypt_v10_cbc(b"another password", &hex(CBC_BLOB)).is_err());
    }

    #[test]
    fn the_wrapped_key_comes_out_of_local_state_without_its_prefix() {
        let state = json!({ "os_crypt": { "encrypted_key": encode_wrapped_key(&[9, 8, 7]) } });
        assert_eq!(wrapped_key(&state).unwrap(), vec![9, 8, 7]);
        assert!(wrapped_key(&json!({})).unwrap_err().contains("no os_crypt"));
        assert!(
            wrapped_key(&json!({ "os_crypt": { "encrypted_key": STANDARD.encode(b"v10xyz") } }))
                .unwrap_err()
                .contains("DPAPI")
        );
        assert!(
            wrapped_key(&json!({ "os_crypt": { "encrypted_key": "!!" } }))
                .unwrap_err()
                .contains("base64")
        );
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_and_a_clean_profile_gets_a_key_that_reads_back() {
        let wrapped = crate::sys::dpapi_protect(b"0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(
            crate::sys::dpapi_unprotect(&wrapped).unwrap(),
            b"0123456789abcdef0123456789abcdef"
        );
        let dir = std::env::temp_dir().join(format!("shell-ss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut lines = Vec::new();
        let first = facts(&dir, &mut |name, data| lines.push((name.to_string(), data)));
        assert_eq!(first["kind"], "win-v10");
        let second = facts(&dir, &mut |_, _| {});
        assert_eq!(
            first, second,
            "the key made on the first run is the one read on the second"
        );
        let state: Value =
            serde_json::from_slice(&std::fs::read(dir.join("Local State")).unwrap()).unwrap();
        assert!(wrapped_key(&state).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
