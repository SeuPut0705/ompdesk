// UNVERIFIED on macOS: written against objc2 0.6 / objc2-foundation 0.3 and AppKit's headers; never compiled.
//! macOS counterpart of `sys::dialogs`: NSAlert for the message box, NSOpenPanel / NSSavePanel for files. AppKit is
//! reached with runtime `msg_send!` calls (no per-class cargo feature, as in `desk`). Everything runs on the main
//! thread (CEF's UI thread) and is modal.
#![allow(unsafe_code)]

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSArray, NSString, NSURL};

use crate::dialog_spec::{
    DialogCancel, FileDialogSpec, MessageBoxResult, MessageBoxSpec, MessageType, default_extension,
    split_default_path,
};

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn string_of(value: Option<Retained<NSString>>) -> String {
    value.map(|s| s.to_string()).unwrap_or_default()
}

/// NSAlert, run as an application-modal dialog (the owner `winId` does not get a sheet: `runModal` blocks the app's
/// main thread until a button is chosen, which is what the caller waits for). A `cancel` aborts the modal session
/// (`abortModal`, queued on the main thread, whose modal run loop runs it): the answer is `cancelId`. A cancel that
/// lands in the instant between `runModal` returning and `disarm` aborts the next modal session, if one starts first.
pub fn message_box(
    _owner: isize,
    spec: &MessageBoxSpec,
    cancel: &DialogCancel,
) -> Result<MessageBoxResult, String> {
    if cancel.is_cancelled() {
        return Ok(MessageBoxResult {
            response: spec.cancel_id,
            checkbox_checked: spec.checkbox_checked,
        });
    }
    // SAFETY: NSAlert messages on the main thread; every argument is a live object or a plain value of the declared type.
    unsafe {
        let alert: Retained<AnyObject> = msg_send![class!(NSAlert), new];
        let _: () = msg_send![&*alert, setMessageText: &*ns(&spec.message)];
        let _: () = msg_send![&*alert, setInformativeText: &*ns(&spec.detail)];
        // NSAlertStyleWarning 0, Informational 1, Critical 2.
        let style: usize = match spec.kind {
            MessageType::Warning => 0,
            MessageType::Error => 2,
            _ => 1,
        };
        let _: () = msg_send![&*alert, setAlertStyle: style];
        if !spec.title.is_empty() {
            let window: Retained<AnyObject> = msg_send![&*alert, window];
            let _: () = msg_send![&*window, setTitle: &*ns(&spec.title)];
        }
        for label in &spec.buttons {
            let _: Retained<AnyObject> = msg_send![&*alert, addButtonWithTitle: &*ns(label)];
        }
        let buttons: Retained<NSArray<AnyObject>> = msg_send![&*alert, buttons];
        for index in 0..spec.buttons.len() {
            let button: Retained<AnyObject> = msg_send![&*buttons, objectAtIndex: index];
            // Return belongs to the default button, Escape to the one that backs out (when it is another one).
            let key = if index == spec.default_id {
                "\r"
            } else if index == spec.cancel_id {
                "\u{1b}"
            } else {
                ""
            };
            let _: () = msg_send![&*button, setKeyEquivalent: &*ns(key)];
        }
        if let Some(label) = &spec.checkbox_label {
            let _: () = msg_send![&*alert, setShowsSuppressionButton: true];
            let checkbox: Retained<AnyObject> = msg_send![&*alert, suppressionButton];
            let _: () = msg_send![&*checkbox, setTitle: &*ns(label)];
            let state: isize = isize::from(spec.checkbox_checked);
            let _: () = msg_send![&*checkbox, setState: state];
        }
        // `sharedApplication` is the process's one NSApplication, readable from any thread, and
        // `performSelectorOnMainThread:withObject:waitUntilDone:` is safe from any thread; `abortModal` then runs on the
        // main thread in the modal session's run loop (common modes).
        cancel.arm(|| {
            let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![
                &*app,
                performSelectorOnMainThread: sel!(abortModal),
                withObject: std::ptr::null::<AnyObject>(),
                waitUntilDone: Bool::NO
            ];
        });
        // NSAlertFirstButtonReturn is 1000; a button's response is 1000 + its index. An aborted session answers
        // NSModalResponseAbort (-1001), which is `cancelId`.
        let code: isize = msg_send![&*alert, runModal];
        cancel.disarm();
        let response = usize::try_from(code - 1000)
            .ok()
            .filter(|i| *i < spec.buttons.len())
            .unwrap_or(spec.cancel_id);
        let mut checked = false;
        if spec.checkbox_label.is_some() {
            let checkbox: Retained<AnyObject> = msg_send![&*alert, suppressionButton];
            let state: isize = msg_send![&*checkbox, state];
            checked = state == 1;
        }
        Ok(MessageBoxResult {
            response,
            checkbox_checked: checked,
        })
    }
}

fn file_url(path: &str) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&ns(path))
}

/// Settings both panels share: title, prompt, message, start folder, hidden files, file types.
///
/// # Safety
/// `panel` must be a live NSSavePanel (or NSOpenPanel); main thread.
unsafe fn configure(panel: &AnyObject, spec: &FileDialogSpec, save: bool) {
    // SAFETY: the caller's contract; each message below is one NSSavePanel declares, with arguments of its types.
    unsafe {
        if let Some(title) = &spec.title {
            let _: () = msg_send![panel, setTitle: &*ns(title)];
        }
        if let Some(label) = &spec.button_label {
            let _: () = msg_send![panel, setPrompt: &*ns(label)];
        }
        if let Some(message) = &spec.message {
            let _: () = msg_send![panel, setMessage: &*ns(message)];
        }
        let _: () = msg_send![panel, setShowsHiddenFiles: spec.show_hidden];
        let _: () = msg_send![panel, setCanCreateDirectories: spec.create_directory || save];
        let _: () =
            msg_send![panel, setTreatsFilePackagesAsDirectories: spec.treat_package_as_directory];
        let any_file = spec
            .filters
            .iter()
            .any(|f| f.extensions.iter().any(|e| e == "*"));
        if !spec.filters.is_empty() && !any_file {
            let types: Vec<Retained<NSString>> = spec
                .filters
                .iter()
                .flat_map(|f| f.extensions.iter())
                .map(|e| ns(e))
                .collect();
            let list = NSArray::from_retained_slice(&types);
            let _: () = msg_send![panel, setAllowedFileTypes: &*list];
        }
        if let Some(path) = &spec.default_path {
            let split = split_default_path(path, |p| std::path::Path::new(p).is_dir());
            if let Some(folder) = split
                .folder
                .as_deref()
                .filter(|f| std::path::Path::new(f).is_dir())
            {
                let _: () = msg_send![panel, setDirectoryURL: &*file_url(folder)];
            }
            if save && let Some(name) = &split.name {
                let _: () = msg_send![panel, setNameFieldStringValue: &*ns(name)];
            }
        }
        if save {
            if let Some(label) = &spec.name_field_label {
                let _: () = msg_send![panel, setNameFieldLabel: &*ns(label)];
            }
            // Same as Windows: the first filter's extension is appended when the user types none.
            if default_extension(&spec.filters).is_some() && !any_file {
                let _: () = msg_send![panel, setExtensionHidden: false];
            }
        }
    }
}

/// `Ok(None)` when the user cancelled.
pub fn open_dialog(_owner: isize, spec: &FileDialogSpec) -> Result<Option<Vec<String>>, String> {
    // SAFETY: NSOpenPanel messages on the main thread, with arguments of the declared types.
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class!(NSOpenPanel), openPanel];
        configure(&panel, spec, false);
        let files = spec.open_file || !spec.open_directory;
        let _: () = msg_send![&*panel, setCanChooseFiles: files];
        let _: () = msg_send![&*panel, setCanChooseDirectories: spec.open_directory];
        let _: () = msg_send![&*panel, setAllowsMultipleSelection: spec.multi_selections];
        // NSModalResponseOK is 1.
        let code: isize = msg_send![&*panel, runModal];
        if code != 1 {
            return Ok(None);
        }
        let urls: Retained<NSArray<NSURL>> = msg_send![&*panel, URLs];
        Ok(Some(urls.iter().map(|url| string_of(url.path())).collect()))
    }
}

/// `Ok(None)` when the user cancelled.
pub fn save_dialog(_owner: isize, spec: &FileDialogSpec) -> Result<Option<String>, String> {
    // SAFETY: NSSavePanel messages on the main thread, with arguments of the declared types.
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class!(NSSavePanel), savePanel];
        configure(&panel, spec, true);
        let code: isize = msg_send![&*panel, runModal];
        if code != 1 {
            return Ok(None);
        }
        let url: Option<Retained<NSURL>> = msg_send![&*panel, URL];
        url.and_then(|u| u.path())
            .map(|p| p.to_string())
            .map(Some)
            .ok_or_else(|| "the save panel returned no file".to_string())
    }
}
