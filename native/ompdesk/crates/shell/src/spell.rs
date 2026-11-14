//! Spellchecker language codes (PROTOCOL.md §6 `setSpellCheckerLanguages`): Chromium's `spellcheck.dictionaries`
//! preference takes the codes of its dictionary list, spelled `en-US`, `ko`, `pt-BR`; Electron accepted `en_US` and any
//! case and ignored what Chromium has no dictionary for.

/// The codes Chromium ships a dictionary for (components/spellcheck `kSupportedSpellCheckerLanguages`), which is what
/// Electron's `availableSpellCheckerLanguages` lists.
pub const AVAILABLE: &[&str] = &[
    "af",
    "bg",
    "ca",
    "cs",
    "cy",
    "da",
    "de",
    "de-DE",
    "el",
    "en-AU",
    "en-CA",
    "en-GB",
    "en-GB-oxendict",
    "en-US",
    "es",
    "es-419",
    "es-AR",
    "es-ES",
    "es-MX",
    "es-US",
    "et",
    "fa",
    "fo",
    "fr",
    "fr-FR",
    "he",
    "hi",
    "hr",
    "hu",
    "hy",
    "id",
    "it",
    "it-IT",
    "ko",
    "lt",
    "lv",
    "nb",
    "nl",
    "pl",
    "pt-BR",
    "pt-PT",
    "ro",
    "ru",
    "sh",
    "sk",
    "sl",
    "sq",
    "sr",
    "sv",
    "ta",
    "tg",
    "tr",
    "uk",
    "vi",
];

/// The dictionary code for one requested language: the exact code (any case, `_` or `-`), else the bare language's
/// dictionary, else its first regional one; `None` when Chromium has none.
pub fn dictionary_for(requested: &str) -> Option<&'static str> {
    let tag = requested.trim().replace('_', "-").to_ascii_lowercase();
    if tag.is_empty() {
        return None;
    }
    let base = tag.split('-').next().unwrap_or("");
    let regional = format!("{base}-");
    let find = |wanted: &dyn Fn(&str) -> bool| {
        AVAILABLE
            .iter()
            .copied()
            .find(|code| wanted(&code.to_ascii_lowercase()))
    };
    find(&|code| code == tag)
        .or_else(|| find(&|code| code == base))
        .or(match base {
            // Chromium's own pick where the first regional dictionary in the list is not the common one.
            "en" => Some("en-US"),
            "pt" => Some("pt-BR"),
            _ => None,
        })
        .or_else(|| find(&|code| code.starts_with(&regional)))
}

/// The codes to hand Chromium for the requested list: each one's dictionary, those without one dropped, repeats
/// dropped, order kept.
pub fn normalize(requested: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for language in requested {
        if let Some(code) = dictionary_for(language)
            && !out.iter().any(|have| have == code)
        {
            out.push(code.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn underscores_and_case_become_the_dictionary_code() {
        assert_eq!(normalize(&list(&["en_US"])), ["en-US"]);
        assert_eq!(normalize(&list(&["EN-us", "PT_br"])), ["en-US", "pt-BR"]);
        assert_eq!(normalize(&list(&["ko"])), ["ko"]);
    }

    #[test]
    fn a_language_without_its_own_region_falls_to_the_bare_or_first_regional_dictionary() {
        assert_eq!(normalize(&list(&["ko-KR"])), ["ko"]);
        assert_eq!(normalize(&list(&["de-AT"])), ["de"]);
        // `en` and `pt` have no bare dictionary: Chromium's pick.
        assert_eq!(normalize(&list(&["en"])), ["en-US"]);
        assert_eq!(normalize(&list(&["pt"])), ["pt-BR"]);
        assert_eq!(normalize(&list(&["en-NZ"])), ["en-US"]);
        assert_eq!(normalize(&list(&["fr-CA"])), ["fr"]);
    }

    #[test]
    fn repeats_and_unknown_codes_are_dropped_in_order() {
        assert_eq!(
            normalize(&list(&["ko", "xx", "", " ko_KR ", "en-US", "en_us"])),
            ["ko", "en-US"]
        );
        assert!(normalize(&list(&["tlh", "  "])).is_empty());
        assert!(normalize(&[]).is_empty());
    }

    #[test]
    fn every_available_code_names_itself() {
        for code in AVAILABLE {
            assert_eq!(dictionary_for(code), Some(*code));
        }
    }
}
