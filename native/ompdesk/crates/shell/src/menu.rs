//! The native menus of the shell's modules: the application menu's installation and the popup (the tray's menu, a
//! page's context menu). The platform code is `shell_core::sys::menu` (Win32) or `shell_core::sys_mac::menu` (AppKit);
//! the template walking is `shell_core::menu_model`. Everything here runs on the UI thread.

use shell_core::menu_model::{self, Hit, Item};

use crate::state;

#[cfg(windows)]
use shell_core::sys::menu as platform;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::menu as platform;

/// The platform's scale for pictures that belong to no window (the tray's icon).
pub fn display_scale() -> f64 {
    platform::system_scale()
}

/// The OS handle of window `id` (0 when it has none yet). The registry borrow ends here: a popup's modal loop runs
/// other tasks that borrow it.
fn window_handle(id: u64) -> Option<isize> {
    let entry = state::win(id)?;
    let handle = entry
        .borrow()
        .window
        .as_ref()
        .map_or(0, state::native_handle);
    Some(handle)
}

/// Shows `items` as a popup menu and returns the id of the chosen item (`None`: dismissed). `owner` is a window handle
/// (0: none), `at` a point in DIP of its content (`None`: the cursor). Blocks in the platform's menu loop until the menu
/// closes. `before` runs just before the menu opens, `after` right after it
/// closed (and before the caller acts on the choice, as Electron's `menu-will-close` came before the item's click).
pub fn popup_with(
    items: &[Item],
    owner: isize,
    at: Option<(f64, f64)>,
    before: impl FnOnce(),
    after: impl FnOnce(),
) -> Result<Option<String>, String> {
    let popup = menu_model::build_popup(items, cfg!(target_os = "macos"));
    if popup.entries.is_empty() {
        return Ok(None);
    }
    let chosen = platform::popup(owner, &popup.entries, at, before, after)?;
    Ok(chosen.and_then(|cmd| popup.id_of(cmd)).map(String::from))
}

/// A popup at the cursor over the app window `win_id` (a module's context menu); `None`: dismissed. UI thread.
pub fn popup_in_window(win_id: u64, items: &[Item]) -> Result<Option<String>, String> {
    let owner = window_handle(win_id).unwrap_or(0);
    popup_with(items, owner, None, || {}, || {})
}

/// Makes `items` the app's menu for a module of the shell: a choice (or an accelerator) reports to `on_hit` with the
/// item's id, never to Node as `menu.click`. UI thread.
pub fn install_application(items: &[Item], on_hit: fn(Hit)) -> Result<(), String> {
    platform::set_application(Some(items), on_hit)
}
