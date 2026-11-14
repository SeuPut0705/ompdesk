use super::*;
use rustls::pki_types::PrivateKeyDer;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub(crate) fn tls() -> (Arc<rustls::ServerConfig>, Arc<ClientConfig>) {
    let key = rcgen::KeyPair::generate().unwrap();
    let certificate = rcgen::CertificateParams::new(vec!["127.0.0.1".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.der().clone()],
            PrivateKeyDer::Pkcs8(key.serialize_der().into()),
        )
        .unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(certificate.der().clone()).unwrap();
    let client = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    (Arc::new(server), Arc::new(client))
}

pub(crate) async fn transaction<I: AsyncRead + AsyncWrite + Unpin>(io: I, baseline: bool) {
    let mut io = BufReader::new(io);
    io.get_mut().write_all(b"* OK fixture\r\n").await.unwrap();
    let mut command = String::new();
    loop {
        command.clear();
        assert!(io.read_line(&mut command).await.unwrap() > 0);
        let (tag, action) = command.trim_end().split_once(' ').unwrap();
        let mut response = match action {
            "LOGIN \"fixture\" \"unused\"" => String::new(),
            "EXAMINE \"INBOX\"" => {
                "* 30 EXISTS\r\n* OK [UIDVALIDITY 7]\r\n* OK [UIDNEXT 31]\r\n".into()
            }
            "UID SEARCH UID 6:*" if !baseline => format!(
                "* SEARCH {}\r\n",
                (6..=30)
                    .map(|uid| uid.to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
            action if action.starts_with("UID FETCH ") && !baseline => {
                assert!(action.starts_with(
                    "UID FETCH 11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30 "
                ));
                assert!(action.contains("BODY.PEEK[HEADER.FIELDS"));
                assert!(action.contains("BODY.PEEK[TEXT]<0.6000>"));
                let headers = "From: a@example.invalid\r\nSubject: =?UTF-8?B?7JWI64WV?=\r\nContent-Type: text/plain; charset=utf-8\r\n";
                format!(
                    "* 30 FETCH (UID 30 BODY[HEADER.FIELDS (SUBJECT)] {{{}}}\r\n{headers} BODY[TEXT]<0> {{5}}\r\nhello)\r\n",
                    headers.len()
                )
            }
            "LOGOUT" => {
                io.get_mut()
                    .write_all(format!("* BYE fixture\r\n{tag} OK done\r\n").as_bytes())
                    .await
                    .unwrap();
                return;
            }
            other => panic!("unexpected command: {other}"),
        };
        response.push_str(&format!("{tag} OK done\r\n"));
        io.get_mut().write_all(response.as_bytes()).await.unwrap();
    }
}

#[tokio::test]
async fn tls_poll_baselines_then_reads_only_the_latest_twenty_without_marking_read() {
    for cursor in [
        None,
        Some(MailCursor {
            validity: 6,
            uid: 5,
        }),
        Some(MailCursor {
            validity: 7,
            uid: 5,
        }),
    ] {
        let baseline = cursor.is_none_or(|cursor| cursor.validity != 7);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (server, client) = tls();
        let serving = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            transaction(
                TlsAcceptor::from(server).accept(socket).await.unwrap(),
                baseline,
            )
            .await;
        });
        let account = Mailbox::new(
            "fixture".into(),
            "Fixture".into(),
            "a@example.invalid".into(),
            "127.0.0.1".into(),
            port,
            Login::new("fixture".into(), "unused".into(), "INBOX".into()),
        )
        .trusted_fixture(client);
        let read = read_mailbox(&account, cursor, &Scope::detached())
            .await
            .unwrap();
        assert_eq!(
            read.cursor,
            MailCursor {
                validity: 7,
                uid: 30
            }
        );
        assert_eq!(read.exists, 30);
        if baseline {
            assert!(read.messages.is_empty());
        } else {
            assert_eq!(read.messages[0].headers["subject"], "안녕");
            assert_eq!(read.messages[0].snippet, "hello");
        }
        serving.await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_closes_the_tls_socket_while_the_server_holds_its_greeting() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (server, client) = tls();
    let (connected, ready) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut io = TlsAcceptor::from(server).accept(socket).await.unwrap();
        connected.send(()).unwrap();
        let mut bytes = Vec::new();
        let _ = io.read_to_end(&mut bytes).await;
        assert!(bytes.is_empty());
    });
    let account = Mailbox::new(
        "fixture".into(),
        "Fixture".into(),
        "a@example.invalid".into(),
        "127.0.0.1".into(),
        port,
        Login::new("fixture".into(), "unused".into(), "INBOX".into()),
    )
    .trusted_fixture(client);
    let scope = Scope::detached();
    let running = scope.clone();
    let read = tokio::spawn(async move { read_mailbox(&account, None, &running).await });
    ready.await.unwrap();
    scope.cancel();
    assert_eq!(read.await.unwrap().unwrap_err().code, "cancelled");
    serving.await.unwrap();
}

#[test]
fn mime_and_untrusted_protocol_fragments_preserve_charset_and_secret_boundaries() {
    assert_eq!(mime::words("=?EUC-KR?B?vsiz5w==?="), "안녕");
    assert_eq!(mime::words("=?windows-1252?Q?caf=E9?="), "café");
    assert_eq!(
        mime::words("=?UTF-8?B?7JWI?= \r\n =?UTF-8?B?64WV?="),
        "안녕"
    );
    let headers = mime::headers(b"Content-Type: multipart/alternative; boundary=abc\r\n");
    let body = b"--abc\r\nContent-Type: text/html\r\n\r\n<b>html</b>\r\n--abc\r\nContent-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9\r\n--abc--\r\n";
    assert_eq!(mime::snippet(&headers, body), "café");
    assert!(
        search_uids(&[Line {
            text: "ééééé".into(),
            literals: vec![]
        }])
        .is_empty()
    );
    let login = Login::new("fixture".into(), "a\\\"b".into(), "INBOX".into());
    let raw = format!("{} {}", login.password, quote(&login.password).unwrap());
    let scrubbed = login.scrub(raw);
    assert!(!scrubbed.contains("a\\"));
    assert!(!scrubbed.contains("b"));
}
