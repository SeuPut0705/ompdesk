//! The control socket itself (was the listening half of `src/main/control-socket/server.ts`): a Unix socket (owner
//! only) or a Windows named pipe, never TCP. It accepts connections up to a cap and serves each (`conn`).
//!
//! POSIX: a socket file already at the path is replaced only when nothing answers on it (a dead OMPdesk left it); a
//! live listener, or anything that is no socket, fails the start. The socket is made inside its owner-only folder and
//! then chmodded 0600. Closing removes only the socket file this listener made.
//!
//! Windows: the pipe's name is unguessable and new each launch (main names it). The first instance is created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a pipe somebody already made under that name fails the start instead of
//! sharing it, and every instance rejects remote clients.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

use super::conn::{self, Serving};
use crate::server::Fault;

/// Another process already listens on the socket path: this one does not start over it.
fn in_use(path: &str) -> Fault {
    Fault::new(
        "socket_in_use",
        format!("{path} is in use by another process"),
    )
}

/// A listener that takes connections until it is closed.
pub struct Listening {
    shutdown: watch::Sender<bool>,
    accepting: JoinHandle<()>,
    #[cfg(unix)]
    made: unix::Made,
}

impl Listening {
    /// Stops accepting, ends every connection and removes the socket file this listener made.
    pub async fn close(self) {
        self.shutdown.send_replace(true);
        let _ = self.accepting.await;
        #[cfg(unix)]
        self.made.remove();
    }
}

/// Connections being served, and how many of them count against the cap.
struct Serve {
    serving: Serving,
    max_connections: usize,
    live: Arc<AtomicUsize>,
    /// Numbers the connections: each one is its own caller.
    accepted: u64,
    shutdown: watch::Receiver<bool>,
    tasks: JoinSet<()>,
}

impl Serve {
    fn accept<R, W>(&mut self, reader: R, writer: W)
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
        W: tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        while self.tasks.try_join_next().is_some() {}
        let half_close = self.serving.half_close;
        if self.live.load(Ordering::SeqCst) >= self.max_connections {
            self.tasks.spawn(conn::turn_away(
                reader,
                writer,
                half_close,
                self.shutdown.clone(),
            ));
            return;
        }
        self.live.fetch_add(1, Ordering::SeqCst);
        self.accepted += 1;
        let serving = self.serving.clone();
        let number = self.accepted;
        let shutdown = self.shutdown.clone();
        let live = Arc::clone(&self.live);
        self.tasks.spawn(async move {
            conn::serve(serving, number, reader, writer, shutdown).await;
            live.fetch_sub(1, Ordering::SeqCst);
        });
    }

    /// The listener closed: every connection is ended and waited for.
    async fn end(mut self) {
        let ended = async { while self.tasks.join_next().await.is_some() {} };
        if tokio::time::timeout(conn::LINGER, ended).await.is_err() {
            self.tasks.abort_all();
        }
    }
}

/// Listens on `path` and returns once it takes connections.
pub async fn listen(
    path: &str,
    serving: Serving,
    max_connections: usize,
) -> Result<Listening, Fault> {
    let (shutdown, closed) = watch::channel(false);
    let serve = Serve {
        serving,
        max_connections,
        live: Arc::default(),
        accepted: 0,
        shutdown: closed.clone(),
        tasks: JoinSet::new(),
    };
    #[cfg(unix)]
    {
        let (listener, made) = unix::bind(path).await?;
        let accepting = tokio::spawn(unix::accept(listener, serve, closed));
        Ok(Listening {
            shutdown,
            accepting,
            made,
        })
    }
    #[cfg(windows)]
    {
        let first = windows::first_instance(path)?;
        let accepting = tokio::spawn(windows::accept(path.to_owned(), first, serve, closed));
        Ok(Listening {
            shutdown,
            accepting,
        })
    }
}

async fn until_closed(closed: &mut watch::Receiver<bool>) {
    let _ = closed.wait_for(|closed| *closed).await;
}

#[cfg(unix)]
mod unix {
    use std::io;
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::path::Path;

    use tokio::net::UnixListener;
    use tokio::sync::watch;

    use super::{Serve, in_use, until_closed};
    use crate::fs::error::{Codes, NodeError};
    use crate::server::Fault;

    const OWNER_ONLY_FILE: u32 = 0o600;

    /// The socket file this listener made, so closing removes only that one.
    pub struct Made {
        path: String,
        dev: u64,
        ino: u64,
    }

    impl Made {
        /// Removes the file while it is still the one made at listen: a socket another process put there since (a newer
        /// OMPdesk) is left alone.
        pub fn remove(&self) {
            let ours = std::fs::symlink_metadata(&self.path)
                .is_ok_and(|now| now.dev() == self.dev && now.ino() == self.ino);
            if ours {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }

    fn fault(error: &io::Error, syscall: &str, path: &str) -> Fault {
        NodeError::new(error, syscall, Some(path)).fault(Codes::None)
    }

    /// A socket file at `path` is replaced only when nobody answers on it (a dead OMPdesk left it). A live listener, or
    /// anything that is no socket, stops the start: never delete what another process serves.
    fn clear_stale(path: &str) -> Result<(), Fault> {
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return Ok(());
        };
        if !meta.file_type().is_socket() {
            return Err(in_use(path));
        }
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(_) => Err(in_use(path)),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                ) =>
            {
                match std::fs::remove_file(path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(fault(&error, "rm", path)),
                }
            }
            Err(_) => Err(in_use(path)),
        }
    }

    pub async fn bind(path: &str) -> Result<(UnixListener, Made), Fault> {
        let checked = path.to_owned();
        tokio::task::spawn_blocking(move || clear_stale(&checked))
            .await
            .map_err(|_| Fault::new("internal", "The stale socket check panicked"))??;
        // No process-wide umask here (the TypeScript set one around its listen): other requests write files and start
        // git on other threads meanwhile. The folder is this user's alone (`endpoint::prepare_dir`), so nobody else
        // reaches the file in the moment before it is 0600.
        let listener = UnixListener::bind(path).map_err(|error| fault(&error, "listen", path))?;
        std::fs::set_permissions(Path::new(path), PermissionsExt::from_mode(OWNER_ONLY_FILE))
            .map_err(|error| fault(&error, "chmod", path))?;
        let made = std::fs::symlink_metadata(path).map_err(|error| fault(&error, "lstat", path))?;
        Ok((
            listener,
            Made {
                path: path.to_owned(),
                dev: made.dev(),
                ino: made.ino(),
            },
        ))
    }

    pub async fn accept(
        listener: UnixListener,
        mut serve: Serve,
        mut closed: watch::Receiver<bool>,
    ) {
        loop {
            tokio::select! {
                () = until_closed(&mut closed) => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let (reader, writer) = stream.into_split();
                        serve.accept(reader, writer);
                    }
                    Err(error) => {
                        // Out of descriptors, or the connection was gone before it was taken: the next may work.
                        eprintln!("ompdesk-core: control socket accept failed: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                },
            }
        }
        drop(listener);
        serve.end().await;
    }
}

#[cfg(windows)]
mod windows {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use tokio::sync::watch;

    use super::{Serve, in_use, until_closed};
    use crate::server::Fault;

    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_PIPE_BUSY: i32 = 231;

    /// The pipe's first instance, which makes the name this process's: one already there fails.
    pub fn first_instance(path: &str) -> Result<NamedPipeServer, Fault> {
        ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(path)
            .map_err(|error| match error.raw_os_error() {
                Some(ERROR_ACCESS_DENIED | ERROR_PIPE_BUSY) => in_use(path),
                _ => Fault::new("io", format!("listen {path}: {error}")),
            })
    }

    pub async fn accept(
        path: String,
        mut listening: NamedPipeServer,
        mut serve: Serve,
        mut closed: watch::Receiver<bool>,
    ) {
        loop {
            let connected = tokio::select! {
                () = until_closed(&mut closed) => break,
                connected = listening.connect() => connected,
            };
            // The next instance exists before this one is served, so a client rarely finds none to connect to (one
            // that does gets "pipe busy" and tries again, as the CLI and node both do).
            let next = match ServerOptions::new()
                .reject_remote_clients(true)
                .create(&path)
            {
                Ok(next) => next,
                Err(error) => {
                    eprintln!("ompdesk-core: control socket stopped accepting: {error}");
                    break;
                }
            };
            let pipe = std::mem::replace(&mut listening, next);
            match connected {
                Ok(()) => {
                    let (reader, writer) = tokio::io::split(pipe);
                    serve.accept(reader, writer);
                }
                Err(error) => eprintln!("ompdesk-core: control socket accept failed: {error}"),
            }
        }
        drop(listening);
        serve.end().await;
    }
}
