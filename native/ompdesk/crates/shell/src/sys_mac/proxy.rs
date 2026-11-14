// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! macOS `session.resolveProxy`: the system proxy settings (`CFNetworkCopySystemProxySettings`) read into
//! `proxy_mac::Settings`, which decides and formats (`PROXY host:port; DIRECT`). When the settings name a PAC script
//! (a URL or auto-discovery), `CFNetworkCopyProxiesForURL` says which script applies and
//! `CFNetworkExecuteProxyAutoConfigurationURL` runs it for the URL, on a private run-loop mode of the calling thread
//! for at most [`PAC_DEADLINE`]; a script that cannot be fetched or run in time falls back to the fixed settings.
//! The script's own answer is read for the types none / HTTP / HTTPS / SOCKS (an `HTTPS` entry is an HTTP proxy
//! reached with CONNECT, written `PROXY`). Any thread.
#![allow(unsafe_code)]

use std::ffi::{CString, c_char, c_void};
use std::time::{Duration, Instant};

use crate::proxy_mac::{Endpoint, Entry, Kind, Settings};

type CFTypeRef = *const c_void;

const UTF8: u32 = 0x0800_0100;
/// `kCFNumberSInt32Type`.
const NUMBER_SINT32: i32 = 3;
/// How long a PAC script may take (download + evaluation) before the fixed settings answer instead.
const PAC_DEADLINE: Duration = Duration::from_secs(3);

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(o: CFTypeRef);
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
    fn CFGetTypeID(o: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
    fn CFNumberGetValue(number: CFTypeRef, kind: i32, out: *mut c_void) -> u8;
    fn CFStringGetLength(s: CFTypeRef) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, encoding: u32) -> CFTypeRef;
    fn CFURLCreateWithString(alloc: CFTypeRef, s: CFTypeRef, base: CFTypeRef) -> CFTypeRef;
    fn CFRunLoopGetCurrent() -> CFTypeRef;
    fn CFRunLoopAddSource(rl: CFTypeRef, source: CFTypeRef, mode: CFTypeRef);
    fn CFRunLoopRemoveSource(rl: CFTypeRef, source: CFTypeRef, mode: CFTypeRef);
    fn CFRunLoopRunInMode(mode: CFTypeRef, seconds: f64, return_after_source: u8) -> i32;
    fn CFRunLoopSourceInvalidate(source: CFTypeRef);
}

/// `CFStreamClientContext`.
#[repr(C)]
struct ClientContext {
    version: isize,
    info: *mut c_void,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
}

#[link(name = "CFNetwork", kind = "framework")]
unsafe extern "C" {
    static kCFNetworkProxiesHTTPEnable: CFTypeRef;
    static kCFNetworkProxiesHTTPProxy: CFTypeRef;
    static kCFNetworkProxiesHTTPPort: CFTypeRef;
    static kCFNetworkProxiesHTTPSEnable: CFTypeRef;
    static kCFNetworkProxiesHTTPSProxy: CFTypeRef;
    static kCFNetworkProxiesHTTPSPort: CFTypeRef;
    static kCFNetworkProxiesSOCKSEnable: CFTypeRef;
    static kCFNetworkProxiesSOCKSProxy: CFTypeRef;
    static kCFNetworkProxiesSOCKSPort: CFTypeRef;
    static kCFNetworkProxiesProxyAutoConfigEnable: CFTypeRef;
    static kCFNetworkProxiesProxyAutoConfigURLString: CFTypeRef;
    static kCFNetworkProxiesProxyAutoDiscoveryEnable: CFTypeRef;
    static kCFNetworkProxiesExceptionsList: CFTypeRef;
    static kCFNetworkProxiesExcludeSimpleHostnames: CFTypeRef;

    static kCFProxyTypeKey: CFTypeRef;
    static kCFProxyHostNameKey: CFTypeRef;
    static kCFProxyPortNumberKey: CFTypeRef;
    static kCFProxyAutoConfigurationURLKey: CFTypeRef;
    static kCFProxyTypeNone: CFTypeRef;
    static kCFProxyTypeHTTP: CFTypeRef;
    static kCFProxyTypeHTTPS: CFTypeRef;
    static kCFProxyTypeSOCKS: CFTypeRef;
    static kCFProxyTypeAutoConfigurationURL: CFTypeRef;

    fn CFNetworkCopySystemProxySettings() -> CFTypeRef;
    fn CFNetworkCopyProxiesForURL(url: CFTypeRef, proxy_settings: CFTypeRef) -> CFTypeRef;
    fn CFNetworkExecuteProxyAutoConfigurationURL(
        pac_url: CFTypeRef,
        target_url: CFTypeRef,
        callback: extern "C" fn(*mut c_void, CFTypeRef, CFTypeRef),
        context: *mut ClientContext,
    ) -> CFTypeRef;
}

/// Owns one CF object (a `Copy…`/`Create…` result) and releases it.
struct Owned(CFTypeRef);

impl Owned {
    fn new(object: CFTypeRef) -> Option<Self> {
        (!object.is_null()).then_some(Self(object))
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the object came from a CF function that returned it retained (+1), released once here.
        unsafe { CFRelease(self.0) };
    }
}

fn is_type(object: CFTypeRef, type_id: usize) -> bool {
    // SAFETY: `object` is a live CF object (checked non-null by the callers).
    !object.is_null() && unsafe { CFGetTypeID(object) } == type_id
}

/// The value under `key` of a dictionary, borrowed (null when absent).
fn value(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef {
    // SAFETY: `dict` is a CFDictionary, `key` a CF constant.
    unsafe { CFDictionaryGetValue(dict, key) }
}

fn number(dict: CFTypeRef, key: CFTypeRef) -> Option<i32> {
    let n = value(dict, key);
    // SAFETY: the type is checked before the CFNumber call; `out` is a 32-bit slot.
    unsafe {
        if !is_type(n, CFNumberGetTypeID()) {
            return None;
        }
        let mut out: i32 = 0;
        (CFNumberGetValue(n, NUMBER_SINT32, (&mut out as *mut i32).cast()) != 0).then_some(out)
    }
}

fn flag(dict: CFTypeRef, key: CFTypeRef) -> bool {
    number(dict, key).is_some_and(|n| n != 0)
}

fn port(dict: CFTypeRef, key: CFTypeRef) -> Option<u16> {
    number(dict, key)
        .and_then(|n| u16::try_from(n).ok())
        .filter(|&p| p != 0)
}

/// A CFString as a Rust string.
fn string_of(s: CFTypeRef) -> Option<String> {
    // SAFETY: the type is checked; the buffer is sized for the worst-case UTF-8 length plus the NUL.
    unsafe {
        if !is_type(s, CFStringGetTypeID()) {
            return None;
        }
        let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), UTF8) + 1;
        let mut buffer = vec![0u8; usize::try_from(size).ok()?];
        if CFStringGetCString(s, buffer.as_mut_ptr().cast(), size, UTF8) == 0 {
            return None;
        }
        let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
        Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
    }
}

fn text(dict: CFTypeRef, key: CFTypeRef) -> Option<String> {
    string_of(value(dict, key)).filter(|t| !t.trim().is_empty())
}

/// `…Enable` set and a host named.
fn endpoint(
    dict: CFTypeRef,
    enable: CFTypeRef,
    host: CFTypeRef,
    port_key: CFTypeRef,
) -> Option<Endpoint> {
    if !flag(dict, enable) {
        return None;
    }
    Some(Endpoint {
        host: text(dict, host)?,
        port: port(dict, port_key),
    })
}

fn settings_of(dict: CFTypeRef) -> Settings {
    // SAFETY: reading CFNetwork's exported key constants.
    unsafe {
        let exceptions = value(dict, kCFNetworkProxiesExceptionsList);
        let exceptions = if is_type(exceptions, CFArrayGetTypeID()) {
            (0..CFArrayGetCount(exceptions))
                .filter_map(|i| string_of(CFArrayGetValueAtIndex(exceptions, i)))
                .collect()
        } else {
            Vec::new()
        };
        Settings {
            http: endpoint(
                dict,
                kCFNetworkProxiesHTTPEnable,
                kCFNetworkProxiesHTTPProxy,
                kCFNetworkProxiesHTTPPort,
            ),
            https: endpoint(
                dict,
                kCFNetworkProxiesHTTPSEnable,
                kCFNetworkProxiesHTTPSProxy,
                kCFNetworkProxiesHTTPSPort,
            ),
            socks: endpoint(
                dict,
                kCFNetworkProxiesSOCKSEnable,
                kCFNetworkProxiesSOCKSProxy,
                kCFNetworkProxiesSOCKSPort,
            ),
            pac_url: flag(dict, kCFNetworkProxiesProxyAutoConfigEnable)
                .then(|| text(dict, kCFNetworkProxiesProxyAutoConfigURLString))
                .flatten(),
            auto_discovery: flag(dict, kCFNetworkProxiesProxyAutoDiscoveryEnable),
            exceptions,
            exclude_simple: flag(dict, kCFNetworkProxiesExcludeSimpleHostnames),
        }
    }
}

/// One `CFNetworkCopyProxiesForURL` / PAC result item as an entry; `None` for a type this shell does not follow
/// (an auto-config entry is [`pac_url_of`]'s).
fn entry_of(item: CFTypeRef) -> Option<Entry> {
    // SAFETY: `item` is a CFDictionary of the kCFProxy… keys (checked); constants are CFNetwork's.
    unsafe {
        if !is_type(item, CFDictionaryGetTypeID()) {
            return None;
        }
        let kind = value(item, kCFProxyTypeKey);
        if kind.is_null() {
            return None;
        }
        if CFEqual(kind, kCFProxyTypeNone) != 0 {
            return Some(Entry::Direct);
        }
        let socks = CFEqual(kind, kCFProxyTypeSOCKS) != 0;
        if !socks && CFEqual(kind, kCFProxyTypeHTTP) == 0 && CFEqual(kind, kCFProxyTypeHTTPS) == 0 {
            return None;
        }
        Some(Entry::Proxy(
            if socks { Kind::Socks5 } else { Kind::Http },
            Endpoint {
                host: text(item, kCFProxyHostNameKey)?,
                port: port(item, kCFProxyPortNumberKey),
            },
        ))
    }
}

/// The script URL (a borrowed CFURL) of an auto-config item.
fn pac_url_of(item: CFTypeRef) -> Option<CFTypeRef> {
    // SAFETY: as `entry_of`.
    unsafe {
        if !is_type(item, CFDictionaryGetTypeID()) {
            return None;
        }
        let kind = value(item, kCFProxyTypeKey);
        if kind.is_null() || CFEqual(kind, kCFProxyTypeAutoConfigurationURL) == 0 {
            return None;
        }
        let url = value(item, kCFProxyAutoConfigurationURLKey);
        (!url.is_null()).then_some(url)
    }
}

fn entries_of(array: CFTypeRef) -> Vec<Entry> {
    // SAFETY: `array` is a CFArray (checked) of dictionaries.
    unsafe {
        if !is_type(array, CFArrayGetTypeID()) {
            return Vec::new();
        }
        (0..CFArrayGetCount(array))
            .filter_map(|i| entry_of(CFArrayGetValueAtIndex(array, i)))
            .collect()
    }
}

/// What the PAC callback leaves for the waiting loop.
struct PacState {
    done: bool,
    /// `None`: the script failed.
    entries: Option<Vec<Entry>>,
}

extern "C" fn pac_done(client: *mut c_void, proxies: CFTypeRef, error: CFTypeRef) {
    // SAFETY: `client` is the `PacState` `run_pac` keeps alive until the source is invalidated; the callback runs on
    // that thread's run loop, inside `CFRunLoopRunInMode`.
    let state = unsafe { &mut *client.cast::<PacState>() };
    state.entries = (error.is_null() && !proxies.is_null()).then(|| entries_of(proxies));
    state.done = true;
}

/// Runs the PAC script at `pac_url` for `target` and waits for it on a private run-loop mode.
fn run_pac(pac_url: CFTypeRef, target: CFTypeRef) -> Option<Vec<Entry>> {
    let mode_name = CString::new("ompdesk.proxy.pac").ok()?;
    // SAFETY: a CFString for the private mode, released by `Owned`.
    let mode = Owned::new(unsafe {
        CFStringCreateWithCString(std::ptr::null(), mode_name.as_ptr(), UTF8)
    })?;
    let mut state = PacState {
        done: false,
        entries: None,
    };
    let mut context = ClientContext {
        version: 0,
        info: (&mut state as *mut PacState).cast(),
        retain: std::ptr::null(),
        release: std::ptr::null(),
        copy_description: std::ptr::null(),
    };
    // SAFETY: valid URLs; `context` is copied by CFNetwork and points at `state`, which outlives the source (it is
    // invalidated below before `state` goes away); the run loop is this thread's.
    unsafe {
        let source = Owned::new(CFNetworkExecuteProxyAutoConfigurationURL(
            pac_url,
            target,
            pac_done,
            &mut context,
        ))?;
        let run_loop = CFRunLoopGetCurrent();
        CFRunLoopAddSource(run_loop, source.0, mode.0);
        let deadline = Instant::now() + PAC_DEADLINE;
        while !state.done && Instant::now() < deadline {
            CFRunLoopRunInMode(mode.0, 0.1, 1);
        }
        CFRunLoopRemoveSource(run_loop, source.0, mode.0);
        CFRunLoopSourceInvalidate(source.0);
    }
    state.entries
}

/// What a PAC script (the one the system settings name) answers for `url`: the script's own entries plus any fixed
/// ones `CFNetworkCopyProxiesForURL` listed; `None` when nothing could be learned.
fn pac_entries(settings: CFTypeRef, url: &str) -> Option<Vec<Entry>> {
    let c_url = CString::new(url).ok()?;
    // SAFETY: CF objects created and released by `Owned`; the PAC URL borrowed from `list` is used while `list` lives.
    unsafe {
        let text = Owned::new(CFStringCreateWithCString(
            std::ptr::null(),
            c_url.as_ptr(),
            UTF8,
        ))?;
        let target = Owned::new(CFURLCreateWithString(
            std::ptr::null(),
            text.0,
            std::ptr::null(),
        ))?;
        let list = Owned::new(CFNetworkCopyProxiesForURL(target.0, settings))?;
        if !is_type(list.0, CFArrayGetTypeID()) {
            return None;
        }
        let mut entries = Vec::new();
        let mut learned = false;
        for i in 0..CFArrayGetCount(list.0) {
            let item = CFArrayGetValueAtIndex(list.0, i);
            if let Some(entry) = entry_of(item) {
                entries.push(entry);
                learned = true;
            } else if let Some(script) = pac_url_of(item)
                && let Some(answer) = run_pac(script, target.0)
            {
                entries.extend(answer);
                learned = true;
            }
        }
        learned.then_some(entries)
    }
}

/// The system proxy for `url` as a PAC result string.
pub fn resolve_proxy(url: &str) -> String {
    // SAFETY: CFNetwork's copy function; the dictionary is released by `Owned`.
    let Some(raw) = Owned::new(unsafe { CFNetworkCopySystemProxySettings() }) else {
        return "DIRECT".into();
    };
    settings_of(raw.0).resolve(url, || pac_entries(raw.0, url))
}
