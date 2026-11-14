// UNVERIFIED on macOS: written against objc2 0.6 / objc2-foundation 0.3 and AppKit's headers; never compiled.
//! macOS counterpart of `sys::clipboard`: the general pasteboard as plain text (`public.utf8-plain-text`).
#![allow(unsafe_code)]

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

const TEXT_TYPE: &str = "public.utf8-plain-text";

fn pasteboard() -> Retained<AnyObject> {
    // SAFETY: NSPasteboard's class method; the general pasteboard always exists.
    unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
}

/// The pasteboard's text, `""` when it holds none.
pub fn read_text() -> Result<String, String> {
    let board = pasteboard();
    // SAFETY: NSPasteboard messages with an NSString type; the answer is nil or an NSString.
    let text: Option<Retained<NSString>> =
        unsafe { msg_send![&*board, stringForType: &*NSString::from_str(TEXT_TYPE)] };
    Ok(text.map(|t| t.to_string()).unwrap_or_default())
}

/// Replaces the pasteboard's content with `text`.
pub fn write_text(text: &str) -> Result<(), String> {
    let board = pasteboard();
    // SAFETY: NSPasteboard messages with NSString arguments; `clearContents` must precede `setString:forType:`.
    let stored: bool = unsafe {
        let _: isize = msg_send![&*board, clearContents];
        msg_send![&*board, setString: &*NSString::from_str(text), forType: &*NSString::from_str(TEXT_TYPE)]
    };
    if stored {
        Ok(())
    } else {
        Err("the pasteboard refused the text".into())
    }
}
