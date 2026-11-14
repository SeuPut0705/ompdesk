//! Pure state of the screen / theme / power namespaces: what a native message means, the theme override, the display
//! diff and the power-blocker set.

use std::collections::HashMap;

use serde_json::{Value, json};

/// What the platform's hidden window reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Msg {
    Suspend,
    Resume,
    PowerStatus,
    Lock,
    Unlock,
    Shutdown,
    /// Theme, colour, animation or work-area setting changed.
    SettingChange,
    DisplayChange,
    Hotkey(i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemeSource {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeSource {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "system" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

/// `nativeTheme.shouldUseDarkColors` etc.: `system` is `{dark, highContrast, inverted}` as the OS reports; `light`/`dark`
/// override only `dark`.
pub fn effective_theme(system: &Value, source: ThemeSource) -> Value {
    let dark = match source {
        ThemeSource::System => system["dark"].as_bool().unwrap_or(false),
        ThemeSource::Light => false,
        ThemeSource::Dark => true,
    };
    json!({
        "dark": dark,
        "highContrast": system["highContrast"].as_bool().unwrap_or(false),
        "inverted": system["inverted"].as_bool().unwrap_or(false),
    })
}

/// Why the display list moved, or `None` when nothing a listener could see changed.
pub fn displays_change(old: &(Vec<Value>, i64), new: &(Vec<Value>, i64)) -> Option<&'static str> {
    if old == new {
        return None;
    }
    Some(match new.0.len().cmp(&old.0.len()) {
        std::cmp::Ordering::Greater => "added",
        std::cmp::Ordering::Less => "removed",
        std::cmp::Ordering::Equal => "metrics",
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerKind {
    AppSuspension,
    DisplaySleep,
}

impl BlockerKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "prevent-app-suspension" => Some(Self::AppSuspension),
            "prevent-display-sleep" => Some(Self::DisplaySleep),
            _ => None,
        }
    }
}

/// Live blockers by Node's id.
#[derive(Debug, Default)]
pub struct Blockers {
    live: HashMap<String, BlockerKind>,
}

impl Blockers {
    pub fn start(&mut self, id: String, kind: BlockerKind) {
        self.live.insert(id, kind);
    }

    pub fn stop(&mut self, id: &str) -> bool {
        self.live.remove(id).is_some()
    }

    /// `(keep the system awake, keep the display on)`; a display blocker also keeps the system awake.
    pub fn wanted(&self) -> (bool, bool) {
        let display = self.live.values().any(|k| *k == BlockerKind::DisplaySleep);
        (!self.live.is_empty(), display)
    }
}

/// `SetThreadExecutionState` argument: `ES_CONTINUOUS` plus what is wanted (alone it clears).
pub fn execution_flags(system: bool, display: bool) -> u32 {
    let mut flags = 0x8000_0000;
    if system {
        flags |= 0x1;
    }
    if display {
        flags |= 0x2;
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_override_only_moves_dark() {
        let sys = json!({"dark": true, "highContrast": true, "inverted": false});
        assert_eq!(effective_theme(&sys, ThemeSource::System)["dark"], true);
        let light = effective_theme(&sys, ThemeSource::Light);
        assert_eq!(light["dark"], false);
        assert_eq!(light["highContrast"], true);
        assert_eq!(
            effective_theme(&json!({"dark": false}), ThemeSource::Dark)["dark"],
            true
        );
        assert_eq!(ThemeSource::parse("dark"), Some(ThemeSource::Dark));
        assert_eq!(ThemeSource::parse("x"), None);
    }

    #[test]
    fn display_diff_reasons() {
        let one = (vec![json!({"id": 1})], 1);
        let two = (vec![json!({"id": 1}), json!({"id": 2})], 1);
        let moved = (vec![json!({"id": 1, "w": 2})], 1);
        assert_eq!(displays_change(&one, &one), None);
        assert_eq!(displays_change(&one, &two), Some("added"));
        assert_eq!(displays_change(&two, &one), Some("removed"));
        assert_eq!(displays_change(&one, &moved), Some("metrics"));
    }

    #[test]
    fn blockers_recompute_from_the_live_set() {
        let mut b = Blockers::default();
        assert_eq!(b.wanted(), (false, false));
        b.start("1".into(), BlockerKind::AppSuspension);
        assert_eq!(b.wanted(), (true, false));
        b.start("2".into(), BlockerKind::DisplaySleep);
        assert_eq!(b.wanted(), (true, true));
        assert!(b.stop("2"));
        assert!(!b.stop("2"));
        assert_eq!(b.wanted(), (true, false));
        assert!(b.stop("1"));
        assert_eq!(execution_flags(b.wanted().0, b.wanted().1), 0x8000_0000);
        assert_eq!(execution_flags(true, true), 0x8000_0003);
    }
}
