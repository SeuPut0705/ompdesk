//! Read-only IMAP polling, ported from `src/main/routines/imap.ts`. Credentials stay in the native
//! account capability, never in an environment, journal, tool response or diagnostic.

mod mime;
#[cfg(test)]
pub(crate) mod tests;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::server::{Fault, Scope};

const TIMEOUT: Duration = Duration::from_secs(30);
const MESSAGES_PER_POLL: usize = 20;
const BODY_BYTES: usize = 6_000;
const HEADER_FIELDS: &str = "FROM TO CC DELIVERED-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO AUTO-SUBMITTED CONTENT-TYPE CONTENT-TRANSFER-ENCODING";
const RESPONSE_MAX: usize = crate::http::BODY_MAX;

pub struct Login {
    username: String,
    password: String,
    mailbox: String,
}

impl Login {
    pub fn new(username: String, password: String, mailbox: String) -> Self {
        Self {
            username,
            password,
            mailbox,
        }
    }
    fn scrub(&self, text: String) -> String {
        if self.password.is_empty() {
            text
        } else {
            text.replace(&self.password, "***").replace(
                &self.password.replace('\\', "\\\\").replace('"', "\\\""),
                "***",
            )
        }
    }
}

/// Produced by Base's actual native account/secret resolver, not deserialized page JSON.
pub struct Mailbox {
    pub id: String,
    pub label: String,
    pub address: String,
    host: String,
    port: u16,
    login: Login,
    #[cfg(test)]
    tls: Option<Arc<ClientConfig>>,
}

impl Mailbox {
    pub fn new(
        id: String,
        label: String,
        address: String,
        host: String,
        port: u16,
        login: Login,
    ) -> Self {
        Self {
            id,
            label,
            address,
            host,
            port,
            login,
            #[cfg(test)]
            tls: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn trusted_fixture(mut self, tls: Arc<ClientConfig>) -> Self {
        self.tls = Some(tls);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailCursor {
    pub validity: i64,
    pub uid: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct MailMessage {
    pub uid: i64,
    pub headers: BTreeMap<String, String>,
    pub snippet: String,
}

#[derive(Debug)]
pub struct MailboxRead {
    pub cursor: MailCursor,
    pub messages: Vec<MailMessage>,
    pub exists: u64,
}

pub async fn read_mailbox(
    account: &Mailbox,
    cursor: Option<MailCursor>,
    scope: &Scope,
) -> Result<MailboxRead, Fault> {
    let read = async {
        let config = tls_config(account)?;
        let name = ServerName::try_from(account.host.clone())
            .map_err(|_| "the mailbox has an invalid TLS server name".to_owned())?;
        let stream = tokio::time::timeout(
            TIMEOUT,
            TcpStream::connect((account.host.as_str(), account.port)),
        )
        .await
        .map_err(|_| "the server did not answer in time".to_owned())?
        .map_err(|error| format!("the connection failed: {error}"))?;
        let stream =
            tokio::time::timeout(TIMEOUT, TlsConnector::from(config).connect(name, stream))
                .await
                .map_err(|_| "the server did not answer in time".to_owned())?
                .map_err(|error| format!("the connection failed: {error}"))?;
        read_stream(stream, &account.login, cursor, TIMEOUT).await
    };
    let result = tokio::select! { biased; _ = scope.on_cancel() => return Err(Fault::cancelled()), result = read => result };
    result.map_err(|message| Fault::new("imap_error", account.login.scrub(message)))
}

fn tls_config(_account: &Mailbox) -> Result<Arc<ClientConfig>, String> {
    #[cfg(test)]
    if let Some(tls) = &_account.tls {
        return Ok(Arc::clone(tls));
    }
    crate::http::machine_tls()
        .map_err(|_| "could not initialize the machine's trusted TLS verifier".into())
}

async fn read_stream<I: AsyncRead + AsyncWrite + Unpin>(
    io: I,
    login: &Login,
    cursor: Option<MailCursor>,
    timeout: Duration,
) -> Result<MailboxRead, String> {
    let mut session = Session {
        io: BufReader::new(io),
        timeout,
        tag: 0,
    };
    let greeting = session.line().await?;
    let upper = greeting.text.to_ascii_uppercase();
    if upper.starts_with("* BYE") {
        return Err(format!(
            "the server refused: {}",
            greeting.text.get(6..).unwrap_or_default()
        ));
    }
    if !upper.starts_with("* OK") && !upper.starts_with("* PREAUTH") {
        return Err("the server did not greet as IMAP".into());
    }
    let mut credentials = format!(
        "LOGIN {} {}",
        quote(&login.username)?,
        quote(&login.password)?
    )
    .into_bytes();
    let logged_in = session.send(&credentials).await;
    credentials.fill(0);
    logged_in?;
    session.answer("login").await?;
    let opened = session
        .command(
            &format!("EXAMINE {}", quote(&login.mailbox)?),
            "open the mailbox",
        )
        .await?;
    let validity = code_number(&opened, "UIDVALIDITY")
        .ok_or_else(|| "the server named no UIDVALIDITY for the mailbox".to_owned())?;
    let next = code_number(&opened, "UIDNEXT");
    let exists = opened
        .iter()
        .find_map(|line| {
            let mut words = line.text.split_whitespace();
            if words.next() != Some("*") {
                return None;
            }
            let n = words.next()?.parse::<u64>().ok()?;
            words.next()?.eq_ignore_ascii_case("EXISTS").then_some(n)
        })
        .unwrap_or(0);
    let last = match next {
        Some(next) => next.saturating_sub(1),
        None => search_uids(
            &session
                .command("UID SEARCH ALL", "list the mailbox")
                .await?,
        )
        .into_iter()
        .max()
        .unwrap_or(0),
    };
    let Some(cursor) = cursor.filter(|cursor| cursor.validity == validity) else {
        session.logout().await;
        return Ok(MailboxRead {
            cursor: MailCursor {
                validity,
                uid: last,
            },
            messages: Vec::new(),
            exists,
        });
    };
    let mut fresh = search_uids(
        &session
            .command(
                &format!("UID SEARCH UID {}:*", cursor.uid.saturating_add(1)),
                "look for new mail",
            )
            .await?,
    );
    fresh.retain(|uid| *uid > cursor.uid);
    fresh.sort_unstable();
    let wanted = &fresh[fresh.len().saturating_sub(MESSAGES_PER_POLL)..];
    let mut messages = Vec::new();
    if !wanted.is_empty() {
        let uids = wanted
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetched = session.command(&format!("UID FETCH {uids} (UID BODY.PEEK[HEADER.FIELDS ({HEADER_FIELDS})] BODY.PEEK[TEXT]<0.{BODY_BYTES}>)"), "read the new mail").await?;
        messages = parse_fetch(&fetched);
    }
    session.logout().await;
    messages.sort_by_key(|message| message.uid);
    Ok(MailboxRead {
        cursor: MailCursor {
            validity,
            uid: fresh
                .into_iter()
                .max()
                .unwrap_or(cursor.uid)
                .max(cursor.uid),
        },
        messages,
        exists,
    })
}

fn quote(text: &str) -> Result<String, String> {
    if text.contains(['\r', '\n']) {
        return Err("a login value or mailbox holds a line break".into());
    }
    Ok(format!(
        "\"{}\"",
        text.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

struct Line {
    text: String,
    literals: Vec<Vec<u8>>,
}
struct Session<I> {
    io: BufReader<I>,
    timeout: Duration,
    tag: u64,
}

impl<I: AsyncRead + AsyncWrite + Unpin> Session<I> {
    async fn send(&mut self, command: &[u8]) -> Result<(), String> {
        self.tag += 1;
        let tag = format!("A{} ", self.tag);
        let written = async {
            self.io.get_mut().write_all(tag.as_bytes()).await?;
            self.io.get_mut().write_all(command).await?;
            self.io.get_mut().write_all(b"\r\n").await?;
            self.io.get_mut().flush().await
        };
        tokio::time::timeout(self.timeout, written)
            .await
            .map_err(|_| "the server did not answer in time".to_owned())?
            .map_err(|error| format!("the connection failed: {error}"))
    }
    async fn command(&mut self, command: &str, what: &str) -> Result<Vec<Line>, String> {
        self.send(command.as_bytes()).await?;
        self.answer(what).await
    }
    async fn answer(&mut self, what: &str) -> Result<Vec<Line>, String> {
        let tag = format!("A{} ", self.tag);
        let mut lines = Vec::new();
        loop {
            let line = self.line().await?;
            if let Some(rest) = line.text.strip_prefix(&tag) {
                let status = rest.split_whitespace().next().unwrap_or_default();
                if status.eq_ignore_ascii_case("OK") {
                    return Ok(lines);
                }
                let message =
                    if status.eq_ignore_ascii_case("NO") || status.eq_ignore_ascii_case("BAD") {
                        rest[status.len()..].trim_start()
                    } else {
                        rest
                    };
                return Err(format!(
                    "could not {what}: {}",
                    if message.is_empty() { rest } else { message }
                ));
            }
            if line.text.starts_with('+') {
                return Err(format!("could not {what}: the server asked for more"));
            }
            lines.push(line);
        }
    }
    async fn logout(&mut self) {
        let _ = self.command("LOGOUT", "log out").await;
    }

    async fn line(&mut self) -> Result<Line, String> {
        let mut text = String::new();
        let mut literals = Vec::new();
        loop {
            let part = self.bytes(None).await?;
            let part = String::from_utf8_lossy(&part);
            let literal = part
                .strip_suffix('}')
                .and_then(|prefix| prefix.rfind('{').map(|at| (at, &prefix[at + 1..])))
                .filter(|(_, digits)| {
                    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
                });
            if let Some((at, digits)) = literal {
                let size = digits
                    .parse::<usize>()
                    .ok()
                    .filter(|size| *size <= RESPONSE_MAX)
                    .ok_or_else(|| "the server's literal is too large".to_owned())?;
                text.push_str(&part[..at]);
                text.push_str(&format!("\0{}\0", literals.len()));
                literals.push(self.bytes(Some(size)).await?);
            } else {
                text.push_str(&part);
                return Ok(Line { text, literals });
            }
        }
    }

    async fn bytes(&mut self, size: Option<usize>) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::with_capacity(size.unwrap_or(128));
        loop {
            if size == Some(bytes.len()) {
                return Ok(bytes);
            }
            let available = tokio::time::timeout(self.timeout, self.io.fill_buf())
                .await
                .map_err(|_| "the server did not answer in time".to_owned())?
                .map_err(|error| format!("the connection failed: {error}"))?;
            if available.is_empty() {
                return Err("the server closed the connection".into());
            }
            let take = match size {
                Some(size) => available.len().min(size - bytes.len()),
                None => available
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(available.len(), |end| end + 1),
            };
            if bytes.len().saturating_add(take) > RESPONSE_MAX {
                return Err("the server's response line is too large".into());
            }
            bytes.extend_from_slice(&available[..take]);
            self.io.consume(take);
            if size.is_none() && bytes.ends_with(b"\r\n") {
                bytes.truncate(bytes.len() - 2);
                return Ok(bytes);
            }
        }
    }
}

fn code_number(lines: &[Line], code: &str) -> Option<i64> {
    let prefix = format!("[{} ", code.to_ascii_uppercase());
    lines.iter().find_map(|line| {
        let upper = line.text.to_ascii_uppercase();
        let start = upper.find(&prefix)? + prefix.len();
        let digits: String = upper[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if upper.as_bytes().get(start + digits.len()) != Some(&b']') {
            return None;
        }
        digits.parse().ok()
    })
}

fn search_uids(lines: &[Line]) -> Vec<i64> {
    lines
        .iter()
        .filter_map(|line| {
            let text = &line.text;
            text.get(..8)
                .filter(|prefix| prefix.eq_ignore_ascii_case("* SEARCH"))
                .and_then(|_| text.get(8..))
        })
        .flat_map(str::split_whitespace)
        .filter_map(|word| {
            word.bytes()
                .all(|byte| byte.is_ascii_digit())
                .then(|| word.parse().ok())
                .flatten()
        })
        .collect()
}

fn parse_fetch(lines: &[Line]) -> Vec<MailMessage> {
    lines
        .iter()
        .filter_map(|line| {
            let upper = line.text.to_ascii_uppercase();
            let mut prefix = upper.split_whitespace();
            if prefix.next() != Some("*")
                || prefix.next()?.parse::<u64>().is_err()
                || prefix.next() != Some("FETCH")
            {
                return None;
            }
            let uid_at = upper.find("UID ")? + 4;
            let uid: i64 = upper[uid_at..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .ok()?;
            let literal = |marker: &str| -> &[u8] {
                upper
                    .find(marker)
                    .and_then(|at| {
                        let text = &line.text[at..];
                        let start = text.find('\0')? + 1;
                        let end = text[start..].find('\0')? + start;
                        line.literals
                            .get(text[start..end].parse::<usize>().ok()?)
                            .map(Vec::as_slice)
                    })
                    .unwrap_or_default()
            };
            let headers = mime::headers(literal("BODY[HEADER.FIELDS"));
            let snippet = mime::snippet(&headers, literal("BODY[TEXT]"));
            Some(MailMessage {
                uid,
                headers,
                snippet,
            })
        })
        .collect()
}
