//! Which navigations Node is asked about (`wc.navigate`). Electron emits no `will-navigate` for a reload, a history step or
//! a fragment change, so the shell does not ask for them either: Node's handler prevents every navigation it is asked
//! about that it did not start itself, which would cancel a DevTools reload.

const TT_SOURCE_MASK: i32 = 0xFF;
const TT_RELOAD: i32 = 8;
const TT_FORWARD_BACK_FLAG: i32 = 0x0100_0000;

/// A reload (the transition's source) or a back/forward step (its qualifier), from CEF's `cef_transition_type_t` bits.
pub fn is_reload_or_history_step(transition: i32) -> bool {
    transition & TT_SOURCE_MASK == TT_RELOAD || transition & TT_FORWARD_BACK_FLAG != 0
}

/// A navigation to a fragment of the document `current` already shows.
pub fn is_fragment_change(current: &str, target: &str) -> bool {
    let Some((target_page, _)) = target.split_once('#') else {
        return false;
    };
    current.split_once('#').map_or(current, |(page, _)| page) == target_page
}

/// Whether `wc.navigate` is asked at all: not for reloads, history steps or fragment changes.
pub fn asks_node(transition: i32, current: &str, target: &str) -> bool {
    !is_reload_or_history_step(transition) && !is_fragment_change(current, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reload_or_a_history_step_is_not_asked_about() {
        assert!(is_reload_or_history_step(8)); // TT_RELOAD
        assert!(is_reload_or_history_step(8 | 0x0200_0000)); // with a client-redirect qualifier
        assert!(is_reload_or_history_step(0x0100_0000)); // TT_LINK, forward/back
        assert!(is_reload_or_history_step(1 | 0x0100_0000)); // TT_EXPLICIT, forward/back
        assert!(!is_reload_or_history_step(0)); // TT_LINK
        assert!(!is_reload_or_history_step(1)); // TT_EXPLICIT
        assert!(!is_reload_or_history_step(1 | 0x0200_0000));
    }

    #[test]
    fn only_a_fragment_of_the_shown_document_is_a_fragment_change() {
        assert!(is_fragment_change(
            "app://ompdesk/index.html",
            "app://ompdesk/index.html#x"
        ));
        assert!(is_fragment_change(
            "app://ompdesk/index.html#a",
            "app://ompdesk/index.html#b"
        ));
        assert!(!is_fragment_change(
            "app://ompdesk/index.html",
            "app://ompdesk/index.html"
        ));
        assert!(!is_fragment_change(
            "app://ompdesk/index.html",
            "app://ompdesk/other.html#x"
        ));
        assert!(!is_fragment_change(
            "app://ompdesk/index.html#a",
            "app://ompdesk/index.html"
        ));
    }

    #[test]
    fn node_is_asked_about_everything_else() {
        assert!(asks_node(
            0,
            "app://ompdesk/index.html",
            "https://example.com/"
        ));
        assert!(asks_node(
            1,
            "app://ompdesk/index.html",
            "file:///c:/x.html"
        ));
        assert!(!asks_node(
            8,
            "app://ompdesk/index.html",
            "app://ompdesk/index.html"
        ));
        assert!(!asks_node(
            0,
            "app://ompdesk/index.html",
            "app://ompdesk/index.html#top"
        ));
    }
}
