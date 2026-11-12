//! One ssh that stays: a port forward or a server's port watch (were the processes `service.ts` kept under the setup
//! supervisor). It runs until it ends by itself or is asked to: on POSIX it gets SIGTERM and is killed `KILL_GRACE`
//! later, as every process of the core is; on Windows its whole tree ends at once (`sys::ProcessTree`, as the
//! supervisor swept it), because ending ssh.exe alone would leave what it started. It never outlives the core: the
//! core's job object (Windows), its process group (POSIX, which main kills) and `kill_on_drop` see to that.

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Notify;

use super::rules;
use crate::run::{KILL_GRACE, Runner};

/// How often a forward that is starting looks whether its local port accepts.
const PROBE: Duration = Duration::from_millis(400);
/// stderr kept for the reason an ssh ended: its end, where ssh says why.
const STDERR_KEPT: usize = 8000;
/// A listing that has not ended by here is dropped.
const LISTING_LIMIT: usize = 1024 * 1024;

/// What ends with the process when it is asked to end.
#[cfg(windows)]
struct Tree(Option<crate::sys::ProcessTree>);
#[cfg(unix)]
struct Tree;

#[cfg(windows)]
impl Tree {
    /// The child and whatever it starts from now on; without a job (the system refused one) the child alone.
    fn of(child: &Child) -> Tree {
        Tree(
            child
                .raw_handle()
                .and_then(|process| crate::sys::ProcessTree::of(process).ok()),
        )
    }

    fn end(&self, child: &mut Child) {
        match &self.0 {
            Some(tree) => tree.end(),
            None => {
                let _ = child.start_kill();
            }
        }
    }

    /// Resolves once nothing of the tree runs (what the process started holds its ports a moment longer than the
    /// process itself), or `KILL_GRACE` passed; dropping the tree then ends what is left.
    async fn gone(&self) {
        let Some(tree) = &self.0 else { return };
        let _ = tokio::time::timeout(KILL_GRACE, async {
            while tree.alive() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
    }
}

#[cfg(unix)]
impl Tree {
    fn of(_child: &Child) -> Tree {
        Tree
    }

    fn end(&self, child: &mut Child) {
        if let Some(pid) = child.id() {
            crate::sys::terminate(pid);
        }
    }

    async fn gone(&self) {}
}

/// An ssh that was started.
pub struct Running {
    child: Child,
    tree: Tree,
    stdout: ChildStdout,
    stderr: ChildStderr,
}

/// Starts `runner`'s program with `args` and `env` over the runner's environment: no shell, no stdin.
pub fn start(runner: &Runner, args: &[String], env: &[(String, String)]) -> io::Result<Running> {
    let mut command = Command::new(&runner.bin);
    command
        .args(&runner.args)
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let env: Vec<(&str, &str)> = env
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    runner.environment(&mut command, &env);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    let tree = Tree::of(&child);
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(io::Error::other("the process's pipes were not open"));
    };
    Ok(Running {
        child,
        tree,
        stdout,
        stderr,
    })
}

impl Running {
    /// A forward: `up` is called once, when `port` first accepts a connection. Resolves with the end of ssh's stderr
    /// once the ssh exited.
    pub async fn forward(self, stop: &Notify, port: u16, up: impl FnOnce()) -> String {
        let Running {
            child,
            tree,
            stdout,
            stderr,
        } = self;
        let kept = Mutex::new(Vec::new());
        {
            let ended = finish(end(child, tree, stop), async {
                tokio::join!(keep_end(stderr, &kept), drain(stdout));
            });
            let accepting = accepts(port);
            tokio::pin!(ended, accepting);
            tokio::select! {
                () = &mut ended => {}
                () = &mut accepting => {
                    up();
                    ended.await;
                }
            }
        }
        text(kept)
    }

    /// A port watch: `listed` hears a listing's ports, and which of them were not in the first listing, whenever
    /// they differ from the listing before. Resolves with the end of ssh's stderr once the ssh exited.
    pub async fn watch(self, stop: &Notify, mut listed: impl FnMut(&[u16], &[u16])) -> String {
        let Running {
            child,
            tree,
            stdout,
            stderr,
        } = self;
        let kept = Mutex::new(Vec::new());
        finish(end(child, tree, stop), async {
            tokio::join!(keep_end(stderr, &kept), listings(stdout, &mut listed));
        })
        .await;
        text(kept)
    }
}

fn text(kept: Mutex<Vec<u8>>) -> String {
    let kept = kept
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    String::from_utf8_lossy(&kept).into_owned()
}

/// Waits for the process; asked to stop, ends it (`Tree::end`), kills it `KILL_GRACE` later, and waits until it is
/// gone.
async fn end(mut child: Child, tree: Tree, stop: &Notify) {
    tokio::select! {
        _ = child.wait() => {}
        () = stop.notified() => {
            tree.end(&mut child);
            if tokio::time::timeout(KILL_GRACE, child.wait()).await.is_err() {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
    }
    tree.gone().await;
}

/// The process's end and the end of what it wrote. Something it started may hold its pipes open after it: the reading
/// stops `KILL_GRACE` after the exit.
async fn finish(exit: impl Future<Output = ()>, reading: impl Future<Output = ()>) {
    tokio::pin!(exit, reading);
    tokio::select! {
        () = &mut reading => exit.await,
        () = &mut exit => {
            let _ = tokio::time::timeout(KILL_GRACE, reading).await;
        }
    }
}

/// Reads `pipe` to its end, keeping its last `STDERR_KEPT` bytes in `kept`.
async fn keep_end(mut pipe: impl AsyncRead + Unpin, kept: &Mutex<Vec<u8>>) {
    let mut chunk = vec![0; 16 * 1024];
    while let Ok(read) = pipe.read(&mut chunk).await
        && read > 0
    {
        let mut kept = kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        kept.extend_from_slice(&chunk[..read]);
        let over = kept.len().saturating_sub(STDERR_KEPT);
        kept.drain(..over);
    }
}

async fn drain(mut pipe: impl AsyncRead + Unpin) {
    let mut chunk = vec![0; 16 * 1024];
    while let Ok(read) = pipe.read(&mut chunk).await
        && read > 0
    {}
}

/// Resolves once this computer's `port` accepts a connection, asked every `PROBE`.
async fn accepts(port: u16) {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    loop {
        tokio::time::sleep(PROBE).await;
        let connecting = tokio::net::TcpStream::connect(address);
        if matches!(tokio::time::timeout(PROBE, connecting).await, Ok(Ok(_))) {
            return;
        }
    }
}

async fn listings(mut pipe: impl AsyncRead + Unpin, listed: &mut impl FnMut(&[u16], &[u16])) {
    let mut reader = Listings::default();
    let mut chunk = vec![0; 16 * 1024];
    while let Ok(read) = pipe.read(&mut chunk).await
        && read > 0
    {
        reader.push(&chunk[..read], listed);
    }
}

/// The watch's output as it arrives: each listing ends with `rules::LISTING_END`.
#[derive(Default)]
struct Listings {
    unread: Vec<u8>,
    /// The ports last told.
    told: Option<Vec<u16>>,
    /// The first listing: what was open when the watch began.
    first: Option<Vec<u16>>,
}

impl Listings {
    fn push(&mut self, bytes: &[u8], listed: &mut impl FnMut(&[u16], &[u16])) {
        let end = rules::LISTING_END.as_bytes();
        self.unread.extend_from_slice(bytes);
        while let Some(at) = self
            .unread
            .windows(end.len())
            .position(|window| window == end)
        {
            let ports = rules::listening_ports(&String::from_utf8_lossy(&self.unread[..at]));
            self.unread.drain(..at + end.len());
            // Most listings repeat the last one: nothing to tell.
            if self.told.as_ref() == Some(&ports) {
                continue;
            }
            let first = self.first.get_or_insert_with(|| ports.clone());
            let opened: Vec<u16> = ports
                .iter()
                .copied()
                .filter(|port| !first.contains(port))
                .collect();
            listed(&ports, &opened);
            self.told = Some(ports);
        }
        if self.unread.len() > LISTING_LIMIT {
            self.unread.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_listing_only_when_it_differs_and_names_what_opened_since_the_first() {
        let mut told: Vec<(Vec<u16>, Vec<u16>)> = Vec::new();
        let mut listed =
            |ports: &[u16], opened: &[u16]| told.push((ports.to_vec(), opened.to_vec()));
        let mut listings = Listings::default();
        let row = |ports: &[u16]| {
            let lines: Vec<String> = ports
                .iter()
                .map(|port| format!("LISTEN 0 4096 127.0.0.1:{port} 0.0.0.0:*"))
                .collect();
            format!("{}\n__ompdesk_ports__\n", lines.join("\n"))
        };
        // A listing split across reads, in the middle of its end mark too.
        let first = row(&[22, 3000]);
        let (head, tail) = first.split_at(first.len() - 9);
        listings.push(head.as_bytes(), &mut listed);
        listings.push(tail.as_bytes(), &mut listed);
        // The same again, twice in one read: nothing to tell.
        listings.push(
            format!("{}{}", row(&[3000, 22]), row(&[22, 3000])).as_bytes(),
            &mut listed,
        );
        listings.push(row(&[22, 3000, 5173]).as_bytes(), &mut listed);
        listings.push(row(&[5173]).as_bytes(), &mut listed);
        listings.push(row(&[]).as_bytes(), &mut listed);
        listings.push(row(&[22, 8080]).as_bytes(), &mut listed);
        // Output without an end mark is dropped once it is too long, and the watch reads on.
        listings.push(&vec![b'x'; LISTING_LIMIT + 1], &mut listed);
        listings.push(row(&[22]).as_bytes(), &mut listed);
        let expected: [(&[u16], &[u16]); 6] = [
            (&[22, 3000], &[]),
            (&[22, 3000, 5173], &[5173]),
            (&[5173], &[5173]),
            (&[], &[]),
            (&[22, 8080], &[8080]),
            (&[22], &[]),
        ];
        let told: Vec<(&[u16], &[u16])> = told
            .iter()
            .map(|(ports, opened)| (ports.as_slice(), opened.as_slice()))
            .collect();
        assert_eq!(told, expected);
    }

    #[tokio::test]
    async fn keeps_the_end_of_what_a_process_wrote() {
        let kept = Mutex::new(Vec::new());
        let written = format!("{}the reason it ended\n", "noise\n".repeat(4000));
        keep_end(written.as_bytes(), &kept).await;
        let kept = text(kept);
        assert_eq!(kept.len(), STDERR_KEPT);
        assert!(kept.ends_with("noise\nthe reason it ended\n"));
        assert_eq!(
            rules::classify_failure(&kept).message,
            "the reason it ended"
        );
    }
}
