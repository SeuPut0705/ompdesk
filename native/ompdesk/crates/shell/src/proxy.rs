//! `session.resolveProxy`: what proxy the system would use for a URL, as `"PROXY host:port; DIRECT"` (Chromium's
//! PAC result syntax, which `parsePacResult` in `src/main/index.ts` reads).

pub fn resolve(url: &str) -> String {
    #[cfg(windows)]
    {
        shell_core::sys::system::resolve_proxy(url)
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        "DIRECT".to_string()
    }
}
