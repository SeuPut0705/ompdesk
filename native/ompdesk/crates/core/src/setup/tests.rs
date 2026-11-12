use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::net::TcpListener;

use super::archives::{
    self, Pages, Platform, gh_archive_file, node_archive_file, parse_shasums, pick_node_lts,
};
use crate::http::tests::read_request;
use crate::server::Registry;

// ---- the pure rules, against what the TypeScript answered (captured.json, captured before it was deleted)

fn captured() -> Value {
    serde_json::from_str(include_str!("captured.json")).unwrap()
}

#[test]
fn picks_the_lts_the_typescript_picked() {
    let rows = captured();
    let rows = rows["lts"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        let expect = row["expect"].as_str().map(str::to_owned);
        assert_eq!(pick_node_lts(&row["index"]), expect, "{}", row["index"]);
    }
}

#[test]
fn reads_the_hash_the_typescript_read() {
    let rows = captured();
    let rows = rows["shasums"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        let (listing, file) = (
            row["listing"].as_str().unwrap(),
            row["file"].as_str().unwrap(),
        );
        let expect = row["expect"].as_str().map(str::to_owned);
        assert_eq!(parse_shasums(listing, file), expect, "{row}");
    }
}

#[test]
fn names_the_archives_the_typescript_named() {
    let rows = captured();
    for row in rows["files"].as_array().unwrap() {
        let (version, arch) = (
            row["version"].as_str().unwrap(),
            row["arch"].as_str().unwrap(),
        );
        assert_eq!(
            node_archive_file(version, arch),
            row["node"].as_str().unwrap()
        );
        assert_eq!(gh_archive_file(version, arch), row["gh"].as_str().unwrap());
    }
}

/// Pages from a table; a page it lacks is a 404, as the TypeScript tests' fake served it.
struct Table {
    pages: HashMap<String, String>,
    asked: Mutex<Vec<String>>,
}

impl Pages for Table {
    async fn text(&self, url: &str) -> Result<String, String> {
        self.asked.lock().unwrap().push(url.to_owned());
        self.pages
            .get(url)
            .cloned()
            .ok_or_else(|| format!("{url} answered 404"))
    }
}

#[tokio::test]
async fn resolves_the_releases_the_typescript_resolved() {
    let rows = captured();
    let rows = rows["resolve"].as_array().unwrap();
    assert!(rows.len() > 80);
    for row in rows {
        let table = Table {
            pages: row["pages"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(url, page)| (url.clone(), page.as_str().unwrap().to_owned()))
                .collect(),
            asked: Mutex::default(),
        };
        let call = &row["call"];
        let arch = call["arch"].as_str().unwrap_or_default();
        let platform = |call: &Value| match call["platform"].as_str().unwrap() {
            "darwin" => Platform::Darwin,
            _ => Platform::Win32,
        };
        let outcome: Result<Value, String> = match call["fn"].as_str().unwrap() {
            "archive" => archives::resolve_archive(&table, call["item"].as_str().unwrap(), arch)
                .await
                .map(|release| serde_json::to_value(release).unwrap()),
            "agent" => archives::resolve_agent_desktop(&table, platform(call), arch)
                .await
                .map(|release| serde_json::to_value(release).unwrap()),
            _ => archives::resolve_tailscale(&table, platform(call), call["msiArch"].as_str())
                .await
                .map(|release| serde_json::to_value(release).unwrap()),
        };
        let asked: Vec<String> = row["asked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|url| url.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(*table.asked.lock().unwrap(), asked, "{call}");
        if let Some(release) = row.get("ok") {
            assert_eq!(outcome.as_ref(), Ok(release), "{call}");
        } else if row["syntax"] == true {
            // V8 and serde word a JSON syntax error differently; that it is one is what is kept.
            assert!(outcome.is_err(), "{call}");
        } else {
            assert_eq!(
                outcome,
                Err(row["err"].as_str().unwrap().to_owned()),
                "{call}"
            );
        }
    }
}

// ---- the whole requests, over the wire, against a server on 127.0.0.1

type Lines = BufReader<ReadHalf<DuplexStream>>;

struct Core {
    lines: Lines,
    write: WriteHalf<DuplexStream>,
    next_id: u64,
}

impl Core {
    async fn start() -> Core {
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let mut registry = Registry::default();
        super::register(&mut registry);
        tokio::spawn(crate::serve(server_read, server_write, registry));
        let (client_read, write) = tokio::io::split(client);
        let mut core = Core {
            lines: BufReader::new(client_read),
            write,
            next_id: 0,
        };
        assert_eq!(core.next().await["event"], "ready");
        core
    }

    async fn next(&mut self) -> Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(60), self.lines.read_line(&mut line))
            .await
            .expect("the core sent nothing for 60 s")
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn send(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let frame = json!({ "id": self.next_id, "method": method, "params": params });
        self.write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
        self.next_id
    }

    /// Every frame up to the answer of request `id`, which is the last.
    async fn until_answer(&mut self, id: u64) -> Vec<Value> {
        let mut frames = Vec::new();
        loop {
            let frame = self.next().await;
            let done = frame["id"] == id;
            frames.push(frame);
            if done {
                return frames;
            }
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        self.until_answer(id).await.pop().unwrap()
    }
}

/// What a route sends: the status, extra headers, the body in chunks, and what happens after the last one.
#[derive(Clone)]
struct Script {
    status: u16,
    headers: Vec<(&'static str, String)>,
    chunks: Vec<Vec<u8>>,
    /// Keeps the connection open after the chunks (a stalled body).
    stall: bool,
}

impl Script {
    fn ok(chunks: &[&[u8]]) -> Script {
        let length = chunks.iter().map(|chunk| chunk.len()).sum::<usize>();
        Script {
            status: 200,
            headers: vec![("content-length", length.to_string())],
            chunks: chunks.iter().map(|chunk| chunk.to_vec()).collect(),
            stall: false,
        }
    }

    fn status(status: u16, body: &str) -> Script {
        Script {
            status,
            ..Script::ok(&[body.as_bytes()])
        }
    }
}

/// Each request a server saw: its path and its lowercased header lines.
type Seen = Arc<Mutex<Vec<(String, Vec<String>)>>>;

struct Server {
    url: String,
    /// Each request's path and its lowercased header lines.
    seen: Seen,
}

/// A server on 127.0.0.1 that answers each path with its script (404 for another).
async fn serve(routes: &[(&str, Script)]) -> Server {
    let routes: Arc<HashMap<String, Script>> = Arc::new(
        routes
            .iter()
            .map(|(path, script)| ((*path).to_owned(), script.clone()))
            .collect(),
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen: Seen = Arc::default();
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let routes = Arc::clone(&routes);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let request = String::from_utf8_lossy(&read_request(&mut socket).await).to_string();
                let mut lines = request.split("\r\n");
                let path = lines
                    .next()
                    .and_then(|first| first.split(' ').nth(1))
                    .unwrap_or_default()
                    .to_owned();
                let headers = lines
                    .take_while(|line| !line.is_empty())
                    .map(str::to_ascii_lowercase)
                    .collect();
                log.lock().unwrap().push((path.clone(), headers));
                let script = routes
                    .get(&path)
                    .cloned()
                    .unwrap_or_else(|| Script::status(404, "not found"));
                let mut head = format!("HTTP/1.1 {} X\r\nconnection: close\r\n", script.status);
                for (name, value) in &script.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = socket.write_all(head.as_bytes()).await;
                for chunk in &script.chunks {
                    let _ = socket.write_all(chunk).await;
                    let _ = socket.flush().await;
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                if script.stall {
                    tokio::time::sleep(Duration::from_secs(120)).await;
                }
                let _ = socket.shutdown().await;
            });
        }
    });
    Server { url, seen }
}

fn temp(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ompdesk-core-setup-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sha256(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn download_params(id_less: Value, server: &Server, file: &Path, sha: &str) -> Value {
    let mut params = json!({
        "id": 7,
        "url": "https://example.test/x",
        "sha256": sha,
        "file": file.to_string_lossy(),
        "mirror": server.url,
    });
    for (key, value) in id_less.as_object().unwrap() {
        params[key] = value.clone();
    }
    params
}

fn progress(frames: &[Value]) -> Vec<(u64, Option<u64>)> {
    frames
        .iter()
        .filter(|frame| frame["event"] == "setup.downloadProgress")
        .map(|frame| {
            assert_eq!(frame["data"]["id"], 7);
            (
                frame["data"]["received"].as_u64().unwrap(),
                frame["data"]["total"].as_u64(),
            )
        })
        .collect()
}

#[tokio::test]
async fn streams_the_file_into_place_with_progress_then_checks_its_hash() {
    let (a, b) = (vec![1_u8; 3000], vec![2_u8; 1000]);
    let whole = [a.clone(), b.clone()].concat();
    let server = serve(&[("/example.test/x", Script::ok(&[&a, &b]))]).await;
    let dir = temp("stream");
    let file = dir.join("downloads").join("PortableGit.7z.exe");
    let mut core = Core::start().await;
    let id = core
        .send(
            "setup.download",
            download_params(json!({}), &server, &file, &sha256(&whole)),
        )
        .await;
    let frames = core.until_answer(id).await;
    let answer = frames.last().unwrap();
    assert_eq!(answer["ok"], true, "{answer}");
    let steps = progress(&frames);
    assert_eq!(steps.first(), Some(&(0, Some(4000))));
    assert_eq!(steps.last(), Some(&(4000, Some(4000))));
    assert!(steps.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    assert_eq!(std::fs::read(&file).unwrap(), whole);
    // Only the verified file is left: no partial copy.
    assert_eq!(listing(&dir.join("downloads")), ["PortableGit.7z.exe"]);
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen[0].0, "/example.test/x");
    assert!(seen[0].1.contains(&"user-agent: ompdesk-setup".to_owned()));
    assert!(!seen[0].1.iter().any(|line| line.starts_with("accept:")));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn sends_the_accept_it_was_given_and_reports_no_total_without_a_length() {
    let body = b"no length".to_vec();
    let mut script = Script::ok(&[&body]);
    script.headers.clear();
    let server = serve(&[("/example.test/x", script)]).await;
    let dir = temp("nolength");
    let file = dir.join("x");
    let mut core = Core::start().await;
    let id = core
        .send(
            "setup.download",
            download_params(
                json!({"accept": "application/octet-stream"}),
                &server,
                &file,
                &sha256(&body),
            ),
        )
        .await;
    let frames = core.until_answer(id).await;
    assert_eq!(frames.last().unwrap()["ok"], true);
    assert_eq!(progress(&frames).last(), Some(&(9, None)));
    assert!(
        server.seen.lock().unwrap()[0]
            .1
            .contains(&"accept: application/octet-stream".to_owned())
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn keeps_nothing_that_does_not_match_the_published_hash() {
    let body = vec![1_u8; 4000];
    let server = serve(&[("/example.test/x", Script::ok(&[&body]))]).await;
    let dir = temp("mismatch");
    let mut core = Core::start().await;
    let zeros = "0".repeat(64);
    let answer = core
        .call(
            "setup.download",
            download_params(json!({}), &server, &dir.join("x"), &zeros),
        )
        .await;
    assert_eq!(answer["error"]["code"], "checksum");
    assert_eq!(
        answer["error"]["message"],
        format!("SHA-256 mismatch: expected {zeros}, got {}", sha256(&body))
    );
    assert_eq!(listing(&dir), Vec::<String>::new());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn calls_an_error_status_an_unreachable_server_or_a_cut_body_a_download_failure() {
    let mut cut = Script::ok(&[&[1_u8; 3000]]);
    cut.headers = vec![("content-length", "4000".to_owned())];
    let server = serve(&[
        ("/example.test/x", Script::status(404, "gone")),
        ("/example.test/empty", Script::status(204, "")),
        ("/example.test/cut", cut),
    ])
    .await;
    let dir = temp("failures");
    let mut core = Core::start().await;
    let sha = "a".repeat(64);
    let answer = core
        .call(
            "setup.download",
            download_params(json!({}), &server, &dir.join("x"), &sha),
        )
        .await;
    assert_eq!(answer["error"]["code"], "download");
    assert_eq!(
        answer["error"]["message"],
        "https://example.test/x answered 404"
    );
    let answer = core
        .call(
            "setup.download",
            download_params(
                json!({"url": "https://example.test/empty"}),
                &server,
                &dir.join("x"),
                &sha,
            ),
        )
        .await;
    assert_eq!(
        answer["error"]["message"],
        "https://example.test/empty answered 204"
    );
    let answer = core
        .call(
            "setup.download",
            download_params(
                json!({"url": "https://example.test/cut"}),
                &server,
                &dir.join("x"),
                &sha,
            ),
        )
        .await;
    assert_eq!(answer["error"]["code"], "download");
    assert_eq!(
        answer["error"]["message"],
        "https://example.test/cut: the connection ended"
    );
    // Nothing listens there.
    let closed = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let gone = format!("http://127.0.0.1:{}", closed.local_addr().unwrap().port());
    drop(closed);
    let answer = core
        .call(
            "setup.download",
            json!({"id": 7, "url": "https://example.test/x", "sha256": sha, "file": dir.join("x"), "mirror": gone}),
        )
        .await;
    assert_eq!(answer["error"]["code"], "download");
    assert_eq!(
        answer["error"]["message"],
        "https://example.test/x: could not connect"
    );
    assert_eq!(listing(&dir), Vec::<String>::new());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn follows_a_redirect_as_fetch_did() {
    let body = b"after the redirect".to_vec();
    let mut moved = Script::status(302, "");
    moved.headers = vec![
        ("location", "/elsewhere/file".to_owned()),
        ("content-length", "0".to_owned()),
    ];
    let server = serve(&[
        ("/example.test/x", moved),
        ("/elsewhere/file", Script::ok(&[&body])),
    ])
    .await;
    let dir = temp("redirect");
    let mut core = Core::start().await;
    let answer = core
        .call(
            "setup.download",
            download_params(json!({}), &server, &dir.join("x"), &sha256(&body)),
        )
        .await;
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(std::fs::read(dir.join("x")).unwrap(), body);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn stops_on_cancel_and_removes_the_partial_file() {
    let mut stalled = Script::ok(&[&[1_u8; 3000]]);
    stalled.headers = vec![("content-length", "4000".to_owned())];
    stalled.stall = true;
    let server = serve(&[("/example.test/x", stalled)]).await;
    let dir = temp("cancel");
    let mut core = Core::start().await;
    // The cancel lands at different points of the start (head, file open, first bytes) over the rounds.
    for round in 0..6_u64 {
        let file = dir.join(format!("x{round}"));
        let id = core
            .send(
                "setup.download",
                download_params(json!({}), &server, &file, &"a".repeat(64)),
            )
            .await;
        if round % 2 == 0 {
            loop {
                let frame = core.next().await;
                if frame["event"] == "setup.downloadProgress" && frame["data"]["received"] == 3000 {
                    break;
                }
            }
        } else {
            tokio::time::sleep(Duration::from_millis(round * 5)).await;
        }
        core.write
            .write_all(format!("{}\n", json!({ "cancel": id })).as_bytes())
            .await
            .unwrap();
        let answer = core.until_answer(id).await.pop().unwrap();
        assert_eq!(answer["error"]["code"], "cancelled", "{answer}");
        assert_eq!(listing(&dir), Vec::<String>::new(), "round {round}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn fails_as_a_download_error_when_the_destination_cannot_be_written() {
    let body = vec![1_u8; 100];
    let server = serve(&[("/example.test/x", Script::ok(&[&body]))]).await;
    let dir = temp("unwritable");
    let file = dir.join("git.zip");
    // A directory where `.part` should go: the file cannot be opened.
    std::fs::create_dir(dir.join("git.zip.part")).unwrap();
    let mut core = Core::start().await;
    let answer = core
        .call(
            "setup.download",
            download_params(json!({}), &server, &file, &sha256(&body)),
        )
        .await;
    assert_eq!(answer["error"]["code"], "download");
    assert!(
        answer["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with(&format!("{}.part: ", file.display())),
        "{answer}"
    );
    assert!(!file.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn resolves_over_the_wire_with_the_token_for_the_github_api_only() {
    let sha = "b".repeat(64);
    let server = serve(&[
        (
            "/api.github.com/repos/cli/cli/releases/latest",
            Script::status(200, r#"{"tag_name":"v2.102.0"}"#),
        ),
        (
            "/github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt",
            Script::status(200, &format!("\u{feff}{sha}  gh_2.102.0_macOS_arm64.zip\n")),
        ),
    ])
    .await;
    let mut core = Core::start().await;
    let answer = core
        .call(
            "setup.resolveArchive",
            json!({"item": "gh", "arch": "arm64", "mirror": server.url, "githubToken": "secret"}),
        )
        .await;
    assert_eq!(
        answer["result"],
        json!({
            "item": "gh",
            "version": "2.102.0",
            "file": "gh_2.102.0_macOS_arm64.zip",
            "url": "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_arm64.zip",
            "sha256": sha,
        })
    );
    {
        let seen = server.seen.lock().unwrap();
        assert!(
            seen[0]
                .1
                .contains(&"authorization: bearer secret".to_owned())
        );
        assert!(seen[0].1.contains(&"user-agent: ompdesk-setup".to_owned()));
        assert!(
            !seen[1]
                .1
                .iter()
                .any(|line| line.starts_with("authorization:"))
        );
    }
    let answer = core
        .call(
            "setup.resolveArchive",
            json!({"item": "node", "arch": "arm64", "mirror": server.url}),
        )
        .await;
    assert_eq!(answer["error"]["code"], "setup_lookup");
    assert_eq!(
        answer["error"]["message"],
        "https://nodejs.org/dist/index.json answered 404"
    );
    let answer = core
        .call(
            "setup.resolveAgentDesktop",
            json!({"platform": "win32", "arch": "ia32", "mirror": server.url}),
        )
        .await;
    assert_eq!(
        answer["error"]["message"],
        "agent-desktop has no release for win32 ia32"
    );
    let answer = core
        .call(
            "setup.resolveArchive",
            json!({"item": "bun", "arch": "x64"}),
        )
        .await;
    assert_eq!(answer["error"]["code"], "invalid_params");
}

#[test]
fn routes_every_host_to_the_mirror_and_leaves_a_real_address_alone() {
    use super::net::routed;
    assert_eq!(
        routed(
            "https://nodejs.org/dist/index.json",
            Some("http://127.0.0.1:9/")
        ),
        "http://127.0.0.1:9/nodejs.org/dist/index.json"
    );
    assert_eq!(
        routed(
            "https://pkgs.tailscale.com/stable/?mode=json",
            Some("http://127.0.0.1:9")
        ),
        "http://127.0.0.1:9/pkgs.tailscale.com/stable/?mode=json"
    );
    assert_eq!(routed("https://nodejs.org/x", None), "https://nodejs.org/x");
}
