//! The remote link's key material (was `src/main/remote/crypto.ts`, node:crypto only): Crockford base32 device ids,
//! X25519 keys as raw base64url public keys, the transcript hash and the HKDF split into the two direction keys.
//!
//! What a key or a transcript looks like on the wire is what the TypeScript made, so an older computer still pairs:
//! `rows` in `crypto-captured.json` are the TypeScript's own answers for these same inputs.

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};

/// base64url characters of a 32-byte key.
pub const RAW_KEY_LEN: usize = 43;

const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const AUTH_INFO: &str = "ompdesk-auth-v2";

/// Node's `Buffer.from(text, "base64url")`: the two unused bits of the last character are ignored, not refused.
const DECODE: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone),
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// Not 43 base64url characters.
    Malformed,
    /// The public key is not the private key's.
    Mismatch,
    /// The peer's key is a small-order point: the agreement is all zeros (node's `diffieHellman` throws).
    LowOrder,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CryptoError::Malformed => "malformed X25519 key",
            CryptoError::Mismatch => "X25519 key pair mismatch",
            CryptoError::LowOrder => "X25519 agreement is not contributory",
        })
    }
}

impl std::error::Error for CryptoError {}

/// `^[A-Za-z0-9_-]{43}$`.
pub fn is_raw_key(s: &str) -> bool {
    s.len() == RAW_KEY_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Crockford base32 of `bytes`, lowercase, unpadded.
pub fn base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(char::from(
                CROCKFORD[((buffer >> (bits - 5)) & 31) as usize],
            ));
            bits -= 5;
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(char::from(
            CROCKFORD[((buffer << (5 - bits)) & 31) as usize],
        ));
    }
    out
}

/// A random 128-bit device id, 26 characters.
pub fn random_device_id() -> String {
    base32(&random_bytes::<16>())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // A system generator that fails leaves no safe key to make: node's `randomBytes` threw there too.
    crate::sys::random(&mut bytes).expect("the system's random generator failed");
    bytes
}

fn decode_key(raw: &str) -> Result<[u8; 32], CryptoError> {
    if !is_raw_key(raw) {
        return Err(CryptoError::Malformed);
    }
    let mut key = [0u8; 32];
    match DECODE.decode_slice(raw, &mut key) {
        Ok(32) => Ok(key),
        _ => Err(CryptoError::Malformed),
    }
}

fn encode_key(key: &[u8; 32]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key)
}

/// An X25519 key pair: the raw public key as base64url, and the secret that makes it.
pub struct KeyPair {
    pub public: String,
    secret: StaticSecret,
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyPair")
            .field("public", &self.public)
            .finish_non_exhaustive()
    }
}

impl KeyPair {
    /// A fresh pair; the secret is clamped as OpenSSL's `X25519_keypair` leaves it, so the file it is kept in reads
    /// as one the TypeScript wrote.
    pub fn generate() -> KeyPair {
        let mut secret = random_bytes::<32>();
        secret[0] &= 248;
        secret[31] &= 127;
        secret[31] |= 64;
        KeyPair::from_secret(secret)
    }

    /// The pair of a given secret, as the raw private key node imports: used as stored, clamped only when used.
    pub fn from_secret(secret: [u8; 32]) -> KeyPair {
        let secret = StaticSecret::from(secret);
        let public = encode_key(PublicKey::from(&secret).as_bytes());
        KeyPair { public, secret }
    }

    /// Rebuild a pair from its persisted raw parts (`importKeyPair`): both must be raw keys, and the public one must
    /// be the private one's, as its canonical text.
    pub fn import(public: &str, private: &str) -> Result<KeyPair, CryptoError> {
        decode_key(public)?;
        let pair = KeyPair::from_secret(decode_key(private)?);
        if pair.public != public {
            return Err(CryptoError::Mismatch);
        }
        Ok(pair)
    }

    /// The persisted form of the private key: its JWK `d`.
    pub fn export_private(&self) -> String {
        encode_key(self.secret.as_bytes())
    }

    /// X25519(private, peer public); refuses a malformed key and a small-order one.
    pub fn dh(&self, peer_public: &str) -> Result<[u8; 32], CryptoError> {
        let peer = PublicKey::from(decode_key(peer_public)?);
        let shared = self.secret.diffie_hellman(&peer);
        if bool::from(shared.as_bytes().ct_eq(&[0u8; 32])) {
            return Err(CryptoError::LowOrder);
        }
        Ok(shared.to_bytes())
    }
}

/// SHA-256 of the canonical transcript: the JSON array of the label and the six fields in protocol order.
pub fn auth_transcript(fields: &[&str; 6]) -> [u8; 32] {
    let mut parts = Vec::with_capacity(7);
    parts.push(AUTH_INFO);
    parts.extend_from_slice(fields);
    let text = serde_json::to_vec(&parts).expect("strings always serialize");
    Sha256::digest(text).into()
}

pub struct DirectionKeys {
    /// Client to host.
    pub ab: [u8; 32],
    /// Host to client.
    pub ba: [u8; 32],
}

/// Split `HKDF-SHA256(ikm, salt = empty, info = "ompdesk-auth-v2" || transcript)` into the two direction keys.
pub fn auth_keys(ikm: &[u8], transcript: &[u8]) -> DirectionKeys {
    let mut info = Vec::with_capacity(AUTH_INFO.len() + transcript.len());
    info.extend_from_slice(AUTH_INFO.as_bytes());
    info.extend_from_slice(transcript);
    let mut okm = [0u8; 64];
    Hkdf::<Sha256>::new(None, ikm)
        .expand(&info, &mut okm)
        .expect("64 bytes is far below HKDF-SHA256's limit");
    let mut keys = DirectionKeys {
        ab: [0; 32],
        ba: [0; 32],
    };
    keys.ab.copy_from_slice(&okm[..32]);
    keys.ba.copy_from_slice(&okm[32..]);
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn captured() -> Value {
        serde_json::from_str(include_str!("crypto-captured.json")).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn secret(s: &str) -> [u8; 32] {
        unhex(s).try_into().unwrap()
    }

    #[test]
    fn base32_matches_the_typescript() {
        let rows = captured();
        let rows = rows["base32"].as_array().unwrap();
        assert!(rows.len() > 50);
        for row in rows {
            let bytes = unhex(row["hex"].as_str().unwrap());
            assert_eq!(base32(&bytes), row["out"].as_str().unwrap(), "{row}");
        }
    }

    #[test]
    fn a_device_id_is_26_characters_of_the_id_alphabet() {
        for _ in 0..50 {
            let id = random_device_id();
            assert_eq!(id.len(), 26);
            assert!(
                id.bytes()
                    .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()),
                "{id}"
            );
            assert!(!id.contains(['i', 'l', 'o', 'u']));
        }
        assert_ne!(random_device_id(), random_device_id());
    }

    #[test]
    fn raw_key_syntax_matches_the_regex() {
        for row in captured()["rawKey"].as_array().unwrap() {
            assert_eq!(
                is_raw_key(row["s"].as_str().unwrap()),
                row["ok"].as_bool().unwrap(),
                "{row}"
            );
        }
    }

    #[test]
    fn keys_of_fixed_secrets_match_what_node_derives_and_exports() {
        for row in captured()["keys"].as_array().unwrap() {
            let pair = KeyPair::from_secret(secret(row["secret"].as_str().unwrap()));
            assert_eq!(pair.public, row["public"].as_str().unwrap(), "{row}");
            assert_eq!(
                pair.export_private(),
                row["private"].as_str().unwrap(),
                "{row}"
            );
            let again = KeyPair::import(&pair.public, &pair.export_private()).unwrap();
            assert_eq!(again.public, pair.public);
        }
    }

    #[test]
    fn import_accepts_and_refuses_as_node_does() {
        let rows = captured();
        let rows = rows["import"].as_array().unwrap();
        let mut accepted = 0;
        for row in rows {
            let got = KeyPair::import(
                row["public"].as_str().unwrap(),
                row["private"].as_str().unwrap(),
            );
            if row["ok"].as_bool().unwrap() {
                let pair = got.unwrap_or_else(|e| panic!("{e}: {row}"));
                assert_eq!(pair.public, row["publicOut"].as_str().unwrap(), "{row}");
                assert_eq!(
                    pair.export_private(),
                    row["privateOut"].as_str().unwrap(),
                    "{row}"
                );
                accepted += 1;
            } else {
                assert!(got.is_err(), "{row}");
            }
        }
        assert!(accepted >= 10 && accepted < rows.len());
    }

    #[test]
    fn a_non_canonical_private_key_imports_and_exports_canonically() {
        let pair = KeyPair::from_secret([7; 32]);
        let d = pair.export_private();
        let last = d.as_bytes()[42];
        let bumped = format!("{}{}", &d[..42], char::from(last + 1));
        assert_ne!(bumped, d);
        let again = KeyPair::import(&pair.public, &bumped).unwrap();
        assert_eq!(again.export_private(), d);
    }

    #[test]
    fn a_generated_pair_is_clamped_and_imports_back() {
        let pair = KeyPair::generate();
        let d = DECODE.decode(pair.export_private()).unwrap();
        assert_eq!(d[0] & 7, 0);
        assert_eq!(d[31] & 0xc0, 0x40);
        assert_ne!(pair.public, KeyPair::generate().public);
        KeyPair::import(&pair.public, &pair.export_private()).unwrap();
    }

    #[test]
    fn dh_matches_node_including_every_small_order_peer() {
        let rows = captured();
        let rows = rows["dh"].as_array().unwrap();
        let mut refused = 0;
        for row in rows {
            let pair = KeyPair::from_secret(secret(row["secret"].as_str().unwrap()));
            let got = pair.dh(row["peer"].as_str().unwrap());
            match row.get("out") {
                Some(out) => assert_eq!(got.unwrap(), secret(out.as_str().unwrap()), "{row}"),
                None => {
                    assert!(got.is_err(), "{row}");
                    refused += 1;
                }
            }
        }
        assert!(refused >= 14 * 8, "{refused}");
    }

    #[test]
    fn both_sides_of_an_agreement_share_the_secret() {
        let (a, b) = (KeyPair::generate(), KeyPair::generate());
        assert_eq!(a.dh(&b.public).unwrap(), b.dh(&a.public).unwrap());
    }

    #[test]
    fn transcripts_match_node_for_awkward_fields() {
        let rows = captured();
        let rows = rows["transcript"].as_array().unwrap();
        assert!(rows.len() >= 8);
        for row in rows {
            let fields: Vec<&str> = row["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f.as_str().unwrap())
                .collect();
            let fields: [&str; 6] = fields.try_into().unwrap();
            assert_eq!(
                auth_transcript(&fields).to_vec(),
                unhex(row["hash"].as_str().unwrap()),
                "{row}"
            );
        }
    }

    #[test]
    fn direction_keys_match_node() {
        let rows = captured();
        let rows = rows["authKeys"].as_array().unwrap();
        assert!(rows.len() >= 25);
        for row in rows {
            let keys = auth_keys(
                &unhex(row["ikm"].as_str().unwrap()),
                &unhex(row["transcript"].as_str().unwrap()),
            );
            assert_eq!(
                keys.ab.to_vec(),
                unhex(row["ab"].as_str().unwrap()),
                "{row}"
            );
            assert_eq!(
                keys.ba.to_vec(),
                unhex(row["ba"].as_str().unwrap()),
                "{row}"
            );
        }
    }
}
