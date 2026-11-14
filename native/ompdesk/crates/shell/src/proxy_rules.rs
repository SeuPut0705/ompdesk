//! WinINET/WinHTTP proxy strings (`http=a:1;https=b:2`, `a:1`, a bypass list `*.corp;<local>`) as Chromium's PAC
//! result (`PROXY host:port; DIRECT`).

/// The proxy for a URL scheme out of a rules string, as `host:port`.
pub fn proxy_for_scheme(rules: &str, scheme: &str) -> Option<String> {
    let mut bare = None;
    for entry in rules
        .split([';', ' '])
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        match entry.split_once('=') {
            Some((s, target)) if s.eq_ignore_ascii_case(scheme) => {
                return Some(strip_scheme(target));
            }
            Some(_) => {}
            None => bare = bare.or_else(|| Some(strip_scheme(entry))),
        }
    }
    bare
}

fn strip_scheme(target: &str) -> String {
    target
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(target)
        .trim_end_matches('/')
        .to_string()
}

/// True when `host` is matched by a bypass entry (`*.corp`, `10.*`, `<local>` for a dotless name).
pub fn bypassed(list: &str, host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    list.split([';', ',', ' '])
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .any(|entry| {
            let entry = entry.to_ascii_lowercase();
            if entry == "<local>" {
                return !host.contains('.');
            }
            glob(&entry, &host)
        })
}

fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti] || p[pi] == '?') {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// `PROXY host:port; DIRECT` or `DIRECT`.
pub fn pac_result(rules: Option<&str>, bypass: Option<&str>, url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("http", url));
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = host
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map(|(h, _)| h)
        .unwrap_or(host);
    if bypass.is_some_and(|list| bypassed(list, host)) {
        return "DIRECT".into();
    }
    match rules.and_then(|r| proxy_for_scheme(r, scheme)) {
        Some(proxy) => format!("PROXY {proxy}; DIRECT"),
        None => "DIRECT".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_pick_the_scheme_or_the_bare_proxy() {
        assert_eq!(
            proxy_for_scheme("http=a:1;https=b:2", "https").as_deref(),
            Some("b:2")
        );
        assert_eq!(proxy_for_scheme("http=a:1;https=b:2", "ftp"), None);
        assert_eq!(
            proxy_for_scheme("proxy.corp:8080", "https").as_deref(),
            Some("proxy.corp:8080")
        );
        assert_eq!(
            proxy_for_scheme("http=http://a:1/", "http").as_deref(),
            Some("a:1")
        );
    }

    #[test]
    fn bypass_entries_match_globs_and_local_names() {
        assert!(bypassed("*.corp;<local>", "git.corp"));
        assert!(bypassed("<local>", "intranet"));
        assert!(!bypassed("<local>", "example.com"));
        assert!(bypassed("10.*", "10.1.2.3"));
        assert!(!bypassed("10.*", "110.1.2.3"));
    }

    #[test]
    fn the_result_is_a_pac_string() {
        assert_eq!(
            pac_result(Some("http=a:1;https=b:2"), None, "https://example.com/x"),
            "PROXY b:2; DIRECT"
        );
        assert_eq!(
            pac_result(
                Some("a:1"),
                Some("*.example.com"),
                "https://api.example.com:443/x"
            ),
            "DIRECT"
        );
        assert_eq!(pac_result(None, None, "https://example.com"), "DIRECT");
    }
}
