//! The stored update token's cipher: Chromium's OSCrypt `v10`, byte-identical to what Electron's `safeStorage` and
//! the shim write (PROTOCOL.md §11), so a token either app stored reads in the other. Decryption is
//! `migrate::safe_storage`'s; this adds the other direction.

use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use aes_gcm::aead::{Aead, KeyInit};

use crate::migrate::safe_storage::{decrypt_v10_cbc, decrypt_v10_gcm, mac_key};

/// The answer a keychain read gives when it would have shown a dialog (`src/shared/keychain.ts`).
pub const KEYCHAIN_WOULD_ASK: &str = "keychain-would-ask";

/// The platform's key: Windows' 32-byte AES-GCM key, or macOS' keychain password (the key is derived from it).
#[derive(Clone)]
pub enum Key {
    Windows(Vec<u8>),
    Mac(Vec<u8>),
}

/// Windows: `"v10" ‖ nonce(12) ‖ AES-256-GCM ‖ tag(16)`.
pub fn encrypt_gcm(key: &[u8], nonce: [u8; 12], plain: &str) -> Result<Vec<u8>, String> {
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key)
        .map_err(|_| "the key is not 32 bytes".to_string())?;
    let sealed = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|_| "AES-GCM encryption failed".to_string())?;
    Ok([b"v10".as_slice(), &nonce, &sealed].concat())
}

/// macOS: `"v10" ‖ AES-128-CBC(PKCS7, IV = 16 spaces)` under PBKDF2-HMAC-SHA1(password, "saltysalt", 1003).
pub fn encrypt_cbc(password: &[u8], plain: &str) -> Vec<u8> {
    let key = mac_key(password);
    let body = cbc::Encryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
        .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    [b"v10".as_slice(), &body].concat()
}

impl Key {
    pub fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String> {
        match self {
            Key::Windows(key) => {
                let mut nonce = [0u8; 12];
                getrandom::fill(&mut nonce).map_err(|e| format!("no random nonce: {e}"))?;
                encrypt_gcm(key, nonce, plain)
            }
            Key::Mac(password) => Ok(encrypt_cbc(password, plain)),
        }
    }

    pub fn decrypt(&self, blob: &[u8]) -> Result<String, String> {
        match self {
            Key::Windows(key) => decrypt_v10_gcm(key, blob),
            Key::Mac(password) => decrypt_v10_cbc(password, blob),
        }
    }
}
