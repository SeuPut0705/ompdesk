//! Reads Electron's userData as it is, for the shell that replaces Electron: what lies there, the `safeStorage`
//! secret (`update-token.bin`; Windows: DPAPI-wrapped AES key in `Local State`, macOS: the "ompdesk Safe Storage"
//! keychain item) and the `file://` origin's Local Storage (composer drafts, outbox, snapshots), exported once for the
//! new origin. Electron's own files are never written, so a failed move leaves Electron as it was.
use serde_json::{Value, json};
use std::path::Path;

/// `log(event, fields)`: the shell's JSON Lines logger.
pub fn run(user_data: &Path, webview_dir: &Path, log: &mut dyn FnMut(&str, Value)) {
    log("migrate.start", json!({ "userData": user_data.display().to_string() }));
    if !user_data.is_dir() {
        log("migrate.none", json!({ "reason": "no userData folder" }));
        return;
    }
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(user_data) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") {
                let ok = std::fs::read(entry.path())
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some();
                files.push(json!({ "name": name, "parsed": ok }));
            }
        }
    }
    log("migrate.files", json!({ "json": files }));

    let token = user_data.join("update-token.bin");
    if token.is_file() {
        match decrypt_safe_storage(user_data, &std::fs::read(&token).unwrap_or_default()) {
            Ok(plain) => {
                use sha2::Digest;
                let digest = sha2::Sha256::digest(plain.as_bytes());
                log(
                    "migrate.token",
                    json!({ "ok": true, "chars": plain.chars().count(), "sha256_8": hex8(&digest) }),
                );
            }
            Err(error) => log("migrate.token", json!({ "ok": false, "error": error })),
        }
    } else {
        log("migrate.token", json!({ "ok": true, "present": false }));
    }

    let target = webview_dir.join("local-storage-import.json");
    if target.exists() {
        log("migrate.localStorage", json!({ "ok": true, "skipped": "already exported" }));
    } else {
        match export_local_storage(&user_data.join("Local Storage").join("leveldb"), "file://") {
            Ok(entries) => {
                let count = entries.len();
                let text = Value::Object(entries).to_string();
                let _ = std::fs::create_dir_all(webview_dir);
                let written = std::fs::write(&target, &text).is_ok();
                log("migrate.localStorage", json!({ "ok": written, "keys": count, "bytes": text.len() }));
            }
            Err(error) => log("migrate.localStorage", json!({ "ok": false, "error": error })),
        }
    }
}

fn hex8(bytes: &[u8]) -> String {
    bytes.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// Chromium's OSCrypt `v10` format: `v10` + 12-byte nonce + AES-256-GCM ciphertext and tag.
#[cfg(windows)]
pub fn decrypt_safe_storage(user_data: &Path, blob: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use base64::Engine;
    let state: Value = serde_json::from_slice(
        &std::fs::read(user_data.join("Local State")).map_err(|e| format!("Local State: {e}"))?,
    )
    .map_err(|e| format!("Local State: {e}"))?;
    let wrapped = state["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or("Local State has no os_crypt.encrypted_key")?;
    let wrapped = base64::engine::general_purpose::STANDARD
        .decode(wrapped)
        .map_err(|e| format!("encrypted_key: {e}"))?;
    let wrapped = wrapped.strip_prefix(b"DPAPI").ok_or("encrypted_key lacks the DPAPI prefix")?;
    let key = dpapi_unprotect(wrapped)?;
    let body = blob.strip_prefix(b"v10").ok_or_else(|| {
        format!("not a v10 blob (prefix {:?})", String::from_utf8_lossy(&blob[..blob.len().min(3)]))
    })?;
    if body.len() < 12 + 16 {
        return Err("blob too short".into());
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&body[..12]), &body[12..])
        .map_err(|_| "AES-GCM authentication failed".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

/// Chromium's macOS OSCrypt `v10`: AES-128-CBC, IV of 16 spaces, key = PBKDF2-HMAC-SHA1(keychain password,
/// "saltysalt", 1003 rounds); the password is the generic keychain item "ompdesk Safe Storage" / account "ompdesk Key"
/// that Electron's `safeStorage` created. The item's ACL trusts the app's designated requirement, so a new shell
/// signed with the same certificate and bundle id reads it without a prompt (the run sheet checks exactly this).
#[cfg(target_os = "macos")]
pub fn decrypt_safe_storage(_user_data: &Path, blob: &[u8]) -> Result<String, String> {
    use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    let service = std::env::var("OMPDESK_PROTO_KEYCHAIN_SERVICE").unwrap_or_else(|_| "ompdesk Safe Storage".into());
    let account = std::env::var("OMPDESK_PROTO_KEYCHAIN_ACCOUNT").unwrap_or_else(|_| "ompdesk Key".into());
    let password = security_framework::passwords::get_generic_password(&service, &account)
        .map_err(|e| format!("keychain {service}/{account}: {e}"))?;
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(&password, b"saltysalt", 1003, &mut key);
    let body = blob.strip_prefix(b"v10").ok_or("not a v10 blob")?;
    let plain = cbc::Decryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|e| format!("AES-CBC: {e}"))?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: input points at `data` for the call; output is allocated by the API and freed with LocalFree below.
    let ok = unsafe {
        CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output)
    };
    if ok == 0 {
        return Err(format!("CryptUnprotectData failed: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: the API returned cbData bytes at pbData.
    let key = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: pbData came from the API's LocalAlloc.
    unsafe { LocalFree(output.pbData as _) };
    Ok(key)
}

/// Every `origin` key of Chromium's Local Storage LevelDB (`_<origin>\0\x01<key>`; a value is `\x01` + Latin-1 or
/// `\x00` + UTF-16LE), read from a copy of the folder so the original is never opened for writing.
pub fn export_local_storage(dir: &Path, origin: &str) -> Result<serde_json::Map<String, Value>, String> {
    if !dir.is_dir() {
        return Ok(serde_json::Map::new());
    }
    let copy = std::env::temp_dir().join(format!("shell-migrate-ls-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&copy);
    std::fs::create_dir_all(&copy).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name() != "LOCK" {
            std::fs::copy(entry.path(), copy.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
    }
    let result = (|| {
        let mut db = rusty_leveldb::DB::open(&copy, rusty_leveldb::Options::default()).map_err(|e| e.to_string())?;
        let mut iter = db.new_iter().map_err(|e| e.to_string())?;
        let prefix = [b"_", origin.as_bytes(), b"\0\x01"].concat();
        let mut out = serde_json::Map::new();
        use rusty_leveldb::LdbIterator;
        while let Some((key, value)) = iter.next() {
            let Some(name) = key.strip_prefix(prefix.as_slice()) else { continue };
            if let (Some(name), Some(value)) = (decode(&[&[1u8][..], name].concat()), decode(&value)) {
                out.insert(name, Value::String(value));
            }
        }
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&copy);
    result
}

fn decode(bytes: &[u8]) -> Option<String> {
    match bytes.split_first()? {
        (1, rest) => Some(rest.iter().map(|&b| b as char).collect()),
        (0, rest) => {
            let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}
