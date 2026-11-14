//! Web Push's sending side (unit 8d; was `src/main/web/push.ts`, `vapid-store.ts` and the `web-push` package): the
//! host's VAPID keypair (RFC 8292), one message encrypted for one subscription (RFC 8291, `aes128gcm` of RFC 8188)
//! and its single POST to the push service. Main keeps what decides whether and what to push (`web-push-notifier.ts`
//! with its batcher) and the rule that a 404 or 410 forgets the subscription.
//!
//! Methods: `push.vapid` `{userData}` → `{publicKey, subject, created}` reads `<userData>/web-push.json` (a missing,
//! damaged or mismatched file makes a new pair, `created: true`, and every subscription made against the old key can
//! no longer be pushed to: the caller drops them) and keeps the pair in the process for `push.send` `{userData,
//! subscription: {endpoint, keys: {p256dh, auth}}, payload, ttl, urgency, topic?, timeoutMs}` → `{statusCode}`. A
//! push service's refusal is an answer; only a message that cannot be made or sent is a fault (`push_subscription`,
//! `push_request`, `push_connect`, `push_tls`, `push_broken`, `push_timeout`, `no_vapid`), and no fault carries the
//! endpoint, which is a capability URL.
//!
//! The private key never leaves this process: main asks for the public key and the core signs.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine as _;
use base64::alphabet::URL_SAFE;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToSec1Point as _;
use p256::{PublicKey, SecretKey};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use url::{Host, Position, Url};

use crate::disk::tree::write_atomic_if;
use crate::http;
use crate::server::{Call, Fault, Registry, Reply};

/// The push services' contact for this sender (RFC 8292 §2.1: a `mailto:` or `https:` URL).
pub const VAPID_SUBJECT: &str = "https://github.com/seuput-inc/ompdesk";

/// A token lives 12 hours (`web-push`'s default; the limit is 24).
const VAPID_EXPIRY_SECONDS: u64 = 12 * 60 * 60;

/// RFC 8188's record size, as `http_ece` wrote it by default.
const RECORD_SIZE: usize = 4096;
const TAG: usize = 16;
const KEY_LEN: usize = 65;

/// Node's `Buffer.from(text, "base64url")`: the unused bits of the last character are ignored, padding is optional.
const DECODE: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// The host's VAPID keypair.
pub struct Vapid {
    signing: SigningKey,
    /// The uncompressed P-256 point, base64url: what `PushManager.subscribe` takes as `applicationServerKey`.
    public: String,
}

impl Vapid {
    fn new(secret: &SecretKey) -> Vapid {
        Vapid {
            signing: SigningKey::from(secret),
            public: URL_SAFE_NO_PAD.encode(public_point(&secret.public_key())),
        }
    }

    pub fn public_key(&self) -> &str {
        &self.public
    }

    /// The ES256 token of RFC 8292: `aud` the push service's origin, `exp` in seconds, `sub` the contact.
    fn token(&self, audience: &str, expires: u64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = URL_SAFE_NO_PAD
            .encode(json!({"aud": audience, "exp": expires, "sub": VAPID_SUBJECT}).to_string());
        let signing_input = format!("{header}.{claims}");
        let signature: Signature = self.signing.sign(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }
}

fn public_point(key: &PublicKey) -> Vec<u8> {
    key.to_sec1_point(false).as_bytes().to_vec()
}

fn random_secret() -> SecretKey {
    loop {
        let mut bytes = [0u8; 32];
        // A system generator that fails leaves no safe key to make: node's `randomBytes` threw there too.
        crate::sys::random(&mut bytes).expect("the system's random generator failed");
        // A scalar of zero or past the group's order (one in 2^32) is drawn again.
        if let Ok(secret) = SecretKey::from_slice(&bytes) {
            return secret;
        }
    }
}

fn is_key_text(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// What the file holds when it is a stored pair (`Stored`: `v` 1, a 87-character public key and a 43-character
/// private key, and the private key really is the public key's); extra keys are ignored, as zod's object did.
fn stored(text: &str) -> Option<Vapid> {
    let Value::Object(object) = serde_json::from_str(text).ok()? else {
        return None;
    };
    if object.get("v")?.as_f64() != Some(1.0) {
        return None;
    }
    let public = object.get("publicKey")?.as_str()?;
    let private = object.get("privateKey")?.as_str()?;
    if !is_key_text(public, 87) || !is_key_text(private, 43) {
        return None;
    }
    let secret = SecretKey::from_slice(&DECODE.decode(private).ok()?).ok()?;
    let vapid = Vapid::new(&secret);
    (DECODE.decode(public).ok()? == public_point(&secret.public_key())).then_some(vapid)
}

fn user_file(user_data: &Path) -> PathBuf {
    user_data.join("web-push.json")
}

/// The pairs this process loaded, by `userData`: the one `push.send` signs with. A load replaces the earlier one, so
/// a send never signs with a key the host did not report.
static OPEN: LazyLock<Mutex<HashMap<PathBuf, Arc<Vapid>>>> = LazyLock::new(Mutex::default);

fn open() -> MutexGuard<'static, HashMap<PathBuf, Arc<Vapid>>> {
    OPEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The pair `load_vapid` last loaded for `user_data`, with no file read and nothing made: the edge's `/api/push`
/// reads the public key through it on each request. None until main's `push.vapid` (or a `load_vapid`) ran.
pub fn loaded(user_data: &Path) -> Option<Arc<Vapid>> {
    open().get(user_data).cloned()
}

/// The keypair in `<userData>/web-push.json`, or a new one written there (atomically, owner only). The flag is true
/// when this call made the pair (first run, or the file was missing, not JSON, of another shape or version, or its
/// halves did not match): every subscription stored before it was made against another key.
pub fn load_vapid(user_data: &Path) -> io::Result<(Arc<Vapid>, bool)> {
    let file = user_file(user_data);
    let found = std::fs::read(&file)
        .ok()
        .and_then(|bytes| stored(&String::from_utf8_lossy(&bytes)));
    let (vapid, created) = match found {
        Some(vapid) => (vapid, false),
        None => {
            let secret = random_secret();
            // `JSON.stringify(value, null, "\t") + "\n"`: every value is base64url text.
            let text = format!(
                "{{\n\t\"v\": 1,\n\t\"publicKey\": \"{}\",\n\t\"privateKey\": \"{}\"\n}}\n",
                URL_SAFE_NO_PAD.encode(public_point(&secret.public_key())),
                URL_SAFE_NO_PAD.encode(secret.to_bytes())
            );
            write_atomic_if(&file, text.as_bytes(), Some(0o600), 0o777, &|| true)
                .map_err(|fault| io::Error::other(fault.message))?;
            (Vapid::new(&secret), true)
        }
    };
    let vapid = Arc::new(vapid);
    open().insert(user_data.to_path_buf(), vapid.clone());
    Ok((vapid, created))
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub enum Urgency {
    #[serde(rename = "very-low")]
    VeryLow,
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "normal")]
    Normal,
    #[serde(rename = "high")]
    High,
}

impl Urgency {
    fn as_str(self) -> &'static str {
        match self {
            Urgency::VeryLow => "very-low",
            Urgency::Low => "low",
            Urgency::Normal => "normal",
            Urgency::High => "high",
        }
    }
}

#[derive(Deserialize)]
pub struct Keys {
    pub p256dh: String,
    pub auth: String,
}

/// A browser's `PushSubscription.toJSON()`.
#[derive(Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: Keys,
}

/// One message's options (`web-push`'s `TTL`, `urgency`, `topic`).
pub struct Options {
    pub ttl: u32,
    pub urgency: Urgency,
    pub topic: Option<String>,
}

/// The request to make: its address, headers (names as `web-push` sent them) and body.
#[derive(Debug, PartialEq)]
pub struct Prepared {
    pub url: Url,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

fn fault(code: &'static str, message: &str) -> Fault {
    Fault::new(code, message)
}

/// Where the core may POST: a push service's `https` address. `http` is accepted only for a loopback host, which a
/// push service never is and the edge's `is_push_endpoint` never lets a page subscribe: it is how the tests put a
/// push service of their own where the network would be.
fn endpoint(raw: &str) -> Result<Url, Fault> {
    let refused = || fault("push_request", "The push endpoint is not an https address");
    let url = Url::parse(raw).map_err(|_| refused())?;
    let plain_loopback = url.scheme() == "http"
        && match url.host() {
            Some(Host::Domain(name)) => name == "localhost",
            Some(Host::Ipv4(address)) => address.is_loopback(),
            Some(Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        };
    if url.scheme() != "https" && !plain_loopback {
        return Err(refused());
    }
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(refused());
    }
    Ok(url)
}

fn subscriber_keys(keys: &Keys) -> Result<(PublicKey, Vec<u8>), Fault> {
    let bad = |message| fault("push_subscription", message);
    let point = DECODE
        .decode(&keys.p256dh)
        .map_err(|_| bad("The subscription p256dh value must be base64url."))?;
    if point.len() != KEY_LEN {
        return Err(bad(
            "The subscription p256dh value should be 65 bytes long.",
        ));
    }
    let auth = DECODE
        .decode(&keys.auth)
        .map_err(|_| bad("The subscription auth key must be base64url."))?;
    if auth.len() < 16 {
        return Err(bad(
            "The subscription auth key should be at least 16 bytes long",
        ));
    }
    let public = PublicKey::from_sec1_bytes(&point)
        .map_err(|_| bad("The subscription p256dh value is not a point on the curve."))?;
    Ok((public, auth))
}

/// RFC 8291 §3.4's content encryption key and nonce for one message.
fn derive(
    subscriber: &PublicKey,
    auth: &[u8],
    sender: &SecretKey,
    salt: &[u8; 16],
) -> ([u8; 16], [u8; 12]) {
    let agreed = diffie_hellman(sender.to_nonzero_scalar(), subscriber.as_affine());
    let mut key_info = Vec::with_capacity(14 + 2 * KEY_LEN);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&public_point(subscriber));
    key_info.extend_from_slice(&public_point(&sender.public_key()));
    let mut input = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), agreed.raw_secret_bytes())
        .expand(&key_info, &mut input)
        .expect("32 bytes is far below HKDF-SHA256's limit");
    let prk = Hkdf::<Sha256>::new(Some(salt), &input);
    let mut key = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .expect("16 bytes is far below HKDF-SHA256's limit");
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .expect("12 bytes is far below HKDF-SHA256's limit");
    (key, nonce)
}

/// The `aes128gcm` body of RFC 8188 for `payload`: the header (salt, record size, the sender's public key as key id),
/// then records of 4096 bytes whose last ends with the delimiter 0x02 (the others 0x01), unpadded, as `http_ece`
/// wrote them.
fn encrypt(
    payload: &[u8],
    subscriber: &PublicKey,
    auth: &[u8],
    sender: &SecretKey,
    salt: &[u8; 16],
) -> Vec<u8> {
    let (key, base_nonce) = derive(subscriber, auth, sender, salt);
    let cipher = Aes128Gcm::new((&key).into());
    let sender_public = public_point(&sender.public_key());
    let mut body = Vec::with_capacity(21 + KEY_LEN + payload.len() + TAG + 1);
    body.extend_from_slice(salt);
    body.extend_from_slice(&(RECORD_SIZE as u32).to_be_bytes());
    body.push(KEY_LEN as u8);
    body.extend_from_slice(&sender_public);
    let room = RECORD_SIZE - TAG - 1;
    let mut start = 0;
    for counter in 0u64.. {
        let end = (start + room).min(payload.len());
        let last = start + room >= payload.len();
        let mut record = payload[start..end].to_vec();
        record.push(if last { 2 } else { 1 });
        // The record's nonce is the base nonce XOR its number, as a big-endian integer.
        let mut nonce = base_nonce;
        for (byte, count) in nonce[4..].iter_mut().zip(counter.to_be_bytes()) {
            *byte ^= count;
        }
        cipher
            .encrypt_in_place(&Nonce::from(nonce), &[], &mut record)
            .expect("a record's size is far below GCM's limit");
        body.extend_from_slice(&record);
        if last {
            return body;
        }
        start = end;
    }
    unreachable!("the loop returns at the last record")
}

/// Makes the request `subscription` gets for `payload`: every random value (the sender's key for this message, the
/// salt) and the clock are given, so a test can fix them.
pub fn prepare(
    vapid: &Vapid,
    subscription: &Subscription,
    payload: &[u8],
    options: &Options,
    sender: &SecretKey,
    salt: &[u8; 16],
    now: u64,
) -> Result<Prepared, Fault> {
    let url = endpoint(&subscription.endpoint)?;
    let (subscriber, auth) = subscriber_keys(&subscription.keys)?;
    if let Some(topic) = &options.topic
        && (topic.len() > 32 || !is_key_text(topic, topic.len()) || topic.is_empty())
    {
        return Err(fault(
            "invalid_params",
            "A topic is up to 32 characters of the URL and filename safe Base64 set",
        ));
    }
    let audience = &url[Position::BeforeScheme..Position::AfterPort];
    let mut headers = vec![("ttl", options.ttl.to_string())];
    let body = if payload.is_empty() {
        Vec::new()
    } else {
        headers.push(("content-type", "application/octet-stream".to_owned()));
        headers.push(("content-encoding", "aes128gcm".to_owned()));
        encrypt(payload, &subscriber, &auth, sender, salt)
    };
    headers.push((
        "authorization",
        format!(
            "vapid t={}, k={}",
            vapid.token(audience, now + VAPID_EXPIRY_SECONDS),
            vapid.public
        ),
    ));
    headers.push(("urgency", options.urgency.as_str().to_owned()));
    if let Some(topic) = &options.topic {
        headers.push(("topic", topic.clone()));
    }
    Ok(Prepared { url, headers, body })
}

/// The one POST, within `timeout` in all. The push service's answer is its status, whatever it is; a request that
/// gets no answer is a fault that names a kind and never the endpoint.
pub async fn deliver(prepared: &Prepared, timeout: Duration) -> Result<u16, Fault> {
    let headers: Vec<(&'static str, &str)> = prepared
        .headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let request = http::Request {
        url: prepared.url.as_str(),
        headers: &headers,
        body: Some(&prepared.body),
    };
    match tokio::time::timeout(timeout, http::status_once(request)).await {
        Err(_) => Err(fault(
            "push_timeout",
            "The push service did not answer in time",
        )),
        Ok(Ok(status)) => Ok(status),
        Ok(Err(failure)) => Err(match failure {
            http::Failure::Connect => {
                fault("push_connect", "Could not connect to the push service")
            }
            http::Failure::Tls(why) => Fault::new(
                "push_tls",
                format!("Could not make a secure connection to the push service: {why}"),
            ),
            http::Failure::Request => fault("push_request", "The push request could not be made"),
            _ => fault("push_broken", "The push service's answer could not be read"),
        }),
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// One native sender's attempt, using the same encryption and HTTP path as the wire method.
pub async fn send_message(
    vapid: &Vapid,
    subscription: &Subscription,
    payload: &[u8],
    options: &Options,
    timeout: Duration,
) -> Result<u16, Fault> {
    let mut salt = [0u8; 16];
    crate::sys::random(&mut salt).map_err(|error| Fault::new("random", error.to_string()))?;
    let prepared = prepare(
        vapid,
        subscription,
        payload,
        options,
        &random_secret(),
        &salt,
        now_seconds(),
    )?;
    deliver(&prepared, timeout).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VapidParams {
    user_data: PathBuf,
}

async fn vapid(call: Call) -> Result<Reply, Fault> {
    let params: VapidParams = call.params()?;
    let (vapid, created) = tokio::task::spawn_blocking(move || load_vapid(&params.user_data))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?
        .map_err(|error| Fault::new("io", error.to_string()))?;
    Reply::json(&json!({
        "publicKey": vapid.public_key(),
        "subject": VAPID_SUBJECT,
        "created": created,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    user_data: PathBuf,
    subscription: Subscription,
    payload: String,
    ttl: u32,
    urgency: Urgency,
    topic: Option<String>,
    timeout_ms: u64,
}

async fn send(call: Call) -> Result<Reply, Fault> {
    let params: SendParams = call.params()?;
    let vapid = open().get(&params.user_data).cloned().ok_or_else(|| {
        fault(
            "no_vapid",
            "The VAPID keypair of this folder was not loaded",
        )
    })?;
    let options = Options {
        ttl: params.ttl,
        urgency: params.urgency,
        topic: params.topic,
    };
    let sending = send_message(
        &vapid,
        &params.subscription,
        params.payload.as_bytes(),
        &options,
        Duration::from_millis(params.timeout_ms),
    );
    let status = tokio::select! {
        status = sending => status?,
        () = call.scope.on_cancel() => return Err(Fault::cancelled()),
    };
    Reply::json(&json!({ "statusCode": status }))
}

pub fn register(registry: &mut Registry) {
    registry.add("push.vapid", |call| Box::pin(vapid(call)));
    registry.add("push.send", |call| Box::pin(send(call)));
}

#[cfg(test)]
mod tests {
    use std::fs;

    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier as _;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ompdesk-push-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn b64(text: &str) -> Vec<u8> {
        DECODE.decode(text).unwrap()
    }

    fn secret(text: &str) -> SecretKey {
        SecretKey::from_slice(&b64(text)).unwrap()
    }

    /// RFC 8291 Appendix A.
    mod rfc {
        pub const PLAINTEXT: &str = "When I grow up, I want to be a watermelon";
        pub const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
        pub const AS_PUBLIC: &str = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
        pub const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
        pub const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
        pub const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
        pub const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
        pub const BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
    }

    fn salt(text: &str) -> [u8; 16] {
        b64(text).try_into().unwrap()
    }

    /// What a browser does with a body: RFC 8188 §2 and RFC 8291 §3.4 from the subscriber's side, written apart from
    /// `encrypt` (it reads the sender's key from the header and takes the key schedule from the other end).
    fn decrypt(body: &[u8], subscriber: &SecretKey, auth: &[u8]) -> Vec<u8> {
        let salt = &body[..16];
        let record_size = u32::from_be_bytes(body[16..20].try_into().unwrap()) as usize;
        let id_len = usize::from(body[20]);
        let sender = PublicKey::from_sec1_bytes(&body[21..21 + id_len]).unwrap();
        let agreed = diffie_hellman(subscriber.to_nonzero_scalar(), sender.as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(&public_point(&subscriber.public_key()));
        info.extend_from_slice(&body[21..21 + id_len]);
        let mut input = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), agreed.raw_secret_bytes())
            .expand(&info, &mut input)
            .unwrap();
        let prk = Hkdf::<Sha256>::new(Some(salt), &input);
        let (mut key, mut base) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut key)
            .unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut base).unwrap();
        let cipher = Aes128Gcm::new((&key).into());
        let mut plain = Vec::new();
        let records = body[21 + id_len..].chunks(record_size);
        let count = records.len();
        for (index, record) in records.enumerate() {
            let mut nonce = base;
            for (byte, count) in nonce[4..].iter_mut().zip((index as u64).to_be_bytes()) {
                *byte ^= count;
            }
            let mut data = record.to_vec();
            cipher
                .decrypt_in_place(&Nonce::from(nonce), &[], &mut data)
                .expect("a record decrypts");
            let delimiter = data.iter().rposition(|byte| *byte != 0).unwrap();
            let last = index + 1 == count;
            assert_eq!(data[delimiter], if last { 2 } else { 1 });
            assert!(
                last || record.len() == record_size,
                "only the last record is short"
            );
            plain.extend_from_slice(&data[..delimiter]);
        }
        plain
    }

    fn subscriber() -> (SecretKey, Vec<u8>, Subscription) {
        let secret = random_secret();
        let mut auth = [0u8; 16];
        crate::sys::random(&mut auth).unwrap();
        let subscription = Subscription {
            endpoint: "https://push.example.com/send/abc".to_owned(),
            keys: Keys {
                p256dh: URL_SAFE_NO_PAD.encode(public_point(&secret.public_key())),
                auth: URL_SAFE_NO_PAD.encode(auth),
            },
        };
        (secret, auth.to_vec(), subscription)
    }

    fn options() -> Options {
        Options {
            ttl: 3600,
            urgency: Urgency::High,
            topic: None,
        }
    }

    fn vapid_pair() -> Vapid {
        Vapid::new(&random_secret())
    }

    #[test]
    fn encrypts_rfc_8291_appendix_a_byte_for_byte() {
        let subscriber = PublicKey::from_sec1_bytes(&b64(rfc::UA_PUBLIC)).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(public_point(&secret(rfc::AS_PRIVATE).public_key())),
            rfc::AS_PUBLIC
        );
        let body = encrypt(
            rfc::PLAINTEXT.as_bytes(),
            &subscriber,
            &b64(rfc::AUTH),
            &secret(rfc::AS_PRIVATE),
            &salt(rfc::SALT),
        );
        assert_eq!(URL_SAFE_NO_PAD.encode(body.as_slice()), rfc::BODY);
        assert_eq!(
            decrypt(&b64(rfc::BODY), &secret(rfc::UA_PRIVATE), &b64(rfc::AUTH)),
            rfc::PLAINTEXT.as_bytes()
        );
    }

    #[test]
    fn a_message_decrypts_with_the_subscribers_private_key() {
        let (private, auth, subscription) = subscriber();
        let (subscriber_key, auth_bytes) = subscriber_keys(&subscription.keys).unwrap();
        assert_eq!(auth_bytes, auth);
        assert_eq!(subscriber_key, private.public_key());
        // Sizes around the record boundaries: one record, exactly full, one byte over, several records.
        for size in [1, 40, 3800, 4078, 4079, 4080, 8158, 8159, 10_000] {
            let payload: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let mut random = [0u8; 16];
            crate::sys::random(&mut random).unwrap();
            let body = encrypt(&payload, &subscriber_key, &auth, &random_secret(), &random);
            assert_eq!(decrypt(&body, &private, &auth), payload, "{size} bytes");
        }
    }

    #[test]
    fn a_full_record_is_not_followed_by_an_empty_one() {
        let (_, auth, subscription) = subscriber();
        let (key, _) = subscriber_keys(&subscription.keys).unwrap();
        // A record holds 4096 - 16 - 1 = 4079 bytes of payload, then the delimiter and the tag.
        let body = encrypt(&[7; 4079], &key, &auth, &random_secret(), &[1; 16]);
        assert_eq!(body.len(), 86 + RECORD_SIZE);
        let body = encrypt(&[7; 4080], &key, &auth, &random_secret(), &[1; 16]);
        assert_eq!(body.len(), 86 + RECORD_SIZE + 1 + 1 + TAG);
    }

    #[test]
    fn the_vapid_token_verifies_with_the_public_key() {
        let vapid = vapid_pair();
        let (_, _, subscription) = subscriber();
        let prepared = prepare(
            &vapid,
            &subscription,
            b"{}",
            &options(),
            &random_secret(),
            &[3; 16],
            1_000,
        )
        .unwrap();
        let header = prepared
            .headers
            .iter()
            .find(|(name, _)| *name == "authorization")
            .unwrap()
            .1
            .clone();
        let (token, key) = header
            .strip_prefix("vapid t=")
            .and_then(|rest| rest.split_once(", k="))
            .unwrap();
        assert_eq!(key, vapid.public_key());
        let (signing_input, signature) = token.rsplit_once('.').unwrap();
        let verifying = VerifyingKey::from_sec1_bytes(&b64(vapid.public_key())).unwrap();
        verifying
            .verify(
                signing_input.as_bytes(),
                &Signature::from_slice(&b64(signature)).unwrap(),
            )
            .unwrap();
        let (head, claims) = signing_input.split_once('.').unwrap();
        assert_eq!(
            String::from_utf8(b64(head)).unwrap(),
            r#"{"typ":"JWT","alg":"ES256"}"#
        );
        assert_eq!(
            String::from_utf8(b64(claims)).unwrap(),
            format!(
                r#"{{"aud":"https://push.example.com","exp":{},"sub":"https://github.com/seuput-inc/ompdesk"}}"#,
                1_000 + 12 * 3600
            )
        );
    }

    #[test]
    fn the_request_carries_what_web_push_sent() {
        let vapid = vapid_pair();
        let (_, _, subscription) = subscriber();
        let mut with_topic = options();
        with_topic.topic = Some("tab-1_A".to_owned());
        let prepared = prepare(
            &vapid,
            &subscription,
            b"hello",
            &with_topic,
            &random_secret(),
            &[9; 16],
            5,
        )
        .unwrap();
        assert_eq!(prepared.url.as_str(), "https://push.example.com/send/abc");
        let names: Vec<_> = prepared.headers.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            names,
            [
                "ttl",
                "content-type",
                "content-encoding",
                "authorization",
                "urgency",
                "topic"
            ]
        );
        let value = |name: &str| {
            prepared
                .headers
                .iter()
                .find(|(n, _)| *n == name)
                .unwrap()
                .1
                .as_str()
        };
        assert_eq!(value("ttl"), "3600");
        assert_eq!(value("content-type"), "application/octet-stream");
        assert_eq!(value("content-encoding"), "aes128gcm");
        assert_eq!(value("urgency"), "high");
        assert_eq!(value("topic"), "tab-1_A");
        assert_eq!(prepared.body.len(), 86 + 5 + 1 + TAG);
    }

    #[test]
    fn an_empty_payload_sends_no_body_and_no_encoding() {
        let (_, _, subscription) = subscriber();
        let prepared = prepare(
            &vapid_pair(),
            &subscription,
            b"",
            &options(),
            &random_secret(),
            &[0; 16],
            0,
        )
        .unwrap();
        assert!(prepared.body.is_empty());
        assert!(
            prepared
                .headers
                .iter()
                .all(|(n, _)| *n != "content-encoding")
        );
    }

    #[test]
    fn refuses_what_it_cannot_send_without_naming_the_endpoint() {
        let vapid = vapid_pair();
        let (_, _, good) = subscriber();
        let prepare_with = |subscription: &Subscription, options: &Options| {
            prepare(
                &vapid,
                subscription,
                b"x",
                options,
                &random_secret(),
                &[0; 16],
                0,
            )
        };
        for endpoint in [
            "http://push.example.com/x",
            "http://192.168.1.4/x",
            "ftp://push.example.com/x",
            "https://user:pass@push.example.com/x",
            "not a url",
            "",
        ] {
            let subscription = Subscription {
                endpoint: endpoint.to_owned(),
                keys: Keys {
                    p256dh: good.keys.p256dh.clone(),
                    auth: good.keys.auth.clone(),
                },
            };
            let refused = prepare_with(&subscription, &options()).unwrap_err();
            assert_eq!(refused.code, "push_request", "{endpoint}");
            assert!(!refused.message.contains("example"), "{endpoint}");
        }
        for (p256dh, auth, message) in [
            ("AAAA", good.keys.auth.as_str(), "65 bytes"),
            (good.keys.p256dh.as_str(), "AAAA", "at least 16 bytes"),
            (
                // 65 bytes that are no point on the curve.
                "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                good.keys.auth.as_str(),
                "not a point",
            ),
        ] {
            let subscription = Subscription {
                endpoint: good.endpoint.clone(),
                keys: Keys {
                    p256dh: p256dh.to_owned(),
                    auth: auth.to_owned(),
                },
            };
            let refused = prepare_with(&subscription, &options()).unwrap_err();
            assert_eq!(refused.code, "push_subscription");
            assert!(refused.message.contains(message), "{}", refused.message);
        }
        for topic in ["", "has space", &"a".repeat(33), "ünï"] {
            let mut bad = options();
            bad.topic = Some(topic.to_owned());
            assert_eq!(
                prepare_with(&good, &bad).unwrap_err().code,
                "invalid_params"
            );
        }
        let loopback = Subscription {
            endpoint: "http://127.0.0.1:9/x".to_owned(),
            keys: Keys {
                p256dh: good.keys.p256dh.clone(),
                auth: good.keys.auth.clone(),
            },
        };
        assert!(prepare_with(&loopback, &options()).is_ok());
    }

    mod store {
        use super::*;

        fn mode(file: &Path) -> u32 {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::metadata(file).unwrap().permissions().mode() & 0o777
            }
            #[cfg(not(unix))]
            {
                let _ = file;
                0o600
            }
        }

        const TS_PUBLIC: &str = "BBGXwCGf-GRnEf7YsLEz-2UmShgC9hYopYRnEo7qm-gtK9qMdYRzWX0Juvh87jrDPAwgl0Qh6XXRVcuPT13Hj9o";
        const TS_PRIVATE: &str = "u6A27KO0vwLMIEjF5XyEnyyB49c83qH2tdoOdkwZp7E";
        /// A pair `generateVAPIDKeys` made whose scalar starts with a zero byte (node drops it; the package pads it).
        const ZERO_PUBLIC: &str = "BBzAncAMcg0Ga51uIPjiUzMfC5DFysiNivp65ZGSUCaUD0iChXZzWSbsGuCz0K3bBpvnLr3UtZ5hDt6FGpPgLsM";
        const ZERO_PRIVATE: &str = "AF98lhE569wo5MzHEv6tsdk32DqhmGOA_StOw2CW2PQ";

        fn typescript_file(public: &str, private: &str) -> String {
            format!(
                "{{\n\t\"v\": 1,\n\t\"publicKey\": \"{public}\",\n\t\"privateKey\": \"{private}\"\n}}\n"
            )
        }

        #[test]
        fn a_missing_file_makes_a_pair_in_the_shape_the_typescript_wrote() {
            let dir = scratch("fresh");
            let (vapid, created) = load_vapid(&dir).unwrap();
            assert!(created);
            let file = user_file(&dir);
            let text = fs::read_to_string(&file).unwrap();
            let json: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(json["v"], 1);
            assert_eq!(json["publicKey"], vapid.public_key());
            assert_eq!(
                text,
                typescript_file(
                    json["publicKey"].as_str().unwrap(),
                    json["privateKey"].as_str().unwrap()
                ),
                "JSON.stringify(value, null, \"\\t\") + \"\\n\""
            );
            assert_eq!(mode(&file), 0o600);
            let point = b64(vapid.public_key());
            assert_eq!((point.len(), point[0]), (65, 4));
            assert_eq!(b64(json["privateKey"].as_str().unwrap()).len(), 32);
        }

        #[test]
        fn the_same_keys_come_back_and_only_the_first_load_made_them() {
            let dir = scratch("again");
            assert!(loaded(&dir).is_none());
            let (first, created) = load_vapid(&dir).unwrap();
            assert_eq!(loaded(&dir).unwrap().public_key(), first.public_key());
            assert!(created);
            let (again, created) = load_vapid(&dir).unwrap();
            assert!(!created);
            assert_eq!(again.public_key(), first.public_key());
        }

        #[test]
        fn a_file_the_typescript_wrote_loads_untouched() {
            for (public, private) in [(TS_PUBLIC, TS_PRIVATE), (ZERO_PUBLIC, ZERO_PRIVATE)] {
                let dir = scratch("typescript");
                let text = typescript_file(public, private);
                fs::write(user_file(&dir), &text).unwrap();
                let (vapid, created) = load_vapid(&dir).unwrap();
                assert!(!created);
                assert_eq!(vapid.public_key(), public);
                assert_eq!(fs::read_to_string(user_file(&dir)).unwrap(), text);
            }
        }

        #[test]
        fn a_damaged_file_makes_a_new_pair() {
            let (first, _) = load_vapid(&scratch("damaged-seed")).unwrap();
            let other = typescript_file(TS_PUBLIC, ZERO_PRIVATE);
            let other_ok = typescript_file(first.public_key(), TS_PRIVATE);
            let (a, b) = ("A".repeat(87), "A".repeat(43));
            let cases = [
                ("not JSON", "{ nope".to_owned()),
                (
                    "another shape",
                    r#"{"v":1,"publicKey":"x","privateKey":"y"}"#.to_owned(),
                ),
                (
                    "a wrong version",
                    format!(r#"{{"v":2,"publicKey":"{a}","privateKey":"{b}"}}"#),
                ),
                ("an array", "[]".to_owned()),
                ("halves that do not match", other),
                ("halves of two pairs", other_ok),
                ("empty", String::new()),
            ];
            for (name, content) in cases {
                let dir = scratch("damaged");
                fs::write(user_file(&dir), content).unwrap();
                let (vapid, created) = load_vapid(&dir).unwrap();
                assert!(created, "{name}");
                let (again, created) = load_vapid(&dir).unwrap();
                assert!(!created, "{name}");
                assert_eq!(again.public_key(), vapid.public_key(), "{name}");
            }
        }

        #[test]
        fn extra_keys_and_a_float_version_are_accepted_as_zod_did() {
            let dir = scratch("extra");
            let text = format!(
                r#"{{"v":1.0,"publicKey":"{TS_PUBLIC}","privateKey":"{TS_PRIVATE}","note":"kept"}}"#
            );
            fs::write(user_file(&dir), text).unwrap();
            assert!(!load_vapid(&dir).unwrap().1);
        }
    }

    /// A push service on loopback: answers `status` (with `extra` lines) to the one request it reads and hands the
    /// request's bytes back.
    async fn service(
        status: u16,
        extra: &'static str,
    ) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/send/abc",
            listener.local_addr().unwrap().port()
        );
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = crate::http::tests::read_request(&mut socket).await;
            let answer = format!(
                "HTTP/1.1 {status} X\r\n{extra}content-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = socket.write_all(answer.as_bytes()).await;
            let _ = socket.shutdown().await;
            request
        });
        (url, served)
    }

    fn prepared_for(endpoint: &str) -> (Prepared, SecretKey, Vec<u8>, Vapid) {
        let (private, auth, mut subscription) = subscriber();
        subscription.endpoint = endpoint.to_owned();
        let vapid = vapid_pair();
        let prepared = prepare(
            &vapid,
            &subscription,
            br#"{"v":1}"#,
            &options(),
            &random_secret(),
            &[5; 16],
            now_seconds(),
        )
        .unwrap();
        (prepared, private, auth, vapid)
    }

    #[tokio::test]
    async fn posts_the_encrypted_body_with_the_headers_and_answers_the_status() {
        for status in [201, 410, 404, 413, 500] {
            let (url, served) = service(status, "").await;
            let (prepared, private, auth, vapid) = prepared_for(&url);
            assert_eq!(
                deliver(&prepared, Duration::from_secs(5)).await.unwrap(),
                status
            );
            let request = served.await.unwrap();
            let split = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let head = String::from_utf8(request[..split].to_vec()).unwrap();
            let lower = head.to_ascii_lowercase();
            assert!(head.starts_with("POST /send/abc HTTP/1.1\r\n"), "{head}");
            for line in [
                "ttl: 3600",
                "urgency: high",
                "content-encoding: aes128gcm",
                "content-type: application/octet-stream",
            ] {
                assert!(lower.contains(line), "{line} in {head}");
            }
            assert!(lower.contains(&format!("k={}", vapid.public_key().to_ascii_lowercase())));
            assert_eq!(
                decrypt(&request[split + 4..], &private, &auth),
                br#"{"v":1}"#
            );
        }
    }

    #[tokio::test]
    async fn a_redirect_is_an_answer_and_is_not_followed() {
        let (url, _) = service(307, "location: http://127.0.0.1:1/elsewhere\r\n").await;
        let (prepared, ..) = prepared_for(&url);
        assert_eq!(
            deliver(&prepared, Duration::from_secs(5)).await.unwrap(),
            307
        );
    }

    #[tokio::test]
    async fn a_service_that_does_not_answer_is_a_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/x",
            listener.local_addr().unwrap().port()
        );
        let _hold = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(socket);
        });
        let (prepared, ..) = prepared_for(&url);
        let fault = deliver(&prepared, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(fault.code, "push_timeout");
    }

    #[tokio::test]
    async fn a_refused_connection_names_no_endpoint() {
        let port = {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let (prepared, ..) = prepared_for(&format!("http://127.0.0.1:{port}/secret-path"));
        let fault = deliver(&prepared, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(fault.code, "push_connect");
        assert!(!fault.message.contains("secret-path") && !fault.message.contains("127.0.0.1"));
    }
}
