//! Stock's advertised browser callback, shared by the device listener and the host's one-use replay. The URL
//! comes from the live target's open_url event, never from the device's callback request.
use crate::server::Fault;
use http_body_util::BodyExt;
use hyper::body::Body;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

pub const PAGE_MAX: usize = 64 * 1024;
const PREFIX_MAX: usize = PAGE_MAX * 3 + 4;
#[derive(Clone)]
pub struct LoopbackCallback {
    pub(super) url: Url,
    pub(super) state: Option<String>,
}
impl LoopbackCallback {
    pub fn parse(authorization_url: &str) -> Option<Self> {
        let authorize = Url::parse(authorization_url).ok()?;
        let redirect = authorize
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")?
            .1
            .into_owned();
        let mut url = Url::parse(&redirect).ok()?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            || url.port().is_none()
        {
            return None;
        }
        url.set_query(None);
        url.set_fragment(None);
        let state = authorize
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, state)| state.into_owned())
            .filter(|state| !state.is_empty());
        Some(Self { url, state })
    }
    pub fn matches(&self, path: &str, query: &str) -> bool {
        self.url.path() == path
            && self.state.as_deref().is_some_and(|state| {
                url::form_urlencoded::parse(query.as_bytes())
                    .find(|(key, _)| key == "state")
                    .is_some_and(|(_, wanted)| wanted == state)
            })
    }
    pub async fn replay(mut self, query: String) -> Result<Page, Fault> {
        self.url.set_query(Some(&query));
        tokio::time::timeout(Duration::from_secs(10), async move {
            let response = crate::http::open_once(crate::http::Request {
                url: self.url.as_str(),
                headers: &[],
                body: None,
            })
            .await
            .map_err(|_| unavailable())?;
            let status = response.status().as_u16();
            let content_type = content_type(
                response
                    .headers()
                    .get(hyper::header::CONTENT_TYPE)
                    .map_or(&[][..], |value| value.as_bytes()),
            );
            let mut stream = response.into_body();
            let mut bytes =
                Vec::with_capacity(stream.size_hint().lower().min(PREFIX_MAX as u64) as usize);
            while bytes.len() < PREFIX_MAX {
                let Some(frame) = stream.frame().await else {
                    break;
                };
                let frame = frame.map_err(|_| unavailable())?;
                if let Ok(data) = frame.into_data() {
                    let keep = data.len().min(PREFIX_MAX - bytes.len());
                    bytes.extend_from_slice(&data[..keep]);
                }
            }
            let text = String::from_utf8_lossy(&bytes);
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            let (prefix, half, _) = crate::git::parse::utf16_prefix(text, PAGE_MAX);
            let mut body = prefix.to_owned();
            if let Some(half) = half {
                body.push(half);
            }
            Ok(Page {
                status,
                content_type,
                body,
            })
        })
        .await
        .map_err(|_| unavailable())?
    }
}
fn unavailable() -> Fault {
    Fault::new(
        "sign_in_unavailable",
        "The sign-in's callback server did not answer",
    )
}
fn content_type(value: &[u8]) -> String {
    let value = value.trim_ascii();
    let is = |kind: &[u8]| {
        value
            .get(..kind.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(kind))
            && value
                .get(kind.len())
                .is_none_or(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_')
    };
    if is(b"text/html") || is(b"text/plain") {
        value
            .iter()
            .take(200)
            .map(|byte| char::from(*byte))
            .collect()
    } else {
        "text/plain; charset=utf-8".into()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "WirePage")]
pub struct Page {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePage {
    status: u16,
    content_type: String,
    body: String,
}
impl TryFrom<WirePage> for Page {
    type Error = &'static str;
    fn try_from(page: WirePage) -> Result<Self, Self::Error> {
        if !(100..=599).contains(&page.status)
            || page.content_type.encode_utf16().count() > 200
            || page.body.encode_utf16().count() > PAGE_MAX
        {
            return Err("Invalid sign-in callback page");
        }
        Ok(Self {
            status: page.status,
            content_type: page.content_type,
            body: page.body,
        })
    }
}
#[cfg(test)]
mod tests;
