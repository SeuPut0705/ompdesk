use super::*;
use serde_json::json;
use std::sync::mpsc;

struct TestHandler {
    events: mpsc::Sender<String>,
}

impl Handler for TestHandler {
    fn event(&self, name: String, _: Value, _: Option<Vec<u8>>) {
        let _ = self.events.send(name);
    }
    fn request(&self, call: Call) {
        assert_eq!(call.method, "native.test");
        call.ok(json!({"answered": true}), Some(vec![9, 0, 8]));
    }
    fn cancel(&self, id: u64) {
        let _ = self.events.send(format!("cancel:{id}"));
    }
    fn disconnected(&self) {
        let _ = self.events.send("disconnected".into());
    }
}

#[cfg(unix)]
fn start(script: &str) -> (Arc<Core>, mpsc::Receiver<String>) {
    let (events, received) = mpsc::channel();
    let config = Config {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        env: BTreeMap::new(),
    };
    (
        Core::spawn(config, Arc::new(TestHandler { events })).unwrap(),
        received,
    )
}

#[cfg(unix)]
#[test]
fn binary_and_bidirectional_request() {
    let (core, events) = start(concat!(
        "printf '{\"event\":\"ready\",\"data\":{\"protocol\":1}}\\n'; ",
        "IFS= read -r line; dd bs=1 count=3 of=/dev/null 2>/dev/null; ",
        "printf '{\"id\":41,\"method\":\"native.test\",\"params\":{}}\\n'; ",
        "IFS= read -r line; dd bs=1 count=3 of=/dev/null 2>/dev/null; ",
        "printf '{\"id\":1,\"ok\":true,\"result\":{\"done\":true},\"bin\":3}\\n\\001\\000\\377'; ",
        "cat >/dev/null"
    ));
    assert_eq!(
        events.recv_timeout(Duration::from_secs(5)).unwrap(),
        "ready"
    );
    let (tx, rx) = mpsc::channel();
    core.request(
        "test",
        json!({}),
        Some(vec![1, 0, 255]),
        Duration::from_secs(5),
        move |result, bin| {
            tx.send((result, bin)).unwrap();
        },
    );
    let (result, bin) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(result.unwrap(), json!({"done": true}));
    assert_eq!(bin.unwrap(), vec![1, 0, 255]);
    core.stop(Duration::from_secs(2));
}

#[cfg(unix)]
#[test]
fn incoming_cancel_is_delivered_to_the_native_handler() {
    struct PendingHandler {
        calls: mpsc::Sender<(bool, u64)>,
        pending: Mutex<Option<Call>>,
    }
    impl Handler for PendingHandler {
        fn event(&self, _: String, _: Value, _: Option<Vec<u8>>) {}
        fn request(&self, call: Call) {
            self.calls.send((false, call.id())).unwrap();
            *self.pending.lock().unwrap() = Some(call);
        }
        fn cancel(&self, id: u64) {
            self.calls.send((true, id)).unwrap();
        }
        fn disconnected(&self) {}
    }
    let (calls, received) = mpsc::channel();
    let handler = Arc::new(PendingHandler {
        calls,
        pending: Mutex::new(None),
    });
    let config = Config {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            concat!(
                "printf '{\"id\":41,\"method\":\"native.test\",\"params\":{}}\\n'; ",
                "printf '{\"cancel\":41}\\n'; cat >/dev/null"
            )
            .into(),
        ],
        env: BTreeMap::new(),
    };
    let core = Core::spawn(config, handler).unwrap();
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        (false, 41)
    );
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        (true, 41)
    );
    core.stop(Duration::from_secs(2));
}

#[cfg(unix)]
#[test]
fn cancel_and_eof_fail_pending_requests() {
    let (core, _) = start("IFS= read -r line; IFS= read -r line; IFS= read -r line; exit 0");
    let (tx, rx) = mpsc::channel();
    let tx2 = tx.clone();
    let id = core.request(
        "one",
        json!({}),
        None,
        Duration::from_secs(5),
        move |r, _| {
            tx.send(r.unwrap_err().code).unwrap();
        },
    );
    core.request(
        "two",
        json!({}),
        None,
        Duration::from_secs(5),
        move |r, _| {
            tx2.send(r.unwrap_err().code).unwrap();
        },
    );
    core.cancel(id);
    let mut codes = vec![
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
    ];
    codes.sort();
    assert_eq!(codes, vec!["cancelled", "unavailable"]);
    core.stop(Duration::from_secs(2));
}

#[cfg(unix)]
#[test]
fn stop_closes_stdin_and_reaps_child() {
    let (core, _) = start("cat >/dev/null");
    core.stop(Duration::from_secs(2));
    assert!(core.child.lock().unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn every_thread_spawn_failure_reaps_the_child() {
    for failed in 0..4 {
        let (events, _) = mpsc::channel();
        let config = Config {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "exec cat".into()],
            env: BTreeMap::new(),
        };
        let mut pid = 0;
        let result = Core::spawn_with(
            config,
            Arc::new(TestHandler { events }),
            |index, child_pid| {
                pid = child_pid;
                if index == failed {
                    Err(io::Error::other("injected thread spawn failure"))
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err());
        assert_ne!(pid, 0);
        let status = std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(
            !status.success(),
            "child {pid} survived failure at thread {failed}"
        );
    }
}

#[test]
#[ignore]
fn core_eof_child_fixture() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let mut socket =
        UnixStream::connect(std::env::var_os("OMPDESK_CORE_EOF_SOCKET").unwrap()).unwrap();
    writeln!(socket, "ready {}", std::process::id()).unwrap();
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).unwrap();
    socket.write_all(b"eof").unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut reply = [0; 1];
    socket.read_exact(&mut reply).unwrap();
    assert_eq!(reply, [1]);
    std::process::exit(0);
}

#[test]
#[ignore]
fn owner_death_fixture() {
    use std::io::{Read, Write};

    let (events, _) = mpsc::channel();
    let config = Config {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "exec 3>&1; exec \"$1\" --ignored --nocapture core_eof_child_fixture 1>&2".into(),
            "core-eof-fixture".into(),
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        ],
        env: BTreeMap::new(),
    };
    let core = Core::spawn(config, Arc::new(TestHandler { events })).unwrap();
    let pid = core.child.lock().unwrap().as_ref().unwrap().id();
    println!("CORE_CHILD_PID={pid}");
    std::io::stdout().flush().unwrap();
    let mut release = [0; 1];
    std::io::stdin().read_exact(&mut release).unwrap();
    std::process::exit(0);
}

#[test]
fn owner_process_death_closes_child_stdin() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

    let path = std::env::temp_dir().join(format!("ce{:x}.sock", std::process::id()));
    let listener = UnixListener::bind(&path).unwrap();
    let (tx, rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let result = (|| -> io::Result<()> {
            let (socket, _) = listener.accept()?;
            socket.set_read_timeout(Some(Duration::from_secs(5)))?;
            let mut reader = BufReader::new(socket);
            let mut ready = String::new();
            reader.read_line(&mut ready)?;
            let pid = ready
                .strip_prefix("ready ")
                .and_then(|s| s.trim().parse::<u32>().ok())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid child ready message")
                })?;
            tx.send(Ok(Some(pid)))
                .map_err(|_| io::Error::other("test receiver closed"))?;
            let mut data = [0; 3];
            reader.read_exact(&mut data)?;
            if &data != b"eof" {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid EOF acknowledgement",
                ));
            }
            reader.get_mut().write_all(&[1])?;
            Ok(())
        })();
        let _ = tx.send(result.map(|()| None));
    });
    let mut owner = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--nocapture", "owner_death_fixture"])
        .env("OMPDESK_CORE_EOF_SOCKET", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut release = owner.stdin.take().unwrap();
    let (output_tx, output_rx) = mpsc::channel();
    let output_thread = thread::spawn(move || {
        let _ = output_tx.send(owner.wait_with_output());
    });
    let ready = rx.recv_timeout(Duration::from_secs(5));
    let pid = match &ready {
        Ok(Ok(Some(pid))) => Some(*pid),
        _ => None,
    };
    if pid.is_some() {
        let _ = release.write_all(&[1]);
    }
    drop(release);
    let result = if pid.is_some() {
        rx.recv_timeout(Duration::from_secs(5))
    } else {
        ready
    };
    if !matches!(&result, Ok(Ok(None))) {
        if let Some(pid) = pid {
            let _ = std::process::Command::new("/bin/kill")
                .arg(pid.to_string())
                .status();
        }
        let _ = UnixStream::connect(&path);
    }
    waiter.join().unwrap();
    let output = output_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    output_thread.join().unwrap();
    let _ = std::fs::remove_file(path);
    assert!(
        matches!(&result, Ok(Ok(None))) && output.status.success(),
        "EOF handshake {result:?}, owner stdout: {}, owner stderr and child stdout/stderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
