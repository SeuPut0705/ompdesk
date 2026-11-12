//! The core's HTTP/1.1 client: one request over one TCP connection, plain or TLS, the whole answer read into memory.
//! It exists for the ai-memory server (`aimemory`), which answers JSON on loopback or, when its config names one, at
//! an `https` address elsewhere. The protocol is hyper's (`hyper::client::conn::http1`: its parser, chunked bodies,
//! interim answers) and TLS is rustls's; this file adds the address, the header check, the redirects and the bounds.
//!
//! Redirects are followed as `fetch` followed them (`redirect: "follow"`): up to 20; a 301 or 302 to a POST and a 303
//! go on as a GET without the body and its `content-type`, a 307 or 308 keeps both; the `authorization` header is
//! dropped for good at the first hop to another origin (scheme, host, port), so a token never leaves its server. A
//! certificate is checked by the platform's verifier against what the machine trusts, plus the certificates
//! `NODE_EXTRA_CA_CERTS` names, as Node's `fetch` added them.
//!
//! What it does not do, on purpose: connection reuse (`connection: close` on every request; a loopback connect costs
//! less than keeping a pool right), compression (no `accept-encoding` is sent, so none comes back), proxies. The
//! address is read as the WHATWG URL standard reads it (`url`, as node's `fetch` did), so the path and query go out
//! normalized the same way.
//!
//! Nothing here keeps or reports what a request carried: a `Failure` names a kind, and the one text it can hold
//! (`Tls`) is rustls's account of a handshake, which ends before any header or body of the request is written.

use std::ffi::OsString;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, LazyLock};

use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::LOCATION;
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use url::{Host, Position, Url};

/// The longest answer kept. `fetch` had no bound; nothing the memory server answers comes near this.
pub const BODY_MAX: usize = 64 * 1024 * 1024;

/// How many redirects one request follows; the 21st fails, as in `fetch`.
const REDIRECT_MAX: usize = 20;

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

/// Why no answer came. It names a kind, never anything of the request.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// The URL is not `http` or `https` with a host and no credentials, or a header's value cannot be sent.
    Request,
    /// Nothing accepted the connection.
    Connect,
    /// The connection ended or the answer was not HTTP/1.x.
    Broken,
    /// The body is past its bound.
    TooLarge,
    /// No TLS connection came about: a certificate the machine does not trust or made for another name, no TLS on the
    /// other side, nothing in common. rustls's words.
    Tls(String),
    /// A redirect could not be followed: one past the 20th, or a `location` that is no `http` or `https` URL.
    Redirect,
}

/// The TLS settings a request uses; tests hand in their own authority.
type Tls = fn() -> Result<Arc<ClientConfig>, Failure>;

/// ring's cryptography, the platform's verifier with `roots` trusted beside the machine's.
fn client_config(roots: Vec<CertificateDer<'static>>) -> Result<Arc<ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = if roots.is_empty() {
        rustls_platform_verifier::Verifier::new(provider.clone())
    } else {
        rustls_platform_verifier::Verifier::new_with_extra_roots(roots, provider.clone())
    }
    .map_err(|error| error.to_string())?;
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// The certificates the file `NODE_EXTRA_CA_CERTS` names. One that cannot be read is skipped with a line on stderr,
/// as node warned and went on.
fn extra_roots(file: Option<OsString>) -> Vec<CertificateDer<'static>> {
    let Some(file) = file.filter(|file| !file.is_empty()) else {
        return Vec::new();
    };
    match CertificateDer::pem_file_iter(&file).and_then(Iterator::collect) {
        Ok(roots) => roots,
        Err(error) => {
            let file = Path::new(&file).display();
            eprintln!("ignoring extra certs from `{file}`, load failed: {error}");
            Vec::new()
        }
    }
}

/// The process's settings, made at its first `https` request.
static MACHINE_TLS: LazyLock<Result<Arc<ClientConfig>, String>> =
    LazyLock::new(|| client_config(extra_roots(std::env::var_os("NODE_EXTRA_CA_CERTS"))));

fn machine_tls() -> Result<Arc<ClientConfig>, Failure> {
    MACHINE_TLS.clone().map_err(Failure::Tls)
}

struct Target {
    tls: bool,
    host: Host<String>,
    port: u16,
    /// `host[:port]` as the URL spells it: the `host` header.
    authority: String,
    /// Path and query.
    path: String,
}

fn target(url: &Url) -> Result<Target, Failure> {
    let tls = match url.scheme() {
        "http" => false,
        "https" => true,
        _ => return Err(Failure::Request),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Failure::Request);
    }
    Ok(Target {
        tls,
        host: url.host().ok_or(Failure::Request)?.to_owned(),
        port: url.port_or_known_default().ok_or(Failure::Request)?,
        authority: url[Position::BeforeHost..Position::AfterPort].to_owned(),
        path: url[Position::BeforePath..Position::AfterQuery].to_owned(),
    })
}

/// One open connection, plain or TLS.
trait Io: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> Io for T {}

async fn connect(target: &Target, tls: Tls) -> Result<Box<dyn Io>, Failure> {
    let config = if target.tls { Some(tls()?) } else { None };
    let stream = match &target.host {
        Host::Domain(name) => TcpStream::connect((name.as_str(), target.port)).await,
        Host::Ipv4(address) => TcpStream::connect((*address, target.port)).await,
        Host::Ipv6(address) => TcpStream::connect((*address, target.port)).await,
    }
    .map_err(|_| Failure::Connect)?;
    let _ = stream.set_nodelay(true);
    let Some(config) = config else {
        return Ok(Box::new(stream));
    };
    let name = match &target.host {
        Host::Domain(name) => ServerName::try_from(name.clone()).map_err(|_| Failure::Request)?,
        Host::Ipv4(address) => ServerName::from(IpAddr::V4(*address)),
        Host::Ipv6(address) => ServerName::from(IpAddr::V6(*address)),
    };
    let stream = TlsConnector::from(config)
        .connect(name, stream)
        .await
        .map_err(|error| {
            match error
                .get_ref()
                .and_then(|inner| inner.downcast_ref::<rustls::Error>())
            {
                Some(refused) => Failure::Tls(refused.to_string()),
                None => Failure::Broken,
            }
        })?;
    Ok(Box::new(stream))
}

/// Sends one request to `url` and answers at its head; the body is still to be read.
async fn exchange_once(
    url: &Url,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    tls: Tls,
) -> Result<hyper::Response<Incoming>, Failure> {
    let target = target(url)?;
    let method = if body.is_some() { "POST" } else { "GET" };
    let mut message = hyper::Request::builder()
        .method(method)
        .uri(target.path.as_str())
        .header("host", target.authority.as_str())
        .header("connection", "close");
    for (name, value) in headers {
        if !value
            .bytes()
            .all(|byte| byte == b'\t' || (0x20..0x7f).contains(&byte))
        {
            return Err(Failure::Request);
        }
        message = message.header(*name, *value);
    }
    let body = Full::new(Bytes::copy_from_slice(body.unwrap_or_default()));
    let message = message.body(body).map_err(|_| Failure::Request)?;
    let stream = connect(&target, tls).await?;
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

/// Sends `request`, following its redirects, and answers at the last head; the body is still to be read.
async fn exchange(request: &Request<'_>, tls: Tls) -> Result<hyper::Response<Incoming>, Failure> {
    let mut url = Url::parse(request.url).map_err(|_| Failure::Request)?;
    let mut headers: Vec<(&str, &str)> = request.headers.to_vec();
    let mut body = request.body;
    for _ in 0..=REDIRECT_MAX {
        let response = exchange_once(&url, &headers, body, tls).await?;
        let status = response.status().as_u16();
        let location = match response.headers().get(LOCATION) {
            Some(location) if matches!(status, 301 | 302 | 303 | 307 | 308) => {
                String::from_utf8_lossy(location.as_bytes()).into_owned()
            }
            _ => return Ok(response),
        };
        let next = url
            .join(&location)
            .ok()
            .filter(|next| matches!(next.scheme(), "http" | "https"))
            .ok_or(Failure::Redirect)?;
        if status < 307 {
            body = None;
            headers.retain(|(name, _)| !name.eq_ignore_ascii_case("content-type"));
        }
        if next.origin() != url.origin() {
            headers.retain(|(name, _)| !name.eq_ignore_ascii_case("authorization"));
        }
        url = next;
    }
    Err(Failure::Redirect)
}

async fn send_within(request: Request<'_>, body_max: usize, tls: Tls) -> Result<Response, Failure> {
    let response = exchange(&request, tls).await?;
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

/// Sends `request` and reads the whole answer. The caller bounds the time (`tokio::time::timeout`), redirects
/// included; dropping the future closes the connection.
pub async fn send(request: Request<'_>) -> Result<Response, Failure> {
    send_within(request, BODY_MAX, machine_tls).await
}

/// Sends `request` and answers its status as soon as the last head arrived; the body is not read.
pub async fn status(request: Request<'_>) -> Result<u16, Failure> {
    Ok(exchange(&request, machine_tls).await?.status().as_u16())
}

/// Sends `request` and answers at the last head with the body still to be read, frame by frame (a download that
/// streams to disk). Dropping the answer closes the connection.
pub async fn open(request: Request<'_>) -> Result<hyper::Response<Incoming>, Failure> {
    exchange(&request, machine_tls).await
}

/// Sends `request` once and answers its status as soon as the head arrived; the body is not read. A redirect is an
/// answer here and is not followed: Web Push's one attempt takes a push service's 3xx as a refusal, as `https.request`
/// did (the redirect rules above are `fetch`'s).
pub async fn status_once(request: Request<'_>) -> Result<u16, Failure> {
    let url = Url::parse(request.url).map_err(|_| Failure::Request)?;
    let response = exchange_once(&url, request.headers, request.body, machine_tls).await?;
    Ok(response.status().as_u16())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;

    use rcgen::{
        BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer,
        KeyPair, KeyUsagePurpose,
    };
    use rustls::ServerConfig;
    use rustls::pki_types::PrivateKeyDer;
    use time::{Duration, OffsetDateTime};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;
    use tokio_rustls::TlsAcceptor;

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
    pub(crate) async fn read_request(socket: &mut (impl AsyncRead + Unpin)) -> Vec<u8> {
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
            send_within(get(&url), 8, machine_tls).await.err(),
            Some(Failure::TooLarge)
        );
        let (url, _served) = canned(answer).await;
        assert_eq!(
            send_within(get(&url), 9, machine_tls)
                .await
                .map(|kept| kept.body.len()),
            Ok(9)
        );
        let chunked = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\n12345\r\n5\r\n67890\r\n0\r\n\r\n";
        let (url, _served) = canned(chunked.to_vec()).await;
        assert_eq!(
            send_within(get(&url), 9, machine_tls).await.err(),
            Some(Failure::TooLarge)
        );
    }

    #[tokio::test]
    async fn refuses_what_it_cannot_send_before_dialing() {
        for url in [
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

    /// Valid from an hour ago for a day: macOS refuses a server certificate valid for more than 825 days.
    fn for_a_day(params: &mut CertificateParams) {
        let now = OffsetDateTime::now_utc();
        params.not_before = now - Duration::hours(1);
        params.not_after = now + Duration::days(1);
    }

    struct Authority {
        issuer: Issuer<'static, KeyPair>,
        der: CertificateDer<'static>,
        pem: String,
    }

    fn authority(name: &str) -> Authority {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.distinguished_name.push(DnType::CommonName, name);
        for_a_day(&mut params);
        let certificate = params.self_signed(&key).unwrap();
        Authority {
            issuer: Issuer::new(params, key),
            der: certificate.der().clone(),
            pem: certificate.pem(),
        }
    }

    /// The test process's authority: the machine does not trust it, `trusting` does.
    static TRUSTED: LazyLock<Authority> = LazyLock::new(|| authority("OMPdesk test CA"));

    fn trusting() -> Result<Arc<ClientConfig>, Failure> {
        static CONFIG: LazyLock<Arc<ClientConfig>> =
            LazyLock::new(|| client_config(vec![TRUSTED.der.clone()]).unwrap());
        Ok(CONFIG.clone())
    }

    /// A server's TLS settings with a certificate for `names`, signed by `issuer`.
    fn server_tls(issuer: &Issuer<'_, KeyPair>, names: &[&str]) -> Arc<ServerConfig> {
        let key = KeyPair::generate().unwrap();
        let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        let mut params = CertificateParams::new(names).unwrap();
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        for_a_day(&mut params);
        let certificate = params.signed_by(&key, issuer).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![certificate.der().clone()],
                PrivateKeyDer::Pkcs8(key.serialize_der().into()),
            )
            .unwrap();
        Arc::new(config)
    }

    type Seen = Arc<Mutex<Vec<Vec<u8>>>>;

    async fn reply(
        stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
        answer: &(dyn Fn(&str) -> String + Send + Sync),
        seen: &Seen,
    ) {
        let request = read_request(stream).await;
        let answer = answer(&String::from_utf8_lossy(&request));
        seen.lock().unwrap().push(request);
        let _ = stream.write_all(answer.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    /// A server on 127.0.0.1, TLS with `tls`, that answers each request (its text) with `answer`; answers its port and
    /// the requests it read, in order.
    async fn serve(
        tls: Option<Arc<ServerConfig>>,
        answer: impl Fn(&str) -> String + Send + Sync + 'static,
    ) -> (u16, Seen) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Seen::default();
        let (answer, kept) = (Arc::new(answer), seen.clone());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (answer, kept, tls) = (answer.clone(), kept.clone(), tls.clone());
                tokio::spawn(async move {
                    match tls {
                        None => reply(&mut socket, &*answer, &kept).await,
                        Some(config) => {
                            if let Ok(mut stream) = TlsAcceptor::from(config).accept(socket).await {
                                reply(&mut stream, &*answer, &kept).await;
                            }
                        }
                    }
                });
            }
        });
        (port, seen)
    }

    fn ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    fn moved(status: u16, location: &str) -> String {
        format!("HTTP/1.1 {status} Moved\r\nlocation: {location}\r\ncontent-length: 2\r\n\r\nno")
    }

    #[tokio::test]
    async fn speaks_tls_to_a_server_whose_authority_is_trusted() {
        let tls = server_tls(&TRUSTED.issuer, &["localhost", "127.0.0.1"]);
        let (port, seen) = serve(Some(tls), |_| ok("secure")).await;
        for host in ["127.0.0.1", "localhost"] {
            let url = format!("https://{host}:{port}/x?y=1");
            let request = Request {
                url: &url,
                headers: &[("authorization", "Bearer abc")],
                body: Some(b"{}"),
            };
            let response = send_within(request, BODY_MAX, trusting).await.unwrap();
            assert_eq!((response.status, response.body), (200, b"secure".to_vec()));
        }
        let seen = seen.lock().unwrap();
        let (first, headers, body) = parts(&seen[0]);
        assert_eq!(
            (first.as_str(), body.as_str()),
            ("POST /x?y=1 HTTP/1.1", "{}")
        );
        assert!(headers.contains(&"authorization: Bearer abc".to_owned()));
        assert!(headers.contains(&format!("host: 127.0.0.1:{port}")));
        assert_eq!(seen.len(), 2);
    }

    #[tokio::test]
    async fn a_certificate_not_trusted_or_not_for_this_host_fails_as_tls_before_the_request() {
        let other = authority("Someone else's CA");
        let names = ["localhost", "127.0.0.1"];
        let cases = [
            (server_tls(&other.issuer, &names), trusting as Tls),
            (server_tls(&TRUSTED.issuer, &["example.invalid"]), trusting),
            // The machine's own settings know nothing of the test authority.
            (server_tls(&TRUSTED.issuer, &names), machine_tls),
        ];
        for (tls, client) in cases {
            let (port, seen) = serve(Some(tls), |_| ok("never")).await;
            let url = format!("https://127.0.0.1:{port}/x");
            let request = Request {
                url: &url,
                headers: &[("authorization", "Bearer abc")],
                body: None,
            };
            match send_within(request, BODY_MAX, client).await {
                Err(Failure::Tls(said)) => {
                    assert!(said.starts_with("invalid peer certificate"), "{said}");
                }
                other => panic!("{:?}", other.map(|response| response.status)),
            }
            assert!(seen.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn a_server_that_answers_no_tls_fails_as_tls() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!(
            "https://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        );
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = socket
                .write_all(b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n")
                .await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
        assert!(matches!(
            send_within(get(&url), BODY_MAX, trusting).await,
            Err(Failure::Tls(_))
        ));
    }

    #[test]
    fn trusts_the_certificates_node_extra_ca_certs_names() {
        let second = authority("Second CA");
        let file =
            std::env::temp_dir().join(format!("ompdesk-http-roots-{}.pem", std::process::id()));
        std::fs::write(&file, format!("{}{}", TRUSTED.pem, second.pem)).unwrap();
        assert_eq!(
            extra_roots(Some(file.clone().into_os_string())),
            vec![TRUSTED.der.clone(), second.der]
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(extra_roots(Some(file.into_os_string())), Vec::new());
        assert_eq!(extra_roots(Some(OsString::new())), Vec::new());
        assert_eq!(extra_roots(None), Vec::new());
    }

    /// A server that redirects as each path says: `/to/<status>` to `/end`, `/chain/<n>` through n more redirects to
    /// `/end`, `/away` to the same server under `localhost` (another origin) and on to `/back`, which comes home.
    async fn redirecting() -> (u16, Seen) {
        serve(None, |request| {
            let path = request.split(' ').nth(1).unwrap_or_default();
            let port = request
                .lines()
                .find_map(|line| line.strip_prefix("host: "))
                .and_then(|host| host.rsplit(':').next())
                .unwrap_or_default()
                .to_owned();
            if let Some(status) = path.strip_prefix("/to/") {
                return moved(status.parse().unwrap(), "/end");
            }
            if let Some(left) = path.strip_prefix("/chain/") {
                return match left.parse::<u16>().unwrap() {
                    0 => ok("end"),
                    left => moved(302, &format!("/chain/{}", left - 1)),
                };
            }
            match path {
                "/away" => moved(307, &format!("http://localhost:{port}/back")),
                "/back" => moved(308, &format!("http://127.0.0.1:{port}/end")),
                "/elsewhere" => moved(302, "ftp://127.0.0.1/end"),
                "/bare" => "HTTP/1.1 302 Found\r\ncontent-length: 4\r\n\r\nbare".to_owned(),
                _ => ok("end"),
            }
        })
        .await
    }

    fn post(url: &str) -> Request<'_> {
        Request {
            url,
            headers: &[
                ("authorization", "Bearer abc"),
                ("content-type", "application/json"),
            ],
            body: Some(b"{\"a\":1}"),
        }
    }

    #[tokio::test]
    async fn a_redirect_keeps_or_drops_the_post_as_fetch_did() {
        let (port, seen) = redirecting().await;
        for (status, method) in [
            (301, "GET"),
            (302, "GET"),
            (303, "GET"),
            (307, "POST"),
            (308, "POST"),
        ] {
            let url = format!("http://127.0.0.1:{port}/to/{status}");
            let response = send(post(&url)).await.unwrap();
            assert_eq!((response.status, response.body), (200, b"end".to_vec()));
            let (first, headers, body) = parts(seen.lock().unwrap().last().unwrap());
            assert_eq!(first, format!("{method} /end HTTP/1.1"), "{status}");
            assert!(headers.contains(&"authorization: Bearer abc".to_owned()));
            let kept = method == "POST";
            assert_eq!(body.is_empty(), !kept, "{status}");
            assert_eq!(
                headers.contains(&"content-type: application/json".to_owned()),
                kept,
                "{status}"
            );
        }
        // A GET stays one through a 303; `status` follows too.
        let url = format!("http://127.0.0.1:{port}/to/303");
        assert_eq!(status(get(&url)).await, Ok(200));
        assert!(
            parts(seen.lock().unwrap().last().unwrap())
                .0
                .starts_with("GET /end ")
        );
    }

    #[tokio::test]
    async fn the_token_never_follows_a_redirect_to_another_origin() {
        let (port, seen) = redirecting().await;
        let url = format!("http://127.0.0.1:{port}/away");
        let response = send(post(&url)).await.unwrap();
        assert_eq!(response.status, 200);
        let hops: Vec<(String, bool)> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                let (first, headers, _) = parts(request);
                let token = headers.contains(&"authorization: Bearer abc".to_owned());
                (first, token)
            })
            .collect();
        assert_eq!(
            hops,
            [
                ("POST /away HTTP/1.1".to_owned(), true),
                ("POST /back HTTP/1.1".to_owned(), false),
                // Home again, still without it: it was dropped for good.
                ("POST /end HTTP/1.1".to_owned(), false),
            ]
        );
    }

    #[tokio::test]
    async fn twenty_redirects_are_followed_and_the_twenty_first_fails() {
        let (port, seen) = redirecting().await;
        let twenty = format!("http://127.0.0.1:{port}/chain/20");
        assert_eq!(
            send(get(&twenty)).await.map(|response| response.status),
            Ok(200)
        );
        assert_eq!(seen.lock().unwrap().len(), 21);
        let past = format!("http://127.0.0.1:{port}/chain/21");
        assert_eq!(send(get(&past)).await.err(), Some(Failure::Redirect));
        assert_eq!(status(get(&past)).await.err(), Some(Failure::Redirect));
    }

    #[tokio::test]
    async fn a_redirect_without_a_location_is_the_answer_and_one_to_another_scheme_fails() {
        let (port, _) = redirecting().await;
        let bare = format!("http://127.0.0.1:{port}/bare");
        let response = send(get(&bare)).await.unwrap();
        assert_eq!((response.status, response.body), (302, b"bare".to_vec()));
        let elsewhere = format!("http://127.0.0.1:{port}/elsewhere");
        assert_eq!(send(get(&elsewhere)).await.err(), Some(Failure::Redirect));
    }
}
