//! How setup reads the network: the address a request goes to (`routed`), what a transport failure says, and the page
//! reader the release lookups use (`Http`, 30 s a page as `fetchText`'s `AbortSignal.timeout(30_000)` bounded it).

use std::time::Duration;

use url::{Position, Url};

use super::archives::Pages;
use crate::http::{self, Failure, Request};

/// The user agent every setup request sends.
pub const USER_AGENT: &str = "ompdesk-setup";

/// The longest one page takes, redirects and body included.
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Where a request for `url` goes. Without `mirror` that is `url`. With one (a test's server on 127.0.0.1; main
/// passes it only when a test built the service with it) every address is read from it instead:
/// `https://nodejs.org/dist/index.json` is `<mirror>/nodejs.org/dist/index.json`. Messages and releases still name
/// the real address.
pub fn routed(url: &str, mirror: Option<&str>) -> String {
    let Some(mirror) = mirror else {
        return url.to_owned();
    };
    match Url::parse(url) {
        Ok(parsed) => format!(
            "{}/{}{}",
            mirror.trim_end_matches('/'),
            parsed.host_str().unwrap_or_default(),
            &parsed[Position::BeforePath..Position::AfterQuery]
        ),
        Err(_) => url.to_owned(),
    }
}

/// What a transport failure says, with nothing of the request in it.
pub fn describe(failure: &Failure) -> String {
    match failure {
        Failure::Request => "the address cannot be fetched".to_owned(),
        Failure::Connect => "could not connect".to_owned(),
        Failure::Broken => "the connection ended".to_owned(),
        Failure::TooLarge => "the answer is too large".to_owned(),
        Failure::Tls(reason) => reason.clone(),
        Failure::Redirect => "too many redirects".to_owned(),
    }
}

/// `fetch(...).text()`: UTF-8, a leading byte order mark dropped, invalid bytes U+FFFD.
fn text_of(body: &[u8]) -> String {
    String::from_utf8_lossy(body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body)).into_owned()
}

/// Pages read over HTTP(S). `token` goes as `authorization: Bearer` to `https://api.github.com/` only (60 requests an
/// hour without one), and is dropped by `http` at the first redirect to another origin.
pub struct Http<'a> {
    pub mirror: Option<&'a str>,
    pub token: Option<&'a str>,
}

impl Pages for Http<'_> {
    async fn text(&self, url: &str) -> Result<String, String> {
        let bearer = self
            .token
            .filter(|_| url.starts_with("https://api.github.com/"))
            .map(|token| format!("Bearer {token}"));
        let mut headers = vec![("user-agent", USER_AGENT)];
        if let Some(bearer) = &bearer {
            headers.push(("authorization", bearer.as_str()));
        }
        let target = routed(url, self.mirror);
        let sent = tokio::time::timeout(
            PAGE_TIMEOUT,
            http::send(Request {
                url: &target,
                headers: &headers,
                body: None,
            }),
        )
        .await
        .map_err(|_| format!("{url}: timed out after {} ms", PAGE_TIMEOUT.as_millis()))?
        .map_err(|failure| format!("{url}: {}", describe(&failure)))?;
        if !(200..300).contains(&sent.status) {
            return Err(format!("{url} answered {}", sent.status));
        }
        Ok(text_of(&sent.body))
    }
}
