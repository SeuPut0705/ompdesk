use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn authorization(port: u16) -> String {
    format!(
        "https://provider.invalid/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fcallback%3Fignored%3Dyes%23fragment&state=expected"
    )
}
#[test]
fn advertised_callback_requires_loopback_explicit_port_exact_path_and_first_state() {
    let callback = LoopbackCallback::parse(&authorization(43210)).unwrap();
    assert!(callback.matches("/callback", "state=expected&code=opaque"));
    assert!(!callback.matches("/else", "state=expected"));
    assert!(!callback.matches("/callback", "state=wrong&state=expected"));
    for redirect in [
        "http://127.0.0.1:80/callback",
        "https://127.0.0.1:43210/callback",
        "http://example.invalid:43210/callback",
    ] {
        let mut url = Url::parse("https://provider.invalid/").unwrap();
        url.query_pairs_mut()
            .append_pair("redirect_uri", redirect)
            .append_pair("state", "expected");
        assert!(LoopbackCallback::parse(url.as_str()).is_none());
    }
    let no_state = authorization(43210).replace("&state=expected", "");
    assert!(
        !LoopbackCallback::parse(&no_state)
            .unwrap()
            .matches("/callback", "state=")
    );
}
#[test]
fn callback_page_validates_wire_bounds_in_utf16_units() {
    let page = |status: u16, content_type: String, body: String| serde_json::json!({"status":status,"contentType":content_type,"body":body});
    assert!(serde_json::from_value::<Page>(page(200, "text/html".into(), "ok".into())).is_ok());
    for invalid in [
        page(99, "text/plain".into(), "ok".into()),
        page(600, "text/plain".into(), "ok".into()),
        page(200, "x".repeat(201), "ok".into()),
        page(200, "text/plain".into(), "🦀".repeat(PAGE_MAX / 2 + 1)),
    ] {
        assert!(serde_json::from_value::<Page>(invalid).is_err());
    }
}
#[tokio::test]
async fn replay_uses_one_get_and_returns_redirect_without_following_location() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback =
        LoopbackCallback::parse(&authorization(listener.local_addr().unwrap().port())).unwrap();
    let response = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
        }
        assert!(
            String::from_utf8(request)
                .unwrap()
                .starts_with("GET /callback?state=expected&code=opaque HTTP/1.1\r\n")
        );
        stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/must-not-follow\r\nContent-Type: application/json\r\nContent-Length: 7\r\nConnection: close\r\n\r\nwaiting").await.unwrap();
    };
    let (page, ()) = tokio::join!(
        callback.replay("state=expected&code=opaque".into()),
        response
    );
    let page = page.unwrap();
    assert_eq!(page.status, 302);
    assert_eq!(page.content_type, "text/plain; charset=utf-8");
    assert_eq!(page.body, "waiting");
}
#[tokio::test]
async fn replay_bounds_decoded_body_and_preserves_text_content_type() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback =
        LoopbackCallback::parse(&authorization(listener.local_addr().unwrap().port())).unwrap();
    let body = format!("\u{feff}{}🦀tail", "a".repeat(PAGE_MAX - 1));
    let response = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
        }
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: TeXt/HTML; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
    };
    let (page, ()) = tokio::join!(callback.replay("state=expected".into()), response);
    let page = page.unwrap();
    assert_eq!(page.content_type, "TeXt/HTML; charset=utf-8");
    assert_eq!(page.body.encode_utf16().count(), PAGE_MAX);
    assert!(page.body.ends_with('\u{fffd}'));
}
#[tokio::test]
async fn stalled_callback_is_aborted_at_the_existing_ten_second_budget() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback =
        LoopbackCallback::parse(&authorization(listener.local_addr().unwrap().port())).unwrap();
    let replay = tokio::spawn(callback.replay("state=expected".into()));
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        request.push(stream.read_u8().await.unwrap());
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(10)).await;
    assert_eq!(
        replay.await.unwrap().err().unwrap().code,
        "sign_in_unavailable"
    );
    tokio::time::resume();
}
