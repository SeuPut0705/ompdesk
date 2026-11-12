//! `tailscale status --json`, reduced to what Mobile web and computer sharing decide on (was `parseStatus` and
//! `httpsProblem` of `src/main/tailscale/status.ts`). Only the keys read here count; the text form of `status` is
//! never parsed.

use serde::Serialize;
use serde_json::Number;

use super::json::{self, Object};
use crate::git::parse::js_number;

/// `BackendState`, the ones that matter; any other reads as `unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    Running,
    NeedsLogin,
    Stopped,
    NeedsMachineAuth,
    Starting,
    NoState,
    InUseOtherUser,
    Unknown,
}

#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `BackendState` as Tailscale spelled it.
    pub(super) backend_state: String,
    pub(super) backend: Backend,
    /// `Version` without the build suffix (`1.104.1-t…` is `1.104.1`).
    pub(super) version: Option<String>,
    /// The sign-in page while `NeedsLogin`.
    pub(super) auth_url: Option<String>,
    /// This machine's MagicDNS name without its trailing dot.
    pub(super) dns_name: Option<String>,
    user_id: Option<Number>,
    /// `User[Self.UserID].LoginName`: this computer's tailnet user.
    pub(super) login: Option<String>,
    cert_domains: Vec<String>,
    /// `CurrentTailnet.MagicDNSEnabled`; none when the document does not say.
    magic_dns: Option<bool>,
    /// `Self.Capabilities`, then the keys of `Self.CapMap`.
    capabilities: Vec<String>,
    key_expiry: Option<String>,
    /// A newer Tailscale exists.
    pub(super) update_available: bool,
    /// Host names of this user's online phones and tablets.
    pub(super) phones: Vec<String>,
    /// This machine's tailnet addresses (`TailscaleIPs`).
    self_ips: Vec<String>,
    /// This machine's node (`Self.ID`, the stable ID `whois` reports).
    self_node_id: Option<String>,
    /// This machine's name on the tailnet.
    self_name: Option<String>,
    /// The other nodes of the tailnet, and those shared with it, in the document's order.
    peers: Vec<Node>,
}

#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// Stable node ID (`Peer.ID`, what `whois` calls `Node.StableID`).
    node_id: String,
    name: String,
    ips: Vec<String>,
    os: Option<String>,
    online: bool,
    /// The node's user's login; none for a tagged node or a user the document does not list.
    login: Option<String>,
    /// The hosts of the node's current and advertised endpoints (its LAN or public addresses, not tailnet ones).
    endpoints: Vec<String>,
}

/// A `UserID`: the number as it goes back to main, and `String(id)`, the key its user is listed under and what two
/// ids are compared by. An integer keeps every digit (JavaScript rounded one past 2^53).
struct UserId {
    number: Number,
    key: String,
}

fn user_id(of: &Object) -> Option<UserId> {
    let number = json::number(of, "UserID")?;
    if let Some(id) = number.as_u64() {
        return Some(UserId {
            number: id.into(),
            key: id.to_string(),
        });
    }
    if let Some(id) = number.as_i64() {
        return Some(UserId {
            number: id.into(),
            key: id.to_string(),
        });
    }
    let float = number.as_f64().filter(|float| float.is_finite())?;
    // `1e3` and `1001.0` are the integers JavaScript read.
    let whole = float.fract() == 0.0 && float.abs() < 9e15;
    Some(UserId {
        number: if whole {
            (float as i64).into()
        } else {
            Number::from_f64(float)?
        },
        key: js_number(float),
    })
}

fn backend(state: &str) -> Backend {
    match state {
        "Running" => Backend::Running,
        "NeedsLogin" => Backend::NeedsLogin,
        "Stopped" => Backend::Stopped,
        "NeedsMachineAuth" => Backend::NeedsMachineAuth,
        "Starting" => Backend::Starting,
        "NoState" => Backend::NoState,
        "InUseOtherUser" => Backend::InUseOtherUser,
        _ => Backend::Unknown,
    }
}

/// `/^(ios|ipados|android)$/i`: a peer that counts as the user's phone or tablet.
fn mobile(os: &str) -> bool {
    ["ios", "ipados", "android"]
        .iter()
        .any(|name| os.eq_ignore_ascii_case(name))
}

/// The host of `[v6]:port` (`/^\[([^\]]+)\]:\d+$/`) or `host:port` (`/^([^:]+):\d+$/`).
fn endpoint_host(endpoint: &str) -> Option<&str> {
    let port = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let bracketed = endpoint
        .strip_prefix('[')
        .and_then(|rest| rest.split_once(']'))
        .filter(|(host, rest)| !host.is_empty() && rest.strip_prefix(':').is_some_and(port))
        .map(|(host, _)| host);
    bracketed.or_else(|| {
        endpoint
            .split_once(':')
            .filter(|(host, rest)| !host.is_empty() && port(rest))
            .map(|(host, _)| host)
    })
}

/// The label before a name's first dot (`name.split(".")[0]`).
fn first_label(name: &str) -> &str {
    name.split('.').next().unwrap_or(name)
}

/// The status document in `stdout`; none when it is not one.
pub fn parse(stdout: &str) -> Option<Status> {
    let json = json::parse(stdout)?;
    let doc = json.as_object()?;
    let backend_state = doc.get("BackendState")?.as_str()?;
    let me = json::object(doc, "Self");
    // `z.record(z.object(…))`: one user that is no object and no user is listed.
    let users = json::records(doc, "User").map(|_| json::object(doc, "User"));
    let login_of = |id: Option<&UserId>| -> Option<String> {
        let user = users??.get(&id?.key)?.as_object()?;
        json::text(user, "LoginName").map(str::to_owned)
    };
    let mine = me.and_then(user_id);
    let mut phones = Vec::new();
    let mut peers = Vec::new();
    for (_, peer) in json::records(doc, "Peer").unwrap_or_default() {
        let name = json::filled(peer, "HostName")
            .or_else(|| json::text(peer, "DNSName").map(first_label))
            .unwrap_or("");
        let theirs = user_id(peer);
        let online = json::flag(peer, "Online") == Some(true);
        let os = json::text(peer, "OS");
        if let Some(id) = json::filled(peer, "ID")
            && !name.is_empty()
        {
            let advertised = json::texts(peer, "Addrs").unwrap_or_default();
            let mut endpoints: Vec<String> = Vec::new();
            let current = json::text(peer, "CurAddr").unwrap_or("");
            for endpoint in std::iter::once(current).chain(advertised.iter().map(String::as_str)) {
                if let Some(host) = endpoint_host(endpoint)
                    && !endpoints.iter().any(|known| known == host)
                {
                    endpoints.push(host.to_owned());
                }
            }
            peers.push(Node {
                node_id: id.to_owned(),
                name: name.to_owned(),
                ips: json::texts(peer, "TailscaleIPs").unwrap_or_default(),
                os: os.map(str::to_owned),
                online,
                login: login_of(theirs.as_ref()),
                endpoints,
            });
        }
        let Some(mine) = &mine else { continue };
        let same_user = theirs.is_some_and(|theirs| theirs.key == mine.key);
        if online && same_user && os.is_some_and(mobile) && !name.is_empty() {
            phones.push(name.to_owned());
        }
    }
    let dns_name = me
        .and_then(|me| json::text(me, "DNSName"))
        .map(|name| name.strip_suffix('.').unwrap_or(name))
        .filter(|name| !name.is_empty());
    let mut capabilities = me
        .and_then(|me| json::texts(me, "Capabilities"))
        .unwrap_or_default();
    if let Some(map) = me.and_then(|me| json::object(me, "CapMap")) {
        capabilities.extend(
            json::entries(map)
                .into_iter()
                .map(|(key, _)| key.to_owned()),
        );
    }
    let client = json::object(doc, "ClientVersion");
    Some(Status {
        backend_state: backend_state.to_owned(),
        backend: backend(backend_state),
        version: json::text(doc, "Version")
            .map(|version| version.split('-').next().unwrap_or(version))
            .filter(|version| !version.is_empty())
            .map(str::to_owned),
        auth_url: json::filled(doc, "AuthURL").map(str::to_owned),
        dns_name: dns_name.map(str::to_owned),
        login: login_of(mine.as_ref()),
        user_id: mine.map(|mine| mine.number),
        cert_domains: json::texts(doc, "CertDomains").unwrap_or_default(),
        magic_dns: json::object(doc, "CurrentTailnet")
            .and_then(|tailnet| json::flag(tailnet, "MagicDNSEnabled")),
        capabilities,
        key_expiry: me
            .and_then(|me| json::text(me, "KeyExpiry"))
            .map(str::to_owned),
        // `RunningLatest` is omitted when false; `LatestVersion` is only set then.
        update_available: client.is_some_and(|client| {
            json::flag(client, "RunningLatest") != Some(true)
                && json::filled(client, "LatestVersion").is_some()
        }),
        phones,
        self_ips: json::texts(doc, "TailscaleIPs").unwrap_or_default(),
        self_node_id: me.and_then(|me| json::filled(me, "ID")).map(str::to_owned),
        self_name: me
            .and_then(|me| json::filled(me, "HostName"))
            .or_else(|| dns_name.map(first_label).filter(|label| !label.is_empty()))
            .map(str::to_owned),
        peers,
    })
}

impl Status {
    /// Why `serve` over HTTPS cannot work on this tailnet, or none when it can: MagicDNS is off, the tailnet has no
    /// certificate domain for this machine (HTTPS is not enabled), or Tailscale reports capabilities and `https`
    /// is not among them.
    pub fn https_problem(&self) -> Option<&'static str> {
        if self.magic_dns == Some(false) {
            return Some("MagicDNS is off for this tailnet");
        }
        if self.cert_domains.is_empty() {
            return Some("HTTPS certificates are not enabled for this tailnet");
        }
        if !self.capabilities.is_empty() && !self.capabilities.iter().any(|cap| cap == "https") {
            return Some("This machine has no https capability");
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::captured;
    use super::*;

    #[test]
    fn reads_a_status_document_as_the_typescript_did() {
        let rows: Vec<(String, Option<Status>, Option<String>)> = captured("status");
        assert!(rows.len() > 150);
        for (text, expected, problem) in rows {
            let parsed = parse(&text);
            assert_eq!(parsed, expected, "{text}");
            let found = parsed.and_then(|status| status.https_problem().map(str::to_owned));
            assert_eq!(found, problem, "{text}");
        }
    }

    /// JavaScript read `9007199254740993` as `…992` and then found no user under that key.
    #[test]
    fn finds_the_user_of_an_id_past_two_to_the_53rd() {
        let status = parse(
            r#"{"BackendState":"Running","Self":{"UserID":9007199254740993},
                "User":{"9007199254740993":{"LoginName":"big@example.com"}},
                "Peer":{"a":{"ID":"nA","HostName":"phone","OS":"iOS","Online":true,"UserID":9007199254740992}}}"#,
        )
        .unwrap();
        assert_eq!(status.login.as_deref(), Some("big@example.com"));
        assert_eq!(status.user_id.unwrap().to_string(), "9007199254740993");
        assert!(status.phones.is_empty(), "another user's phone");
    }

    #[test]
    fn reads_half_a_surrogate_pair_in_a_name_as_the_replacement_character() {
        let status =
            parse(r#"{"BackendState":"Running","Self":{"HostName":"box \ud83d"}}"#).unwrap();
        assert_eq!(status.self_name.as_deref(), Some("box \u{fffd}"));
    }
}
