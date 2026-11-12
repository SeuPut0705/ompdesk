//! The Chromium browsers the Default browser setting can point agents at, as this computer has them (was
//! `src/main/agent-browsers.ts`): each one in its standard install place (`browsers.find`), whether a profile of it
//! loaded its own copy of the omp Browser Relay extension and whether that copy is connected to its relay
//! (`browsers.status`), writing that copy (`browsers.installRelay`, `relay.rs`) and opening the browser at its
//! extensions page (`browsers.openExtensions`).
//!
//! Main hands over what it also spells for the page: the browsers in `auto` order with their names and relay ports
//! (`src/shared/default-browser.ts`), where this machine keeps things (`systemBrowserPlaces`), and how it runs omp.
//! It keeps finding `ego-browser` along the spawn PATH (`findOnPath`, which omp's lookup shares) and the
//! once-per-launch answer every session reads.

mod relay;

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::server::{Fault, Registry, Reply, Scope};

/// A browser the setting can name.
#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Id {
    Chrome,
    Edge,
    Brave,
    Arc,
    Chromium,
}

/// Where a browser is installed and keeps its profiles.
struct Definition {
    /// macOS bundle name.
    app: Option<&'static str>,
    /// Windows exe under a program folder.
    exe: Option<&'static [&'static str]>,
    /// User data folder under `~/Library/Application Support`.
    mac_data: &'static [&'static str],
    /// User data folder under `%LOCALAPPDATA%`.
    win_data: Option<&'static [&'static str]>,
    /// The scheme its extensions page answers to.
    scheme: &'static str,
}

impl Id {
    fn name(self) -> &'static str {
        match self {
            Id::Chrome => "chrome",
            Id::Edge => "edge",
            Id::Brave => "brave",
            Id::Arc => "arc",
            Id::Chromium => "chromium",
        }
    }

    fn definition(self) -> Definition {
        match self {
            Id::Chrome => Definition {
                app: Some("Google Chrome.app"),
                exe: Some(&["Google", "Chrome", "Application", "chrome.exe"]),
                mac_data: &["Google", "Chrome"],
                win_data: Some(&["Google", "Chrome", "User Data"]),
                scheme: "chrome",
            },
            Id::Edge => Definition {
                app: Some("Microsoft Edge.app"),
                exe: Some(&["Microsoft", "Edge", "Application", "msedge.exe"]),
                mac_data: &["Microsoft Edge"],
                win_data: Some(&["Microsoft", "Edge", "User Data"]),
                scheme: "edge",
            },
            Id::Brave => Definition {
                app: Some("Brave Browser.app"),
                exe: Some(&["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
                mac_data: &["BraveSoftware", "Brave-Browser"],
                win_data: Some(&["BraveSoftware", "Brave-Browser", "User Data"]),
                scheme: "brave",
            },
            // Arc ships as a Store app on Windows, with no standard install place to look in.
            Id::Arc => Definition {
                app: Some("Arc.app"),
                exe: None,
                mac_data: &["Arc", "User Data"],
                win_data: None,
                scheme: "arc",
            },
            Id::Chromium => Definition {
                app: Some("Chromium.app"),
                exe: Some(&["Chromium", "Application", "chrome.exe"]),
                mac_data: &["Chromium"],
                win_data: Some(&["Chromium", "User Data"]),
                scheme: "chrome",
            },
        }
    }
}

/// One browser as main names it.
#[derive(Deserialize)]
struct Named {
    id: Id,
    name: String,
    /// Its own relay's loopback port.
    port: u16,
}

/// Where the machine keeps things; a test points these at a temp folder.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Places {
    /// Whose install places are read: `darwin` or `win32` (any other has none).
    platform: String,
    home: String,
    /// macOS folders holding `.app` bundles.
    app_dirs: Vec<String>,
    /// Windows `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%` roots for installed exes.
    program_dirs: Vec<String>,
    /// Windows `%LOCALAPPDATA%`.
    local_app_data: String,
}

#[derive(Deserialize)]
struct FindParams {
    places: Places,
    /// In `auto` order.
    browsers: Vec<Named>,
}

/// A browser found on disk: what the launch and the relay check need.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Found {
    id: Id,
    name: String,
    /// The `.app` bundle (macOS) or the exe (Windows).
    app: String,
    data_dir: String,
    extensions_url: String,
}

/// An installed browser with the state of its own relay extension copy.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    id: Id,
    name: String,
    relay_installed: bool,
    relay_connected: bool,
}

fn joined(root: &str, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(PathBuf::from(root), |path, part| path.join(part))
}

fn text(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// The first of `roots` holding `parts`, as a path that stats (a link is followed).
fn first_in(roots: &[String], parts: &[&str]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| joined(root, parts))
        .find(|candidate| std::fs::metadata(candidate).is_ok())
}

fn find_one(named: &Named, places: &Places) -> Option<Found> {
    let definition = named.id.definition();
    let (app, data_dir) = match places.platform.as_str() {
        "darwin" => (
            first_in(&places.app_dirs, &[definition.app?])?,
            joined(&places.home, &["Library", "Application Support"])
                .join(joined("", definition.mac_data)),
        ),
        "win32" => (
            first_in(&places.program_dirs, definition.exe?)?,
            joined(&places.local_app_data, definition.win_data?),
        ),
        _ => return None,
    };
    Some(Found {
        id: named.id,
        name: named.name.clone(),
        app: text(app),
        data_dir: text(data_dir),
        extensions_url: format!("{}://extensions", definition.scheme),
    })
}

/// The installed browsers of `browsers`, in their order.
fn find(params: &FindParams) -> Vec<Found> {
    params
        .browsers
        .iter()
        .filter_map(|named| find_one(named, &params.places))
        .collect()
}

/// File work on tokio's blocking pool.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The browser read panicked"))
}

/// Is `port`'s relay serving a connected extension? Stock answers `/json/version` 200 then, 503 while it waits. The
/// status line within 500 ms, as the TypeScript's `fetch` with its 500 ms signal; anything else is no.
async fn relay_connected(port: u16) -> bool {
    let probe = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .ok()?;
        let request = format!(
            "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut head = Vec::new();
        let mut chunk = [0_u8; 256];
        while !head.contains(&b'\n') && head.len() < 4096 {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            head.extend_from_slice(&chunk[..read]);
        }
        let line = head.split(|&byte| byte == b'\n').next()?;
        let mut words = line.split(|&byte| byte == b' ');
        Some(words.next()?.starts_with(b"HTTP/1.") && words.next()? == b"200")
    };
    matches!(
        tokio::time::timeout(Duration::from_millis(500), probe).await,
        Ok(Some(true))
    )
}

/// The installed browsers with the state of their own relay extension copy. The profiles are read first, then the
/// relays of the installed copies are asked together.
async fn status(params: FindParams) -> Result<Vec<Installed>, Fault> {
    let read = blocking(move || {
        find(&params)
            .into_iter()
            .map(|browser| {
                let dir = text(relay::extension_dir(&params.places.home, browser.id));
                let installed = relay::loaded_in(&browser.data_dir, &dir);
                let port = params
                    .browsers
                    .iter()
                    .find_map(|named| (named.id == browser.id).then_some(named.port))
                    .unwrap_or_default();
                (browser, installed, port)
            })
            .collect::<Vec<_>>()
    })
    .await?;
    let asks: Vec<_> = read
        .into_iter()
        .map(|(browser, relay_installed, port)| {
            tokio::spawn(async move {
                Installed {
                    id: browser.id,
                    name: browser.name,
                    relay_installed,
                    relay_connected: relay_installed && relay_connected(port).await,
                }
            })
        })
        .collect();
    let mut installed = Vec::with_capacity(asks.len());
    for ask in asks {
        installed.push(
            ask.await
                .map_err(|_| Fault::new("internal", "The relay probe panicked"))?,
        );
    }
    Ok(installed)
}

#[derive(Deserialize)]
struct OpenParams {
    /// The `.app` bundle (macOS) or the exe (Windows).
    app: String,
    url: String,
}

/// Starts the browser's exe at `url`, detached as node's `spawn(…, { detached: true })` started it, and out of the
/// job this process lives in (`sys.rs` `end_children_with_this_process`): a browser that was not running becomes the
/// browser the person keeps, which must outlive OMPdesk. The only start in this process that leaves the job. A job
/// around OMPdesk that forbids it fails the start as any other failed start, never runs the browser inside the job.
/// Answered once it started, not when it ends.
#[cfg(windows)]
async fn open(params: OpenParams, _scope: Scope) -> Result<(), Fault> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    // Its stdio is NUL (never this process's pipes, which std would otherwise duplicate for it), and nothing of main's
    // pipes is inheritable when it starts: a browser outliving this process must not keep main from seeing it end.
    static PIPES_KEPT: std::sync::Once = std::sync::Once::new();
    PIPES_KEPT.call_once(crate::sys::stdio_not_inherited);
    Command::new(&params.app)
        .arg(&params.url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .map(drop)
        .map_err(|error| {
            Fault::new(
                "spawn_failed",
                format!("spawn {} {}", params.app, crate::fs::error::uv_code(&error)),
            )
        })
}

/// `open -a <app> <url>`, answered once `open` exits, as `execFile` answered it.
#[cfg(not(windows))]
async fn open(params: OpenParams, scope: Scope) -> Result<(), Fault> {
    use crate::run::{Exec, Opts, Runner};

    let runner = Runner {
        bin: "open".to_owned(),
        args: Vec::new(),
        env: std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect(),
        timeout_ms: 30_000,
        max_bytes: 1024 * 1024,
    };
    let output = Exec::new(runner, scope, "open")
        .run(".", &["-a", &params.app, &params.url], Opts::default())
        .await?;
    if output.code != 0 {
        return Err(Fault::new(
            "open_failed",
            format!(
                "Command failed: open -a {} {}\n{}",
                params.app, params.url, output.stderr
            ),
        ));
    }
    Ok(())
}

pub fn register(registry: &mut Registry) {
    registry.add("browsers.find", |call| {
        Box::pin(async move {
            let params: FindParams = call.params()?;
            Reply::json(&blocking(move || find(&params)).await?)
        })
    });
    registry.add("browsers.status", |call| {
        Box::pin(async move { Reply::json(&status(call.params()?).await?) })
    });
    registry.add("browsers.installRelay", |call| {
        Box::pin(async move { Reply::json(&relay::install(call.params()?, call.scope).await?) })
    });
    registry.add("browsers.openExtensions", |call| {
        Box::pin(async move {
            open(call.params()?, call.scope).await?;
            Reply::json(&())
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_relay_is_connected_only_when_its_status_line_says_200() {
        async fn answering(status: &'static str) -> u16 {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 512];
                let _ = socket.read(&mut request).await;
                let _ = socket.write_all(status.as_bytes()).await;
            });
            port
        }
        assert!(
            relay_connected(answering("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await).await
        );
        assert!(
            !relay_connected(answering("HTTP/1.1 503 Service Unavailable\r\n\r\n").await).await
        );
        assert!(!relay_connected(answering("HTTP/1.1 2000 OK\r\n\r\n").await).await);
        // Nothing listening.
        let closed = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        assert!(!relay_connected(port).await);
    }

    #[tokio::test]
    async fn a_relay_that_never_answers_is_not_connected_after_half_a_second() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let held = tokio::spawn(async move {
            let accepted = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(accepted);
        });
        let started = std::time::Instant::now();
        assert!(!relay_connected(port).await);
        assert!(started.elapsed() < Duration::from_secs(2));
        held.abort();
    }
}
