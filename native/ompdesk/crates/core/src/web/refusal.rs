//! The page a browser sees when the edge turns it away for a reason it can act on (`web/refusal-page.ts`): an account
//! that is not allowed, a device with no account, or a blocked device or login. Inline style only (the page's CSP allows
//! nothing else), Korean or English by `Accept-Language`, every inserted value escaped.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalKind {
    UserNotAllowed,
    NoUser,
    BlockedNode,
    BlockedLogin,
}

impl RefusalKind {
    fn name(self) -> &'static str {
        match self {
            Self::UserNotAllowed => "user-not-allowed",
            Self::NoUser => "no-user",
            Self::BlockedNode => "blocked-node",
            Self::BlockedLogin => "blocked-login",
        }
    }
}

pub struct Refusal<'a> {
    pub kind: RefusalKind,
    pub login: Option<&'a str>,
    pub allowed: &'a [String],
    pub accept_language: Option<&'a str>,
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Korean when the browser asks for it first, else English.
pub fn prefers_korean(accept_language: Option<&str>) -> bool {
    let first = accept_language
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .trim_matches(super::auth::js_space)
        .to_lowercase();
    first == "ko" || first.starts_with("ko-")
}

fn text(korean: bool, details: &Refusal<'_>) -> (String, String) {
    let accounts = details.allowed.join(", ");
    let login = details.login.unwrap_or("");
    let pair = |ko: (&str, String), en: (&str, String)| {
        let (title, body) = if korean { ko } else { en };
        (title.to_owned(), body)
    };
    match details.kind {
        RefusalKind::UserNotAllowed => pair(
            (
                "이 계정으로는 열 수 없어요",
                format!("이 기기는 Tailscale에 {login} 계정으로 로그인돼 있어요. OMPdesk는 {accounts} 계정에서만 열려요. Tailscale 앱에서 그 계정으로 로그인한 뒤 다시 열어 주세요."),
            ),
            (
                "This account can't open OMPdesk",
                format!("This device is signed in to Tailscale as {login}. OMPdesk opens only for {accounts}. Sign in to that account in the Tailscale app, then open this page again."),
            ),
        ),
        RefusalKind::NoUser => pair(
            ("Tailscale 계정이 없는 기기예요", format!("태그된 기기는 계정이 없어서 열 수 없어요. {accounts} 계정으로 로그인한 기기에서 열어 주세요.")),
            ("This device has no Tailscale account", format!("A tagged device has no account, so it can't open OMPdesk. Open it on a device signed in as {accounts}.")),
        ),
        RefusalKind::BlockedNode => pair(
            ("이 기기는 차단됐어요", "컴퓨터의 OMPdesk에서 이 기기를 차단했어요. 다시 쓰려면 컴퓨터에서 차단을 풀어 주세요.".to_owned()),
            ("This device is blocked", "OMPdesk on your computer blocked this device. To use it again, unblock it on your computer.".to_owned()),
        ),
        RefusalKind::BlockedLogin => pair(
            ("이 기기는 차단됐어요", format!("컴퓨터의 OMPdesk가 {login} 계정의 모든 기기를 차단했어요. 다시 쓰려면 컴퓨터에서 차단을 풀어 주세요.")),
            ("This device is blocked", format!("OMPdesk on your computer blocked every device of {login}. To use it again, unblock it on your computer.")),
        ),
    }
}

/// The whole HTML document.
pub fn refusal_page(details: &Refusal<'_>) -> String {
    let korean = prefers_korean(details.accept_language);
    let (title, body) = text(korean, details);
    format!(
        "<!doctype html>\n<html lang=\"{}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"color-scheme\" content=\"light dark\">\n<title>{}</title>\n<style>body{{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}}main{{max-width:26rem}}h1{{font-size:1.25rem;margin:0 0 .5rem}}p{{margin:0;color:GrayText;overflow-wrap:anywhere}}</style>\n</head>\n<body>\n<main data-refusal=\"{}\">\n<h1>{}</h1>\n<p>{}</p>\n</main>\n</body>\n</html>\n",
        if korean { "ko" } else { "en" },
        escape(&title),
        details.kind.name(),
        escape(&title),
        escape(&body),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_and_picks_the_language() {
        let allowed = vec!["me@example.com".to_owned()];
        let page = refusal_page(&Refusal {
            kind: RefusalKind::UserNotAllowed,
            login: Some("<b>\"x\"&'y'</b>"),
            allowed: &allowed,
            accept_language: Some("en-US"),
        });
        assert!(page.contains("&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;"));
        assert!(
            page.contains("<html lang=\"en\">")
                && page.contains("data-refusal=\"user-not-allowed\"")
        );
        let page = refusal_page(&Refusal {
            kind: RefusalKind::NoUser,
            login: None,
            allowed: &allowed,
            accept_language: Some("ko-KR,en"),
        });
        assert!(
            page.contains("<html lang=\"ko\">") && page.contains("Tailscale 계정이 없는 기기예요")
        );
        assert!(
            !prefers_korean(Some("en,ko")) && prefers_korean(Some("ko")) && !prefers_korean(None)
        );
    }
}
