//! Which page memory already holds a new learned page replaces (was `src/main/ai-memory/supersede.ts`): only the one
//! the model names in `supersedes`, a path it was shown in the page's own scope. No title-similarity fallback, and a
//! pinned page is the owner's and is never replaced.
//!
//! `supersede-captured.json` holds what the TypeScript answered for the same inputs; the tests replay every row.

use super::distill::{DistillKind, KnownPage};

/// The page a proposal of `kind` that names `supersedes` replaces (`pageToReplace`).
pub fn page_to_replace<'a>(
    kind: DistillKind,
    supersedes: Option<&str>,
    known: &'a [KnownPage],
) -> Option<&'a KnownPage> {
    let supersedes = supersedes.filter(|path| !path.is_empty())?;
    let global = kind.layout().global;
    known
        .iter()
        .find(|page| page.path == supersedes && page.global == global && !page.pinned)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn known() -> Vec<KnownPage> {
        let page = |path: &str, title: &str, global: bool, pinned: bool| KnownPage {
            path: path.to_owned(),
            title: title.to_owned(),
            global,
            pinned,
            ..KnownPage::default()
        };
        vec![
            page(
                "_rules/run-the-checks-before-pushing.md",
                "Run the checks before pushing",
                false,
                false,
            ),
            page(
                "decisions/tailscale-only.md",
                "Computers share over Tailscale only",
                false,
                false,
            ),
            page(
                "preferences/one-line-rows.md",
                "Settings rows read on one line",
                true,
                false,
            ),
            page("_rules/pinned.md", "Pinned rule", false, true),
        ]
    }

    #[test]
    fn replaces_only_the_page_the_model_named_within_the_proposals_own_scope_never_a_pinned_one() {
        let known = known();
        let path = |kind, supersedes| {
            page_to_replace(kind, supersedes, &known).map(|page| page.path.as_str())
        };
        assert_eq!(path(DistillKind::Rule, None), None);
        assert_eq!(
            path(DistillKind::Decision, Some("decisions/tailscale-only.md")),
            Some("decisions/tailscale-only.md")
        );
        assert_eq!(
            path(
                DistillKind::Correction,
                Some("preferences/one-line-rows.md")
            ),
            Some("preferences/one-line-rows.md")
        );
        assert_eq!(
            path(DistillKind::Decision, Some("preferences/one-line-rows.md")),
            None
        );
        assert_eq!(path(DistillKind::Rule, Some("_rules/pinned.md")), None);
        assert_eq!(path(DistillKind::Rule, Some("_rules/not-shown.md")), None);
    }

    #[test]
    fn every_captured_row_is_what_the_typescript_answered() {
        let table: Value = serde_json::from_str(&crate::json::whole_surrogates(include_str!(
            "supersede-captured.json"
        )))
        .unwrap();
        let known: Vec<KnownPage> = table["known"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| KnownPage {
                path: row["path"].as_str().unwrap().to_owned(),
                title: row["title"].as_str().unwrap().to_owned(),
                global: row["global"].as_bool().unwrap(),
                pinned: row["pinned"].as_bool().unwrap_or(false),
                ..KnownPage::default()
            })
            .collect();
        let rows = table["rows"].as_array().unwrap();
        for row in rows {
            let kind = DistillKind::parse(row["proposal"]["kind"].as_str().unwrap()).unwrap();
            let got = page_to_replace(kind, row["proposal"]["supersedes"].as_str(), &known);
            match row["result"].as_object() {
                Some(expected) => {
                    let got = got.unwrap_or_else(|| panic!("{row}"));
                    assert_eq!(got.path, expected["path"].as_str().unwrap(), "{row}");
                    assert_eq!(got.title, expected["title"].as_str().unwrap(), "{row}");
                }
                None => assert!(got.is_none(), "{row}"),
            }
        }
        assert!(
            rows.iter().any(|row| row["result"].is_object())
                && rows.iter().any(|row| row["result"].is_null())
        );
    }
}
