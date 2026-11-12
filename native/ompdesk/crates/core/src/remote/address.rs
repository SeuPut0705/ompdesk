//! Ports and `host:port` text (was `src/main/remote/address.ts`). The host listens on the first free port of
//! `candidates` and a device dials the same list, so both ends read one list.

use std::net::{IpAddr, Ipv6Addr};

pub const DEFAULT_REMOTE_PORT: u16 = 47821;
/// The default port and its successors: the next one when another app holds it.
pub const REMOTE_PORT_SPAN: u32 = 5;
/// One port in each of five other thousand-blocks below the dynamic range, for the default port only: Windows
/// reserves whole blocks (Hyper-V, WSL, Docker), so a span of neighbours can all be taken at once.
pub const FALLBACK_REMOTE_PORTS: [u16; 5] = [41821, 38821, 35821, 32821, 29821];

/// The first port: main's `OMP_GUI_REMOTE_PORT` as main read it (`setting`), else this process's, when it is a
/// port; else the default. Main sends its own, since the core started before a test changed it.
pub fn remote_port(setting: Option<&str>) -> u32 {
    match setting {
        Some(raw) => port_setting(raw),
        None => match std::env::var("OMP_GUI_REMOTE_PORT") {
            Ok(raw) => port_setting(&raw),
            Err(_) => u32::from(DEFAULT_REMOTE_PORT),
        },
    }
}

fn port_setting(raw: &str) -> u32 {
    let raw = raw.trim();
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return u32::from(DEFAULT_REMOTE_PORT);
    }
    match raw.parse::<u64>() {
        Ok(port) if port <= 65535 => port as u32,
        _ => u32::from(DEFAULT_REMOTE_PORT),
    }
}

/// The ports tried in order: `base` and its successors, then the fallbacks for the default port. Port 0 (tests: any
/// free port) is tried alone.
pub fn candidates(base: u32) -> Vec<u32> {
    if base == 0 {
        return vec![0];
    }
    let mut ports: Vec<u32> = (0..REMOTE_PORT_SPAN)
        .map(|i| base + i)
        .take_while(|port| *port <= 65535)
        .collect();
    if base == u32::from(DEFAULT_REMOTE_PORT) {
        ports.extend(FALLBACK_REMOTE_PORTS.iter().map(|port| u32::from(*port)));
    }
    ports
}

/// node's `net.isIPv6`: an IPv6 address, a zone (`%eth0`) allowed.
pub fn is_ipv6(text: &str) -> bool {
    let (address, zone) = match text.split_once('%') {
        Some((address, zone)) => (address, Some(zone)),
        None => (text, None),
    };
    if zone.is_some_and(|zone| zone.is_empty()) {
        return false;
    }
    address.parse::<Ipv6Addr>().is_ok()
}

pub fn is_ipv4(text: &str) -> bool {
    matches!(text.parse::<IpAddr>(), Ok(IpAddr::V4(_)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPort {
    pub host: String,
    pub port: u16,
}

/// `host:port`, `[v6]:port`, a bare v6 address or a bare host (port `default_port`); None for anything else.
pub fn parse(input: &str, default_port: u16) -> Option<HostPort> {
    let text = input.trim_matches(is_js_space);
    if text.is_empty() || text.chars().any(is_js_space) {
        return None;
    }
    let (host, port_text) = if let Some(inner) = text.strip_prefix('[') {
        let (host, rest) = inner.split_once(']')?;
        if host.is_empty() || host.contains('[') {
            return None;
        }
        let port = match rest {
            "" => None,
            rest => {
                let digits = rest.strip_prefix(':')?;
                if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                Some(digits)
            }
        };
        if !is_ipv6(host) {
            return None;
        }
        (host, port)
    } else if is_ipv6(text) {
        (text, None)
    } else {
        let mut parts = text.split(':');
        let host = parts.next().unwrap_or_default();
        let port = parts.next();
        if parts.next().is_some() {
            return None;
        }
        if let Some(port) = port
            && (port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return None;
        }
        (host, port)
    };
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '%' | '_' | '-');
    if host.is_empty() || !host.chars().all(allowed) {
        return None;
    }
    let port = match port_text {
        None => u32::from(default_port),
        Some(digits) => digits.parse::<u32>().ok()?,
    };
    if !(1..=65535).contains(&port) {
        return None;
    }
    Some(HostPort {
        host: host.to_owned(),
        port: port as u16,
    })
}

/// `[v6]:port` or `host:port`.
pub fn format(host: &str, port: u32) -> String {
    if is_ipv6(host) {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// What JavaScript's `trim` and `\s` take as space.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_candidate_ports_as_address_ts() {
        assert_eq!(
            candidates(47821),
            vec![
                47821, 47822, 47823, 47824, 47825, 41821, 38821, 35821, 32821, 29821
            ]
        );
        assert_eq!(candidates(50000), vec![50000, 50001, 50002, 50003, 50004]);
        assert_eq!(candidates(65534), vec![65534, 65535]);
        assert_eq!(candidates(0), vec![0]);
        assert_eq!(port_setting(" 50000 "), 50000);
        for raw in ["", "x", "-1", "70000", "1.5"] {
            assert_eq!(port_setting(raw), 47821, "{raw:?}");
        }
    }

    #[test]
    fn parses_and_formats_addresses_as_address_ts() {
        let some = |host: &str, port| {
            Some(HostPort {
                host: host.into(),
                port,
            })
        };
        assert_eq!(parse("100.64.0.1:47822", 47821), some("100.64.0.1", 47822));
        assert_eq!(parse(" 100.64.0.1 ", 47821), some("100.64.0.1", 47821));
        assert_eq!(parse("[fd7a::1]:5", 47821), some("fd7a::1", 5));
        assert_eq!(parse("[fd7a::1]", 47821), some("fd7a::1", 47821));
        assert_eq!(parse("fd7a:115c::1", 47821), some("fd7a:115c::1", 47821));
        assert_eq!(parse("studio", 47821), some("studio", 47821));
        for bad in [
            "",
            "a b",
            "h:0",
            "h:65536",
            "h:x",
            "h:1:2",
            "[nope]:1",
            "[fd7a::1]x",
            "h/1",
            "h:",
        ] {
            assert_eq!(parse(bad, 47821), None, "{bad:?}");
        }
        assert_eq!(format("fd7a::1", 5), "[fd7a::1]:5");
        assert_eq!(format("100.64.0.1", 5), "100.64.0.1:5");
    }
}
