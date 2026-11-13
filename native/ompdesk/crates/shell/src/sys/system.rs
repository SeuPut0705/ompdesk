//! What the OS tells the shell about the machine: locale, displays, theme, power, network, input idle time.

use std::path::PathBuf;

use serde_json::{Value, json};
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, LPARAM, RECT, TRUE};
use windows_sys::Win32::Globalization::{
    GetUserDefaultLocaleName, GetUserPreferredUILanguages, MUI_LANGUAGE_NAME,
};
use windows_sys::Win32::Graphics::Gdi::{
    DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW,
    HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MONITORINFOF_PRIMARY, SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST, SystemParametersInfoW,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// `ko-KR`.
pub fn user_locale_name() -> String {
    let mut buf = [0u16; 85];
    // SAFETY: the buffer holds LOCALE_NAME_MAX_LENGTH (85) units, as the API requires.
    let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        "en-US".into()
    } else {
        from_wide(&buf)
    }
}

/// The user's preferred UI languages, best first (`["ko-KR", "en-US"]`).
pub fn preferred_languages() -> Vec<String> {
    let mut count = 0u32;
    let mut len = 0u32;
    // SAFETY: the first call asks for the needed length only (null buffer).
    let ok = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut len,
        )
    };
    if ok == 0 || len == 0 {
        return vec![user_locale_name()];
    }
    let mut buf = vec![0u16; len as usize];
    // SAFETY: `buf` holds `len` units, the length the first call reported.
    let ok = unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buf.as_mut_ptr(), &mut len)
    };
    if ok == 0 {
        return vec![user_locale_name()];
    }
    // A REG_MULTI_SZ-style list: names separated by NUL, ended by two.
    buf.split(|&c| c == 0)
        .filter(|part| !part.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

fn registry_dword(subkey: &str, value: &str) -> Option<u32> {
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let subkey = wide(subkey);
    let value = wide(value);
    // SAFETY: both names are NUL-terminated; `data` is a 4-byte buffer and `size` says so.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (status == ERROR_SUCCESS).then_some(data)
}

/// `{dark, highContrast, inverted}` as `nativeTheme` reports them.
pub fn theme() -> Value {
    let dark = registry_dword(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        "AppsUseLightTheme",
    ) == Some(0);
    let mut hc = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        dwFlags: 0,
        lpszDefaultScheme: std::ptr::null_mut(),
    };
    // SAFETY: `hc` is a HIGHCONTRASTW with its size set, as SPI_GETHIGHCONTRAST requires.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            hc.cbSize,
            (&mut hc as *mut HIGHCONTRASTW).cast(),
            0,
        )
    };
    let high_contrast = ok != 0 && hc.dwFlags & HCF_HIGHCONTRASTON != 0;
    json!({ "dark": dark, "highContrast": high_contrast, "inverted": false })
}

/// `systemPreferences.getAnimationSettings().prefersReducedMotion`.
pub fn reduced_motion() -> bool {
    let mut enabled: i32 = TRUE;
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL into the buffer.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        )
    };
    ok != 0 && enabled == 0
}

/// True when the machine runs on battery (AC line status 0).
pub fn on_battery() -> bool {
    let mut status = SYSTEM_POWER_STATUS {
        ACLineStatus: 255,
        BatteryFlag: 0,
        BatteryLifePercent: 0,
        SystemStatusFlag: 0,
        BatteryLifeTime: 0,
        BatteryFullLifeTime: 0,
    };
    // SAFETY: `status` is a SYSTEM_POWER_STATUS the API fills.
    unsafe { GetSystemPowerStatus(&mut status) != 0 && status.ACLineStatus == 0 }
}

/// True when the machine has a system battery (a laptop: a lid to close). `BatteryFlag` 128 is "no system battery",
/// 255 "unknown status": neither counts.
pub fn has_battery() -> bool {
    let mut status = SYSTEM_POWER_STATUS {
        ACLineStatus: 255,
        BatteryFlag: 255,
        BatteryLifePercent: 0,
        SystemStatusFlag: 0,
        BatteryLifeTime: 0,
        BatteryFullLifeTime: 0,
    };
    // SAFETY: `status` is a SYSTEM_POWER_STATUS the API fills.
    unsafe {
        GetSystemPowerStatus(&mut status) != 0
            && status.BatteryFlag & 128 == 0
            && status.BatteryFlag != 255
    }
}

/// Seconds since the last keyboard or mouse input.
pub fn idle_seconds() -> u64 {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` has its size set; GetTickCount takes no arguments.
    let (ok, now) = unsafe { (GetLastInputInfo(&mut info), GetTickCount()) };
    if ok == 0 {
        0
    } else {
        u64::from(now.wrapping_sub(info.dwTime) / 1000)
    }
}

struct Monitor {
    handle: HMONITOR,
    rect: RECT,
}

unsafe extern "system" fn collect(
    handle: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> i32 {
    // SAFETY: `data` is the `&mut Vec<Monitor>` `monitors` passed below, alive for the whole enumeration.
    let list = unsafe { &mut *(data as *mut Vec<Monitor>) };
    list.push(Monitor {
        handle,
        rect: RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        },
    });
    TRUE
}

/// Electron's `Display[]` (PROTOCOL.md §1): bounds in DIP, the primary first, and its id.
pub fn displays() -> (Vec<Value>, i64) {
    let mut monitors: Vec<Monitor> = Vec::new();
    // SAFETY: the callback only pushes onto `monitors`, which outlives the call; null DC and clip rect list all monitors.
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(collect),
            (&mut monitors as *mut Vec<Monitor>) as LPARAM,
        )
    };
    let mut out = Vec::new();
    let mut primary_id = 0i64;
    for (index, monitor) in monitors.iter_mut().enumerate() {
        let mut info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
                rcMonitor: monitor.rect,
                rcWork: monitor.rect,
                dwFlags: 0,
            },
            szDevice: [0; 32],
        };
        // SAFETY: `info` is a MONITORINFOEXW with cbSize set to its size; the handle came from the enumeration.
        if unsafe { GetMonitorInfoW(monitor.handle, (&mut info as *mut MONITORINFOEXW).cast()) }
            == 0
        {
            continue;
        }
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        // SAFETY: the out-parameters are two u32s.
        unsafe { GetDpiForMonitor(monitor.handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
        let scale = f64::from(dpi_x.max(96)) / 96.0;
        let dip = |r: &RECT| {
            json!({
                "x": (f64::from(r.left) / scale).round() as i64,
                "y": (f64::from(r.top) / scale).round() as i64,
                "width": (f64::from(r.right - r.left) / scale).round() as i64,
                "height": (f64::from(r.bottom - r.top) / scale).round() as i64,
            })
        };
        let device = from_wide(&info.szDevice);
        let mut mode: DEVMODEW = unsafe_zeroed_devmode();
        // SAFETY: `szDevice` is NUL-terminated by the OS; `mode` has dmSize set.
        let have_mode = unsafe {
            EnumDisplaySettingsW(info.szDevice.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode)
        } != 0;
        let id = index as i64 + 1;
        if info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0 {
            primary_id = id;
        }
        let mut display = json!({
            "id": id,
            "label": device,
            "bounds": dip(&info.monitorInfo.rcMonitor),
            "workArea": dip(&info.monitorInfo.rcWork),
            "scaleFactor": scale,
            "rotation": 0,
            "internal": false,
            "colorDepth": if have_mode { mode.dmBitsPerPel as i64 } else { 24 },
        });
        if have_mode && mode.dmDisplayFrequency > 1 {
            display["monitorFrequency"] = json!(mode.dmDisplayFrequency);
        }
        out.push(display);
    }
    if primary_id == 0 {
        primary_id = out.first().and_then(|d| d["id"].as_i64()).unwrap_or(1);
    }
    (out, primary_id)
}

fn unsafe_zeroed_devmode() -> DEVMODEW {
    // SAFETY: DEVMODEW is plain data; all-zero is a valid value, and dmSize is set before use.
    let mut mode: DEVMODEW = unsafe { std::mem::zeroed() };
    mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    mode
}

/// Every folder `app.getPath` serves that the OS owns.
pub fn known_paths() -> std::collections::BTreeMap<&'static str, PathBuf> {
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music,
        FOLDERID_Pictures, FOLDERID_Profile, FOLDERID_RoamingAppData, FOLDERID_Videos,
    };
    let mut out = std::collections::BTreeMap::new();
    let table: [(&'static str, &windows_sys::core::GUID); 8] = [
        ("appData", &FOLDERID_RoamingAppData),
        ("home", &FOLDERID_Profile),
        ("desktop", &FOLDERID_Desktop),
        ("documents", &FOLDERID_Documents),
        ("downloads", &FOLDERID_Downloads),
        ("music", &FOLDERID_Music),
        ("pictures", &FOLDERID_Pictures),
        ("videos", &FOLDERID_Videos),
    ];
    for (name, id) in table {
        if let Some(path) = super::known_folder(id) {
            out.insert(name, path);
        }
    }
    out
}

/// Whether any network adapter is up with a routable address: the stand-in for Chromium's network-change notifier.
pub fn online() -> bool {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
        GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::AF_UNSPEC;
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size = 16 * 1024u32;
    let mut buffer: Vec<u8> = vec![0; size as usize];
    for _ in 0..3 {
        // SAFETY: `buffer` holds `size` bytes; the API fills a linked list of adapters into it.
        let status = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_UNSPEC),
                flags,
                std::ptr::null(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status == 111 {
            // ERROR_BUFFER_OVERFLOW: `size` now holds what is needed.
            buffer = vec![0; size as usize];
            continue;
        }
        if status != 0 {
            return true;
        }
        let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !adapter.is_null() {
            // SAFETY: `adapter` walks the list the API wrote into `buffer`, which is alive here.
            let a = unsafe { &*adapter };
            // IF_TYPE_SOFTWARE_LOOPBACK = 24
            if a.OperStatus == IfOperStatusUp && a.IfType != 24 && !a.FirstUnicastAddress.is_null()
            {
                return true;
            }
            adapter = a.Next;
        }
        return false;
    }
    true
}

/// The system proxy for `url` as a PAC result: the user's WinINET settings (a fixed proxy and its bypass list, or an
/// auto-config / WPAD script resolved through WinHTTP).
pub fn resolve_proxy(url: &str) -> String {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::Networking::WinHttp::{
        WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_AUTO_DETECT_TYPE_DHCP,
        WINHTTP_AUTO_DETECT_TYPE_DNS_A, WINHTTP_AUTOPROXY_AUTO_DETECT,
        WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS,
        WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO, WinHttpCloseHandle,
        WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl, WinHttpOpen,
    };
    let take = |p: *mut u16| -> Option<String> {
        if p.is_null() {
            return None;
        }
        // SAFETY: WinHTTP returns NUL-terminated wide strings allocated with GlobalAlloc.
        let text = unsafe {
            let mut len = 0;
            while *p.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        };
        // SAFETY: freeing the block WinHTTP allocated for us, once.
        unsafe { GlobalFree(p.cast()) };
        Some(text)
    };
    let mut ie = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG {
        fAutoDetect: 0,
        lpszAutoConfigUrl: std::ptr::null_mut(),
        lpszProxy: std::ptr::null_mut(),
        lpszProxyBypass: std::ptr::null_mut(),
    };
    // SAFETY: the struct is filled by the call; its strings are freed by `take` below.
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut ie) } == 0 {
        return "DIRECT".into();
    }
    let auto_detect = ie.fAutoDetect != 0;
    let pac_url = take(ie.lpszAutoConfigUrl);
    let rules = take(ie.lpszProxy);
    let bypass = take(ie.lpszProxyBypass);
    if auto_detect || pac_url.is_some() {
        let agent = wide("ompdesk-shell");
        // SAFETY: a throwaway WinHTTP session used for this one lookup and closed after it.
        let session = unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        };
        if !session.is_null() {
            let pac = pac_url.as_deref().map(wide);
            let mut options = WINHTTP_AUTOPROXY_OPTIONS {
                dwFlags: if pac.is_some() {
                    WINHTTP_AUTOPROXY_CONFIG_URL
                } else {
                    WINHTTP_AUTOPROXY_AUTO_DETECT
                },
                dwAutoDetectFlags: if pac.is_some() {
                    0
                } else {
                    WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A
                },
                lpszAutoConfigUrl: pac.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
                lpvReserved: std::ptr::null_mut(),
                dwReserved: 0,
                fAutoLogonIfChallenged: 1,
            };
            let target = wide(url);
            let mut info = WINHTTP_PROXY_INFO {
                dwAccessType: 0,
                lpszProxy: std::ptr::null_mut(),
                lpszProxyBypass: std::ptr::null_mut(),
            };
            // SAFETY: valid session, NUL-terminated URL, options and out-struct as the API requires.
            let found =
                unsafe { WinHttpGetProxyForUrl(session, target.as_ptr(), &mut options, &mut info) }
                    != 0;
            // SAFETY: closes the session opened above.
            unsafe { WinHttpCloseHandle(session) };
            if found {
                let proxy = take(info.lpszProxy);
                take(info.lpszProxyBypass);
                return crate::proxy_rules::pac_result(proxy.as_deref(), None, url);
            }
        }
    }
    crate::proxy_rules::pac_result(rules.as_deref(), bypass.as_deref(), url)
}

/// Blocks until process `pid` has ended, at most `timeout`: a relaunch waits for the instance it replaces to let go of
/// the single-instance pipe.
pub fn wait_for_pid(pid: u32, timeout: std::time::Duration) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    // SAFETY: opens a handle for waiting only; null (the process is already gone) ends the wait at once.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return;
    }
    // SAFETY: waits on the handle opened above, then closes it.
    unsafe {
        WaitForSingleObject(
            handle,
            timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32,
        );
        CloseHandle(handle);
    }
}

fn reg_string(
    root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
    value: &str,
) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};
    let (subkey, value) = (wide(subkey), wide(value));
    let mut size = 0u32;
    // SAFETY: the first call only asks for the size of the value.
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS || size < 2 {
        return None;
    }
    let mut buf = vec![0u16; size as usize / 2 + 1];
    // SAFETY: `buf` holds at least `size` bytes.
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    (status == ERROR_SUCCESS).then(|| from_wide(&buf))
}

/// The display adapters the OS knows (the display class in the registry): vendor and device ids, the driver.
pub fn gpu_adapters() -> Vec<Value> {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
    let class = "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let mut out = Vec::new();
    for index in 0..8 {
        let key = format!("{class}\\{index:04}");
        let Some(desc) = reg_string(HKEY_LOCAL_MACHINE, &key, "DriverDesc") else {
            continue;
        };
        let ids = reg_string(HKEY_LOCAL_MACHINE, &key, "MatchingDeviceId")
            .unwrap_or_default()
            .to_uppercase();
        let hex = |tag: &str| {
            ids.split(tag)
                .nth(1)
                .and_then(|r| u32::from_str_radix(r.get(..4)?, 16).ok())
                .unwrap_or(0)
        };
        out.push(json!({
            "vendorId": hex("VEN_"),
            "deviceId": hex("DEV_"),
            "active": out.is_empty(),
            "driverVendor": reg_string(HKEY_LOCAL_MACHINE, &key, "ProviderName"),
            "driverVersion": reg_string(HKEY_LOCAL_MACHINE, &key, "DriverVersion"),
            "deviceString": desc,
        }));
    }
    out
}

/// `HKCU\Software\Classes\<protocol>` pointing at `exe`: `omp://…` launches it with the URL as its argument.
pub fn register_protocol(protocol: &str, exe: &str) -> bool {
    use windows_sys::Win32::System::Registry::{
        HKEY, REG_SZ, RegCloseKey, RegCreateKeyExW, RegSetValueExW,
    };
    let set = |subkey: &str, name: Option<&str>, value: &str| -> bool {
        let subkey = wide(subkey);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: creates or opens a key under HKCU; `key` receives the handle closed below.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                std::ptr::null(),
                0,
                0x0002_0006,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return false;
        }
        let name = name.map(wide);
        let data = wide(value);
        // SAFETY: `data` is a NUL-terminated UTF-16 string of the byte length given; `key` is open.
        let status = unsafe {
            RegSetValueExW(
                key,
                name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        };
        // SAFETY: closes the key opened above.
        unsafe { RegCloseKey(key) };
        status == ERROR_SUCCESS
    };
    let base = format!("Software\\Classes\\{protocol}");
    set(&base, None, &format!("URL:{protocol}"))
        && set(&base, Some("URL Protocol"), "")
        && set(
            &format!("{base}\\shell\\open\\command"),
            None,
            &format!("\"{exe}\" \"%1\""),
        )
}

/// Windows' AppUserModelID of this process: the taskbar grouping and the toast notifications' identity.
pub fn set_app_user_model_id(id: &str) {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let id = wide(id);
    // SAFETY: a NUL-terminated string that outlives the call.
    unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
}
