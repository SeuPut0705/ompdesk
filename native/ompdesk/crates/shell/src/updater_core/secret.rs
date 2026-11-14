//! The stored update token's cipher: Chromium's OSCrypt `v10`, byte-identical to what Electron's `safeStorage` and
//! the shim write (PROTOCOL.md §11), so a token either app stored reads in the other. Decryption is
//! `migrate::safe_storage`'s; this adds the other direction.

use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use aes_gcm::aead::{Aead, KeyInit};

use crate::migrate::safe_storage::{decrypt_v10_cbc, decrypt_v10_gcm, mac_key};

/// The answer a keychain read gives when it would have shown a dialog (`src/shared/keychain.ts`).
pub const KEYCHAIN_WOULD_ASK: &str = "keychain-would-ask";

/// Keep the only ciphertext until its refusal reason is durable. The native caller supplies the common atomic
/// saver and receives its error so its retained-save owner can retry a full disk.
pub fn drop_unreadable_token(
    user_data: &std::path::Path,
    atomic_write: impl FnOnce(&std::path::Path, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<()> {
    atomic_write(
        &user_data.join("update-token.dropped"),
        KEYCHAIN_WOULD_ASK.as_bytes(),
    )?;
    match std::fs::remove_file(user_data.join("update-token.bin")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_refusal_save_keeps_the_token_until_its_reason_can_be_saved() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let tag: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let root = std::env::temp_dir().join(format!("updater-token-{tag}"));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("update-token.bin");
        std::fs::write(&file, b"ciphertext").unwrap();
        let error = drop_unreadable_token(&root, |_, _| Err(std::io::Error::other("disk full")));
        let kept = std::fs::read(&file).unwrap();
        let marker_before = root.join("update-token.dropped").exists();
        drop_unreadable_token(&root, |path, bytes| std::fs::write(path, bytes)).unwrap();
        let marker = std::fs::read_to_string(root.join("update-token.dropped")).unwrap();
        let token_exists = file.exists();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(error.is_err());
        assert_eq!(kept, b"ciphertext");
        assert!(!marker_before);
        assert_eq!(marker, KEYCHAIN_WOULD_ASK);
        assert!(!token_exists);
    }
}
