//! The device proof made by real browsers' WebCrypto (`src/main/web/web-edge-p256.test.ts` drives Playwright's Chromium
//! and WebKit and writes `testdata/browser-p256.json`) against the Rust verifier: every signature a browser made is
//! accepted, and a tampered nonce, a tampered signature, another key, a DER-encoded signature and a wrong length are
//! refused. This is a Rust test over captured signatures, not a Playwright run: cargo cannot start a browser.

use std::collections::HashMap;

use p256::ecdsa::Signature;
use serde::Deserialize;

use super::auth::{PublicKey, lenient_base64, parse_public_key_jwk, verify_device_proof};

const CAPTURED: &str = include_str!("testdata/browser-p256.json");

#[derive(Deserialize)]
struct Made {
    #[serde(rename = "publicKeyJwk")]
    public_key_jwk: serde_json::Value,
    #[serde(rename = "otherPublicKeyJwk")]
    other_public_key_jwk: serde_json::Value,
    proofs: Vec<Proof>,
}

#[derive(Deserialize)]
struct Proof {
    nonce: String,
    signature: String,
}

fn base64url(bytes: &[u8]) -> String {
    super::auth::base64url(bytes)
}

fn captured() -> HashMap<String, Made> {
    serde_json::from_str(CAPTURED).unwrap()
}

#[test]
fn both_browsers_are_captured() {
    let captured = captured();
    let mut names: Vec<_> = captured.keys().cloned().collect();
    names.sort();
    assert_eq!(names, ["chromium", "webkit"]);
    for made in captured.values() {
        assert!(made.proofs.len() >= 16);
    }
}

#[test]
fn a_browsers_signature_is_accepted_and_anything_else_is_refused() {
    let mut high_s = 0;
    for (browser, made) in captured() {
        let key = parse_public_key_jwk(&made.public_key_jwk)
            .expect("the page's public JWK parses as /api/pair reads it");
        let other: PublicKey = parse_public_key_jwk(&made.other_public_key_jwk).unwrap();
        for Proof { nonce, signature } in &made.proofs {
            assert!(
                verify_device_proof(&key, nonce, signature),
                "{browser}: valid"
            );
            assert!(
                !verify_device_proof(&key, &format!("{nonce}x"), signature),
                "{browser}: tampered nonce"
            );
            assert!(
                !verify_device_proof(&key, &nonce[1..], signature),
                "{browser}: shortened nonce"
            );
            let raw = lenient_base64(signature);
            assert_eq!(
                raw.len(),
                64,
                "{browser}: WebCrypto writes r and s, 32 bytes each"
            );
            for at in [0, 31, 32, 63] {
                let mut flipped = raw.clone();
                flipped[at] ^= 1;
                assert!(
                    !verify_device_proof(&key, nonce, &base64url(&flipped)),
                    "{browser}: bit flipped at {at}"
                );
            }
            assert!(
                !verify_device_proof(&other, nonce, signature),
                "{browser}: another key"
            );
            let parsed = Signature::from_slice(&raw).unwrap();
            let der = parsed.to_der();
            assert!(
                !verify_device_proof(&key, nonce, &base64url(der.as_bytes())),
                "{browser}: DER"
            );
            assert!(
                !verify_device_proof(&key, nonce, &base64url(&raw[..63])),
                "{browser}: 63 bytes"
            );
            let mut long = raw.clone();
            long.push(0);
            assert!(
                !verify_device_proof(&key, nonce, &base64url(&long)),
                "{browser}: 65 bytes"
            );
            assert!(!verify_device_proof(&key, nonce, ""), "{browser}: empty");
            assert!(
                !verify_device_proof(&key, "", signature),
                "{browser}: empty nonce"
            );
            // WebCrypto does not normalise `s` to the low half; OpenSSL (node) accepts either, so must this.
            if parsed.normalize_s() != parsed {
                high_s += 1;
            }
        }
    }
    eprintln!("{high_s} of the captured signatures have a high s: accepted all the same");
}

#[test]
fn a_key_off_the_curve_or_of_the_wrong_size_never_verifies() {
    let captured = captured();
    let made = &captured["chromium"];
    let Proof { nonce, signature } = &made.proofs[0];
    let good = parse_public_key_jwk(&made.public_key_jwk).unwrap();
    let off_curve = PublicKey {
        x: good.x.clone(),
        y: good.x.clone(),
    };
    assert!(!verify_device_proof(&off_curve, nonce, signature));
    let short = PublicKey {
        x: "A".repeat(10),
        y: good.y,
    };
    assert!(!verify_device_proof(&short, nonce, signature));
}
