// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! Electron's `safeStorage` key on macOS: the login keychain's generic password the app's Chromium (OSCrypt) made.
//! Reading it can prompt the person and fails on a locked or denied keychain, so the shell never reads it at launch:
//! Node's shim runs the shell once as `--keychain-key <userData>` when a secret is first needed (`cli`).
//!
//! Service and account, from the sources (not guessed):
//! - Electron v36.0.0 `shell/browser/electron_browser_main_parts.cc`, `PostCreateMainMessageLoop` (lines 545-546):
//!   `KeychainPassword::GetServiceName() = app_name + " Safe Storage"; KeychainPassword::GetAccountName() = app_name;`
//!   with `app_name = electron::Browser::Get()->GetName()` (line 504): service `ompdesk Safe Storage`, account `ompdesk`
//!   for the app named `ompdesk`.
//! - Chromium `components/os_crypt/sync/keychain_password_mac.mm`: `KeychainPassword::GetPassword` calls
//!   `FindGenericPassword(GetServiceName(), GetAccountName())` and returns the item's data bytes as they are (a base64
//!   string of 16 random bytes, made by `AddRandomPasswordToKeychain` when the item is missing); `os_crypt_mac.mm`
//!   `DeriveKey` feeds exactly those bytes to PBKDF2-HMAC-SHA1 (salt "saltysalt", 1003 rounds), which is
//!   `migrate::safe_storage::mac_key`.
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use security_framework::passwords::get_generic_password;
use serde_json::{Value, json};

const SERVICE: &str = "ompdesk Safe Storage";
const ACCOUNT: &str = "ompdesk";

// OSStatus codes worth naming to the person.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_AUTH_FAILED: i32 = -25293;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

/// `{"kind":"mac-v10","password":"<base64>"}` (the item's password bytes) or `{"unavailable":"<why>"}`. The profile
/// folder is not needed: macOS keeps the key in the keychain, not beside the profile.
pub fn key_json(_user_data: &Path) -> Value {
    match get_generic_password(SERVICE, ACCOUNT) {
        Ok(password) => json!({ "kind": "mac-v10", "password": STANDARD.encode(password) }),
        Err(error) => {
            let why = match error.code() {
                ERR_SEC_ITEM_NOT_FOUND => {
                    format!("the keychain has no item \"{SERVICE}\" for account \"{ACCOUNT}\"")
                }
                ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED => {
                    format!("access to the keychain item \"{SERVICE}\" was denied")
                }
                ERR_SEC_INTERACTION_NOT_ALLOWED => {
                    format!("the keychain is locked and cannot ask for access to \"{SERVICE}\"")
                }
                code => format!(
                    "reading the keychain item \"{SERVICE}\" failed: {error} (OSStatus {code})"
                ),
            };
            json!({ "unavailable": why })
        }
    }
}

/// The one-shot mode: `args` (the process's arguments without the executable) is `["--keychain-key", "<userData>"]` →
/// prints `key_json` as one JSON line on stdout and answers `Some(0)`; anything else answers `None` and the shell
/// starts as usual. Runs before CEF, logging, the single-instance listener and Node.
pub fn cli(args: &[String]) -> Option<i32> {
    match args {
        [flag, user_data] if flag == "--keychain-key" => {
            println!("{}", key_json(Path::new(user_data)));
            Some(0)
        }
        _ => None,
    }
}
