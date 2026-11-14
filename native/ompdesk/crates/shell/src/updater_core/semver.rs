//! The version rule electron-updater applied (`semver.parse`, `semver.gt` of node-semver, strict): a release is an
//! update when its version parses and is greater than the running one. Build metadata never counts.

use std::cmp::Ordering;

/// node-semver's `MAX_SAFE_INTEGER` bound on each number, and its longest accepted version string.
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_LENGTH: usize = 256;

#[derive(Debug, PartialEq, Eq)]
enum Ident {
    Number(u64),
    Text(String),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<Ident>,
}

fn number(text: &str) -> Option<u64> {
    if text.is_empty()
        || !text.bytes().all(|b| b.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
    {
        return None;
    }
    text.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE)
}

fn identifier(text: &str) -> Option<Ident> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return None;
    }
    if text.bytes().all(|b| b.is_ascii_digit()) {
        return number(text).map(Ident::Number);
    }
    Some(Ident::Text(text.to_string()))
}

/// `semver.parse(text)` (not loose): surrounding whitespace and one leading `v` allowed.
pub fn parse(text: &str) -> Option<Version> {
    if text.len() > MAX_LENGTH {
        return None;
    }
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let (main, build) = match text.split_once('+') {
        Some((main, build)) => (main, Some(build)),
        None => (text, None),
    };
    if let Some(build) = build
        && (build.is_empty()
            || build.split('.').any(|part| {
                part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }))
    {
        return None;
    }
    let (core, pre) = match main.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (main, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let [major, minor, patch] = parts.as_slice() else {
        return None;
    };
    let core = [number(major)?, number(minor)?, number(patch)?];
    let pre = match pre {
        None => Vec::new(),
        Some(pre) => pre.split('.').map(identifier).collect::<Option<Vec<_>>>()?,
    };
    Some(Version { core, pre })
}

fn compare_ident(a: &Ident, b: &Ident) -> Ordering {
    match (a, b) {
        (Ident::Number(a), Ident::Number(b)) => a.cmp(b),
        (Ident::Number(_), Ident::Text(_)) => Ordering::Less,
        (Ident::Text(_), Ident::Number(_)) => Ordering::Greater,
        (Ident::Text(a), Ident::Text(b)) => a.cmp(b),
    }
}

/// SemVer 2.0 precedence: the numbers, then a release above its pre-releases, then identifier by identifier.
pub fn compare(a: &Version, b: &Version) -> Ordering {
    a.core
        .cmp(&b.core)
        .then_with(|| match (a.pre.is_empty(), b.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (x, y) in a.pre.iter().zip(&b.pre) {
                    let order = compare_ident(x, y);
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                a.pre.len().cmp(&b.pre.len())
            }
        })
}

/// Whether `latest` is newer than `current`; `None` when `latest` does not parse (electron-updater's
/// `ERR_UPDATER_INVALID_VERSION`). A `current` that does not parse counts as no update.
pub fn is_newer(latest: &str, current: &str) -> Option<bool> {
    let latest = parse(latest)?;
    Some(parse(current).is_some_and(|current| compare(&latest, &current) == Ordering::Greater))
}
