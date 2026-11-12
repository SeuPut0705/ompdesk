//! Publishing OMPdesk's page with `tailscale serve` without touching anything else the user serves (was
//! `src/main/tailscale/serve.ts`): `serve status --json` reduced to what ownership and the choice of a port need, and
//! the rules over it.
//!
//! The only commands the requests of this module's callers run are
//! `serve --bg --https=<port> http://127.0.0.1:<local>/<secret>` and `serve --https=<port> off`, the second only for a
//! handler main's record says OMPdesk published and that is still exactly that (one `/` handler proxying to the
//! recorded target, with or without the secret path: an earlier OMPdesk published it without). Nothing here clears
//! the whole serve configuration or exposes a port to the internet: a port that could be exposed (443, 8443, 10000)
//! is never ours, and the exposure flag found on our own port makes the page refuse to start.

use serde_json::Value;

use super::json;
use crate::fs::order::js_trim;

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct Handler {
    pub proxy: Option<String>,
    /// A path, text or redirect handler: never something OMPdesk published.
    pub other: bool,
}

/// `<mount path>` and its handler, in the document's order.
type Site = Vec<(String, Handler)>;

/// `serve status --json`, reduced to what ownership and port choice need.
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Ports with a TCP handler (an HTTPS handler or a TCP forward): each key of `TCP` that JavaScript's
    /// `Number(key)` reads as an integer.
    tcp_ports: Vec<f64>,
    /// `<host>:<port>` (lowercase) and its handlers.
    web: Vec<(String, Site)>,
    /// The `<host>:<port>` keys (lowercase) the internet may reach.
    funnel: Vec<String>,
}

/// `Number(text)` for a key of `TCP`, as JavaScript reads a string as a number; none where it reads NaN.
fn number_of(text: &str) -> Option<f64> {
    let text = js_trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        let digits = text
            .get(..2)
            .filter(|start| start.eq_ignore_ascii_case(prefix))
            .map(|_| &text[2..]);
        if let Some(digits) = digits {
            return digits
                .chars()
                .try_fold(0.0, |sum: f64, digit| {
                    Some(sum * f64::from(radix) + f64::from(digit.to_digit(radix)?))
                })
                .filter(|_| !digits.is_empty());
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return Some(if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    // What is left of the grammar is a decimal literal, which Rust reads the same way once its own extra spellings
    // (`inf`, `nan`) are ruled out.
    text.bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'))
        .then(|| text.parse().ok())
        .flatten()
}

/// The serve config in `stdout` (an empty answer is an empty config); none when it is not one.
pub fn parse(stdout: &str) -> Option<Config> {
    let json = if js_trim(stdout).is_empty() {
        Value::Object(json::Object::new())
    } else {
        json::parse(stdout)?
    };
    let doc = json.as_object()?;
    let mut config = Config::default();
    for (key, _) in json::records(doc, "TCP").unwrap_or_default() {
        let port = number_of(key).filter(|port| port.is_finite() && port.fract() == 0.0);
        if let Some(port) = port
            && !config.tcp_ports.contains(&port)
        {
            config.tcp_ports.push(port);
        }
    }
    for (key, site) in json::records(doc, "Web").unwrap_or_default() {
        let handlers: Site = json::records(site, "Handlers")
            .unwrap_or_default()
            .into_iter()
            .map(|(mount, handler)| {
                let other = ["Path", "Text", "Redirect"]
                    .iter()
                    .any(|kind| json::filled(handler, kind).is_some());
                let proxy = json::text(handler, "Proxy").map(str::to_owned);
                (mount.to_owned(), Handler { proxy, other })
            })
            .collect();
        // A `Map`: a key written twice (two spellings of one host) keeps its first place and its last value.
        let key = key.to_lowercase();
        match config.web.iter_mut().find(|(known, _)| *known == key) {
            Some((_, known)) => *known = handlers,
            None => config.web.push((key, handlers)),
        }
    }
    // `z.record(z.boolean())`: one value that is no boolean and no key is exposed.
    let exposed = json::object(doc, "AllowFunnel")
        .map(json::entries)
        .and_then(|entries| {
            entries
                .into_iter()
                .map(|(key, on)| Some((key, on.as_bool()?)))
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or_default();
    for (key, on) in exposed {
        let key = key.to_lowercase();
        if on && !config.funnel.contains(&key) {
            config.funnel.push(key);
        }
    }
    Some(config)
}

/// What OMPdesk published: main's record, the pref `mobileWeb.serve`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct Record {
    pub host: String,
    pub port: u32,
    /// `http://127.0.0.1:<local port>`, without the secret path.
    pub target: String,
}

/// The pref's value as a record; none when it is anything else.
pub fn read_record(value: &Value) -> Option<Record> {
    let host = value
        .get("host")?
        .as_str()
        .filter(|host| !host.is_empty())?;
    let target = value
        .get("target")?
        .as_str()
        .filter(|target| !target.is_empty())?;
    let port = value.get("port")?.as_f64()?;
    (port.fract() == 0.0 && (1.0..=65535.0).contains(&port)).then(|| Record {
        host: host.to_owned(),
        port: port as u32,
        target: target.to_owned(),
    })
}

fn site_key(host: &str, port: u32) -> String {
    format!("{}:{port}", host.to_lowercase())
}

impl Config {
    fn site(&self, key: &str) -> Option<&Site> {
        self.web
            .iter()
            .find(|(known, _)| known == key)
            .map(|(_, site)| site)
    }

    /// Whether some handler already listens on `port` (any host name of this node, TCP forward or HTTPS).
    pub fn port_taken(&self, port: u32) -> bool {
        let suffix = format!(":{port}");
        self.tcp_ports.contains(&f64::from(port))
            || self.web.iter().any(|(key, _)| key.ends_with(&suffix))
    }

    /// The URL of the single `/` proxy on `record`'s `<host>:<port>` when it is exactly what OMPdesk published:
    /// `current` (the local address plus the secret path now in force), the same secret path on another loopback
    /// port (the last run listened elsewhere because 47831 was busy: the secret is ours alone, so the port does not
    /// matter), or the bare recorded target an earlier release published (the one-time cutover). Any other path on
    /// the same local address is somebody else's handler and is never ours.
    pub fn own_proxy(&self, record: &Record, current: &str) -> Option<&str> {
        let handlers = self.site(&site_key(&record.host, record.port))?;
        let [(mount, root)] = handlers.as_slice() else {
            return None;
        };
        let proxy = root
            .proxy
            .as_deref()
            .filter(|_| mount == "/" && !root.other)?;
        (proxy == record.target || proxy == current || same_secret_path(proxy, current))
            .then_some(proxy)
    }

    /// The handler on `record`'s `<host>:<port>` is what OMPdesk published (see `own_proxy`).
    pub fn handler_is_ours(&self, record: &Record, current: &str) -> bool {
        self.own_proxy(record, current).is_some()
    }

    /// The internet may reach `<host>:<port>`.
    pub fn exposed(&self, host: &str, port: u32) -> bool {
        self.funnel.contains(&site_key(host, port))
    }

    /// Where to publish `target` (the full proxy URL, secret path included) on `host`:
    /// - our own earlier handler (the record matches what is there): that port, left alone when it already proxies
    ///   to exactly `target`, published again over itself otherwise (an old target without the secret, a new local
    ///   port);
    /// - else the first port from `first` up that nothing uses (the user's other handlers are never moved or reused).
    pub fn plan(&self, host: &str, target: &str, record: Option<&Record>, first: u32) -> Plan {
        let ours = record
            .filter(|record| record.host.to_lowercase() == host.to_lowercase())
            .and_then(|record| Some((record.port, self.own_proxy(record, target)?)));
        if let Some((port, proxy)) = ours {
            return if proxy == target {
                Plan::Reuse(port)
            } else {
                Plan::Publish(port)
            };
        }
        (first..first.saturating_add(PORT_ATTEMPTS))
            .take_while(|port| *port <= 65535)
            .find(|port| !self.port_taken(*port))
            .map_or(Plan::None, Plan::Publish)
    }

    /// Everything except what is on `port`: what turning our handler off must leave exactly as it was.
    pub fn without_port(&self, port: u32) -> Config {
        let suffix = format!(":{port}");
        Config {
            tcp_ports: self
                .tcp_ports
                .iter()
                .copied()
                .filter(|other| *other != f64::from(port))
                .collect(),
            web: self
                .web
                .iter()
                .filter(|(key, _)| !key.ends_with(&suffix))
                .cloned()
                .collect(),
            funnel: self
                .funnel
                .iter()
                .filter(|key| !key.ends_with(&suffix))
                .cloned()
                .collect(),
        }
    }

    /// The two configs hold the same handlers, whatever the order they were written in.
    pub fn same(&self, other: &Config) -> bool {
        let ports = |config: &Config| {
            let mut ports = config.tcp_ports.clone();
            ports.sort_by(f64::total_cmp);
            ports
        };
        // `[...set].sort().join()`: the keys in UTF-16 order with commas between.
        let exposed = |config: &Config| {
            let mut keys: Vec<&str> = config.funnel.iter().map(String::as_str).collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            keys.join(",")
        };
        fn handlers(config: &Config) -> Vec<(&str, Vec<&(String, Handler)>)> {
            let mut sites: Vec<(&str, Vec<&(String, Handler)>)> = config
                .web
                .iter()
                .map(|(key, site)| {
                    let mut site: Vec<_> = site.iter().collect();
                    site.sort_by(|(a, _), (b, _)| a.cmp(b));
                    (key.as_str(), site)
                })
                .collect();
            sites.sort_by_key(|(key, _)| *key);
            sites
        }
        ports(self) == ports(other)
            && exposed(self) == exposed(other)
            && handlers(self) == handlers(other)
    }
}

/// Both are `http://127.0.0.1:<port>/<secret>` with the same non-empty path, read as node's `URL` reads them.
fn same_secret_path(proxy: &str, current: &str) -> bool {
    let (Ok(a), Ok(b)) = (url::Url::parse(proxy), url::Url::parse(current)) else {
        return false;
    };
    let loopback = |url: &url::Url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    loopback(&a) && loopback(&b) && b.path().len() > 1 && a.path() == b.path()
}

/// The next port is tried this many times above the first before giving up.
const PORT_ATTEMPTS: u32 = 50;

#[derive(Debug, PartialEq)]
pub enum Plan {
    Reuse(u32),
    Publish(u32),
    None,
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::super::tests::captured;
    use super::*;

    /// A config as the capture wrote the TypeScript's: its sets and maps as lists, in their order.
    #[derive(Debug, PartialEq, Deserialize)]
    struct Flat {
        tcp: Vec<f64>,
        web: Vec<(String, Site)>,
        funnel: Vec<String>,
    }

    fn config(text: &str) -> Config {
        parse(text).unwrap_or_else(|| panic!("not a serve config: {text}"))
    }

    #[test]
    fn reads_a_serve_config_as_the_typescript_did() {
        let rows: Vec<(String, Option<Flat>)> = captured("serve");
        assert!(rows.len() > 30);
        for (text, expected) in rows {
            let parsed = parse(&text).map(|config| Flat {
                tcp: config.tcp_ports,
                web: config.web,
                funnel: config.funnel,
            });
            assert_eq!(parsed, expected, "{text}");
        }
    }

    #[test]
    fn reads_a_record_only_in_its_exact_shape() {
        let rows: Vec<(Value, Option<Record>)> = captured("records");
        assert!(rows.len() > 15);
        for (value, expected) in rows {
            assert_eq!(read_record(&value), expected, "{value}");
        }
    }

    /// Each rule the TypeScript's tests asked, with what it answered. Read as plain JSON: every row has its own
    /// fields.
    #[test]
    fn rules_as_the_typescript_ruled() {
        let rules: Vec<Value> = captured("rules");
        assert!(rules.len() > 70);
        for (at, rule) in rules.iter().enumerate() {
            let text = |key: &str| {
                rule[key]
                    .as_str()
                    .unwrap_or_else(|| panic!("rule {at}: {key}"))
            };
            let port = || u32::try_from(rule["port"].as_u64().unwrap()).unwrap();
            let expect = &rule["expect"];
            match text("op") {
                "plan" => {
                    let record = read_record(&rule["record"]);
                    let first = rule["first"].as_u64().map_or(47831, |first| first as u32);
                    let plan = config(text("config")).plan(
                        text("host"),
                        text("target"),
                        record.as_ref(),
                        first,
                    );
                    let planned = expect["port"].as_u64().map(|port| port as u32);
                    let expected = match (expect["kind"].as_str(), planned) {
                        (Some("reuse"), Some(port)) => Plan::Reuse(port),
                        (Some("publish"), Some(port)) => Plan::Publish(port),
                        _ => Plan::None,
                    };
                    assert_eq!(plan, expected, "rule {at}: {rule}");
                }
                "own" => {
                    let record = read_record(&rule["record"]).unwrap();
                    let owned = config(text("config"));
                    assert_eq!(
                        owned.own_proxy(&record, text("current")),
                        expect.as_str(),
                        "rule {at}: {rule}"
                    );
                    assert_eq!(
                        owned.handler_is_ours(&record, text("current")),
                        expect.is_string()
                    );
                }
                "taken" => assert_eq!(
                    Some(config(text("config")).port_taken(port())),
                    expect.as_bool(),
                    "rule {at}: {rule}"
                ),
                "exposed" => assert_eq!(
                    Some(config(text("config")).exposed(text("host"), port())),
                    expect.as_bool(),
                    "rule {at}: {rule}"
                ),
                "off" => assert_eq!(
                    Some(config(text("after")).same(&config(text("before")).without_port(port()))),
                    expect.as_bool(),
                    "rule {at}: {rule}"
                ),
                op => panic!("rule {at}: unknown op {op}"),
            }
        }
    }

    #[test]
    fn reads_a_key_as_javascript_reads_a_number() {
        for (text, expected) in [
            ("443", Some(443.0)),
            (" 80\n", Some(80.0)),
            ("", Some(0.0)),
            ("0x1F", Some(31.0)),
            ("0B101", Some(5.0)),
            ("0o17", Some(15.0)),
            ("1e3", Some(1000.0)),
            ("-1.5", Some(-1.5)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("-Infinity", Some(f64::INFINITY)),
            ("0x", None),
            ("0xg", None),
            ("-0x10", None),
            ("inf", None),
            ("nan", None),
            ("1e", None),
            ("1_000", None),
            ("١", None),
        ] {
            let read = number_of(text).map(f64::abs);
            assert_eq!(read, expected.map(f64::abs), "{text:?}");
        }
    }
}
