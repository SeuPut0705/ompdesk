use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::{
    Config, Sink,
    watch::{self, Event, Watch},
};
use crate::routines::{files, text::clip};
use crate::server::{Fault, Scope};

const LISTING_MAX: usize = 2_000;
const PATHS_MAX: usize = 1_000;
const SHOWN_MAX: usize = 10;

type Listing = Option<files::Listing>;
type Scan = JoinHandle<Result<Listing, Fault>>;

struct Burst {
    names: Vec<String>,
    seen: HashSet<String>,
    first: Option<Instant>,
    due: Option<Instant>,
}

impl Burst {
    fn new() -> Self {
        Self {
            names: Vec::new(),
            seen: HashSet::new(),
            first: None,
            due: None,
        }
    }
    fn note(&mut self, name: String, now: Instant, config: Config) {
        if self.names.len() >= PATHS_MAX {
            return;
        }
        let first = *self.first.get_or_insert(now);
        if self.seen.insert(name.clone()) {
            self.names.push(name);
        }
        self.due = Some((now + config.file_debounce).min(first + config.file_max_wait));
    }
    fn take(&mut self, path: &str) -> Option<String> {
        self.due = None;
        self.first = None;
        self.seen.clear();
        let names = std::mem::take(&mut self.names);
        if names.is_empty() {
            return None;
        }
        let listed: Vec<&str> = names
            .iter()
            .map(String::as_str)
            .filter(|name| !name.is_empty())
            .collect();
        if listed.is_empty() {
            return Some(format!("Something under {path} changed"));
        }
        let shown: Vec<String> = listed
            .iter()
            .take(SHOWN_MAX)
            .map(|name| clip(name, 200))
            .collect();
        let more = listed.len().saturating_sub(SHOWN_MAX);
        Some(format!(
            "{} changed{}",
            shown.join(", "),
            if more > 0 {
                format!(", and {more} more")
            } else {
                String::new()
            }
        ))
    }
}

pub(super) async fn run<C: Sink>(
    path: String,
    mark: Option<Value>,
    sink: C,
    scope: &Scope,
    config: Config,
) {
    let (events, mut changes) = mpsc::unbounded_channel();
    let mut watcher = None;
    let mut retry = Some(Instant::now());
    let mut list_due = Some(Instant::now());
    let mut listing: Option<Scan> = None;
    let mut again = false;
    let mut before = files::parse_mark(mark.as_ref());
    let mut burst = Burst::new();
    let watch_key = format!("files {path}: watch");
    let list_key = format!("files {path}: list");
    loop {
        if scope.cancelled() || !sink.current() {
            break;
        }
        let now = Instant::now();
        if retry.is_some_and(|at| at <= now) {
            retry = None;
            if let Some(old) = watcher.take() {
                Watch::close(old).await;
            }
            match watch::start(PathBuf::from(&path), events.clone(), config.scan_poll).await {
                Ok(attached) => {
                    sink.failure(&watch_key, None);
                    watcher = Some(attached);
                }
                Err(error) => {
                    sink.failure(&watch_key, Some(&error.message));
                    retry = Some(Instant::now() + config.file_retry);
                }
            }
        }
        if list_due.is_some_and(|at| at <= Instant::now()) {
            list_due = None;
            if listing.is_some() {
                again = true;
            } else {
                let path = PathBuf::from(&path);
                listing = Some(tokio::spawn(watch::scan(path, LISTING_MAX)));
            }
        }
        if burst.due.is_some_and(|at| at <= Instant::now()) {
            let line = burst.take(&path);
            if !sink.quiet()
                && let Some(line) = line
            {
                sink.publish(None, &[line]);
            }
        }
        let deadline = retry.into_iter().chain(list_due).chain(burst.due).min();
        tokio::select! {
            biased;
            _ = scope.on_cancel() => break,
            result = scan_result(&mut listing) => {
                listing.take();
                if scope.cancelled() || !sink.current() { break; }
                match result {
                    Ok(current) => {
                        sink.failure(&list_key, None);
                        sink.publish(Some(json!({"listing":current})), &[]);
                        if let Some(previous) = before.take() && !sink.quiet() {
                            for name in files::changed_names(previous.as_ref(), current.as_ref()) { burst.note(name, Instant::now(), config); }
                        }
                    }
                    Err(error) => sink.failure(&list_key, Some(&error.message)),
                }
                if again { again = false; list_due = Some(Instant::now()); }
            }
            event = changes.recv() => match event {
                Some(Event::Lost(error)) => {
                    if let Some(old) = watcher.take() { Watch::close(old).await; }
                    sink.failure(&watch_key, Some(&error));
                    retry = Some(Instant::now() + config.file_retry);
                }
                Some(Event::Names(names)) => {
                    for name in names {
                        let name = name.replace('\\', "/");
                        if name.split('/').any(|part| matches!(part, ".git" | "node_modules")) { continue; }
                        list_due = Some(Instant::now() + config.file_debounce);
                        if !sink.quiet() { burst.note(name, Instant::now(), config); }
                    }
                }
                None => break,
            },
            _ = until(deadline) => {}
        }
    }
    drop(changes);
    if let Some(watcher) = watcher {
        Watch::close(watcher).await;
    }
    if let Some(listing) = listing {
        let _ = listing.await;
    }
}

async fn until(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline).await;
    } else {
        std::future::pending::<()>().await;
    }
}

async fn scan_result(task: &mut Option<Scan>) -> Result<Listing, Fault> {
    match task {
        Some(task) => task
            .await
            .map_err(|error| Fault::new("scan_failed", error.to_string()))?,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn a_burst_keeps_order_deduplicates_and_bounds_a_steady_stream() {
        let config = Config::default();
        let start = Instant::now();
        let mut burst = Burst::new();
        burst.note("a.txt".into(), start, config);
        burst.note("a.txt".into(), start, config);
        for seconds in 1..10 {
            burst.note(
                format!("b{seconds}.txt"),
                start + std::time::Duration::from_secs(seconds),
                config,
            );
        }
        assert_eq!(burst.due, Some(start + config.file_max_wait));
        assert_eq!(
            burst.take("/work").unwrap(),
            "a.txt, b1.txt, b2.txt, b3.txt, b4.txt, b5.txt, b6.txt, b7.txt, b8.txt, b9.txt changed"
        );
        assert!(burst.take("/work").is_none());
    }
}
