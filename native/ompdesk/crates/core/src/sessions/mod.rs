//! The session index's own disk work (was the watch, the header read and the row rules of
//! `src/main/session-index.ts`): the one recursive watch of the sessions tree with its settle and its change events,
//! the legacy chat label read from a session file's head once per session id, and which rows of a list are kept.
//!
//! The list itself is not read here: main asks stock omp for it (`listAllSessions` in the stock helper) and hands this
//! side each row's path and id, in the list's order. Main also keeps the tombstones, the folder filter of a window's
//! list and the shared numbered copy, whose order and diff are the page's own code (`src/shared`).
//!
//! An index is named by main (`index`); its state here is made on first use and dropped by `sessions.close`. Events:
//! `sessions.watching` `{index, watching, missed}` when the tree's watch starts or ends, `sessions.changed`
//! `{index, names}` with the settled entries relative to the root, `names: null` when anything may have changed.

mod rules;
pub(crate) mod source;
mod watch;

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::server::{Call, Fault, Registry, Reply};
pub(crate) use watch::Report as NativeReport;
use watch::Report;
use watch::Watch;

/// How much of a session file is read for its header.
const HEAD_BYTES: u64 = 4096;
/// From this many unread headers on, they are read by several threads.
const PARALLEL_FROM: usize = 64;
const READERS: usize = 4;

/// A session file's legacy chat flag, with the session id its header named: a header never changes, so a list (asked
/// for after every settled append while an agent streams) reads each file's head once, not each time.
struct Legacy {
    id: String,
    chat: bool,
}

type LegacyFlags = Arc<Mutex<HashMap<String, Legacy>>>;

#[derive(Default)]
pub(crate) struct NativeIndex {
    legacy: LegacyFlags,
    watch: Option<Watch>,
}

static INDEXES: LazyLock<Mutex<HashMap<String, NativeIndex>>> = LazyLock::new(Default::default);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl NativeIndex {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn watch(
        &mut self,
        root: PathBuf,
        report: impl Fn(NativeReport) + Send + Sync + 'static,
    ) {
        let flags = Arc::clone(&self.legacy);
        let folder = root.clone();
        self.watch = Some(watch::spawn(root, move |event| {
            if let Report::Changed(settled) = &event {
                let mut flags = locked(&flags);
                for entry in settled.iter().filter(|entry| entry.gone) {
                    flags.remove(folder.join(&entry.name).to_string_lossy().as_ref());
                }
            }
            report(event);
        }));
    }

    pub(crate) fn listed(&self, rows: &[(String, String)]) -> Vec<(usize, bool)> {
        listed_rows(&self.legacy, rows.len(), |at| (&rows[at].0, &rows[at].1))
            .into_iter()
            .map(|row| (row.row, row.chat))
            .collect()
    }

    pub(crate) fn kind(path: &str) -> Option<bool> {
        legacy_chat(path)
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("sessions.watch", |call| {
        Box::pin(async move { watch(&call) })
    });
    registry.add("sessions.close", |call| {
        Box::pin(async move { close(&call) })
    });
    registry.add("sessions.listed", |call| {
        Box::pin(blocking(move || listed(call.params()?)))
    });
    registry.add("sessions.kind", |call| {
        Box::pin(blocking(move || kind(&call.params()?)))
    });
}

async fn blocking(
    work: impl FnOnce() -> Result<Reply, Fault> + Send + 'static,
) -> Result<Reply, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The session read panicked"))?
}

#[derive(Deserialize)]
struct WatchParams {
    index: String,
    /// The sessions root, absolute, as main's `path.resolve` spells it.
    root: String,
}

#[derive(Serialize)]
struct Watching<'a> {
    index: &'a str,
    watching: bool,
    missed: bool,
}

#[derive(Serialize)]
struct Changed<'a> {
    index: &'a str,
    names: Option<Vec<String>>,
}

#[derive(Serialize)]
struct Done {}

/// Starts the index's watch of `root` (in place of the one it had). It answers at once; the watch says when it began
/// (`sessions.watching`), which for a root that is not there yet is when it is made.
fn watch(call: &Call) -> Result<Reply, Fault> {
    let params: WatchParams = call.params()?;
    let mut indexes = locked(&INDEXES);
    let index = indexes.entry(params.index.clone()).or_default();
    let events = call.events.clone();
    let root = PathBuf::from(&params.root);
    let name = params.index;
    index.watch(root, move |report| match report {
        Report::Watching { missed } => events.send(
            "sessions.watching",
            &Watching {
                index: &name,
                watching: true,
                missed,
            },
        ),
        Report::Unwatched => events.send(
            "sessions.watching",
            &Watching {
                index: &name,
                watching: false,
                missed: false,
            },
        ),
        Report::Anything => events.send(
            "sessions.changed",
            &Changed {
                index: &name,
                names: None,
            },
        ),
        Report::Changed(settled) => {
            let names = settled.into_iter().map(|entry| entry.name).collect();
            events.send(
                "sessions.changed",
                &Changed {
                    index: &name,
                    names: Some(names),
                },
            );
        }
    });
    Reply::json(&Done {})
}

#[derive(Deserialize)]
struct CloseParams {
    index: String,
}

/// Stops the index's watch and forgets what was read for it.
fn close(call: &Call) -> Result<Reply, Fault> {
    let params: CloseParams = call.params()?;
    locked(&INDEXES).remove(&params.index);
    Reply::json(&Done {})
}

#[derive(Deserialize)]
struct ListedParams {
    index: String,
    /// Every row of the list stock answered, in the list's order (newest first).
    rows: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    path: String,
    id: String,
}

#[derive(Serialize)]
struct ListedRow {
    /// The row's place in `rows`.
    row: usize,
    /// Whether its file's header carries the legacy chat flag.
    chat: bool,
}

#[derive(Serialize)]
struct Listed {
    listed: Vec<ListedRow>,
}

/// The rows the list keeps (one per session id), each with its legacy chat flag, read from the file only the first
/// time this session is listed at that path.
fn listed(params: ListedParams) -> Result<Reply, Fault> {
    let flags = Arc::clone(&locked(&INDEXES).entry(params.index).or_default().legacy);
    let listed = listed_rows(&flags, params.rows.len(), |at| {
        (&params.rows[at].path, &params.rows[at].id)
    });
    Reply::json(&Listed { listed })
}

fn listed_rows<'a>(
    flags: &LegacyFlags,
    length: usize,
    row_at: impl Fn(usize) -> (&'a str, &'a str),
) -> Vec<ListedRow> {
    let kept = rules::first_of_each_id((0..length).map(|at| row_at(at).1));
    let mut listed: Vec<ListedRow> = Vec::with_capacity(kept.len());
    let mut unread = Vec::new();
    {
        let known = locked(flags);
        for row in kept {
            let (path, id) = row_at(row);
            let chat = match known.get(path) {
                Some(legacy) if legacy.id == id => legacy.chat,
                _ => {
                    unread.push(listed.len());
                    false
                }
            };
            listed.push(ListedRow { row, chat });
        }
    }
    let read: Vec<Option<bool>> = {
        let paths: Vec<&str> = unread.iter().map(|at| row_at(listed[*at].row).0).collect();
        read_flags(&paths)
    };
    let mut known = locked(flags);
    for (at, chat) in unread.into_iter().zip(read) {
        // No header read (unreadable, or not written yet): asked again next time.
        let Some(chat) = chat else { continue };
        let (path, id) = row_at(listed[at].row);
        known.insert(
            path.to_owned(),
            Legacy {
                id: id.to_owned(),
                chat,
            },
        );
        listed[at].chat = chat;
    }
    drop(known);
    listed
}

/// Each file's legacy chat flag, in order; a first list of many sessions reads them on a few threads.
fn read_flags(paths: &[&str]) -> Vec<Option<bool>> {
    if paths.len() < PARALLEL_FROM {
        return paths.iter().map(|path| legacy_chat(path)).collect();
    }
    let share = paths.len().div_ceil(READERS);
    std::thread::scope(|scope| {
        let readers: Vec<_> = paths
            .chunks(share)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|path| legacy_chat(path))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        readers
            .into_iter()
            .flat_map(|reader| reader.join().unwrap_or_default())
            .collect()
    })
}

/// The legacy chat flag of the session file at `path`; `None` when no header was read (missing, unreadable, none in
/// its head).
fn legacy_chat(path: &str) -> Option<bool> {
    let mut head = Vec::new();
    File::open(Path::new(path))
        .ok()?
        .take(HEAD_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    rules::legacy_chat(&head)
}

#[derive(Deserialize)]
struct KindParams {
    path: String,
}

#[derive(Serialize)]
struct Kind {
    chat: Option<bool>,
}

/// One session file's legacy chat flag, read now.
fn kind(params: &KindParams) -> Result<Reply, Fault> {
    Reply::json(&Kind {
        chat: legacy_chat(&params.path),
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-core-sessions-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn listed_rows(index: &str, rows: &[(&Path, &str)]) -> Vec<(usize, bool)> {
        let params = ListedParams {
            index: index.to_owned(),
            rows: rows
                .iter()
                .map(|(path, id)| Row {
                    path: path.to_string_lossy().into_owned(),
                    id: (*id).to_owned(),
                })
                .collect(),
        };
        let reply = listed(params).unwrap();
        let value: serde_json::Value = serde_json::from_str(reply.result.get()).unwrap();
        value["listed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    usize::try_from(row["row"].as_u64().unwrap()).unwrap(),
                    row["chat"].as_bool().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn reads_a_header_once_per_session_id_and_keeps_one_row_of_each_id() {
        let dir = temp("listed");
        let chat = dir.join("chat.jsonl");
        let agent = dir.join("agent.jsonl");
        let copy = dir.join("copy.jsonl");
        let header = |id: &str, kind: &str| {
            format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\"{kind}}}\n")
        };
        std::fs::write(&chat, header("chat-one", ",\"kind\":\"chat\"")).unwrap();
        std::fs::write(
            &agent,
            format!(
                "{{\"type\":\"title\",\"title\":\"\"}}\n{}",
                header("agent-one", "")
            ),
        )
        .unwrap();
        std::fs::write(&copy, header("chat-one", "")).unwrap();
        let missing = dir.join("missing.jsonl");
        let rows: [(&Path, &str); 5] = [
            (&chat, "chat-one"),
            (&agent, "agent-one"),
            (&copy, "chat-one"),
            (&missing, "missing"),
            (&agent, ""),
        ];
        assert_eq!(
            listed_rows("unit-listed", &rows),
            [(0, true), (1, false), (3, false)]
        );
        // The same session's header is not read again.
        std::fs::write(&chat, header("chat-one", "")).unwrap();
        assert_eq!(listed_rows("unit-listed", &rows[..1]), [(0, true)]);
        // Another session at that path is, and so is a file whose header could not be read before.
        std::fs::write(&chat, header("agent-two", "")).unwrap();
        std::fs::write(&missing, header("missing", ",\"kind\":\"chat\"")).unwrap();
        assert_eq!(
            listed_rows(
                "unit-listed",
                &[(&chat, "agent-two"), (&missing, "missing")]
            ),
            [(0, false), (1, true)]
        );
        // Another index reads for itself.
        assert_eq!(
            listed_rows("unit-listed-other", &[(&chat, "chat-one")]),
            [(0, false)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_many_headers_in_order() {
        let dir = temp("many");
        let paths: Vec<PathBuf> = (0..200)
            .map(|n| {
                let path = dir.join(format!("{n}.jsonl"));
                let kind = if n % 3 == 0 { ",\"kind\":\"chat\"" } else { "" };
                std::fs::write(&path, format!("{{\"type\":\"session\"{kind}}}\n")).unwrap();
                path
            })
            .collect();
        let ids: Vec<String> = (0..200).map(|n| format!("id-{n}")).collect();
        let rows: Vec<(&Path, &str)> = paths
            .iter()
            .zip(&ids)
            .map(|(path, id)| (path.as_path(), id.as_str()))
            .collect();
        let expected: Vec<(usize, bool)> = (0..200).map(|n| (n, n % 3 == 0)).collect();
        assert_eq!(listed_rows("unit-many", &rows), expected);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Over the wire: the watch outlives the request that started it, its events name the index, and a watch left
    /// running does not keep the server from ending with its input.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_watch_reports_as_events_and_ends_with_the_connection() {
        let root = temp("wire");
        std::fs::create_dir_all(root.join("p")).unwrap();
        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(crate::serve(server_read, server_write, crate::registry()));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read).lines();
        let request = serde_json::json!({
            "id": 1,
            "method": "sessions.watch",
            "params": { "index": "unit-wire", "root": root.to_string_lossy() },
        });
        client_write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let mut next = async || -> serde_json::Value {
            let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
                .await
                .expect("a frame in time")
                .unwrap()
                .expect("the connection is open");
            serde_json::from_str(&line).unwrap()
        };
        let mut watching = false;
        let mut answered = false;
        let mut round = 0;
        let mut named = false;
        while !named {
            if watching && answered {
                round += 1;
                std::fs::write(root.join("p").join("a.jsonl"), "{}\n".repeat(round)).unwrap();
            }
            let frame = if watching && answered {
                match tokio::time::timeout(Duration::from_secs(1), next()).await {
                    Ok(frame) => frame,
                    Err(_) => continue,
                }
            } else {
                next().await
            };
            if frame["id"] == 1 {
                assert_eq!(frame["ok"], true, "{frame}");
                answered = true;
            } else if frame["event"] == "sessions.watching" {
                assert_eq!(
                    frame["data"],
                    serde_json::json!({ "index": "unit-wire", "watching": true, "missed": false })
                );
                watching = true;
            } else if frame["event"] == "sessions.changed" {
                assert_eq!(frame["data"]["index"], "unit-wire");
                let names = frame["data"]["names"].as_array().unwrap();
                named = names
                    .iter()
                    .any(|name| name.as_str().is_some_and(|name| name.ends_with("a.jsonl")));
            }
        }
        client_write.shutdown().await.unwrap();
        drop(client_write);
        tokio::time::timeout(Duration::from_secs(30), server)
            .await
            .expect("the server ends with its input while a watch still runs")
            .unwrap()
            .unwrap();
        locked(&INDEXES).remove("unit-wire");
        let _ = std::fs::remove_dir_all(&root);
    }
}
