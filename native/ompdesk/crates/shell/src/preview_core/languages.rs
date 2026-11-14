//! The Accept-Language the Preview's pages send: the system's languages, not the en-US Chromium's trimmed locale set
//! leaves (was `acceptLanguages` of `src/main/system-languages.ts`, whose only caller was the Preview).

/// Each system language, then its bare language, then English, as Chromium's own defaults read; "" for none.
pub fn accept_languages(preferred: &[String]) -> String {
    fn add(list: &mut Vec<String>, tag: &str) {
        if !tag.is_empty() && !list.iter().any(|entry| entry.eq_ignore_ascii_case(tag)) {
            list.push(tag.to_owned());
        }
    }
    let mut list: Vec<String> = Vec::new();
    for raw in preferred {
        let tag = raw.trim_matches(super::js::is_space).replace('_', "-");
        add(&mut list, &tag);
        add(&mut list, tag.split('-').next().unwrap_or(""));
    }
    if list.is_empty() {
        return String::new();
    }
    add(&mut list, "en-US");
    add(&mut list, "en");
    list.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(tags: &[&str]) -> String {
        accept_languages(&tags.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn lists_each_system_language_its_bare_language_then_english() {
        assert_eq!(of(&["de-DE", "en-GB"]), "de-DE,de,en-GB,en,en-US");
        assert_eq!(of(&["ko-KR"]), "ko-KR,ko,en-US,en");
        assert_eq!(of(&["pt_BR", "pt-PT", "en-US"]), "pt-BR,pt,pt-PT,en-US,en");
        assert_eq!(of(&[]), "");
        assert_eq!(of(&["de-DE"]), "de-DE,de,en-US,en");
    }
}
