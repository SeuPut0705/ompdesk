// UNVERIFIED on macOS: written against objc2 0.6 / objc2-foundation 0.3 and AppKit's headers; never compiled.
//! macOS counterpart of `sys::menu`: popup menus (`NSMenu popUpMenuPositioningItem:`) and the application menu (the
//! app's main menu, with key equivalents). Every call runs on the main thread. The AppKit classes are reached with
//! runtime `msg_send!` calls (as `desk.rs` does), so no per-class cargo feature is needed; the one class defined here
//! is the target custom items send their action to.
#![allow(unsafe_code)]

use std::cell::{Cell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, Sel};
use objc2::{AnyThread, class, define_class, msg_send, sel};
use objc2_foundation::{NSPoint, NSRect, NSString};

use crate::accelerator::Accelerator;
use crate::menu_model::{Entry, Hit, Item, ItemEntry, Mark, build_popup};

/// Tags of application-menu items start here; a popup's are the plain command numbers.
const APP_BASE: isize = 1 << 24;

// NSEventModifierFlags
const SHIFT: usize = 1 << 17;
const CONTROL: usize = 1 << 18;
const OPTION: usize = 1 << 19;
const COMMAND: usize = 1 << 20;

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class adds no instance variables.
    #[unsafe(super(NSObject))]
    #[name = "OMPdeskMenuTarget"]
    struct MenuTarget;

    impl MenuTarget {
        #[unsafe(method(fire:))]
        fn fire(&self, sender: &AnyObject) {
            fired(sender);
        }
    }
);

impl MenuTarget {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: `init` of NSObject on a freshly allocated instance whose (empty) ivars are set.
        unsafe { msg_send![super(this), init] }
    }
}

struct AppItem {
    id: String,
    mark: Mark,
}

thread_local! {
    /// Menu items hold their target weakly: it lives as long as the thread.
    static TARGET: Retained<MenuTarget> = MenuTarget::new();
    static CHOSEN: Cell<Option<u32>> = const { Cell::new(None) };
    static APP_ITEMS: RefCell<Vec<AppItem>> = const { RefCell::new(Vec::new()) };
    static ON_HIT: Cell<Option<fn(Hit)>> = const { Cell::new(None) };
}

/// A custom item was chosen: a popup's choice is remembered for `popup` to return; an application-menu item is
/// reported (a checkbox toggled first, as AppKit does not).
fn fired(sender: &AnyObject) {
    // SAFETY: `sender` is the NSMenuItem that sent the action.
    let tag: isize = unsafe { msg_send![sender, tag] };
    if tag >= APP_BASE {
        let index = (tag - APP_BASE) as usize;
        let Some((id, mark)) = APP_ITEMS.with(|items| {
            items
                .borrow()
                .get(index.wrapping_sub(1))
                .map(|i| (i.id.clone(), i.mark))
        }) else {
            return;
        };
        let checked = match mark {
            Mark::Checkbox(_) => {
                // SAFETY: reads and writes the item's state.
                let on = unsafe {
                    let state: isize = msg_send![sender, state];
                    let on = state == 0;
                    let _: () = msg_send![sender, setState: isize::from(on)];
                    on
                };
                Some(on)
            }
            Mark::Radio(_) => {
                // SAFETY: writes the item's state.
                unsafe {
                    let _: () = msg_send![sender, setState: 1isize];
                }
                Some(true)
            }
            Mark::None => None,
        };
        if let Some(on_hit) = ON_HIT.with(Cell::get) {
            on_hit(Hit { id, checked });
        }
    } else if tag > 0 {
        CHOSEN.with(|c| c.set(u32::try_from(tag).ok()));
    }
}

/// The main screen's backing scale (2.0 on Retina).
pub fn system_scale() -> f64 {
    // SAFETY: class messages to NSScreen on the main thread.
    unsafe {
        let screen: *mut AnyObject = msg_send![class!(NSScreen), mainScreen];
        if screen.is_null() {
            return 1.0;
        }
        let scale: f64 = msg_send![screen, backingScaleFactor];
        if scale > 0.0 { scale } else { 1.0 }
    }
}

fn selector_of(role: &str) -> Option<Sel> {
    Some(match role {
        "about" => sel!(orderFrontStandardAboutPanel:),
        "hide" => sel!(hide:),
        "hideOthers" => sel!(hideOtherApplications:),
        "unhide" => sel!(unhideAllApplications:),
        "front" => sel!(arrangeInFront:),
        "zoom" => sel!(performZoom:),
        "quit" => sel!(terminate:),
        "minimize" => sel!(performMiniaturize:),
        "close" => sel!(performClose:),
        _ => return None,
    })
}

fn modifier_mask(accelerator: &Accelerator) -> usize {
    let mods = accelerator.mods;
    (if mods.shift { SHIFT } else { 0 })
        | (if mods.ctrl { CONTROL } else { 0 })
        | (if mods.alt { OPTION } else { 0 })
        | (if mods.meta { COMMAND } else { 0 })
}

fn nsstring(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn new_menu(title: &str) -> Retained<AnyObject> {
    // SAFETY: `new` creates an NSMenu (+1); the title is an NSString; the menu is left to enable its items itself
    // off, because every item's state comes from the template.
    unsafe {
        let menu: Retained<AnyObject> = msg_send![class!(NSMenu), new];
        let _: () = msg_send![&*menu, setTitle: &*nsstring(title)];
        let _: () = msg_send![&*menu, setAutoenablesItems: Bool::NO];
        menu
    }
}

/// A custom or role item.
fn new_item(entry: &ItemEntry, target: &MenuTarget, tag: isize) -> Retained<AnyObject> {
    // SAFETY: messages to a freshly created NSMenuItem; every argument matches the selector's type.
    unsafe {
        let item: Retained<AnyObject> = msg_send![class!(NSMenuItem), new];
        let _: () = msg_send![&*item, setTitle: &*nsstring(&entry.label)];
        match entry.role.as_deref().and_then(selector_of) {
            // A role acts on the app or the key window through the responder chain: no target.
            Some(action) => {
                let _: () = msg_send![&*item, setAction: action];
            }
            None => {
                let _: () = msg_send![&*item, setAction: sel!(fire:)];
                let _: () = msg_send![&*item, setTarget: target];
            }
        }
        if let Some(accelerator) = &entry.accelerator
            && let Some(key) = accelerator.mac_key_equivalent()
        {
            let _: () = msg_send![&*item, setKeyEquivalent: &*nsstring(&key.to_string())];
            let _: () = msg_send![&*item, setKeyEquivalentModifierMask: modifier_mask(accelerator)];
        }
        let state: isize = if matches!(entry.mark, Mark::Checkbox(true) | Mark::Radio(true)) {
            1
        } else {
            0
        };
        let _: () = msg_send![&*item, setState: state];
        let _: () = msg_send![&*item, setEnabled: Bool::new(entry.enabled)];
        let _: () = msg_send![&*item, setTag: tag];
        if let Some(tip) = &entry.tool_tip {
            let _: () = msg_send![&*item, setToolTip: &*nsstring(tip)];
        }
        if let Some(sublabel) = &entry.sublabel {
            // NSMenuItem.subtitle exists from macOS 14.4.
            let responds: Bool = msg_send![&*item, respondsToSelector: sel!(setSubtitle:)];
            if responds.as_bool() {
                let _: () = msg_send![&*item, setSubtitle: &*nsstring(sublabel)];
            }
        }
        item
    }
}

/// Fills `menu` with `entries`; a clickable item's tag is `tag_base + cmd`.
fn fill_menu(menu: &AnyObject, entries: &[Entry], target: &MenuTarget, tag_base: isize) {
    // SAFETY: messages to menus and items created here, on the main thread.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        for entry in entries {
            match entry {
                Entry::Separator => {
                    let separator: Retained<AnyObject> =
                        msg_send![class!(NSMenuItem), separatorItem];
                    let _: () = msg_send![menu, addItem: &*separator];
                }
                Entry::Item(item) => {
                    let item = new_item(item, target, tag_base + item.cmd as isize);
                    let _: () = msg_send![menu, addItem: &*item];
                }
                Entry::Submenu {
                    label,
                    enabled,
                    role,
                    entries,
                } => {
                    let item: Retained<AnyObject> = msg_send![class!(NSMenuItem), new];
                    let _: () = msg_send![&*item, setTitle: &*nsstring(label)];
                    let _: () = msg_send![&*item, setEnabled: Bool::new(*enabled)];
                    let sub = new_menu(label);
                    fill_menu(&sub, entries, target, tag_base);
                    let _: () = msg_send![&*item, setSubmenu: &*sub];
                    match role.as_deref() {
                        Some("services") => {
                            let _: () = msg_send![app, setServicesMenu: &*sub];
                        }
                        Some("windowMenu") => {
                            let _: () = msg_send![app, setWindowsMenu: &*sub];
                        }
                        Some("help") => {
                            let _: () = msg_send![app, setHelpMenu: &*sub];
                        }
                        _ => {}
                    }
                    let _: () = msg_send![menu, addItem: &*item];
                }
            }
        }
    }
}

/// The screen point (bottom-left origin) for `x, y` DIP from the top-left of the content of the window `owner`
/// (an NSView or an NSWindow), or the mouse location.
fn screen_point(owner: isize, at: Option<(f64, f64)>) -> NSPoint {
    // SAFETY: `owner` is a live NSView or NSWindow pointer from the shell's window registry (checked non-null);
    // the other messages go to AppKit classes.
    unsafe {
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let (Some((x, y)), true) = (at, owner != 0) else {
            return mouse;
        };
        let object = owner as *mut AnyObject;
        let is_window: Bool = msg_send![object, isKindOfClass: class!(NSWindow)];
        let window: *mut AnyObject = if is_window.as_bool() {
            object
        } else {
            msg_send![object, window]
        };
        if window.is_null() {
            return mouse;
        }
        let frame: NSRect = msg_send![window, frame];
        let content: NSRect = msg_send![window, contentRectForFrameRect: frame];
        NSPoint::new(
            content.origin.x + x,
            content.origin.y + content.size.height - y,
        )
    }
}

/// Shows `entries` and returns the command chosen (`None`: dismissed). Blocks in AppKit's menu tracking loop until
/// the menu closes; `before` runs just before it opens, `after` right after it closed.
pub fn popup(
    owner: isize,
    entries: &[Entry],
    at: Option<(f64, f64)>,
    before: impl FnOnce(),
    after: impl FnOnce(),
) -> Result<Option<u32>, String> {
    let menu = new_menu("");
    TARGET.with(|target| fill_menu(&menu, entries, target, 0));
    let point = screen_point(owner, at);
    CHOSEN.with(|c| c.set(None));
    before();
    // SAFETY: shows the menu at a screen point (no view); the call returns when the menu has closed and its action,
    // if any, has been sent (`fired` stored the command).
    unsafe {
        let _: Bool = msg_send![&*menu, popUpMenuPositioningItem: std::ptr::null::<AnyObject>(), atLocation: point, inView: std::ptr::null::<AnyObject>()];
    }
    after();
    Ok(CHOSEN.with(Cell::take))
}

/// Makes `items` the app's main menu (`None` removes it). Custom items report through `on_hit`.
pub fn set_application(items: Option<&[Item]>, on_hit: fn(Hit)) -> Result<(), String> {
    ON_HIT.with(|h| h.set(Some(on_hit)));
    // SAFETY: sharedApplication on the main thread.
    let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
    let Some(items) = items else {
        APP_ITEMS.with(|a| a.borrow_mut().clear());
        // SAFETY: a nil main menu removes the menu bar.
        unsafe {
            let _: () = msg_send![app, setMainMenu: std::ptr::null::<AnyObject>()];
        }
        return Ok(());
    };
    let popup = build_popup(items, true);
    let mut marks: Vec<Mark> = vec![Mark::None; popup.ids.len()];
    collect_marks(&popup.entries, &mut marks);
    APP_ITEMS.with(|a| {
        *a.borrow_mut() = popup
            .ids
            .iter()
            .zip(marks)
            .map(|(id, mark)| AppItem {
                id: id.clone(),
                mark,
            })
            .collect()
    });
    let menu = new_menu("");
    TARGET.with(|target| fill_menu(&menu, &popup.entries, target, APP_BASE));
    // SAFETY: installs the menu as the main menu.
    unsafe {
        let _: () = msg_send![app, setMainMenu: &*menu];
    }
    Ok(())
}

fn collect_marks(entries: &[Entry], marks: &mut [Mark]) {
    for entry in entries {
        match entry {
            Entry::Item(item) => {
                if let Some(slot) = marks.get_mut((item.cmd as usize).wrapping_sub(1)) {
                    *slot = item.mark;
                }
            }
            Entry::Submenu { entries, .. } => collect_marks(entries, marks),
            Entry::Separator => {}
        }
    }
}
