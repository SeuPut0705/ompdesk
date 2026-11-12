//! The Node process that runs the TypeScript main (`out/main/index.js`), started with an open stdin pipe the shell
//! holds: Node exits when the shell dies and the pipe closes (the repo's child-process rule).

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::json;

use crate::log::log;

pub struct NodeChild {
    child: Child,
    _stdin: ChildStdin,
}

static NODE: Mutex<Option<NodeChild>> = Mutex::new(None);

/// Where `node` is: packaged `<resources>/node/node(.exe)`, else env `OMPDESK_NODE`, else `node` on PATH.
pub fn node_program(packaged: bool, resources: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if packaged {
        return resources.join("node").join(exe);
    }
    match std::env::var("OMPDESK_NODE") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from("node"),
    }
}

/// The main script: env `OMPDESK_APP_ENTRY` (an absolute path; the e2e harness runs pinned snapshots), else
/// `<appDir>/out/main/index.js`.
pub fn entry_script(app_dir: &Path) -> PathBuf {
    match std::env::var("OMPDESK_APP_ENTRY") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => app_dir.join("out").join("main").join("index.js"),
    }
}

pub fn spawn(
    program: &Path,
    entry: &Path,
    args: &[String],
    socket: &str,
    token: &str,
) -> io::Result<()> {
    let mut command = Command::new(program);
    if std::env::var("OMP_GUI_TEST_NODE_INSPECT").as_deref() == Ok("1") {
        command.arg("--inspect=127.0.0.1:0");
    }
    command
        .arg(entry)
        .args(args)
        .env("OMPDESK_SHELL_SOCKET", socket)
        .env("OMPDESK_SHELL_TOKEN", token)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window for the console-subsystem node.exe of a GUI app (CREATE_NO_WINDOW).
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("no stdin pipe"))?;
    log(
        "node.spawned",
        json!({ "pid": child.id(), "program": program.display().to_string(), "entry": entry.display().to_string() }),
    );
    *NODE.lock().unwrap() = Some(NodeChild {
        child,
        _stdin: stdin,
    });
    Ok(())
}

/// Waits for Node to end (on its own thread); `on_exit` gets its exit code (`None` when killed by a signal).
pub fn watch(on_exit: impl FnOnce(Option<i32>) + Send + 'static) {
    std::thread::Builder::new()
        .name("node-watch".into())
        .spawn(move || {
            // The child stays in NODE while we wait on a clone-free handle: poll its status.
            loop {
                let status = {
                    let mut guard = NODE.lock().unwrap();
                    match guard.as_mut() {
                        Some(node) => node.child.try_wait(),
                        None => return,
                    }
                };
                match status {
                    Ok(Some(status)) => return on_exit(status.code()),
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    Err(_) => return on_exit(None),
                }
            }
        })
        .expect("node watch thread");
}

/// Closes Node's stdin (it ends on its own) and, when it is still running after `grace`, kills it.
pub fn stop(grace: std::time::Duration) {
    let Some(mut node) = NODE.lock().unwrap().take() else {
        return;
    };
    drop(node._stdin);
    let deadline = std::time::Instant::now() + grace;
    while std::time::Instant::now() < deadline {
        if matches!(node.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = node.child.kill();
    let _ = node.child.wait();
}
