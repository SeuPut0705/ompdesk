//! One lazy OS key read for the native app's encrypted stores. No keychain prompt is permitted.

use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::updater_core::secret::Key;

static KEY: Mutex<Option<Result<Arc<Key>, String>>> = Mutex::new(None);

fn read_key(user_data: &Path) -> Result<Key, String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let answer = crate::sys_mac::keychain::key_json(user_data);
        match answer["password"].as_str() {
            Some(password) => base64::engine::general_purpose::STANDARD
                .decode(password)
                .map(Key::Mac)
                .map_err(|error| error.to_string()),
            None => Err(answer["unavailable"]
                .as_str()
                .unwrap_or("the keychain gave no key")
                .to_string()),
        }
    }
    #[cfg(windows)]
    {
        crate::migrate::safe_storage::windows_key(user_data).map(Key::Windows)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = user_data;
        Err("safeStorage is read on Windows and macOS only".into())
    }
}

/// Called only for an existing encrypted value or a save, never merely because the app started.
pub fn key(user_data: &Path) -> Result<Arc<Key>, String> {
    let mut slot = KEY.lock().unwrap_or_else(|error| error.into_inner());
    slot.get_or_insert_with(|| read_key(user_data).map(Arc::new))
        .clone()
}

/// Only the private core stdio connection may reach this; it never goes through request tracing or page IPC.
pub fn request(user_data: &Path, mut call: crate::core_client::Call) {
    use crate::updater_core::secret::KEYCHAIN_WOULD_ASK;
    use serde_json::{Value, json};

    match call.method.as_str() {
        "native.secret.status" => {
            let key = key(user_data);
            call.ok(json!({
                "available": key.is_ok(),
                "blocked": key.as_ref().err().is_some_and(|reason| reason == KEYCHAIN_WOULD_ASK),
            }), None);
        }
        "native.secret.encrypt" => {
            let Some(text) = call.params.get("text").and_then(Value::as_str) else {
                call.err("invalid_params", "The native secret has no text");
                return;
            };
            match key(user_data).and_then(|key| key.encrypt(text)) {
                Ok(bytes) => call.ok(Value::Null, Some(bytes)),
                Err(_) => call.err("secret_unavailable", "The password could not be encrypted"),
            }
        }
        "native.secret.decrypt" => {
            let Some(bytes) = call.bin.take() else {
                call.err("invalid_params", "The native secret has no ciphertext");
                return;
            };
            match key(user_data).and_then(|key| key.decrypt(&bytes)) {
                Ok(text) => call.ok(Value::String(text), None),
                Err(_) => call.err(
                    "secret_unavailable",
                    "The stored password could not be decrypted",
                ),
            }
        }
        _ => call.err("unsupported", "Unknown native secret operation"),
    }
}
