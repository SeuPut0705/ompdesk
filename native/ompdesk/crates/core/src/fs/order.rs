//! Text rules the TypeScript took from the JavaScript engine: name order (`Intl.Collator(locale, { numeric: true })`,
//! ICU's collation with the same locale), `toLocaleLowerCase`, and what `trim` removes.

use std::cmp::Ordering;

use icu_casemap::CaseMapper;
use icu_collator::options::CollatorOptions;
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use icu_locale_core::Locale;

/// Name order for every listing: numeric runs compare as numbers (`file-2` before `file-10`), the rest as ICU's
/// collation for `locale` (main passes the locale its `Intl.Collator` resolves).
pub struct NameOrder {
    collator: CollatorBorrowed<'static>,
    locale: Locale,
}

impl NameOrder {
    pub fn new(locale: &str) -> NameOrder {
        let locale = Locale::try_from_str(locale).unwrap_or(Locale::UNKNOWN);
        let collator = Self::collator(&locale)
            .or_else(|| Self::collator(&Locale::UNKNOWN))
            .unwrap_or_else(|| unreachable!("the root collation is compiled in"));
        NameOrder { collator, locale }
    }

    fn collator(locale: &Locale) -> Option<CollatorBorrowed<'static>> {
        let mut prefs = CollatorPreferences::from(locale);
        prefs.numeric_ordering = Some(CollationNumericOrdering::True);
        Collator::try_new(prefs, CollatorOptions::default()).ok()
    }

    pub fn compare(&self, a: &str, b: &str) -> Ordering {
        self.collator.compare(a, b)
    }

    /// `text.toLocaleLowerCase()` under this locale.
    pub fn lowercase(&self, text: &str) -> String {
        CaseMapper::new()
            .lowercase_to_string(text, &self.locale.id)
            .into_owned()
    }
}

/// JavaScript's WhiteSpace and LineTerminator: what `trim` removes (U+FEFF yes, U+0085 no, unlike Rust's `trim`).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_numbers_by_value() {
        let order = NameOrder::new("en-US");
        let mut names = vec![
            "file-10.txt",
            "file-2.txt",
            "Notes.md",
            "file-1.txt",
            "file-010.txt",
        ];
        names.sort_by(|a, b| order.compare(a, b));
        // What `["…"].sort(new Intl.Collator("en-US", { numeric: true }).compare)` gives in node 24.
        assert_eq!(
            names,
            [
                "file-1.txt",
                "file-2.txt",
                "file-10.txt",
                "file-010.txt",
                "Notes.md"
            ]
        );
    }

    #[test]
    fn falls_back_to_the_root_order_for_a_locale_it_cannot_read() {
        let order = NameOrder::new("not a locale");
        assert_eq!(order.compare("a2", "a10"), Ordering::Less);
    }

    #[test]
    fn lowercases_by_locale() {
        assert_eq!(
            NameOrder::new("en-US").lowercase("ÎSTANBUL ΟΔΟΣ"),
            "îstanbul οδος"
        );
        assert_eq!(NameOrder::new("tr").lowercase("KIRMIZI İ"), "kırmızı i");
    }

    #[test]
    fn trims_what_javascript_trims() {
        assert_eq!(js_trim("\u{feff}\u{3000} x \u{2029}"), "x");
        assert_eq!(js_trim("\u{85}x"), "\u{85}x");
    }
}
