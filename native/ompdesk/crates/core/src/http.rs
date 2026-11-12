//! The core's HTTP/1.1 client: one request over one plain TCP connection, the whole answer read into memory. It
//! exists for the local ai-memory server (`aimemory`), which answers JSON on loopback. The protocol is hyper's
//! (`hyper::client::conn::http1`: its parser, chunked bodies, interim answers); this file adds the address, the
//! header check and the bounds.
//!
//! What it does not do, on purpose: TLS (an `https` URL is refused before anything is dialed), redirects (a 3xx is the
//! answer), connection reuse (`connection: close` on every request; a loopback connect costs less than keeping a pool
//! right), compression (no `accept-encoding` is sent, so none comes back), proxies. The address is read as the WHATWG
//! URL standard reads it (`url`, as node's `fetch` did), so the path and query go out normalized the same way.
//!
//! Nothing here keeps or reports what a request carried: a `Failure` is a bare kind, so no header (a bearer token) and
//! no body can reach an error text or a log through it.

use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use url::{Host, Position, Url};

/// The longest answer kept. `fetch` had no bound; nothing the memory server answers comes near this.
pub const BODY_MAX: usize = 64 * 1024 * 1024;

/// A GET, or a POST of `body` when there is one. A header's value is visible ASCII (spaces and tabs too); one that
/// could end its line is refused, never sent.
pub struct Request<'a> {
    pub url: &'a str,
    pub headers: &'a [(&'static str, &'a str)],
    pub body: Option<&'a [u8]>,
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Why no answer came. It names a kind only, never anything of the request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Failure {
    /// The URL is not plain `http` with a host and no credentials, or a header's value cannot be sent.
    Request,
    /// Nothing accepted the connection.
    Connect,
    /// The connection ended or the answer was not HTTP/1.x.
    Broken,
    /// The body is past its bound.
    TooLarge,
}

struct Target {
    host: Host<String>,
    port: u16,
    /// `host[:port]` as the URL spells it: the `host` header.
    authority: String,
    /// Path and query.
    path: String,
}

fn target(url: &str) -> Result<Target, Failure> {
    let url = Url::parse(url).map_err(|_| Failure::Request)?;
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return Err(Failure::Request);
    }
    Ok(Target {
        host: url.host().ok_or(Failure::Request)?.to_owned(),
        port: url.port().unwrap_or(80),
        authority: url[Position::BeforeHost..Position::AfterPort].to_owned(),
        path: url[Position::BeforePath..Position::AfterQuery].to_owned(),
    })
}

async fn connect(target: &Target) -> Result<TcpStream, Failure> {
    let stream = match &target.host {
        Host::Domain(name) => TcpStream::connect((name.as_str(), target.port)).await,
        Host::Ipv4(address) => TcpStream::connect((*address, target.port)).await,
        Host::Ipv6(address) => TcpStream::connect((*address, target.port)).await,
    }
    .map_err(|_| Failure::Connect)?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Sends `request` and answers at its head; the body is still to be read.
async fn exchange(request: &Request<'_>) -> Result<hyper::Response<Incoming>, Failure> {
    let target = target(request.url)?;
    let method = if request.body.is_some() {
        "POST"
    } else {
        "GET"
    };
    let mut message = hyper::Request::builder()
        .method(method)
        .uri(target.path.as_str())
        .header("host", target.authority.as_str())
        .header("connection", "close");
    for (name, value) in request.headers {
        if !value
            .bytes()
            .all(|byte| byte == b'\t' || (0x20..0x7f).contains(&byte))
        {
            return Err(Failure::Request);
        }
        message = message.header(*name, *value);
    }
    let body = Full::new(Bytes::copy_from_slice(request.body.unwrap_or_default()));
    let message = message.body(body).map_err(|_| Failure::Request)?;
    let stream = connect(&target).await?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| Failure::Broken)?;
    // The connection's own task: it ends when the answer was read or the caller gave up on it.
    tokio::spawn(async move {
        let _ = connection.await;
    });
    sender
        .send_request(message)
        .await
        .map_err(|_| Failure::Broken)
}

async fn send_within(request: Request<'_>, body_max: usize) -> Result<Response, Failure> {
    let response = exchange(&request).await?;
    let status = response.status().as_u16();
    let body = Limited::new(response.into_body(), body_max)
        .collect()
        .await
        .map_err(|error| {
            if error.is::<LengthLimitError>() {
                Failure::TooLarge
            } else {
                Failure::Broken
            }
        })?;
    Ok(Response {
        status,
        body: body.to_bytes().to_vec(),
    })
}

/// Sends `request` and reads the whole answer. The caller bounds the time (`tokio::time::timeout`); dropping the
/// future closes the connection.
pub async fn send(request: Request<'_>) -> Result<Response, Failure> {
    send_within(request, BODY_MAX).await
}

/// Sends `request` and answers its status as soon as the head arrived; the body is not read.
pub async fn status(request: Request<'_>) -> Result<u16, Failure> {
    Ok(exchange(&request).await?.status().as_u16())
}

#[cfg(test)]
pub(crate) mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    use super::*;

    /// A server on 127.0.0.1 that reads one request whole, writes `answer` and closes; the handle answers the
    /// request's bytes.
    async fn canned(answer: Vec<u8>) -> (String, JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            let _ = socket.write_all(&answer).await;
            let _ = socket.shutdown().await;
            request
        });
        (url, served)
    }

    /// One request's head and, by its `content-length`, its body.
    pub(crate) async fn read_request(socket: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let head_end = request.windows(4).position(|window| window == b"\r\n\r\n");
            if let Some(end) = head_end {
                let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .map_or(0, |value| value.parse::<usize>().unwrap());
                if request.len() >= end + 4 + length {
                    return request;
                }
            }
            let read = socket.read(&mut chunk).await.unwrap();
            if read == 0 {
                return request;
            }
            request.extend_from_slice(&chunk[..read]);
        }
    }

    fn get(url: &str) -> Request<'_> {
        Request {
            url,
            headers: &[],
            body: None,
        }
    }

    async fn body_of(answer: &str) -> Result<(u16, String), Failure> {
        let (url, _served) = canned(answer.as_bytes().to_vec()).await;
        let response = send(get(&url)).await?;
        Ok((response.status, String::from_utf8(response.body).unwrap()))
    }

    /// A request as the server read it: its first line, its header lines in order of name, its body.
    fn parts(request: &[u8]) -> (String, Vec<String>, String) {
        let text = String::from_utf8(request.to_vec()).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut lines = head.split("\r\n").map(str::to_owned);
        let first = lines.next().unwrap();
        let mut headers: Vec<String> = lines.collect();
        headers.sort();
        (first, headers, body.to_owned())
    }

    #[tokio::test]
    async fn sends_a_get_and_a_post_as_http_1_1_with_its_headers_and_body() {
        let (url, served) =
            canned(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok".to_vec()).await;
        let address = url.trim_start_matches("http://").to_owned();
        let response = send(Request {
            url: &format!("{url}/a%20b/../c?q=1 2#frag"),
            headers: &[("authorization", "Bearer abc"), ("accept", "text/plain")],
            body: None,
        })
        .await
        .unwrap();
        assert_eq!(
            (response.status, response.body.as_slice()),
            (200, &b"ok"[..])
        );
        assert_eq!(
            parts(&served.await.unwrap()),
            (
                "GET /c?q=1%202 HTTP/1.1".to_owned(),
                vec![
                    "accept: text/plain".to_owned(),
                    "authorization: Bearer abc".to_owned(),
                    "connection: close".to_owned(),
                    format!("host: {address}"),
                ],
                String::new()
            )
        );

        let (url, served) =
            canned(b"HTTP/1.1 201 Created\r\ncontent-length: 0\r\n\r\n".to_vec()).await;
        let address = url.trim_start_matches("http://").to_owned();
        let response = send(Request {
            url: &format!("{url}/write"),
            headers: &[("content-type", "application/json")],
            body: Some("{\"a\":\"한\"}".as_bytes()),
        })
        .await
        .unwrap();
        assert_eq!((response.status, response.body.len()), (201, 0));
        assert_eq!(
            parts(&served.await.unwrap()),
            (
                "POST /write HTTP/1.1".to_owned(),
                vec![
                    "connection: close".to_owned(),
                    "content-length: 11".to_owned(),
                    "content-type: application/json".to_owned(),
                    format!("host: {address}"),
                ],
                "{\"a\":\"한\"}".to_owned()
            )
        );
    }

    #[tokio::test]
    async fn reads_a_body_by_its_length_in_chunks_and_to_the_connection_s_end() {
        assert_eq!(
            body_of("HTTP/1.1 404 Not Found\r\nContent-Length: 5\r\n\r\nhello").await,
            Ok((404, "hello".to_owned()))
        );
        assert_eq!(
            body_of(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\nA\r\n pedia in \r\n0\r\nx-trailer: 1\r\n\r\n"
            )
            .await,
            Ok((200, "Wiki pedia in ".to_owned()))
        );
        assert_eq!(
            body_of("HTTP/1.0 200 OK\r\nServer: x\r\n\r\nto the end").await,
            Ok((200, "to the end".to_owned()))
        );
        // An interim answer is skipped; 204 has no body.
        assert_eq!(
            body_of(
                "HTTP/1.1 103 Early Hints\r\nlink: x\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\n1"
            )
            .await,
            Ok((200, "1".to_owned()))
        );
        assert_eq!(
            body_of("HTTP/1.1 204 No Content\r\n\r\n").await,
            Ok((204, String::new()))
        );
    }

    #[tokio::test]
    async fn an_answer_that_is_cut_or_is_not_http_is_broken() {
        for answer in [
            "",
            "HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\nshort",
            "HTTP/1.1 200 OK\r\ncontent-length: 2",
            "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nab",
            "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\nab\r\n0\r\n\r\n",
            "HTTP/1.1 200 OK\r\ncontent-length: 1\r\ncontent-length: 2\r\n\r\nab",
            "HTTP/1.1 200 OK\r\ncontent-length: -1\r\n\r\n",
            "HTTP/2 200\r\n\r\n",
            "SSH-2.0-OpenSSH\r\n\r\n",
            "HTTP/1.1 2000 OK\r\n\r\n",
            "HTTP/1.1 200 OK\r\nno colon\r\n\r\n",
        ] {
            assert_eq!(body_of(answer).await, Err(Failure::Broken), "{answer:?}");
        }
    }

    #[tokio::test]
    async fn a_body_past_its_bound_is_too_large() {
        let answer = b"HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\n123456789".to_vec();
        let (url, _served) = canned(answer.clone()).await;
        assert_eq!(
            send_within(get(&url), 8).await.err(),
            Some(Failure::TooLarge)
        );
        let (url, _served) = canned(answer).await;
        assert_eq!(
            send_within(get(&url), 9).await.map(|kept| kept.body.len()),
            Ok(9)
        );
        let chunked = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\n12345\r\n5\r\n67890\r\n0\r\n\r\n";
        let (url, _served) = canned(chunked.to_vec()).await;
        assert_eq!(
            send_within(get(&url), 9).await.err(),
            Some(Failure::TooLarge)
        );
    }

    #[tokio::test]
    async fn refuses_what_it_cannot_send_before_dialing() {
        for url in [
            "https://127.0.0.1:1/x",
            "http://user:pass@127.0.0.1:1/x",
            "http://user@127.0.0.1:1/x",
            "ftp://127.0.0.1/x",
            "127.0.0.1:1/x",
            "",
        ] {
            assert_eq!(send(get(url)).await.err(), Some(Failure::Request), "{url}");
        }
        // A header that would end its line, or is not ASCII, is never written: nothing connects.
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        for value in ["a\r\nx-injected: 1", "a\nb", "a\0b", "tok\u{e9}n", "\u{7f}"] {
            let refused = send(Request {
                url: &url,
                headers: &[("authorization", value)],
                body: None,
            })
            .await;
            assert_eq!(refused.err(), Some(Failure::Request), "{value:?}");
        }
        tokio::select! {
            biased;
            _ = listener.accept() => panic!("a refused request connected"),
            () = std::future::ready(()) => {}
        }
    }

    #[tokio::test]
    async fn nothing_listening_is_a_failed_connect() {
        let closed = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", closed.local_addr().unwrap().port());
        drop(closed);
        assert_eq!(send(get(&url)).await.err(), Some(Failure::Connect));
        assert_eq!(status(get(&url)).await.err(), Some(Failure::Connect));
    }

    #[tokio::test]
    async fn status_answers_at_the_head_without_waiting_for_the_body() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let held = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 4\r\n\r\n")
                .await
                .unwrap();
            // The body never comes.
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            drop(socket);
        });
        assert_eq!(status(get(&url)).await, Ok(503));
        held.abort();
    }

    #[tokio::test]
    async fn a_caller_that_gives_up_closes_the_connection() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (read, was_read) = tokio::sync::oneshot::channel();
        let closed = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            read.send(()).unwrap();
            // No answer: this read ends only when the client's side closes.
            let mut rest = Vec::new();
            let _ = socket.read_to_end(&mut rest).await;
        });
        let asking = tokio::spawn(async move { send(get(&url)).await.map(|_| ()) });
        was_read.await.unwrap();
        asking.abort();
        closed.await.unwrap();
    }
}
