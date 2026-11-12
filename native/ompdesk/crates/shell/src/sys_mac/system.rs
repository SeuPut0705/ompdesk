// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! macOS counterpart of `sys::system`: what the OS tells the shell about the machine at startup (`facts::collect`).
//! The displays, theme, reduced-motion and battery queries are `desk`'s (the same ones feed `screen.*`, `theme.*` and
//! `power.*`); this module adds the locale and re-exports them under the names `facts` calls. Main thread.
#![allow(unsafe_code)]

use std::ffi::{CStr, c_char};

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};

pub use super::desk::{displays, on_battery, reduced_motion, theme};

/// An `NSString` (or nil) as a Rust string.
pub(super) fn string_of(object: *mut AnyObject) -> String {
    if object.is_null() {
        return String::new();
    }
    // SAFETY: `object` is a live NSString; `UTF8String` is valid until the string is released and is copied at once.
    unsafe {
        let text: *const c_char = msg_send![object, UTF8String];
        if text.is_null() {
            String::new()
        } else {
            CStr::from_ptr(text).to_string_lossy().into_owned()
        }
    }
}

/// `ko_KR` (or `ko_KR@calendar=gregorian`) as the BCP 47 tag `ko-KR`.
fn bcp47(identifier: &str) -> String {
    identifier
        .split('@')
        .next()
        .unwrap_or_default()
        .replace('_', "-")
}

/// `ko-KR`: the current locale's language and region.
pub fn system_locale() -> String {
    autoreleasepool(|_| {
        // SAFETY: class messages to NSLocale; the identifier is copied before the pool drains.
        let identifier = unsafe {
            let locale: *mut AnyObject = msg_send![class!(NSLocale), currentLocale];
            let identifier: *mut AnyObject = msg_send![locale, localeIdentifier];
            string_of(identifier)
        };
        let tag = bcp47(&identifier);
        if tag.is_empty() { "en-US".into() } else { tag }
    })
}

/// The user's preferred languages, best first (`["ko-KR", "en-US"]`).
pub fn preferred_languages() -> Vec<String> {
    let languages: Vec<String> = autoreleasepool(|_| {
        // SAFETY: `preferredLanguages` is an NSArray of NSString; every element is copied before the pool drains.
        unsafe {
            let array: *mut AnyObject = msg_send![class!(NSLocale), preferredLanguages];
            if array.is_null() {
                return Vec::new();
            }
            let count: usize = msg_send![array, count];
            (0..count)
                .map(|index| {
                    let item: *mut AnyObject = msg_send![array, objectAtIndex: index];
                    string_of(item)
                })
                .filter(|tag| !tag.is_empty())
                .collect()
        }
    });
    if languages.is_empty() {
        vec![system_locale()]
    } else {
        languages
    }
}

#[cfg(test)]
mod tests {
    use super::bcp47;

    #[test]
    fn locale_identifiers_become_bcp47_tags() {
        assert_eq!(bcp47("ko_KR"), "ko-KR");
        assert_eq!(bcp47("en_US@calendar=gregorian"), "en-US");
        assert_eq!(bcp47("zh-Hans_CN"), "zh-Hans-CN");
        assert_eq!(bcp47(""), "");
    }
}
