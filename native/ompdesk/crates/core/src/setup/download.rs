//! A download main runs itself for an install (PortableGit, a gh/Node archive; was `src/main/setup/download.ts`), so
//! the setup screen can show real byte progress instead of a silent installer. The body streams to `<file>.part`, is
//! hashed on the way, and is renamed to `file` only when its SHA-256 equals the published one; any failure, or the
//! request's cancel, leaves nothing behind.
//!
//! The file is written by a thread of its own that this request joins on every path, so the `.part` file is closed
//! before it is removed (Windows refuses to delete an open one) and a slow disk backs the body up through a bounded
//! queue instead of memory. Progress is an event `setup.downloadProgress` `{id, received, total}`: the first at 0, one
//! every `PROGRESS_EVERY` while bytes arrived, and the last before the hash is checked.

use std::fs::File;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

use http_body_util::BodyExt;
use hyper::body::Bytes;
use hyper::header::CONTENT_LENGTH;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};

use super::net::{USER_AGENT, describe, routed};
use crate::fs::error::NodeError;
use crate::http::{self, Request};
use crate::server::{Call, Fault, Reply, Scope};

/// How often the bytes received so far are reported while they grow.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Chunks waiting for the disk.
const QUEUE: usize = 8;
/// `Number.isSafeInteger`'s ceiling: a larger announced length is no total.
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    /// Main's name for this download: what its progress events carry.
    id: u64,
    url: String,
    /// The published SHA-256, lowercase hex, compared as written.
    sha256: String,
    file: String,
    /// An `accept` header (the GitHub API's asset URL wants `application/octet-stream`).
    accept: Option<String>,
    mirror: Option<String>,
}

#[derive(Serialize)]
struct Progress {
    id: u64,
    received: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
struct Done {}

/// Why a download ended early.
enum Stop {
    Cancelled,
    Fault(Fault),
    /// The writer thread ended before the body did; its own error says why.
    WriterGone,
}

fn failed(message: String) -> Stop {
    Stop::Fault(Fault::new("download", message))
}

pub async fn handle(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let report = |received, total| {
        call.events.send(
            "setup.downloadProgress",
            &Progress {
                id: params.id,
                received,
                total,
            },
        )
    };
    verified(&params, &call.scope, &report).await?;
    Reply::json(&Done {})
}

pub(super) async fn fetch(
    download: &super::types::PlanDownload,
    mirror: Option<String>,
    scope: &Scope,
    report: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<(), Fault> {
    let params = Params {
        id: 0,
        url: download.url.clone(),
        sha256: download.sha256.clone(),
        file: download.file.clone(),
        accept: None,
        mirror,
    };
    verified(&params, scope, report).await
}

async fn verified(
    params: &Params,
    scope: &Scope,
    report: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<(), Fault> {
    let part = format!("{}.part", params.file);
    let mut created = false;
    let outcome = transfer(params, &part, scope, report, &mut created).await;
    if outcome.is_err() && created {
        let part = part.clone();
        let _ = blocking(move || std::fs::remove_file(part)).await;
    }
    match outcome {
        Ok(()) => Ok(()),
        Err(Stop::Cancelled) => Err(Fault::cancelled()),
        Err(Stop::Fault(fault)) => Err(fault),
        Err(Stop::WriterGone) => Err(Fault::new("download", format!("{part}: the file is gone"))),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(io::Error::other)?
}

/// The file's thread: chunks in, written in order. Its first error ends it and is the answer of `finish`.
struct Writer {
    chunks: Option<mpsc::Sender<Bytes>>,
    thread: Option<JoinHandle<io::Result<()>>>,
}

impl Writer {
    fn start(mut file: File) -> Writer {
        let (chunks, mut queue) = mpsc::channel::<Bytes>(QUEUE);
        let thread = tokio::task::spawn_blocking(move || {
            while let Some(chunk) = queue.blocking_recv() {
                file.write_all(&chunk)?;
            }
            file.flush()
        });
        Writer {
            chunks: Some(chunks),
            thread: Some(thread),
        }
    }

    /// Queues a chunk; false once the thread has ended.
    async fn write(&self, chunk: Bytes) -> bool {
        match &self.chunks {
            Some(chunks) => chunks.send(chunk).await.is_ok(),
            None => false,
        }
    }

    /// Ends the queue and waits until the thread wrote what it held and closed the file.
    async fn finish(&mut self) -> io::Result<()> {
        self.chunks = None;
        match self.thread.take() {
            Some(thread) => thread.await.map_err(io::Error::other)?,
            None => Ok(()),
        }
    }
}

fn write_failed(part: &str, error: &io::Error) -> Stop {
    failed(format!(
        "{part}: {}",
        NodeError::new(error, "write", None).message
    ))
}

async fn transfer(
    params: &Params,
    part: &str,
    scope: &Scope,
    report: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    created: &mut bool,
) -> Result<(), Stop> {
    let target = routed(&params.url, params.mirror.as_deref());
    let mut headers = vec![("user-agent", USER_AGENT)];
    if let Some(accept) = &params.accept {
        headers.push(("accept", accept.as_str()));
    }
    let request = Request {
        url: &target,
        headers: &headers,
        body: None,
    };
    let response = tokio::select! {
        biased;
        () = scope.on_cancel() => return Err(Stop::Cancelled),
        response = http::open(request) => response,
    }
    .map_err(|failure| failed(format!("{}: {}", params.url, describe(&failure))))?;
    let status = response.status().as_u16();
    // `204` and `205` carry no body, which `fetch` reports as no body to read.
    if !(200..300).contains(&status) || matches!(status, 204 | 205) {
        return Err(failed(format!("{} answered {status}", params.url)));
    }
    let total = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|length| length.to_str().ok())
        .and_then(|length| length.trim().parse::<u64>().ok())
        .filter(|length| (1..=MAX_SAFE).contains(length));

    let parent = Path::new(&params.file)
        .parent()
        .map(Path::to_path_buf)
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = parent {
        let shown = parent.display().to_string();
        blocking(move || std::fs::create_dir_all(parent))
            .await
            .map_err(|error| failed(NodeError::new(&error, "mkdir", Some(&shown)).message))?;
    }
    let path = part.to_owned();
    let file = blocking(move || File::create(path))
        .await
        .map_err(|error| {
            failed(format!(
                "{part}: {}",
                NodeError::new(&error, "open", Some(part)).message
            ))
        })?;
    *created = true;
    let mut writer = Writer::start(file);

    let streamed = stream(response.into_body(), &writer, params, total, scope, report).await;
    let closed = writer.finish().await;
    let (received, digest) = match (streamed, closed) {
        (Err(Stop::WriterGone), Err(error)) | (Ok(_), Err(error)) => {
            return Err(write_failed(part, &error));
        }
        (Err(stop), _) => return Err(stop),
        (Ok(done), Ok(())) => done,
    };
    report(received, total);
    let actual = crate::hex(&digest.finalize());
    if actual != params.sha256 {
        return Err(Stop::Fault(Fault::new(
            "checksum",
            format!("SHA-256 mismatch: expected {}, got {actual}", params.sha256),
        )));
    }
    let (from, to) = (part.to_owned(), params.file.clone());
    let moved = blocking(move || std::fs::rename(from, to)).await;
    moved.map_err(|error| {
        failed(NodeError::with_dest(&error, "rename", Some(part), Some(&params.file)).message)
    })?;
    *created = false;
    Ok(())
}

/// Reads the body into the writer, hashing as it goes and reporting progress; answers the bytes and their hash.
async fn stream(
    mut body: hyper::body::Incoming,
    writer: &Writer,
    params: &Params,
    total: Option<u64>,
    scope: &Scope,
    progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<(u64, Sha256), Stop> {
    let report = |received| progress(received, total);
    let mut hash = Sha256::new();
    let mut received = 0_u64;
    let mut reported = 0_u64;
    report(0);
    let mut tick = interval(PROGRESS_EVERY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        tokio::select! {
            biased;
            () = scope.on_cancel() => return Err(Stop::Cancelled),
            _ = tick.tick() => {
                if received != reported {
                    reported = received;
                    report(received);
                }
            }
            frame = body.frame() => {
                let Some(frame) = frame else { break };
                let frame = frame.map_err(|_| failed(format!("{}: the connection ended", params.url)))?;
                let Ok(chunk) = frame.into_data() else { continue };
                hash.update(&chunk);
                received += chunk.len() as u64;
                if !writer.write(chunk).await {
                    return Err(Stop::WriterGone);
                }
            }
        }
    }
    Ok((received, hash))
}
