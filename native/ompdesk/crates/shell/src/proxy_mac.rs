//! macOS system proxy settings (`CFNetworkCopySystemProxySettings`) as Chromium's PAC result, the answer of
//! `session.resolveProxy`: `PROXY host:port; DIRECT`, `SOCKS5 host:port; DIRECT` or `DIRECT`. The fetching is
//! `sys_mac::proxy`'s; what is decided here (which URLs skip the proxy, which proxy a scheme takes, how an entry list
//! is written) is pure, so `cargo test` covers it on any platform.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::proxy_rules;

/// What a proxy speaks. CFNetwork's `kCFProxyTypeHTTPS` is an HTTP proxy used for https URLs (CONNECT), not a proxy
/// reached over TLS, so it is [`Kind::Http`] too: Chromium's `HTTPS host:port` would mean TLS to the proxy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Http,
    Socks5,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    /// `None`: the setting names no port, so the kind's usual one applies.
    pub port: Option<u16>,
}

impl Endpoint {
    fn host_port(&self, default_port: u16) -> String {
        let port = self.port.unwrap_or(default_port);
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{port}", self.host)
        } else {
            format!("{}:{port}", self.host)
        }
    }
}

/// One answer of the system: use no proxy, or this one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Direct,
    Proxy(Kind, Endpoint),
}

/// The keys of `CFNetworkCopySystemProxySettings()` this shell reads. A proxy whose `…Enable` is off is `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Settings {
    pub http: Option<Endpoint>,
    pub https: Option<Endpoint>,
    pub socks: Option<Endpoint>,
    /// `ProxyAutoConfigEnable` with a `ProxyAutoConfigURLString`.
    pub pac_url: Option<String>,
    /// `ProxyAutoDiscoveryEnable` (WPAD).
    pub auto_discovery: bool,
    /// `ExceptionsList`: shell-style patterns (`*.local`, `192.168.1.1`) and CIDR ranges (`169.254/16`).
    pub exceptions: Vec<String>,
    /// `ExcludeSimpleHostnames`: a name without a dot goes direct.
    pub exclude_simple: bool,
}

impl Settings {
    /// True when the answer depends on a PAC script (a configured URL or auto-discovery).
    pub fn uses_pac(&self) -> bool {
        self.pac_url.is_some() || self.auto_discovery
    }

    /// True when `url` never goes through a proxy: the loopback names and addresses, a simple hostname when the
    /// setting says so, and the exception list.
    pub fn bypasses(&self, url: &str) -> bool {
        let (_, host) = scheme_and_host(url);
        if host.is_empty() {
            return true;
        }
        let ip = host.parse::<IpAddr>().ok();
        if host == "localhost"
            || host.ends_with(".localhost")
            || ip.is_some_and(|ip| ip.is_loopback())
        {
            return true;
        }
        if self.exclude_simple && ip.is_none() && !host.contains('.') {
            return true;
        }
        self.exceptions
            .iter()
            .map(|e| e.trim())
            .filter(|e| !e.is_empty())
            .any(|entry| match cidr(entry) {
                Some((base, bits)) => ip.is_some_and(|ip| in_range(ip, base, bits)),
                None => proxy_rules::bypassed(entry, &host),
            })
    }

    /// The proxy the fixed settings give `url`: its scheme's (`http`/`ws`, `https`/`wss`), else SOCKS.
    pub fn static_entries(&self, url: &str) -> Vec<Entry> {
        let (scheme, _) = scheme_and_host(url);
        let (scheme_proxy, default_port) = match scheme.as_str() {
            "https" | "wss" => (&self.https, 443),
            "http" | "ws" => (&self.http, 80),
            _ => (&None, 80),
        };
        match (scheme_proxy, &self.socks) {
            (Some(proxy), _) => vec![Entry::Proxy(Kind::Http, with_port(proxy, default_port))],
            (None, Some(socks)) => vec![Entry::Proxy(Kind::Socks5, socks.clone())],
            (None, None) => vec![Entry::Direct],
        }
    }

    /// The PAC result for `url`. `pac` is asked only when a PAC script decides and the URL is not bypassed; it
    /// returns what the script (resolved by the OS) answered, or `None` when it could not be run, which falls back to
    /// the fixed settings.
    pub fn resolve(&self, url: &str, pac: impl FnOnce() -> Option<Vec<Entry>>) -> String {
        if self.bypasses(url) {
            return "DIRECT".into();
        }
        let entries = if self.uses_pac() {
            pac().unwrap_or_else(|| self.static_entries(url))
        } else {
            self.static_entries(url)
        };
        pac_string(&entries)
    }
}

/// An endpoint with its scheme's usual port filled in when the setting carries none.
fn with_port(endpoint: &Endpoint, default_port: u16) -> Endpoint {
    Endpoint {
        host: endpoint.host.clone(),
        port: Some(endpoint.port.unwrap_or(default_port)),
    }
}

/// Entries as Chromium's PAC syntax, `DIRECT` last (a dead proxy falls back to a direct connection, as the Windows
/// answer does). An empty list is `DIRECT`.
pub fn pac_string(entries: &[Entry]) -> String {
    let mut parts: Vec<String> = entries
        .iter()
        .map(|entry| match entry {
            Entry::Direct => "DIRECT".to_string(),
            Entry::Proxy(Kind::Http, endpoint) => format!("PROXY {}", endpoint.host_port(80)),
            Entry::Proxy(Kind::Socks5, endpoint) => {
                format!("SOCKS5 {}", endpoint.host_port(1080))
            }
        })
        .collect();
    if parts.last().is_none_or(|last| last != "DIRECT") {
        parts.push("DIRECT".into());
    }
    parts.dedup();
    parts.join("; ")
}

/// Lower-case scheme and host (no port, brackets or user info) of a URL; a URL without `://` is read as http.
fn scheme_and_host(url: &str) -> (String, String) {
    let (scheme, rest) = url.split_once("://").unwrap_or(("http", url));
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else {
        authority
            .rsplit_once(':')
            .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
            .map(|(h, _)| h)
            .unwrap_or(authority)
    };
    (
        scheme.to_ascii_lowercase(),
        host.trim_end_matches('.').to_ascii_lowercase(),
    )
}

/// `169.254/16`, `10.0.0.0/8`, `fe80::/10`: the base address (an IPv4 one may omit trailing zero octets) and the
/// prefix length. `None` for anything else.
fn cidr(entry: &str) -> Option<(IpAddr, u8)> {
    let (base, bits) = entry.split_once('/')?;
    let bits: u8 = bits.parse().ok()?;
    if base.contains(':') {
        let ip = base.parse::<Ipv6Addr>().ok()?;
        return (bits <= 128).then_some((IpAddr::V6(ip), bits));
    }
    let mut octets = [0u8; 4];
    let parts: Vec<&str> = base.split('.').collect();
    if parts.is_empty() || parts.len() > 4 || bits > 32 {
        return None;
    }
    for (slot, part) in octets.iter_mut().zip(&parts) {
        *slot = part.parse().ok()?;
    }
    Some((IpAddr::V4(Ipv4Addr::from(octets)), bits))
}

fn in_range(ip: IpAddr, base: IpAddr, bits: u8) -> bool {
    match (ip, base) {
        (IpAddr::V4(ip), IpAddr::V4(base)) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(bits)).unwrap_or(0);
            u32::from(ip) & mask == u32::from(base) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(base)) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(bits)).unwrap_or(0);
            u128::from(ip) & mask == u128::from(base) & mask
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(host: &str, port: Option<u16>) -> Endpoint {
        Endpoint {
            host: host.into(),
            port,
        }
    }

    fn settings() -> Settings {
        Settings {
            http: Some(endpoint("web.corp", Some(8080))),
            https: Some(endpoint("secure.corp", Some(8443))),
            ..Settings::default()
        }
    }

    fn no_pac() -> Option<Vec<Entry>> {
        panic!("no PAC script is involved");
    }

    #[test]
    fn a_scheme_takes_its_own_proxy() {
        let s = settings();
        assert_eq!(
            s.resolve("https://chatgpt.com", no_pac),
            "PROXY secure.corp:8443; DIRECT"
        );
        assert_eq!(
            s.resolve("http://example.com/x", no_pac),
            "PROXY web.corp:8080; DIRECT"
        );
        assert_eq!(
            s.resolve("wss://example.com", no_pac),
            "PROXY secure.corp:8443; DIRECT"
        );
    }

    #[test]
    fn socks_answers_for_a_scheme_without_a_proxy() {
        let s = Settings {
            socks: Some(endpoint("127.0.0.1", Some(1081))),
            http: Some(endpoint("web.corp", None)),
            ..Settings::default()
        };
        assert_eq!(
            s.resolve("https://example.com", no_pac),
            "SOCKS5 127.0.0.1:1081; DIRECT"
        );
        assert_eq!(
            s.resolve("http://example.com", no_pac),
            "PROXY web.corp:80; DIRECT"
        );
        assert_eq!(
            s.resolve("ftp://example.com", no_pac),
            "SOCKS5 127.0.0.1:1081; DIRECT"
        );
    }

    #[test]
    fn no_proxy_is_direct_and_a_missing_port_gets_the_default() {
        assert_eq!(
            Settings::default().resolve("https://example.com", no_pac),
            "DIRECT"
        );
        let s = Settings {
            https: Some(endpoint("p.corp", None)),
            socks: Some(endpoint("::1", None)),
            ..Settings::default()
        };
        assert_eq!(
            s.resolve("https://example.com", no_pac),
            "PROXY p.corp:443; DIRECT"
        );
        assert_eq!(
            s.resolve("ftp://example.com", no_pac),
            "SOCKS5 [::1]:1080; DIRECT"
        );
    }

    #[test]
    fn loopback_simple_names_and_exceptions_go_direct() {
        let mut s = settings();
        s.exclude_simple = true;
        s.exceptions = vec![
            "*.local".into(),
            "192.168.1.1".into(),
            "169.254/16".into(),
            "10.0.0.0/8".into(),
            "fe80::/10".into(),
        ];
        for url in [
            "http://localhost:3000/",
            "http://api.localhost/",
            "https://127.0.0.1/",
            "http://[::1]:8080/",
            "http://intranet/",
            "https://printer.local/x",
            "http://192.168.1.1/",
            "http://169.254.7.9/",
            "http://10.200.0.4/",
            "http://[fe80::1]/",
        ] {
            assert_eq!(s.resolve(url, no_pac), "DIRECT", "{url}");
        }
        for url in [
            "https://example.com/",
            "http://192.168.1.2/",
            "http://11.0.0.1/",
            "http://[2001:db8::1]/",
        ] {
            assert_ne!(s.resolve(url, || None), "DIRECT", "{url}");
        }
    }

    #[test]
    fn simple_names_use_the_proxy_unless_the_setting_excludes_them() {
        let mut s = settings();
        assert_eq!(
            s.resolve("http://intranet/", no_pac),
            "PROXY web.corp:8080; DIRECT"
        );
        s.exclude_simple = true;
        assert_eq!(s.resolve("http://intranet/", no_pac), "DIRECT");
    }

    #[test]
    fn cidr_ranges_are_read_with_short_bases() {
        assert_eq!(
            cidr("169.254/16"),
            Some((IpAddr::V4(Ipv4Addr::new(169, 254, 0, 0)), 16))
        );
        assert_eq!(cidr("10.0.0.0/33"), None);
        assert_eq!(cidr("*.local"), None);
        assert!(in_range(
            "0.0.0.0".parse().unwrap(),
            "1.2.3.4".parse().unwrap(),
            0
        ));
    }

    #[test]
    fn a_pac_script_decides_when_one_is_configured() {
        let s = Settings {
            pac_url: Some("http://wpad.corp/proxy.pac".into()),
            exceptions: vec!["*.corp".into()],
            ..settings()
        };
        let from_script = || {
            Some(vec![
                Entry::Proxy(Kind::Http, endpoint("a.corp", Some(3128))),
                Entry::Proxy(Kind::Socks5, endpoint("b.corp", Some(1080))),
            ])
        };
        assert_eq!(
            s.resolve("https://example.com/", from_script),
            "PROXY a.corp:3128; SOCKS5 b.corp:1080; DIRECT"
        );
        assert_eq!(
            s.resolve("https://example.com/", || Some(vec![Entry::Direct])),
            "DIRECT"
        );
        // The script is not run for an exception, and a script that cannot run falls back to the fixed settings.
        assert_eq!(s.resolve("https://git.corp/", no_pac), "DIRECT");
        assert_eq!(
            s.resolve("https://example.com/", || None),
            "PROXY secure.corp:8443; DIRECT"
        );
        let discovery = Settings {
            auto_discovery: true,
            ..Settings::default()
        };
        assert!(discovery.uses_pac());
        assert_eq!(discovery.resolve("https://example.com/", || None), "DIRECT");
    }

    #[test]
    fn hosts_come_out_of_urls_with_ports_users_and_brackets() {
        assert_eq!(
            scheme_and_host("HTTPS://user:pw@Example.COM.:8443/a?b#c"),
            ("https".into(), "example.com".into())
        );
        assert_eq!(
            scheme_and_host("http://[::1]:80/"),
            ("http".into(), "::1".into())
        );
        assert_eq!(
            scheme_and_host("example.com"),
            ("http".into(), "example.com".into())
        );
    }
}
