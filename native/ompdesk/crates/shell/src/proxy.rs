//! `session.resolveProxy`: what proxy the system would use for a URL, as `"PROXY host:port; DIRECT"` (Chromium's
//! PAC result syntax, which `parsePacResult` in `src/main/index.ts` reads). Windows reads the WinINET / WinHTTP
//! settings (PAC and WPAD followed); macOS reads `CFNetworkCopySystemProxySettings` and runs a PAC script through
//! CFNetwork; elsewhere the answer is `DIRECT`.

pub fn resolve(url: &str) -> String {
    #[cfg(windows)]
    {
        shell_core::sys::system::resolve_proxy(url)
    }
    #[cfg(target_os = "macos")]
    {
        shell_core::sys_mac::proxy::resolve_proxy(url)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = url;
        "DIRECT".to_string()
    }
}
