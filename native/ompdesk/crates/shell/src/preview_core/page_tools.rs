//! OMPdesk's tools on a Preview page: the element picker, region select, comment pins, CSS variable tweaks and the
//! `data-choice` wait (`page_tools.js`, byte for byte the TypeScript's `PRELUDE`). They run in an isolated world
//! ([`PAGE_WORLD`]), so the page's own scripts can neither read nor call them, and act only on trusted input events;
//! the module adds the gesture and agent checks on top.

use serde_json::Value;

/// Isolated world id for the page tools (any id other than 0, the page's own world).
pub const PAGE_WORLD: u32 = 1077;

const PRELUDE: &str = include_str!("page_tools.js");

/// One call into the page tools: the prelude, then `method` with `args` JSON-encoded, never spliced as code.
pub fn call(method: &str, args: &[Value]) -> String {
    let method = Value::from(method);
    let args = Value::Array(args.to_vec());
    format!("{PRELUDE}\nglobalThis.__ompdesk[{method}](...{args})")
}

#[cfg(test)]
mod tests {
    use super::super::captured;
    use super::*;

    #[test]
    fn the_prelude_is_the_typescripts() {
        assert_eq!(PRELUDE, captured("page-tools")["prelude"].as_str().unwrap());
    }

    #[test]
    fn calls_are_the_typescripts() {
        let rows = captured("page-tools")["calls"].as_array().unwrap();
        assert!(!rows.is_empty());
        for row in rows {
            let method = row["method"].as_str().unwrap();
            let args = row["args"].as_array().unwrap();
            let made = call(method, args);
            assert_eq!(
                &made[PRELUDE.len()..],
                row["call"].as_str().unwrap(),
                "{method}"
            );
        }
    }
}
