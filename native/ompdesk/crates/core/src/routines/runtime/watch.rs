use std::path::{Path, PathBuf};

use tokio::sync::mpsc;

use crate::server::Fault;

pub(super) enum Event {
    Names(Vec<String>),
    Lost(String),
}

pub(super) trait Watch: Send {
    fn close(self) -> impl Future<Output = ()> + Send;
}

struct Root {
    directory: PathBuf,
    file: Option<String>,
}

fn root(path: &Path) -> Result<Root, Fault> {
    let meta =
        std::fs::metadata(path).map_err(|error| crate::disk::tree::fault(&error, "watch", path))?;
    if meta.is_dir() {
        return Ok(Root {
            directory: path.to_path_buf(),
            file: None,
        });
    }
    let actual = std::fs::canonicalize(path)
        .map_err(|error| crate::disk::tree::fault(&error, "watch", path))?;
    let file = actual
        .file_name()
        .ok_or_else(|| Fault::new("watch_failed", "The watched file has no name"))?
        .to_string_lossy()
        .into_owned();
    let directory = actual
        .parent()
        .ok_or_else(|| Fault::new("watch_failed", "The watched file has no parent"))?
        .to_path_buf();
    Ok(Root {
        directory,
        file: Some(file),
    })
}

#[cfg(any(windows, target_os = "macos"))]
struct Native<S: Send> {
    _source: S,
}

#[cfg(any(windows, target_os = "macos"))]
impl<S: Send> Watch for Native<S> {
    async fn close(self) {
        drop(self);
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub(super) async fn start(
    path: PathBuf,
    events: mpsc::UnboundedSender<Event>,
    _: std::time::Duration,
) -> Result<impl Watch, Fault> {
    tokio::task::spawn_blocking(move || {
        use crate::sessions::source::{self, Raw};
        let Root { directory, file } = root(&path)?;
        let source = source::start(&directory, move |raw| {
            let event = match raw {
                Raw::Names(mut names) => {
                    if let Some(file) = &file {
                        names.retain(|name| {
                            name == file
                                || (cfg!(windows) && name.eq_ignore_ascii_case(file))
                                || name.is_empty()
                        });
                    }
                    if names.is_empty() {
                        return;
                    }
                    Event::Names(names)
                }
                Raw::Anything => Event::Names(vec![String::new()]),
                Raw::Ended(error) => Event::Lost(error),
            };
            let _ = events.send(event);
        })
        .map_err(|error| crate::disk::tree::fault(&error, "watch", &path))?;
        Ok(Native { _source: source })
    })
    .await
    .map_err(|error| Fault::new("watch_failed", error.to_string()))?
}

#[cfg(not(any(windows, target_os = "macos")))]
struct Scan {
    scope: crate::server::Scope,
    task: Option<tokio::task::JoinHandle<()>>,
}

#[cfg(not(any(windows, target_os = "macos")))]
impl Drop for Scan {
    fn drop(&mut self) {
        self.scope.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
impl Watch for Scan {
    async fn close(mut self) {
        self.scope.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) async fn start(
    path: PathBuf,
    events: mpsc::UnboundedSender<Event>,
    period: std::time::Duration,
) -> Result<impl Watch, Fault> {
    use crate::routines::files;
    use crate::server::Scope;
    let Root { directory, file } = root(&path)?;
    drop(directory);
    let mut before = scan(path.clone(), usize::MAX).await?;
    let scope = Scope::detached();
    let running = scope.clone();
    let task = tokio::spawn(async move {
        loop {
            if !super::wait(&running, period).await {
                return;
            }
            let now = match scan(path.clone(), usize::MAX).await {
                Ok(now) => now,
                Err(error) => {
                    let _ = events.send(Event::Lost(error.message));
                    return;
                }
            };
            if running.cancelled() {
                return;
            }
            let mut names = files::changed_names(before.as_ref(), now.as_ref());
            if let Some(file) = &file {
                for name in &mut names {
                    if name.is_empty() {
                        name.clone_from(file);
                    }
                }
            }
            let missing = now.is_none();
            before = now;
            if !names.is_empty() {
                let _ = events.send(Event::Names(names));
            }
            if missing {
                let _ = events.send(Event::Lost("the watched path no longer exists".into()));
                return;
            }
        }
    });
    Ok(Scan {
        scope,
        task: Some(task),
    })
}

pub(super) async fn scan(
    path: PathBuf,
    max: usize,
) -> Result<Option<crate::routines::files::Listing>, Fault> {
    tokio::task::spawn_blocking(move || {
        crate::routines::files::scan(
            &path.to_string_lossy(),
            &[".git".into(), "node_modules".into()],
            max,
        )
    })
    .await
    .map_err(|error| Fault::new("scan_failed", error.to_string()))?
}
