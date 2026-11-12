//! `tailscale whois --json <tailnet IP>`: which node and user an address belongs to (was `parseWhois` of
//! `src/main/tailscale/whois.ts`). Serve puts the client's tailnet address in `X-Forwarded-For`; whois names its node
//! (a device name for the desktop's notice), the node's stable ID (what a block keys on) and the login behind it
//! (checked against `Tailscale-User-Login`).

use serde::Serialize;

use super::json;
use crate::fs::order::js_trim;

/// What whois says about an address; each part none when whois did not say.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    /// The node's stable ID: the same device across key rotations and renames.
    node_id: Option<String>,
    /// The node's device name, as Tailscale shows it.
    node_name: Option<String>,
    /// The login of the user that owns the node (none for a tagged node: it has none).
    login: Option<String>,
}

/// The longest name shown, in UTF-16 units (`slice(0, 80)`).
const NAME_UNITS: usize = 80;

/// A name safe to show: no control characters, trimmed, at most 80 UTF-16 units; none when nothing is left. A
/// character cut in half by the limit ends the name as U+FFFD (JavaScript kept the lone half).
fn clean_name(value: Option<&str>) -> Option<String> {
    let shown: String = value?.chars().filter(|c| !c.is_control()).collect();
    let mut name = String::new();
    let mut units = 0;
    for c in js_trim(&shown).chars() {
        if units + c.len_utf16() > NAME_UNITS {
            if units < NAME_UNITS {
                name.push(char::REPLACEMENT_CHARACTER);
            }
            break;
        }
        units += c.len_utf16();
        name.push(c);
    }
    (!name.is_empty()).then_some(name)
}

/// The peer in `stdout`; none when it is not whois output.
pub fn parse(stdout: &str) -> Option<Peer> {
    let json = json::parse(stdout)?;
    let node = json::object(json.as_object()?, "Node")?;
    let trimmed = |text: Option<&str>| {
        text.map(js_trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let label = json::text(node, "Name")
        .map(|name| name.strip_suffix('.').unwrap_or(name))
        .map(|name| name.split('.').next().unwrap_or(name));
    let host = json::object(node, "Hostinfo").and_then(|info| json::text(info, "Hostname"));
    let login = json::object(json.as_object()?, "UserProfile")
        .and_then(|profile| json::text(profile, "LoginName"));
    Some(Peer {
        node_id: trimmed(json::text(node, "StableID")),
        node_name: clean_name(json::text(node, "ComputedName"))
            .or_else(|| clean_name(label))
            .or_else(|| clean_name(host)),
        login: trimmed(login),
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::captured;
    use super::*;

    #[test]
    fn reads_whois_output_as_the_typescript_did() {
        let rows: Vec<(String, Option<Peer>)> = captured("whois");
        assert!(rows.len() > 30);
        for (text, expected) in rows {
            assert_eq!(parse(&text), expected, "{text}");
        }
    }

    #[test]
    fn ends_a_name_cut_through_a_character_with_the_replacement_character() {
        let name = format!("{}😀tail", "x".repeat(79));
        let text = serde_json::json!({ "Node": { "ComputedName": name } }).to_string();
        let expected = format!("{}\u{fffd}", "x".repeat(79));
        assert_eq!(parse(&text).unwrap().node_name, Some(expected));
    }
}
