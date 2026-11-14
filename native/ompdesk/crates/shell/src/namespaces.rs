//! Who owns a method or event name on the host wire: the Electron shim's namespaces (PROTOCOL.md §1–13) or one
//! subsystem moved out of the Node main into the shell (PROTOCOL.md §15, batch SX). Pure, so `cargo test` checks the
//! registration list's rules without CEF; the binary asserts them once when it builds its registry.

/// The namespaces the Electron shim speaks, plus the contract's own (PROTOCOL.md §15): `core` (the relay to
/// `ompdesk-core`), `log` (lines for `gui-runtime.jsonl`, written by Node) and `i18n` (Node's label table). A moved module
/// never takes one of these: `app.*` is the one namespace Node sends before `app.ready`, and a module
/// beside a shim namespace of the same name would split one table between two owners.
pub const SHIM_NAMESPACES: &[&str] = &[
    "hello",
    "app",
    "win",
    "wc",
    "view",
    "session",
    "protocol",
    "menu",
    "tray",
    "dialog",
    "clipboard",
    "shell",
    "notification",
    "screen",
    "theme",
    "power",
    "shortcut",
    "net",
    "system",
    "ipc",
    "core",
    "log",
    "i18n",
];

/// The namespace of a method or event name: the text before its first dot (the whole name when it has none).
pub fn namespace_of(name: &str) -> &str {
    name.split_once('.')
        .map_or(name, |(namespace, _)| namespace)
}

/// Checks a registration list: each namespace one lowercase word (`[a-z][a-z0-9]*`), none a shim namespace, none
/// twice. The error names the first namespace that breaks a rule.
pub fn check_modules(namespaces: &[&str]) -> Result<(), String> {
    for (index, namespace) in namespaces.iter().enumerate() {
        let mut chars = namespace.chars();
        let word = chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        if !word {
            return Err(format!(
                "module namespace {namespace:?} is not one lowercase word"
            ));
        }
        if SHIM_NAMESPACES.contains(namespace) {
            return Err(format!(
                "module namespace {namespace:?} is the Electron shim's"
            ));
        }
        if namespaces[..index].contains(namespace) {
            return Err(format!("module namespace {namespace:?} registered twice"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_belongs_to_the_text_before_its_first_dot() {
        assert_eq!(namespace_of("preview.open"), "preview");
        assert_eq!(namespace_of("wc.cdp.send"), "wc");
        assert_eq!(namespace_of("hello"), "hello");
    }

    #[test]
    fn the_batch_sx_namespaces_pass() {
        assert_eq!(
            check_modules(&["chrome", "preview", "services", "updater", "boot"]),
            Ok(())
        );
    }

    #[test]
    fn a_module_never_takes_a_shim_namespace() {
        for taken in ["app", "tray", "menu", "core", "win"] {
            assert!(check_modules(&["preview", taken]).is_err(), "{taken}");
        }
    }

    #[test]
    fn a_namespace_is_one_lowercase_word_owned_once() {
        assert!(check_modules(&["app.windows"]).is_err());
        assert!(check_modules(&["Preview"]).is_err());
        assert!(check_modules(&["1st"]).is_err());
        assert!(check_modules(&[""]).is_err());
        assert!(check_modules(&["updater", "updater"]).is_err());
    }
}
