//! The newest version in what a registry lookup printed: `pip index versions` and `npm view <pkg> version` (or
//! `bun pm view`). Main runs the lookup; a text that names no version fails with its last line, which is the tool's
//! own reason.

use super::is_line_end;
use crate::fs::order::{is_js_space, js_trim};
use crate::server::Fault;

/// The output's last line, or `fallback` when it has none: what the row shows as the reason.
fn no_version(output: &str, fallback: &str) -> Fault {
    let last = js_trim(output).rsplit('\n').next().unwrap_or_default();
    let last = last.strip_suffix('\r').unwrap_or(last);
    Fault::new("no_version", if last.is_empty() { fallback } else { last })
}

/// `name (1.2.3)` at the start of a line.
fn pip_headline(line: &str) -> Option<&str> {
    let name_end = line.find(is_js_space).filter(|end| *end > 0)?;
    let version = line[name_end..].strip_prefix(" (")?;
    let end = version.find(|c: char| c == ')' || is_js_space(c))?;
    (end > 0 && version[end..].starts_with(')')).then(|| &version[..end])
}

/// `Available versions: 1.2.3, 1.2.2, …`: the first version listed.
fn pip_available(output: &str) -> Option<&str> {
    const LABEL: &str = "Available versions:";
    output.match_indices(LABEL).find_map(|(at, _)| {
        let listed = output[at + LABEL.len()..].trim_start_matches(is_js_space);
        let end = listed
            .find(|c: char| c == ',' || is_js_space(c))
            .unwrap_or(listed.len());
        (end > 0).then(|| &listed[..end])
    })
}

/// `pip index versions` output: `name (1.2.3)` on a line, `Available versions: 1.2.3, 1.2.2, …` below.
pub fn pip(output: &str) -> Result<&str, Fault> {
    let mut lines = std::iter::once(0).chain(
        output
            .char_indices()
            .filter(|(_, c)| is_line_end(*c))
            .map(|(at, c)| at + c.len_utf8()),
    );
    lines
        .find_map(|start| pip_headline(&output[start..]))
        .or_else(|| pip_available(output))
        .ok_or_else(|| no_version(output, "no version in pip's answer"))
}

/// `1.2.3` with its prerelease tag (`-beta.1`) at the start of `text`.
fn version_at(text: &str) -> Option<&str> {
    let digits = |text: &str| {
        let end = text
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(text.len());
        (end > 0).then_some(end)
    };
    let mut end = digits(text)?;
    for _ in 0..2 {
        end += 1 + digits(text[end..].strip_prefix('.')?)?;
    }
    if let Some(tag) = text[end..].strip_prefix('-') {
        let tagged = tag
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-')))
            .unwrap_or(tag.len());
        if tagged > 0 {
            end += 1 + tagged;
        }
    }
    Some(&text[..end])
}

/// `npm view <pkg> version`: the first version in the output, with its prerelease tag.
pub fn registry(output: &str) -> Result<&str, Fault> {
    output
        .char_indices()
        .find_map(|(at, _)| version_at(&output[at..]))
        .ok_or_else(|| no_version(output, "no version in the registry's answer"))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::super::captured;
    use super::*;

    fn check(table: &str, parse: fn(&str) -> Result<&str, Fault>) {
        for row in captured(table) {
            let output = row[0].as_str().unwrap();
            match parse(output) {
                Ok(version) => assert_eq!(Value::from(version), row[1]["ok"], "{output:?}"),
                Err(fault) => assert_eq!(Value::from(fault.message), row[1]["error"], "{output:?}"),
            }
        }
    }

    #[test]
    fn reads_pip_as_the_typescript_did() {
        check("pip", pip);
    }

    #[test]
    fn reads_a_registry_answer_as_the_typescript_did() {
        check("registry", registry);
    }
}
