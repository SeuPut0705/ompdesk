//! Pure decisions behind two native surfaces: the taskbar/Dock progress of `win.op setProgressBar` and the window
//! chrome colour scheme that follows `nativeTheme.themeSource`.

use crate::desk_state::ThemeSource;

/// Resolution of the determinate progress: `completed` out of this many.
pub const PROGRESS_TOTAL: u64 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress {
    None,
    Indeterminate,
    Normal(u64),
    Error(u64),
    Paused(u64),
}

/// Electron's `setProgressBar(value, {mode})`: `value` in 0..=1 is determinate, below 0 removes the bar, above 1 is
/// indeterminate. An explicit `mode` wins over what `value` implies (`none` and `indeterminate` ignore the value; the
/// others keep a determinate fill, clamped to 0..=1).
pub fn progress(value: f64, mode: Option<&str>) -> Progress {
    let fill = || {
        let v = if value.is_nan() {
            0.0
        } else {
            value.clamp(0.0, 1.0)
        };
        (v * PROGRESS_TOTAL as f64).round() as u64
    };
    match mode {
        Some("none") => Progress::None,
        Some("indeterminate") => Progress::Indeterminate,
        Some("error") => Progress::Error(fill()),
        Some("paused") => Progress::Paused(fill()),
        Some("normal") => Progress::Normal(fill()),
        _ if value.is_nan() || value < 0.0 => Progress::None,
        _ if value > 1.0 => Progress::Indeterminate,
        _ => Progress::Normal(fill()),
    }
}

/// Whether window chrome is dark for `source`; `system_dark` is what the OS reports now.
pub fn chrome_dark(source: ThemeSource, system_dark: bool) -> bool {
    match source {
        ThemeSource::System => system_dark,
        ThemeSource::Light => false,
        ThemeSource::Dark => true,
    }
}

/// A window's largest size for the window delegate (`(0, 0)` means the OS default). `enableLargerThanScreen` lifts the
/// OS clamp to the display (Windows answers `WM_GETMINMAXINFO` from this maximum): a window may then be sized beyond
/// the screen, as Electron's option allows. An explicit maximum wins.
pub fn max_window_size(max: (i32, i32), larger_than_screen: bool) -> (i32, i32) {
    const HUGE: i32 = 16_384;
    match (max, larger_than_screen) {
        ((0, 0), true) => (HUGE, HUGE),
        _ => max,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_may_pass_the_screen_only_when_it_asked_to() {
        assert_eq!(max_window_size((0, 0), false), (0, 0));
        assert_eq!(max_window_size((0, 0), true), (16_384, 16_384));
        assert_eq!(max_window_size((1200, 800), true), (1200, 800));
    }

    #[test]
    fn value_maps_to_state() {
        assert_eq!(progress(-1.0, None), Progress::None);
        assert_eq!(progress(f64::NAN, None), Progress::None);
        assert_eq!(progress(0.0, None), Progress::Normal(0));
        assert_eq!(progress(0.5, None), Progress::Normal(500));
        assert_eq!(progress(1.0, None), Progress::Normal(1000));
        assert_eq!(progress(2.0, None), Progress::Indeterminate);
    }

    #[test]
    fn mode_overrides_value() {
        assert_eq!(progress(0.5, Some("none")), Progress::None);
        assert_eq!(
            progress(0.5, Some("indeterminate")),
            Progress::Indeterminate
        );
        assert_eq!(progress(0.25, Some("error")), Progress::Error(250));
        assert_eq!(progress(7.0, Some("paused")), Progress::Paused(1000));
        assert_eq!(progress(-1.0, Some("normal")), Progress::Normal(0));
        assert_eq!(progress(0.5, Some("bogus")), Progress::Normal(500));
    }

    #[test]
    fn chrome_follows_source() {
        assert!(chrome_dark(ThemeSource::System, true));
        assert!(!chrome_dark(ThemeSource::System, false));
        assert!(!chrome_dark(ThemeSource::Light, true));
        assert!(chrome_dark(ThemeSource::Dark, false));
    }
}
