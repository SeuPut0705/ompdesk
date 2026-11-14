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
use security_framework::os::macos::keychain::SecKeychain;
use security_framework::passwords::{get_generic_password, set_generic_password};
use serde_json::{Value, json};

const SERVICE: &str = "ompdesk Safe Storage";
const ACCOUNT: &str = "ompdesk";

// OSStatus codes worth naming to the person.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_AUTH_FAILED: i32 = -25293;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

/// What the one-shot answers when a read would show a keychain dialog (the item's access list does not include this
/// process, the keychain is locked): the shim keys on this exact string and asks the person to enter the secret again.
pub const WOULD_ASK: &str = "keychain-would-ask";

/// Chromium's `AddRandomPasswordToKeychain`: 16 random bytes as base64, the password OSCrypt derives its key from.
fn make_item() -> Result<Vec<u8>, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|e| format!("no random bytes for a new keychain item: {e}"))?;
    let password = STANDARD.encode(bytes).into_bytes();
    set_generic_password(SERVICE, ACCOUNT, &password)
        .map_err(|e| format!("creating the keychain item \"{SERVICE}\" failed: {e}"))?;
    Ok(password)
}

/// `{"kind":"mac-v10","password":"<base64>"}` (the item's password bytes) or `{"unavailable":"<why>"}`. The profile
/// folder is not needed: macOS keeps the key in the keychain, not beside the profile. User interaction is switched off
/// for the read, so a read that would show a dialog fails with `errSecInteractionNotAllowed` and answers
/// `unavailable: "keychain-would-ask"`: no dialog is ever shown by this process. A missing item is created, as
/// Chromium's OSCrypt does (creating one never asks).
pub fn key_json(_user_data: &Path) -> Value {
    // Held until the read is over; dropping it restores the previous setting.
    let _no_dialogs = SecKeychain::disable_user_interaction().ok();
    let interaction_off = _no_dialogs.is_some();
    let found = match get_generic_password(SERVICE, ACCOUNT) {
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => make_item().map_err(Err),
        Ok(password) => Ok(password),
        Err(error) => Err(Ok(error)),
    };
    match found {
        Ok(password) => json!({ "kind": "mac-v10", "password": STANDARD.encode(password) }),
        Err(Err(why)) => json!({ "unavailable": why }),
        Err(Ok(error)) => {
            let why = match error.code() {
                ERR_SEC_INTERACTION_NOT_ALLOWED => WOULD_ASK.to_string(),
                // With dialogs off, an item whose access list does not name this process answers "authorization
                // failed" instead of asking (seen on macOS 15 for an ad-hoc signed item): the read was refused
                // without a prompt, which is what `keychain-would-ask` says.
                ERR_SEC_AUTH_FAILED if interaction_off => WOULD_ASK.to_string(),
                ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED => {
                    format!("access to the keychain item \"{SERVICE}\" was denied")
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
