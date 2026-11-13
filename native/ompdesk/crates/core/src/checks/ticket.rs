//! The admission ticket (design §7 criterion 1): an HMAC-SHA256 of the computer, repo, ref, commit and expiry under
//! that computer's admission key. Each OMPdesk has its own key, never synced between computers; its hub mints a ticket
//! for each dispatch it makes and passes it as the workflow's `ticket` input. queue-gate.yml parses the computer from
//! the ticket, reads that computer's key from the Actions secret `CHECKS_ADMISSION_KEY_<DEVICE>`, recomputes the mac
//! and refuses a macOS dispatch without a valid one ("start it with ompdesk_checks"), and one from a computer the
//! repository variable `CHECKS_ADMISSION_DEVICES` does not list.
//!
//! The ticket is `v1.<DEVICE>.<expires ms>.<hex mac>`, the mac over
//! `ompdesk-checks-ticket-v1\n<DEVICE>\n<repo>\n<ref>\n<sha>\n<expires ms>`; `DEVICE` is `[A-Z0-9_]{1,40}`. The
//! workflow's shell (`openssl dgst -sha256 -mac HMAC -macopt hexkey:…`) computes the same bytes;
//! `src/main/ci-queue.test.ts` runs that step against [`VECTOR`], so the two cannot drift apart.
//!
//! The key never appears in a log, a serializable shape or a session's environment (design §9.7): [`AdmissionKey`]
//! prints its device only and has no serde.

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq as _;

const BLOCK: usize = 64;
const PREFIX: &str = "ompdesk-checks-ticket-v1";

/// How long a minted ticket stays valid: the gate job runs within seconds of the dispatch; this covers a queued runner.
pub const TICKET_TTL_MS: u64 = 30 * 60 * 1000;

/// A computer's name in a ticket and in its secret's name: uppercase letters, digits and `_`, at most 40.
pub fn device_ok(device: &str) -> bool {
    !device.is_empty()
        && device.len() <= 40
        && device
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

/// One computer's admission key. Its bytes leave this type only into the mac.
#[derive(Clone)]
pub struct AdmissionKey {
    device: String,
    key: Vec<u8>,
}

impl std::fmt::Debug for AdmissionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AdmissionKey({}, ..)", self.device)
    }
}

impl AdmissionKey {
    /// `device`'s key from its hex form, as the Actions secret holds it. None for a device name outside
    /// `device_ok` or anything that is not 32 or more bytes of hex.
    pub fn from_hex(device: &str, text: &str) -> Option<AdmissionKey> {
        let text = text.trim();
        if !device_ok(device) || text.len() < 64 || !text.len().is_multiple_of(2) {
            return None;
        }
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
            .collect::<Option<Vec<u8>>>()
            .map(|key| AdmissionKey {
                device: device.to_owned(),
                key,
            })
    }

    pub fn device(&self) -> &str {
        &self.device
    }
}

fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|k| k ^ byte);
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The ticket for one dispatch: `repo` as `owner/name`, `git_ref` the branch name the workflow sees as
/// `github.ref_name`, `sha` the commit the dispatch runs.
pub fn mint(key: &AdmissionKey, repo: &str, git_ref: &str, sha: &str, expires_ms: u64) -> String {
    let device = &key.device;
    let message = format!("{PREFIX}\n{device}\n{repo}\n{git_ref}\n{sha}\n{expires_ms}");
    let mac = hmac(&key.key, message.as_bytes());
    format!("v1.{device}.{expires_ms}.{}", hex(&mac))
}

/// Why a ticket was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    Malformed,
    /// Minted by another computer than the key's.
    OtherDevice,
    Expired,
    Forged,
}

/// The gate's check, for tests and for any Rust reader of a ticket.
pub fn verify(
    key: &AdmissionKey,
    ticket: &str,
    repo: &str,
    git_ref: &str,
    sha: &str,
    now_ms: u64,
) -> Result<(), Refused> {
    let mut parts = ticket.split('.');
    let (Some("v1"), Some(device), Some(expires), Some(mac), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(Refused::Malformed);
    };
    if !device_ok(device) {
        return Err(Refused::Malformed);
    }
    if device != key.device {
        return Err(Refused::OtherDevice);
    }
    let expires_ms: u64 = expires.parse().map_err(|_| Refused::Malformed)?;
    if now_ms >= expires_ms {
        return Err(Refused::Expired);
    }
    let want = mint(key, repo, git_ref, sha, expires_ms);
    let got = format!("v1.{device}.{expires_ms}.{mac}");
    if bool::from(want.as_bytes().ct_eq(got.as_bytes())) {
        Ok(())
    } else {
        Err(Refused::Forged)
    }
}

/// One fixed ticket, pinned here and in `src/main/ci-queue.test.ts`, which runs the workflow's step on it.
pub const VECTOR: Vector = Vector {
    device: "MACBOOK",
    key_hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    repo: "SeuPut0705/ompdesk",
    git_ref: "omp/agent/feature",
    sha: "0123456789abcdef0123456789abcdef01234567",
    expires_ms: 1_800_000_000_000,
    ticket: "v1.MACBOOK.1800000000000.a5db0c6c659da7c94e6cb1bb0510878465d311d6485aeb71123e613ad6b71c1e",
};

pub struct Vector {
    pub device: &'static str,
    pub key_hex: &'static str,
    pub repo: &'static str,
    pub git_ref: &'static str,
    pub sha: &'static str,
    pub expires_ms: u64,
    pub ticket: &'static str,
}

impl Vector {
    pub fn key(&self) -> AdmissionKey {
        AdmissionKey::from_hex(self.device, self.key_hex).expect("the vector's key is well formed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mac_is_rfc_4231_hmac_sha256() {
        // RFC 4231 test cases 2 (a short key) and 6 (a key longer than the block).
        assert_eq!(
            hex(&hmac(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex(&hmac(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn the_pinned_vector_is_what_mint_writes() {
        assert_eq!(
            mint(
                &VECTOR.key(),
                VECTOR.repo,
                VECTOR.git_ref,
                VECTOR.sha,
                VECTOR.expires_ms
            ),
            VECTOR.ticket
        );
    }

    #[test]
    fn a_ticket_admits_only_its_own_computer_repo_ref_and_commit_before_it_expires() {
        let key = VECTOR.key();
        let ticket = mint(&key, "o/r", "feat", "abc", 1_000);
        assert_eq!(verify(&key, &ticket, "o/r", "feat", "abc", 999), Ok(()));
        assert_eq!(
            verify(&key, &ticket, "o/r", "feat", "abc", 1_000),
            Err(Refused::Expired)
        );
        for (repo, git_ref, sha) in [
            ("o/other", "feat", "abc"),
            ("o/r", "main", "abc"),
            ("o/r", "feat", "abd"),
        ] {
            assert_eq!(
                verify(&key, &ticket, repo, git_ref, sha, 0),
                Err(Refused::Forged)
            );
        }
        // Another computer's key reads it as not its own, even with the same bytes.
        let mini = AdmissionKey::from_hex("MINI", VECTOR.key_hex).unwrap();
        assert_eq!(
            verify(&mini, &ticket, "o/r", "feat", "abc", 0),
            Err(Refused::OtherDevice)
        );
        // A ticket relabelled as another computer's does not carry that computer's mac.
        let relabelled = ticket.replacen("v1.MACBOOK.", "v1.MINI.", 1);
        assert_eq!(
            verify(&mini, &relabelled, "o/r", "feat", "abc", 0),
            Err(Refused::Forged)
        );
        // A later expiry written over a real mac does not extend it.
        let stretched = ticket.replacen(".1000.", ".9000.", 1);
        assert_eq!(
            verify(&key, &stretched, "o/r", "feat", "abc", 0),
            Err(Refused::Forged)
        );
        for broken in ["v1.x.y", "v1.mac.1.ab", "v1.MACBOOK.1000.ab.cd"] {
            assert_eq!(
                verify(&key, broken, "o/r", "feat", "abc", 0),
                Err(Refused::Malformed),
                "{broken}"
            );
        }
    }

    #[test]
    fn the_key_never_prints_and_a_device_is_a_secret_names_part() {
        assert_eq!(format!("{:?}", VECTOR.key()), "AdmissionKey(MACBOOK, ..)");
        assert!(AdmissionKey::from_hex("MACBOOK", "abcd").is_none());
        for bad in ["", "mac", "MAC-BOOK", "MAC BOOK", &"A".repeat(41)] {
            assert!(
                AdmissionKey::from_hex(bad, VECTOR.key_hex).is_none(),
                "{bad}"
            );
        }
    }
}
