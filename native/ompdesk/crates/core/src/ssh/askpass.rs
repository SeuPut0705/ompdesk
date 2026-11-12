//! OMPdesk's ssh processes ask their questions (a password, a key's passphrase, a one-time code, an unknown host key)
//! through `SSH_ASKPASS` (was `src/main/ssh/askpass.ts`). The helper ssh runs is this binary itself (`helper`, the
//! first thing `main.rs` looks at): it sends the question with its process's token over a local socket (a Unix socket
//! only this user may open; on Windows a named pipe only local clients reach), the listener lists it as a waiting
//! prompt for main to show, and the person's answer goes back over that connection to the helper's stdout, which ssh
//! reads.
//!
//! An answer lives only in that exchange. Nothing here stores, logs or reports one: a prompt names the question, never
//! what was answered, and what a process was answered is handed to its run when it ends (`release`) only to be cut out
//! of that process's own stderr before anything reads it (`rules::scrub`). A question nobody answers is cancelled
//! after the time main sends; one whose helper or whose ssh ended is cancelled with it.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::random_hex;
use super::rules::{self, Asked};
use crate::git::parse::utf16_prefix;

const SOCKET_ENV: &str = "OMPDESK_ASKPASS_SOCKET";
const TOKEN_ENV: &str = "OMPDESK_ASKPASS_TOKEN";
/// A question's line that has not ended by here is none.
const LINE_LIMIT: u64 = 16_384;
/// How much of ssh's question is kept, in UTF-16 units.
const QUESTION_UNITS: usize = 4000;
/// How long an answered connection is kept for its helper to read the answer and leave.
const LINGER: Duration = Duration::from_secs(2);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What `main` looks at first: `Some(exit code)` when ssh ran this binary as its askpass helper (the two variables
/// only `Askpass::grant` sets), with ssh's question as the one argument. It prints the answer for ssh and exits 0, or
/// exits 1 for a question that was cancelled.
pub fn helper() -> Option<u8> {
    let socket = std::env::var_os(SOCKET_ENV)?;
    let token = std::env::var(TOKEN_ENV).ok()?;
    let question = std::env::args_os()
        .nth(1)
        .map(|question| question.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(answer) = ask(&socket, &token, &question) else {
        return Some(1);
    };
    let mut out = io::stdout().lock();
    let written = out
        .write_all(answer.as_bytes())
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush());
    Some(u8::from(written.is_err()))
}

/// The helper's side of the exchange, one line each way: the answer, or `None` for a cancelled question and a
/// listener that is gone.
fn ask(socket: &OsStr, token: &str, question: &str) -> Option<String> {
    let mut connection = os::connect(socket).ok()?;
    let mut line = serde_json::to_vec(&json!({ "token": token, "prompt": question })).ok()?;
    line.push(b'\n');
    connection.write_all(&line).ok()?;
    let mut reply = String::new();
    io::BufReader::new(connection).read_line(&mut reply).ok()?;
    let reply: Value = serde_json::from_str(&reply).ok()?;
    reply.get("value")?.as_str().map(str::to_owned)
}

/// A waiting question as the page shows it (`SshPrompt`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    id: String,
    /// The saved host the asking ssh runs for.
    server: String,
    /// ssh's own question.
    text: String,
    #[serde(flatten)]
    asked: Asked,
    /// When it is cancelled unanswered, in epoch milliseconds.
    expires_at: u64,
}

struct Waiting {
    prompt: Prompt,
    /// The ssh process that asked.
    token: String,
    answer: oneshot::Sender<Option<String>>,
}

/// One ssh process that may ask.
struct Granted {
    server: String,
    /// What it was answered, for `rules::scrub` once it ended.
    secrets: Vec<String>,
}

#[derive(Default)]
struct State {
    granted: HashMap<String, Granted>,
    /// In the order they were asked.
    waiting: Vec<Waiting>,
    closed: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Told the waiting questions after every change, in the order the changes happened (it is called with the state
    /// locked, so it must not block).
    changed: Box<dyn Fn(Vec<Prompt>) + Send + Sync>,
    timeout: Duration,
}

impl Shared {
    fn tell(&self, state: &State) {
        (self.changed)(
            state
                .waiting
                .iter()
                .map(|entry| entry.prompt.clone())
                .collect(),
        );
    }

    /// Lists `question` for the process of `token`; `None` for a token no live process holds.
    fn list(
        &self,
        token: &str,
        question: &str,
    ) -> Option<(String, oneshot::Receiver<Option<String>>)> {
        let id = random_hex(8).ok()?;
        let mut state = locked(&self.state);
        if state.closed {
            return None;
        }
        let server = state.granted.get(token)?.server.clone();
        let (kept, half, _) = utf16_prefix(question, QUESTION_UNITS);
        let mut text = kept.to_owned();
        text.extend(half);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let (answer, answered) = oneshot::channel();
        state.waiting.push(Waiting {
            prompt: Prompt {
                id: id.clone(),
                server,
                asked: rules::classify_prompt(&text),
                text,
                expires_at: u64::try_from((now + self.timeout).as_millis()).unwrap_or(u64::MAX),
            },
            token: token.to_owned(),
            answer,
        });
        self.tell(&state);
        Some((id, answered))
    }

    /// Takes the question `id` off the list; false when it already left (answered, or its process ended).
    fn withdraw(&self, id: &str) -> bool {
        let mut state = locked(&self.state);
        let Some(at) = state.waiting.iter().position(|entry| entry.prompt.id == id) else {
            return false;
        };
        state.waiting.remove(at);
        self.tell(&state);
        true
    }

    /// Waits for the answer to the listed question `id`: the person's, or `None` once its time passed, its helper
    /// left (`helper` ends, or sends what a helper never sends) or it was cancelled.
    async fn answer(
        &self,
        id: &str,
        mut answered: oneshot::Receiver<Option<String>>,
        helper: &mut (impl AsyncRead + Unpin),
    ) -> Option<String> {
        let mut byte = [0];
        tokio::select! {
            answer = &mut answered => return answer.ok().flatten(),
            () = tokio::time::sleep(self.timeout) => {}
            _ = helper.read(&mut byte) => {}
        }
        // An answer given at this very moment has taken it off the list and is on its way.
        if self.withdraw(id) {
            None
        } else {
            answered.await.ok().flatten()
        }
    }
}

/// The listener of one SSH tools service and the questions that wait on it.
pub struct Askpass {
    shared: Arc<Shared>,
    /// Where the helper connects.
    address: String,
    /// The binary ssh runs as its helper: this one.
    helper: String,
    accepting: JoinHandle<()>,
}

impl Askpass {
    /// Starts listening, inside the runtime. `changed` hears the waiting questions after every change and must not
    /// block.
    pub fn start(
        timeout: Duration,
        changed: impl Fn(Vec<Prompt>) + Send + Sync + 'static,
    ) -> io::Result<Askpass> {
        let helper = std::env::current_exe()?.to_string_lossy().into_owned();
        let address = os::address(&format!("ompdesk-askpass-{}", random_hex(6)?));
        let listener = os::bind(&address)?;
        let shared = Arc::new(Shared {
            state: Mutex::default(),
            changed: Box::new(changed),
            timeout,
        });
        let accepting = tokio::spawn(os::accept(listener, address.clone(), Arc::clone(&shared)));
        Ok(Askpass {
            shared,
            address,
            helper,
            accepting,
        })
    }

    /// Lets one ssh process ask on behalf of `server`: its token, and the variables that make ssh ask here. `display`
    /// is the person's own `DISPLAY` (ssh asks through a helper only when one is set).
    pub fn grant(
        &self,
        server: &str,
        display: Option<&str>,
    ) -> io::Result<(String, Vec<(String, String)>)> {
        let token = random_hex(24)?;
        locked(&self.shared.state).granted.insert(
            token.clone(),
            Granted {
                server: server.to_owned(),
                secrets: Vec::new(),
            },
        );
        let display = display.filter(|display| !display.is_empty());
        let env = [
            ("SSH_ASKPASS", self.helper.as_str()),
            ("SSH_ASKPASS_REQUIRE", "force"),
            ("DISPLAY", display.unwrap_or("ompdesk:0")),
            (SOCKET_ENV, self.address.as_str()),
            (TOKEN_ENV, token.as_str()),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .to_vec();
        Ok((token, env))
    }

    /// The process of `token` ended: its questions are cancelled, and what it was answered is returned so that its
    /// stderr can be read without them.
    pub fn release(&self, token: &str) -> Vec<String> {
        let mut state = locked(&self.shared.state);
        let secrets = state
            .granted
            .remove(token)
            .map(|granted| granted.secrets)
            .unwrap_or_default();
        let (ended, waiting): (Vec<Waiting>, Vec<Waiting>) = std::mem::take(&mut state.waiting)
            .into_iter()
            .partition(|entry| entry.token == token);
        state.waiting = waiting;
        if !ended.is_empty() {
            for entry in ended {
                let _ = entry.answer.send(None);
            }
            self.shared.tell(&state);
        }
        secrets
    }

    /// The person's answer to the question `id` (`None` cancels it); an unknown or expired id does nothing.
    pub fn answer(&self, id: &str, value: Option<String>) {
        let mut state = locked(&self.shared.state);
        let Some(at) = state.waiting.iter().position(|entry| entry.prompt.id == id) else {
            return;
        };
        let entry = state.waiting.remove(at);
        if let Some(value) = &value
            && entry.prompt.asked.kind != rules::HOST_KEY
            && rules::is_secret(value)
            && let Some(granted) = state.granted.get_mut(&entry.token)
        {
            granted.secrets.push(value.clone());
        }
        let _ = entry.answer.send(value);
        self.shared.tell(&state);
    }

    /// Cancels every waiting question and stops listening.
    pub fn close(&self) {
        let mut state = locked(&self.shared.state);
        if state.closed {
            return;
        }
        state.closed = true;
        let waiting = std::mem::take(&mut state.waiting);
        if !waiting.is_empty() {
            for entry in waiting {
                let _ = entry.answer.send(None);
            }
            self.shared.tell(&state);
        }
        drop(state);
        self.accepting.abort();
        os::unlisten(&self.address);
    }
}

impl Drop for Askpass {
    fn drop(&mut self) {
        self.close();
    }
}

/// One helper's connection: its question's line, then one line back, the answer or a cancel.
async fn serve(shared: Arc<Shared>, connection: impl AsyncRead + AsyncWrite + Unpin) {
    let (reader, mut writer) = tokio::io::split(connection);
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let read = (&mut reader)
        .take(LINE_LIMIT + 1)
        .read_until(b'\n', &mut line)
        .await;
    if read.is_err() || line.last() != Some(&b'\n') {
        return;
    }
    let Ok(request) = serde_json::from_slice::<Value>(&line) else {
        return;
    };
    let token = request.get("token").and_then(Value::as_str).unwrap_or("");
    let listed = request
        .get("prompt")
        .and_then(Value::as_str)
        .and_then(|question| shared.list(token, question));
    let answer = match listed {
        Some((id, answered)) => shared.answer(&id, answered, &mut reader).await,
        None => None,
    };
    let reply = match answer {
        Some(value) => json!({ "value": value }),
        None => json!({ "cancel": true }),
    };
    let reply = format!("{reply}\n");
    if writer.write_all(reply.as_bytes()).await.is_ok() && writer.flush().await.is_ok() {
        // The helper leaves once it read its line. The connection is kept until then: a pipe that is closed with
        // the answer still in it may drop it.
        let mut rest = Vec::new();
        let _ = tokio::time::timeout(LINGER, reader.read_to_end(&mut rest)).await;
    }
}

#[cfg(unix)]
mod os {
    use std::ffi::OsStr;
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::net::UnixListener;

    use super::{Shared, serve};

    pub type Listener = UnixListener;

    /// A Unix socket in the temp folder.
    pub fn address(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("{name}.sock"))
            .to_string_lossy()
            .into_owned()
    }

    /// The socket, which only this user may open.
    pub fn bind(address: &str) -> io::Result<Listener> {
        let listener = UnixListener::bind(address)?;
        if let Err(error) =
            std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))
        {
            unlisten(address);
            return Err(error);
        }
        Ok(listener)
    }

    pub async fn accept(listener: Listener, _address: String, shared: Arc<Shared>) {
        loop {
            match listener.accept().await {
                Ok((connection, _)) => {
                    tokio::spawn(serve(Arc::clone(&shared), connection));
                }
                // The system refused (no descriptor left): wait, never spin.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    }

    /// The socket's file goes with its listener.
    pub fn unlisten(address: &str) {
        let _ = std::fs::remove_file(address);
    }

    pub fn connect(address: &OsStr) -> io::Result<UnixStream> {
        UnixStream::connect(address)
    }
}

#[cfg(windows)]
mod os {
    use std::ffi::OsStr;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    use super::{Shared, serve};

    pub type Listener = NamedPipeServer;

    pub fn address(name: &str) -> String {
        format!(r"\\.\pipe\{name}")
    }

    /// The pipe's first instance, which makes the name this process's (one already there fails); every instance
    /// rejects remote clients, as the control socket's do.
    pub fn bind(address: &str) -> io::Result<Listener> {
        ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(address)
    }

    pub async fn accept(mut listening: Listener, address: String, shared: Arc<Shared>) {
        loop {
            let connected = listening.connect().await;
            // The next instance exists before this one is served: a helper that finds none free gets "pipe busy" and
            // asks again (`connect`).
            let Ok(next) = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&address)
            else {
                return;
            };
            let connection = std::mem::replace(&mut listening, next);
            if connected.is_ok() {
                tokio::spawn(serve(Arc::clone(&shared), connection));
            }
        }
    }

    /// A pipe is gone with its last instance.
    pub fn unlisten(_address: &str) {}

    /// Every instance of the pipe is taken for a moment while the listener makes the next one: asked again for 5 s.
    pub fn connect(address: &OsStr) -> io::Result<File> {
        const ERROR_PIPE_BUSY: i32 = 231;
        let started = Instant::now();
        loop {
            match OpenOptions::new().read(true).write(true).open(address) {
                Err(error)
                    if error.raw_os_error() == Some(ERROR_PIPE_BUSY)
                        && started.elapsed() < Duration::from_secs(5) =>
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
                opened => return opened,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

    use super::*;

    type Changes = mpsc::UnboundedReceiver<Vec<Prompt>>;

    /// A listener whose changes arrive on a channel.
    fn started(timeout: Duration) -> (Askpass, Changes) {
        let (changes, changed) = mpsc::unbounded_channel();
        let askpass = Askpass::start(timeout, move |prompts| {
            let _ = changes.send(prompts);
        })
        .unwrap();
        (askpass, changed)
    }

    /// The helper, asking from a thread of its own as ssh's child would from its own process.
    fn asks(askpass: &Askpass, token: &str, question: &str) -> JoinHandle<Option<String>> {
        let (address, token, question) = (
            askpass.address.clone(),
            token.to_owned(),
            question.to_owned(),
        );
        tokio::task::spawn_blocking(move || ask(OsStr::new(&address), &token, &question))
    }

    /// The next list of waiting questions that holds `count` of them.
    async fn waiting(changed: &mut Changes, count: usize) -> Vec<Prompt> {
        loop {
            let prompts = tokio::time::timeout(Duration::from_secs(20), changed.recv())
                .await
                .expect("the waiting questions did not change for 20 s")
                .unwrap();
            if prompts.len() == count {
                return prompts;
            }
        }
    }

    // `service.test.ts` "answers only its own processes' tokens".
    #[tokio::test(flavor = "multi_thread")]
    async fn answers_only_its_own_processes_tokens() {
        let (askpass, mut changed) = started(Duration::from_secs(60));
        let (token, env) = askpass.grant("box", None).unwrap();
        assert_eq!(asks(&askpass, "forged", "password:").await.unwrap(), None);
        assert_eq!(asks(&askpass, "", "password:").await.unwrap(), None);
        assert!(
            changed.try_recv().is_err(),
            "a forged token listed a question"
        );
        let names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "SSH_ASKPASS",
                "SSH_ASKPASS_REQUIRE",
                "DISPLAY",
                SOCKET_ENV,
                TOKEN_ENV
            ]
        );
        assert_eq!(env[1].1, "force");
        assert_eq!(env[2].1, "ompdesk:0");
        assert_eq!(env[4].1, token);
        assert_eq!(token.len(), 48);
        assert_eq!(askpass.grant("box", Some("")).unwrap().1[2].1, "ompdesk:0");
        assert_eq!(askpass.grant("box", Some(":1")).unwrap().1[2].1, ":1");
    }

    // `service.test.ts` "release cancels only the prompts of its own token, not another process's on the same server".
    #[tokio::test(flavor = "multi_thread")]
    async fn release_cancels_only_the_questions_of_its_own_process() {
        let (askpass, mut changed) = started(Duration::from_secs(60));
        let (forward, _) = askpass.grant("box", None).unwrap();
        let (watch, _) = askpass.grant("box", None).unwrap();
        let watch_asks = asks(&askpass, &watch, "box's password: ");
        waiting(&mut changed, 1).await;
        let forward_asks = asks(&askpass, &forward, "Enter passphrase for key: ");
        waiting(&mut changed, 2).await;
        // The watch ends: its question goes, the forward's stays open on the same server.
        assert_eq!(askpass.release(&watch), Vec::<String>::new());
        assert_eq!(watch_asks.await.unwrap(), None);
        let left = waiting(&mut changed, 1).await;
        assert_eq!(left[0].asked.kind, "passphrase");
        assert_eq!(left[0].server, "box");
        assert_eq!(left[0].text, "Enter passphrase for key: ");
        askpass.answer(&left[0].id, Some("secret".into()));
        assert_eq!(forward_asks.await.unwrap().as_deref(), Some("secret"));
        assert!(waiting(&mut changed, 0).await.is_empty());
        // An id that is gone does nothing.
        askpass.answer(&left[0].id, Some("again".into()));
        assert!(changed.try_recv().is_err());
        assert_eq!(askpass.release(&forward), ["secret"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn keeps_what_a_process_was_answered_only_for_its_own_stderr() {
        let (askpass, mut changed) = started(Duration::from_secs(60));
        let (token, _) = askpass.grant("box", None).unwrap();
        let mut shown = Vec::new();
        for (question, value) in [
            (
                "The authenticity of host 'box (10.0.0.1)' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
                "yes-of-course",
            ),
            ("me@box's password: ", "hunter2-hunter2"),
            ("Enter passphrase for key '/k': ", "correct horse"),
            ("Verification code: ", "123456"),
            ("PIN: ", "ab"),
        ] {
            let helper = asks(&askpass, &token, question);
            let prompt = waiting(&mut changed, 1).await.remove(0);
            // A prompt names the question and never an answer.
            let line = serde_json::to_string(&prompt).unwrap();
            assert!(line.contains("\"expiresAt\":") && line.contains("\"fingerprint\":"));
            shown.push(line);
            askpass.answer(&prompt.id, Some(value.into()));
            assert_eq!(helper.await.unwrap().as_deref(), Some(value));
            waiting(&mut changed, 0).await;
        }
        // A host key's yes and an answer too short to cut out are no secrets; the rest is, in the order given.
        assert_eq!(
            askpass.release(&token),
            ["hunter2-hunter2", "correct horse", "123456"]
        );
        for line in shown {
            for secret in ["hunter2", "correct horse", "123456", "yes-of-course"] {
                assert!(!line.contains(secret), "{line}");
            }
        }
        // A process that already ended is answered nothing and remembered nowhere.
        assert_eq!(asks(&askpass, &token, "password:").await.unwrap(), None);
        assert_eq!(askpass.release(&token), Vec::<String>::new());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancels_a_question_nobody_answers_and_one_whose_helper_left() {
        let (askpass, mut changed) = started(Duration::from_millis(300));
        let (token, _) = askpass.grant("box", None).unwrap();
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let helper = asks(&askpass, &token, "password:");
        let prompt = waiting(&mut changed, 1).await.remove(0);
        let expires = u128::from(prompt.expires_at);
        assert!(
            (before + 300..before + 20_000).contains(&expires),
            "{expires}"
        );
        assert_eq!(helper.await.unwrap(), None);
        assert!(waiting(&mut changed, 0).await.is_empty());

        let (askpass, mut changed) = started(Duration::from_secs(60));
        let (token, _) = askpass.grant("box", None).unwrap();
        let mut connection = os::connect(OsStr::new(&askpass.address)).unwrap();
        let line = format!("{}\n", json!({ "token": token, "prompt": "password:" }));
        connection.write_all(line.as_bytes()).unwrap();
        waiting(&mut changed, 1).await;
        drop(connection);
        assert!(waiting(&mut changed, 0).await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_what_is_no_question_and_stops_listening_when_closed() {
        let (askpass, mut changed) = started(Duration::from_secs(60));
        let (token, _) = askpass.grant("box", None).unwrap();
        // What the listener answers to `line`, read to the end of the connection.
        let reply = |line: String| {
            let address = askpass.address.clone();
            tokio::task::spawn_blocking(move || {
                let mut connection = os::connect(OsStr::new(&address)).unwrap();
                // The listener may stop reading a line that is no question before all of it is written.
                let _ = connection.write_all(line.as_bytes());
                let mut reply = String::new();
                let mut reader = io::BufReader::new(connection);
                if reader.read_line(&mut reply).is_ok_and(|read| read > 0) {
                    return reply;
                }
                let _ = reader.read_to_string(&mut reply);
                reply
            })
        };
        let cancelled = "{\"cancel\":true}\n";
        assert_eq!(reply("not json\n".into()).await.unwrap(), "");
        assert_eq!(reply("null\n".into()).await.unwrap(), cancelled);
        let no_text = json!({ "token": token, "prompt": 5 });
        assert_eq!(reply(format!("{no_text}\n")).await.unwrap(), cancelled);
        let no_token = json!({ "token": 5, "prompt": "x" });
        assert_eq!(reply(format!("{no_token}\n")).await.unwrap(), cancelled);
        let endless = "x".repeat(usize::try_from(LINE_LIMIT).unwrap() + 4096);
        assert_eq!(reply(endless).await.unwrap(), "");
        assert!(changed.try_recv().is_err());

        // A long question is cut, a waiting one is cancelled by the close, and nothing listens afterwards.
        let long = "p".repeat(QUESTION_UNITS + 50);
        let helper = asks(&askpass, &token, &long);
        let prompt = waiting(&mut changed, 1).await.remove(0);
        assert_eq!(prompt.text.len(), QUESTION_UNITS);
        askpass.close();
        assert_eq!(helper.await.unwrap(), None);
        assert!(waiting(&mut changed, 0).await.is_empty());
        askpass.close();
        let mut gone = false;
        for _ in 0..400 {
            if os::connect(OsStr::new(&askpass.address)).is_err() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(gone, "the listener outlived its close");
        assert_eq!(asks(&askpass, &token, "password:").await.unwrap(), None);
    }
}
