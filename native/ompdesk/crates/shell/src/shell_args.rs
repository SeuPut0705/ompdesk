//! Argument checks of `shell.*` (PROTOCOL.md §8) that need no OS: what `openExternal` accepts and how a path is
//! handed to the Windows shell. Pure, so it is tested on every OS.

/// `shell.openExternal`: Electron refuses what it cannot parse as a URL and a URL with a double quote (the shell
/// would read it as the end of an argument). Returns the URL to hand over, or why it is refused.
pub fn validate_external_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("openExternal needs a URL".into());
    }
    if url.contains('"') {
        return Err("a URL with a double quote is not opened".into());
    }
    if url.chars().any(char::is_control) {
        return Err("a URL with control characters is not opened".into());
    }
    let scheme_end = url
        .find(':')
        .ok_or_else(|| format!("'{url}' has no scheme, so it is not a URL"))?;
    let scheme = &url[..scheme_end];
    let valid = scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid {
        return Err(format!("'{url}' has no valid scheme, so it is not a URL"));
    }
    Ok(url)
}

/// The shell takes backslashes; the app hands over `C:/x/y` as often as `C:\x\y`.
pub fn windows_path(path: &str) -> String {
    path.replace('/', "\\")
}

/// A path with no usable text is an error before any API sees it.
pub fn validate_path(path: &str) -> Result<&str, String> {
    if path.trim().is_empty() {
        return Err("the path is empty".into());
    }
    if path.contains('\0') {
        return Err("the path contains a NUL character".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_urls_with_a_scheme() {
        assert_eq!(
            validate_external_url(" https://example.com/a?b=c "),
            Ok("https://example.com/a?b=c")
        );
        assert_eq!(
            validate_external_url("ms-settings:privacy-microphone"),
            Ok("ms-settings:privacy-microphone")
        );
        assert_eq!(
            validate_external_url("x-apple.systempreferences:com.apple.preference.security"),
            Ok("x-apple.systempreferences:com.apple.preference.security")
        );
        assert_eq!(
            validate_external_url("mailto:me@example.com"),
            Ok("mailto:me@example.com")
        );
    }

    #[test]
    fn refuses_empty_unparsable_and_quoted_urls() {
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("   ").is_err());
        assert!(validate_external_url("example.com").is_err());
        assert!(validate_external_url("1http://x").is_err());
        assert!(validate_external_url("https://x/\" --flag").is_err());
        assert!(
            validate_external_url("https://x/\n").is_ok(),
            "a trailing newline is trimmed, not refused"
        );
        assert!(validate_external_url("https://x/\u{1}y").is_err());
    }

    #[test]
    fn paths_use_backslashes_for_the_shell() {
        assert_eq!(
            windows_path("C:/Users/me/a b.txt"),
            "C:\\Users\\me\\a b.txt"
        );
        assert_eq!(windows_path("C:\\a"), "C:\\a");
    }

    #[test]
    fn empty_paths_are_refused() {
        assert!(validate_path("").is_err());
        assert!(validate_path("a\0b").is_err());
        assert_eq!(validate_path("C:\\a"), Ok("C:\\a"));
    }
}
