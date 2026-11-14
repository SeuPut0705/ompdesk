//! Every string main shows (menus, tray, dialogs, notifications, coded failures) in both UI languages, and which one is
//! shown. `main-text.json` is the one table: `MAIN_TEXT`'s keys as they were, `TRAY_LABELS`'s as `tray.<key>`
//! (was `src/main/i18n-text.ts` and `tray-labels.ts`). The shell's modules read it through `labels::label`; Node's
//! `mainT` reads the copy the shell pushes (`boot.labels`, PROTOCOL.md §15.9). A new string is added here, in both
//! languages.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::Value;

/// A UI language (`src/shared/ui-language.ts` `UI_LANGUAGES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    Ko,
}

impl Lang {
    /// `en` / `ko`; anything else is not a UI language.
    pub fn parse(value: &str) -> Option<Lang> {
        match value {
            "en" => Some(Lang::En),
            "ko" => Some(Lang::Ko),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Ko => "ko",
        }
    }

    /// `uiLanguageFromLocale`: Korean for a `ko…` locale, English for every other.
    pub fn from_locale(locale: &str) -> Lang {
        if locale.to_ascii_lowercase().starts_with("ko") {
            Lang::Ko
        } else {
            Lang::En
        }
    }

    /// `getMainLanguage`: the language the person chose (prefs `language`), else the app locale's.
    pub fn chosen(stored: Option<&str>, app_locale: &str) -> Lang {
        stored
            .and_then(Lang::parse)
            .unwrap_or_else(|| Lang::from_locale(app_locale))
    }
}

/// The table as it is written: `{key: {en, ko}}`.
pub const RAW: &str = include_str!("main-text.json");

#[derive(Deserialize)]
struct Entry {
    en: String,
    ko: String,
}

static TABLE: LazyLock<HashMap<String, Entry>> =
    LazyLock::new(|| serde_json::from_str(RAW).expect("main-text.json is a table of {en, ko}"));

/// The table as JSON, for `boot.labels`.
pub static TABLE_JSON: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(RAW).expect("main-text.json is JSON"));

/// `key`'s template in `lang`, placeholders unfilled; `None` for a key the table lacks.
pub fn template(lang: Lang, key: &str) -> Option<&'static str> {
    TABLE.get(key).map(|entry| match lang {
        Lang::En => entry.en.as_str(),
        Lang::Ko => entry.ko.as_str(),
    })
}

/// The `language` the person stored in `<userData>/prefs.json` (electron-store's file), when it is a string.
pub fn stored_language(prefs_json: &str) -> Option<String> {
    serde_json::from_str::<Value>(prefs_json)
        .ok()?
        .get("language")?
        .as_str()
        .map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_has_both_languages_and_tray_keys_are_prefixed() {
        assert!(TABLE.len() > 200);
        assert_eq!(template(Lang::En, "menu.quit"), Some("Quit OMPdesk"));
        assert_eq!(template(Lang::Ko, "menu.quit"), Some("OMPdesk 종료"));
        assert_eq!(template(Lang::Ko, "tray.quit"), Some("종료"));
        assert_eq!(template(Lang::En, "no.such.key"), None);
        assert_eq!(TABLE_JSON.as_object().map(|o| o.len()), Some(TABLE.len()));
    }

    #[test]
    fn the_chosen_language_wins_over_the_locale() {
        assert_eq!(Lang::chosen(Some("ko"), "en-US"), Lang::Ko);
        assert_eq!(Lang::chosen(Some("de"), "ko-KR"), Lang::Ko);
        assert_eq!(Lang::chosen(None, "KO"), Lang::Ko);
        assert_eq!(Lang::chosen(None, "en-GB"), Lang::En);
        assert_eq!(Lang::chosen(None, ""), Lang::En);
    }

    #[test]
    fn reads_the_stored_language_from_prefs() {
        assert_eq!(
            stored_language(r#"{"language":"ko","theme":"dark"}"#).as_deref(),
            Some("ko")
        );
        assert_eq!(stored_language(r#"{"language":3}"#), None);
        assert_eq!(stored_language("not json"), None);
    }
}
