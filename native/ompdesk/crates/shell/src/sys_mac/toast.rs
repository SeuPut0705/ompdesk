// UNVERIFIED on macOS: written against objc2 0.6 / block2 0.6 and the UserNotifications headers; never compiled.
//! macOS counterpart of `sys::toast`: `UNUserNotificationCenter`. It needs the app to run from a signed bundle with a
//! bundle identifier; from a bare binary `show` answers an error (reported as `failed`). A delegate (a runtime-made
//! class) reports clicks and lets banners show while the app is in front. Main thread.
#![allow(unsafe_code)]

use std::sync::OnceLock;

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSArray, NSString};

use crate::notify_spec::ToastSpec;

/// Where a toast's events go: `(id, "click" | "close" | "failed", reason)`. Called from any thread.
pub type Emit = fn(u64, &'static str, Option<String>);

static EMIT: OnceLock<Emit> = OnceLock::new();

#[link(name = "UserNotifications", kind = "framework")]
unsafe extern "C" {}

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn center() -> Retained<AnyObject> {
    // SAFETY: the class method of UNUserNotificationCenter (valid only with a bundle: `show` checks that first).
    unsafe { msg_send![class!(UNUserNotificationCenter), currentNotificationCenter] }
}

/// The request identifier of a delivered notification response (`ToastSpec::id` as text), as an id.
fn id_of_response(response: *mut AnyObject) -> Option<u64> {
    if response.is_null() {
        return None;
    }
    // SAFETY: `response` is the UNNotificationResponse the center passed; notification → request → identifier.
    let identifier: Option<Retained<NSString>> = unsafe {
        let notification: Retained<AnyObject> = msg_send![response, notification];
        let request: Retained<AnyObject> = msg_send![&*notification, request];
        msg_send![&*request, identifier]
    };
    identifier?.to_string().parse().ok()
}

/// `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:`
extern "C" fn did_receive(
    _this: *mut AnyObject,
    _cmd: Sel,
    _center: *mut AnyObject,
    response: *mut AnyObject,
    handler: *mut AnyObject,
) {
    if let (Some(id), Some(emit)) = (id_of_response(response), EMIT.get()) {
        emit(id, "click", None);
    }
    // SAFETY: the center hands over a live completion block (an object pointer) that must be called exactly once. Raw
    // pointers throughout: they sidestep the lifetimes that keep `&Block` arguments from being a `MethodImplementation`.
    unsafe { (*handler.cast::<Block<dyn Fn()>>()).call(()) };
}

/// `userNotificationCenter:willPresentNotification:withCompletionHandler:`: show the banner (and its list entry) even
/// when the app is the active one; the sound stays whatever the content asked for.
extern "C" fn will_present(
    _this: *mut AnyObject,
    _cmd: Sel,
    _center: *mut AnyObject,
    _notification: *mut AnyObject,
    handler: *mut AnyObject,
) {
    // UNNotificationPresentationOptionSound 2 | List 8 | Banner 16
    // SAFETY: as above.
    unsafe { (*handler.cast::<Block<dyn Fn(usize)>>()).call((2 | 8 | 16,)) };
}

fn delegate_class() -> Result<&'static AnyClass, String> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    CLASS
        .get_or_init(|| {
            let mut builder = ClassBuilder::new(c"OMPdeskNotificationDelegate", class!(NSObject))?;
            if let Some(protocol) = objc2::runtime::AnyProtocol::get(c"UNUserNotificationCenterDelegate") {
                builder.add_protocol(protocol);
            }
            // SAFETY: the function pointers match the selectors' Objective-C signatures (object, selector, three arguments).
            unsafe {
                builder.add_method(
                    sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:),
                    did_receive as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject),
                );
                builder.add_method(
                    sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:),
                    will_present as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject),
                );
            }
            Some(builder.register())
        })
        .ok_or_else(|| "the notification delegate class could not be registered".to_string())
}

fn install_delegate(center: &AnyObject) -> Result<(), String> {
    static DELEGATE: OnceLock<usize> = OnceLock::new();
    if DELEGATE.get().is_some() {
        return Ok(());
    }
    let class = delegate_class()?;
    // SAFETY: a plain `new` of the registered class; the center keeps only a weak reference, so the object is leaked on purpose.
    let delegate: *mut AnyObject = unsafe { msg_send![class, new] };
    // SAFETY: `delegate` is a live object that conforms to UNUserNotificationCenterDelegate.
    let _: () = unsafe { msg_send![center, setDelegate: delegate] };
    let _ = DELEGATE.set(delegate as usize);
    Ok(())
}

/// Asks for permission (once the user decided it is immediate), then posts the notification. Errors that arrive later
/// (permission refused, the center rejecting the request) come back as a `failed` event.
pub fn show(spec: &ToastSpec, emit: Emit) -> Result<(), String> {
    let _ = EMIT.set(emit);
    // SAFETY: NSBundle's main bundle identifier is nil for a bare executable, which UNUserNotificationCenter cannot serve.
    let identifier: Option<Retained<NSString>> = unsafe {
        let bundle: Retained<AnyObject> = msg_send![class!(NSBundle), mainBundle];
        msg_send![&*bundle, bundleIdentifier]
    };
    if identifier.is_none() {
        return Err("macOS notifications need the app to run from an application bundle".into());
    }
    let center = center();
    install_delegate(&center)?;

    // SAFETY: UNMutableNotificationContent / UNNotificationRequest messages with NSString arguments, on the main thread.
    let request: Retained<AnyObject> = unsafe {
        let content: Retained<AnyObject> = msg_send![class!(UNMutableNotificationContent), new];
        let _: () = msg_send![&*content, setTitle: &*ns(&spec.title)];
        let _: () = msg_send![&*content, setBody: &*ns(&spec.body)];
        if !spec.silent {
            let sound: Retained<AnyObject> = msg_send![class!(UNNotificationSound), defaultSound];
            let _: () = msg_send![&*content, setSound: &*sound];
        }
        let none: *mut AnyObject = std::ptr::null_mut();
        msg_send![class!(UNNotificationRequest), requestWithIdentifier: &*ns(&spec.id.to_string()), content: &*content, trigger: none]
    };

    let id = spec.id;
    let post_center = center.clone();
    let after_permission = RcBlock::new(move |granted: Bool, error: *mut AnyObject| {
        if !granted.as_bool() {
            let why = if error.is_null() {
                "the user did not allow notifications for this app".to_string()
            } else {
                "notification permission was refused".to_string()
            };
            emit(id, "failed", Some(why));
            return;
        }
        let done = RcBlock::new(move |error: *mut AnyObject| {
            if !error.is_null() {
                emit(
                    id,
                    "failed",
                    Some("the notification centre refused the notification".to_string()),
                );
            }
        });
        // SAFETY: `request` outlives the block that retains it; the completion block is retained by the center.
        let _: () = unsafe {
            msg_send![&*post_center, addNotificationRequest: &*request, withCompletionHandler: &*done]
        };
    });
    // UNAuthorizationOptionSound 2 | Alert 4
    let options: usize = 2 | 4;
    // SAFETY: the center's authorization call with an options mask and a completion block.
    let _: () = unsafe {
        msg_send![&*center, requestAuthorizationWithOptions: options, completionHandler: &*after_permission]
    };
    Ok(())
}

/// Removes the notification from the screen and the notification centre; an unknown id is not an error.
pub fn close(id: u64) {
    let ids = NSArray::from_retained_slice(&[ns(&id.to_string())]);
    let center = center();
    // SAFETY: both messages take an NSArray of identifier strings.
    unsafe {
        let _: () = msg_send![&*center, removeDeliveredNotificationsWithIdentifiers: &*ids];
        let _: () = msg_send![&*center, removePendingNotificationRequestsWithIdentifiers: &*ids];
    }
}
