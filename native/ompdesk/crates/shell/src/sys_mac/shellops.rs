// UNVERIFIED on macOS: written against objc2 0.6 / objc2-foundation 0.3 and AppKit's headers; never compiled.
//! macOS counterpart of `sys::shellops`: NSWorkspace opens URLs and paths and reveals items; NSFileManager moves an
//! item to the Trash; `NSBeep` beeps. Main thread.
#![allow(unsafe_code)]

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSError, NSFileManager, NSString, NSURL};

use crate::shell_args::{validate_external_url, validate_path};

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSBeep();
}

fn workspace() -> Retained<AnyObject> {
    // SAFETY: NSWorkspace's class method.
    unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] }
}

pub fn open_external(url: &str) -> Result<(), String> {
    let url = validate_external_url(url)?;
    let target = NSURL::URLWithString(&NSString::from_str(url))
        .ok_or_else(|| format!("'{url}' is not a valid URL"))?;
    // SAFETY: `openURL:` takes an NSURL and answers whether a handler accepted it.
    let opened: bool = unsafe { msg_send![&*workspace(), openURL: &*target] };
    if opened {
        Ok(())
    } else {
        Err(format!("no application could open '{url}'"))
    }
}

pub fn open_path(path: &str) -> Result<(), String> {
    let path = validate_path(path)?;
    if !std::path::Path::new(path).exists() {
        return Err(format!("'{path}' does not exist"));
    }
    let target = NSURL::fileURLWithPath(&NSString::from_str(path));
    // SAFETY: `openURL:` takes an NSURL and answers whether a handler accepted it.
    let opened: bool = unsafe { msg_send![&*workspace(), openURL: &*target] };
    if opened {
        Ok(())
    } else {
        Err(format!("no application could open '{path}'"))
    }
}

/// Finder with the item selected (its folder when the item is gone).
pub fn show_item_in_folder(path: &str) -> Result<(), String> {
    let path = validate_path(path)?;
    let exists = std::path::Path::new(path).exists();
    let shown = if exists {
        path
    } else {
        std::path::Path::new(path)
            .parent()
            .and_then(|p| p.to_str())
            .filter(|p| !p.is_empty())
            .ok_or_else(|| format!("'{path}' does not exist"))?
    };
    let target = NSURL::fileURLWithPath(&NSString::from_str(shown));
    let urls = objc2_foundation::NSArray::from_retained_slice(&[target]);
    // SAFETY: `activateFileViewerSelectingURLs:` takes an NSArray of file URLs.
    let _: () = unsafe { msg_send![&*workspace(), activateFileViewerSelectingURLs: &*urls] };
    Ok(())
}

/// Moves `path` to the Trash.
pub fn trash_item(path: &str) -> Result<(), String> {
    let path = validate_path(path)?;
    if std::fs::symlink_metadata(path).is_err() {
        return Err(format!("'{path}' does not exist"));
    }
    let target = NSURL::fileURLWithPath(&NSString::from_str(path));
    // SAFETY: NSFileManager's trash call with an NSURL, no result URL wanted and an error out-parameter.
    unsafe {
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&target, None)
            .map_err(|e: Retained<NSError>| {
                format!("moving '{path}' to the Trash: {}", e.localizedDescription())
            })
    }
}

pub fn beep() {
    // SAFETY: NSBeep takes no arguments.
    unsafe { NSBeep() };
}
