//! Version order (was `compareVersions` of `src/shared/version.ts`, the only part Mobile web reads): semver with
//! prerelease tags (`1.0.0-beta.2` is older than `1.0.0`), an optional leading `v`, any number of dotted parts
//! (`1.2` equals `1.2.0`), build metadata ignored. A text that is no dotted-number version has no order.

use std::cmp::Ordering;

use crate::fs::order::js_trim;

struct Parsed<'a> {
    core: Vec<f64>,
    pre: Vec<&'a str>,
}

/// `/^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/` over the trimmed text.
fn parse(version: &str) -> Option<Parsed<'_>> {
    let text = js_trim(version);
    let text = text.strip_prefix('v').unwrap_or(text);
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let tag = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    };
    let (rest, _build) = match text.split_once('+') {
        Some((rest, build)) if tag(build) => (rest, Some(build)),
        Some(_) => return None,
        None => (text, None),
    };
    // The core is digits and dots; the first `-` after it starts the prerelease tag.
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) if tag(pre) => (core, Some(pre)),
        Some(_) => return None,
        None => (rest, None),
    };
    if !core.split('.').all(digits) {
        return None;
    }
    Some(Parsed {
        core: core
            .split('.')
            .map(|part| part.parse::<f64>().unwrap_or(f64::INFINITY))
            .collect(),
        pre: pre.map(|pre| pre.split('.').collect()).unwrap_or_default(),
    })
}

fn is_number(identifier: &str) -> bool {
    !identifier.is_empty() && identifier.bytes().all(|byte| byte.is_ascii_digit())
}

fn compare_pre(a: &[&str], b: &[&str]) -> Ordering {
    // A release outranks any prerelease of the same core.
    if a.is_empty() || b.is_empty() {
        return a.is_empty().cmp(&b.is_empty());
    }
    for at in 0..a.len().max(b.len()) {
        let (Some(x), Some(y)) = (a.get(at), b.get(at)) else {
            return if a.get(at).is_none() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        };
        match (is_number(x), is_number(y)) {
            (true, true) => {
                let (x, y) = (
                    x.parse::<f64>().unwrap_or(f64::INFINITY),
                    y.parse::<f64>().unwrap_or(f64::INFINITY),
                );
                if x != y {
                    return if x < y {
                        Ordering::Less
                    } else {
                        Ordering::Greater
                    };
                }
            }
            (x_number, y_number) if x_number != y_number => {
                return if x_number {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
            }
            _ if x != y => return x.cmp(y),
            _ => {}
        }
    }
    Ordering::Equal
}

/// `compareVersions(a, b)`: none when either side is not a dotted-number version.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let (a, b) = (parse(a)?, parse(b)?);
    for at in 0..a.core.len().max(b.core.len()) {
        let x = a.core.get(at).copied().unwrap_or(0.0);
        let y = b.core.get(at).copied().unwrap_or(0.0);
        if x != y {
            return Some(if x < y {
                Ordering::Less
            } else {
                Ordering::Greater
            });
        }
    }
    Some(compare_pre(&a.pre, &b.pre))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each row is what `compareVersions(a, b)` returned (-1, 0, 1 or null).
    #[test]
    fn orders_versions_as_the_typescript_did() {
        let rows: &[(&str, &str, Option<i8>)] = &[
            ("1.104.1", "1.52.0", Some(1)),
            ("1.52.0", "1.52", Some(0)),
            ("1.51.9", "1.52.0", Some(-1)),
            ("v1.2", "1.2.0", Some(0)),
            ("2024.2", "2024.1.5", Some(1)),
            ("1.0.0-beta.2", "1.0.0", Some(-1)),
            ("1.0.0", "1.0.0-rc.1", Some(1)),
            ("1.0.0-beta.2", "1.0.0-beta.11", Some(-1)),
            ("1.0.0-beta", "1.0.0-beta.1", Some(-1)),
            ("1.0.0-1", "1.0.0-alpha", Some(-1)),
            ("1.0.0-alpha", "1.0.0-1", Some(1)),
            ("1.0.0-alpha", "1.0.0-beta", Some(-1)),
            ("1.0.0+build5", "1.0.0", Some(0)),
            ("  1.0.0 ", "1.0.0", Some(0)),
            ("1.0rc1", "1.0.0", None),
            ("abc", "1.0.0", None),
            ("1.0.0-", "1.0.0", None),
            ("1..0", "1.0", None),
            ("1.52.0", "", None),
            ("007.1", "7.1", Some(0)),
            ("1.0.0-a..b", "1.0.0-a..b", Some(0)),
        ];
        for (a, b, expected) in rows {
            let got = compare(a, b).map(|order| order as i8);
            assert_eq!(got, *expected, "{a} vs {b}");
        }
    }
}
