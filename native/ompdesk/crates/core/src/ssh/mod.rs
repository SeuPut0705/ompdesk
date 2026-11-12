//! OMPdesk's own ssh for Settings › SSH tools (were `src/main/ssh/options.ts`, `askpass.ts` and every process
//! `service.ts` started): the rules of a saved host and its arguments (`rules`), the config every run reads, the
//! questions an ssh asks (`askpass`), the port forwards and port watches that stay (`live`), and the short runs of
//! `ssh -G`, `ssh-keygen` and `ssh-add` through the shared runner (`crate::run`).
//!
//! Main keeps what the person wants: which forwards exist, their retry and grace clocks and the saved list
//! (`src/main/ssh/service.ts`). It hands every request how to run (`How`: the three programs, the whole environment,
//! the home folder, its own ssh folder, how long a short run may take), as it does for git and gh.
//!
//! A forward or a watch is named by main (`service`, `run`). Its request answers once the ssh started; from then on
//! it reports by events and is ended by `ssh.stop`, by its service's `ssh.close`, or when the core's input ends
//! (`close_all`):
//! - `ssh.up` `{service, run}`: a forward's local port accepts connections;
//! - `ssh.ports` `{service, run, ports, opened}`: a watch's listing, when it differs from the one before;
//! - `ssh.exit` `{service, run, failure: {kind, message}}`: the ssh is gone, and why (`rules::classify_failure`);
//! - `ssh.prompts` `{service, prompts}`: the questions that wait for the person, after every change.
//!
//! A secret never leaves through a message. An answer arrives in `ssh.answer` and goes to the helper that asked; the
//! core logs no request, this module's refusals of a request are fixed texts that repeat nothing of it, and what an
//! ssh was answered is cut out of its stderr before that is read (`rules::scrub`).

mod askpass;
mod live;
mod rules;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::io::{self, Write as _};
use std::net::{Ipv4Addr, TcpListener};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

pub use askpass::helper as askpass_helper;
use askpass::{Askpass, Prompt};
use rules::{Destination, Failure, Target, refused};

use crate::fs::error::{Codes, NodeError, uv_code};
use crate::fs::order::js_trim;
use crate::run::{Exec, Opts, Output, Runner};
use crate::server::{Call, Events, Fault, Registry, Reply, Scope};

/// What a short run may print.
const MAX_OUTPUT: usize = 1024 * 1024;
/// The longest answer to a question, in UTF-16 units.
const ANSWER_UNITS: usize = 4000;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `bytes` bytes from the system's random generator in hex, as node's `randomBytes(n).toString("hex")`: a token, a
/// question's id, a socket's name.
fn random_hex(bytes: usize) -> io::Result<String> {
    let mut raw = vec![0; bytes];
    crate::sys::random(&mut raw)?;
    let mut hex = String::with_capacity(bytes * 2);
    for byte in raw {
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

pub fn register(registry: &mut Registry) {
    registry.add("ssh.plan", |call| Box::pin(async move { plan(&call) }));
    registry.add("ssh.forward", |call| Box::pin(forward(call)));
    registry.add("ssh.watch", |call| Box::pin(watch(call)));
    registry.add("ssh.stop", |call| Box::pin(async move { stop(&call) }));
    registry.add("ssh.close", |call| Box::pin(async move { close(&call) }));
    registry.add("ssh.answer", |call| Box::pin(async move { answer(&call) }));
    registry.add("ssh.agent", |call| Box::pin(agent(call)));
    registry.add("ssh.createKey", |call| Box::pin(create_key(call)));
    registry.add("ssh.loadKeys", |call| Box::pin(load_keys(call)));
    registry.add("ssh.forgetHostKey", |call| Box::pin(forget_host_key(call)));
}

/// A request's params; what does not read as them is refused in fixed words, which repeat nothing of the request (a
/// request can carry an answer and always carries the environment).
fn params<T: DeserializeOwned>(call: &Call) -> Result<T, Fault> {
    serde_json::from_str(call.params.get()).map_err(|_| refused("Invalid SSH tools request"))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The ssh tools' disk work panicked"))?
}

#[derive(Serialize)]
struct Done {}

/// How main runs ssh, read when the request was made.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct How {
    /// The three programs: names for the `PATH` of `env`, or the paths a test's stand-ins are at.
    ssh: String,
    ssh_add: String,
    ssh_keygen: String,
    /// The whole environment of each process.
    env: BTreeMap<String, String>,
    /// The person's home folder: `~/.ssh` is under it.
    home: String,
    /// OMPdesk's own ssh folder (`<userData>/ssh`): the config and the known_hosts it pins.
    dir: String,
    /// How long one short run may take.
    timeout_ms: u64,
}

impl How {
    fn runner(&self, program: &str) -> Runner {
        Runner {
            bin: program.to_owned(),
            args: Vec::new(),
            env: self.env.clone(),
            timeout_ms: self.timeout_ms,
            max_bytes: MAX_OUTPUT,
        }
    }
}

fn joined(base: &str, parts: &[&str]) -> String {
    let mut path = Path::new(base).to_path_buf();
    path.extend(parts);
    path.to_string_lossy().into_owned()
}

/// `fsp.mkdir(dir, { recursive: true, mode: 0o700 })`, failing in node's words.
fn make_dir(dir: &str) -> Result<(), Fault> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(dir)
        .map_err(|error| NodeError::new(&error, "mkdir", Some(dir)).fault(Codes::None))
}

/// The config of every run and the known_hosts it pins.
struct Config {
    file: String,
    known_hosts: String,
}

/// Writes `<dir>/config` (`rules::config_text`) unless it already reads so: runs that start together never see half
/// a file, and one that was removed or changed is written again.
fn write_config(dir: &str, home: &str) -> Result<Config, Fault> {
    static WRITING: Mutex<()> = Mutex::new(());
    let config = Config {
        file: joined(dir, &["config"]),
        known_hosts: joined(dir, &["known_hosts"]),
    };
    let text = rules::config_text(&config.known_hosts, &joined(home, &[".ssh", "config"]))?;
    let _one_writer = locked(&WRITING);
    make_dir(dir)?;
    if std::fs::read(&config.file).is_ok_and(|written| written == text.as_bytes()) {
        return Ok(config);
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(&config.file)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .map_err(|error| NodeError::new(&error, "open", Some(&config.file)).fault(Codes::None))?;
    Ok(config)
}

async fn config_of(how: &How) -> Result<Config, Fault> {
    let (dir, home) = (how.dir.clone(), how.home.clone());
    blocking(move || write_config(&dir, &home)).await
}

/// One SSH tools service of main (`SshTools`): the questions its ssh processes ask and the ones that stay.
struct Service {
    /// Where it reports: the output of the connection that opened it.
    events: Events,
    /// Set before anything of it is ended: nothing starts in a closed service.
    closed: AtomicBool,
    askpass: Mutex<Option<Arc<Askpass>>>,
    /// What ends each run that has not exited.
    runs: Mutex<HashMap<String, Arc<Notify>>>,
}

#[derive(Default)]
struct Services {
    open: HashMap<String, Arc<Service>>,
    /// Main names every service once: a request that arrives after its service's close must not open it again.
    closed: HashSet<String>,
}

static SERVICES: LazyLock<Mutex<Services>> = LazyLock::new(Default::default);

fn closed_fault() -> Fault {
    Fault::new("ssh_closed", "The SSH tools were closed")
}

/// The service `name`, opened by its first run.
fn service(name: &str, events: &Events) -> Result<Arc<Service>, Fault> {
    let mut services = locked(&SERVICES);
    if services.closed.contains(name) {
        return Err(closed_fault());
    }
    let service = services.open.entry(name.to_owned()).or_insert_with(|| {
        Arc::new(Service {
            events: events.clone(),
            closed: AtomicBool::new(false),
            askpass: Mutex::default(),
            runs: Mutex::default(),
        })
    });
    Ok(Arc::clone(service))
}

/// Ends everything of the service `name` for good: its runs, its waiting questions, its listener.
fn end(name: &str) {
    let service = {
        let mut services = locked(&SERVICES);
        services.closed.insert(name.to_owned());
        services.open.remove(name)
    };
    let Some(service) = service else { return };
    service.closed.store(true, Ordering::SeqCst);
    for stop in locked(&service.runs).values() {
        stop.notify_one();
    }
    if let Some(askpass) = locked(&service.askpass).take() {
        askpass.close();
    }
}

/// Ends every service that reports to `events`' output, or to none any more. `serve` calls it when its input ended:
/// a main that died never asks for the close, and what stays must not outlive the input (each ssh is asked to end,
/// the listeners' sockets go).
pub fn close_all(events: &Events) {
    let ending: Vec<String> = locked(&SERVICES)
        .open
        .iter()
        .filter(|(_, service)| !service.events.reaches_another(events))
        .map(|(name, _)| name.clone())
        .collect();
    for name in ending {
        end(&name);
    }
}

#[derive(Serialize)]
struct Prompts<'a> {
    service: &'a str,
    prompts: Vec<Prompt>,
}

impl Service {
    /// The service's listener for questions, started by its first run (inside the runtime).
    fn askpass(&self, name: &str, timeout: Duration) -> Result<Arc<Askpass>, Fault> {
        let mut slot = locked(&self.askpass);
        if self.closed.load(Ordering::SeqCst) {
            return Err(closed_fault());
        }
        if let Some(askpass) = &*slot {
            return Ok(Arc::clone(askpass));
        }
        let (events, service) = (self.events.clone(), name.to_owned());
        let askpass = Askpass::start(timeout, move |prompts| {
            events.send(
                "ssh.prompts",
                &Prompts {
                    service: &service,
                    prompts,
                },
            );
        })
        .map_err(|error| Fault::new("io", format!("listen {}", uv_code(&error))))?;
        Ok(Arc::clone(slot.insert(Arc::new(askpass))))
    }

    fn add_run(&self, run: &str, stop: &Arc<Notify>) -> Result<(), Fault> {
        let mut runs = locked(&self.runs);
        if self.closed.load(Ordering::SeqCst) {
            return Err(closed_fault());
        }
        if runs.insert(run.to_owned(), Arc::clone(stop)).is_some() {
            return Err(Fault::new("internal", "The ssh run is named twice"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanParams {
    target: Target,
    remote_port: f64,
    /// The local port wanted: the forward's saved one, or the one the person asked for.
    local_port: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    local_port: u16,
}

/// A free port on this computer's loopback: `wanted` when it is free, else one the system picks.
fn free_port(wanted: u16) -> Result<u16, Fault> {
    let bound = |port: u16| {
        TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .and_then(|listener| listener.local_addr())
            .map(|address| address.port())
            .ok()
    };
    bound(wanted)
        .or_else(|| bound(0))
        .ok_or_else(|| Fault::new("no_port", "No free local port"))
}

/// Before a forward connects: is what the page sent a host and two ports (`rules`), and which local port is free.
fn plan(call: &Call) -> Result<Reply, Fault> {
    let params: PlanParams = params(call)?;
    params.target.destination()?;
    rules::port(params.remote_port)?;
    let wanted = rules::port(params.local_port)?;
    Reply::json(&Plan {
        local_port: free_port(wanted)?,
    })
}

/// What every run that stays is told.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    service: String,
    run: String,
    how: How,
    target: Target,
    /// How long a question of this service waits for its answer.
    prompt_timeout_ms: u64,
}

/// A forward's own params, beside `Start`'s.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardPorts {
    local_port: f64,
    remote_port: f64,
}

/// A watch's own params, beside `Start`'s.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchPace {
    /// The pause between two listings on the server.
    poll_seconds: u32,
}

enum Stays {
    Forward { local_port: u16 },
    Watch,
}

#[derive(Serialize)]
struct RunEvent<'a> {
    service: &'a str,
    run: &'a str,
}

#[derive(Serialize)]
struct PortsEvent<'a> {
    service: &'a str,
    run: &'a str,
    ports: &'a [u16],
    opened: &'a [u16],
}

#[derive(Serialize)]
struct ExitEvent<'a> {
    service: &'a str,
    run: &'a str,
    failure: Failure,
}

async fn forward(call: Call) -> Result<Reply, Fault> {
    let ports: ForwardPorts = params(&call)?;
    let local_port = rules::port(ports.local_port)?;
    let remote_port = rules::port(ports.remote_port)?;
    let stays = Stays::Forward { local_port };
    let args = move |host: &Destination| host.forward_args(local_port, remote_port);
    stay(params(&call)?, call.events, stays, args).await
}

async fn watch(call: Call) -> Result<Reply, Fault> {
    let WatchPace { poll_seconds } = params(&call)?;
    let args = move |host: &Destination| host.watch_args(poll_seconds);
    stay(params(&call)?, call.events, Stays::Watch, args).await
}

/// node's `spawn <program> ENOENT` for a program that is not there.
fn spawn_failure(program: &str, error: &io::Error) -> String {
    let code = if error.kind() == io::ErrorKind::NotFound {
        "ENOENT"
    } else {
        uv_code(error)
    };
    format!("spawn {program} {code}")
}

/// Starts an ssh that stays and answers. Its end is the `ssh.exit` event, also for an ssh that could not start
/// (the supervisor reported that as its stderr too).
async fn stay(
    start: Start,
    events: Events,
    stays: Stays,
    args: impl FnOnce(&Destination) -> Vec<String>,
) -> Result<Reply, Fault> {
    let Start {
        service: name,
        run,
        how,
        target,
        prompt_timeout_ms,
    } = start;
    let destination = target.destination()?;
    let service = service(&name, &events)?;
    let config = config_of(&how).await?;
    let askpass = service.askpass(&name, Duration::from_millis(prompt_timeout_ms))?;
    let stop = Arc::new(Notify::new());
    service.add_run(&run, &stop)?;
    let display = how.env.get("DISPLAY").map(String::as_str);
    let (token, env) = askpass
        .grant(&destination.name, display)
        .inspect_err(|_| {
            locked(&service.runs).remove(&run);
        })
        .map_err(|error| Fault::new("io", format!("random {}", uv_code(&error))))?;
    let mut all = vec!["-F".to_owned(), config.file];
    all.extend(args(&destination));
    let runner = how.runner(&how.ssh);
    let started = live::start(&runner, &all, &env);
    tokio::spawn(async move {
        let stderr = match (started, stays) {
            (Err(error), _) => spawn_failure(&runner.bin, &error),
            (Ok(running), Stays::Forward { local_port }) => {
                let up = || {
                    events.send(
                        "ssh.up",
                        &RunEvent {
                            service: &name,
                            run: &run,
                        },
                    );
                };
                running.forward(&stop, local_port, up).await
            }
            (Ok(running), Stays::Watch) => {
                let listed = |ports: &[u16], opened: &[u16]| {
                    events.send(
                        "ssh.ports",
                        &PortsEvent {
                            service: &name,
                            run: &run,
                            ports,
                            opened,
                        },
                    );
                };
                running.watch(&stop, listed).await
            }
        };
        let secrets = askpass.release(&token);
        let failure = rules::classify_failure(&rules::scrub(stderr, &secrets));
        locked(&service.runs).remove(&run);
        events.send(
            "ssh.exit",
            &ExitEvent {
                service: &name,
                run: &run,
                failure,
            },
        );
    });
    Reply::json(&Done {})
}

#[derive(Deserialize)]
struct StopParams {
    service: String,
    run: String,
}

/// Asks a run to end; its `ssh.exit` says when it is gone. A run that already ended is nothing to stop.
fn stop(call: &Call) -> Result<Reply, Fault> {
    let params: StopParams = params(call)?;
    let service = locked(&SERVICES).open.get(&params.service).cloned();
    if let Some(service) = service
        && let Some(stop) = locked(&service.runs).get(&params.run)
    {
        stop.notify_one();
    }
    Reply::json(&Done {})
}

#[derive(Deserialize)]
struct CloseParams {
    service: String,
}

/// Main is done with a service (a quit, a test's end).
fn close(call: &Call) -> Result<Reply, Fault> {
    let params: CloseParams = params(call)?;
    end(&params.service);
    Reply::json(&Done {})
}

#[derive(Deserialize)]
struct AnswerParams {
    service: String,
    id: String,
    /// `null` cancels the question.
    value: Option<String>,
}

/// The person's answer to a waiting question; an unknown or expired id does nothing.
fn answer(call: &Call) -> Result<Reply, Fault> {
    let params: AnswerParams = params(call)?;
    if params
        .value
        .as_ref()
        .is_some_and(|value| value.encode_utf16().count() > ANSWER_UNITS)
    {
        return Err(refused("Invalid SSH tools request"));
    }
    let service = locked(&SERVICES).open.get(&params.service).cloned();
    let askpass = service.and_then(|service| locked(&service.askpass).clone());
    if let Some(askpass) = askpass {
        askpass.answer(&params.id, params.value);
    }
    Reply::json(&Done {})
}

/// The short runs of one request (`ssh -G`, `ssh-keygen`, `ssh-add`), held to its scope.
struct Tools<'a> {
    how: &'a How,
    scope: Scope,
}

impl Tools<'_> {
    /// What the program did, or `None` when it could not start or ran past its time (the TypeScript's `run` never
    /// threw); a cancelled request fails.
    async fn run(&self, program: &str, args: &[&str]) -> Result<Option<Output>, Fault> {
        let exec = Exec::new(self.how.runner(program), self.scope.clone(), "ssh");
        match exec.run(".", args, Opts::default()).await {
            Ok(output) => Ok(Some(output)),
            Err(fault) if fault.code == "cancelled" => Err(fault),
            Err(_) => Ok(None),
        }
    }
}

#[derive(Deserialize)]
struct HowParams {
    how: How,
}

/// The names in `~/.ssh` that end in `.pub`, in JavaScript's sort order; none when the folder cannot be read.
fn public_keys(home: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(joined(home, &[".ssh"]))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".pub"))
        .collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    agent: &'static str,
    agent_keys: Vec<String>,
    key_files: Vec<String>,
    keygen: bool,
}

/// Does an ssh-agent answer, which keys does it hold, which key files exist, can a key be made (`SshAgentStatus`).
async fn agent(call: Call) -> Result<Reply, Fault> {
    let HowParams { how } = params(&call)?;
    let tools = Tools {
        how: &how,
        scope: call.scope.clone(),
    };
    let home = how.home.clone();
    let (listed, keygen, key_files) = tokio::join!(
        tools.run(&how.ssh_add, &["-l"]),
        tools.run(&how.ssh_keygen, &["-?"]),
        blocking(move || Ok(public_keys(&home))),
    );
    let (listed, keygen, key_files) = (listed?, keygen?, key_files?);
    // ssh-add -l: 0 = keys listed, 1 = an agent without keys, 2 = no agent to talk to.
    let agent = match listed.as_ref().map(|output| output.code) {
        Some(0 | 1) => "available",
        Some(2) => "none",
        _ => "error",
    };
    let agent_keys = listed
        .filter(|output| output.code == 0)
        .map(|output| {
            output
                .text()
                .split('\n')
                .map(js_trim)
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Reply::json(&Agent {
        agent,
        agent_keys,
        key_files,
        keygen: keygen.is_some(),
    })
}

/// "Create a key": `~/.ssh/id_ed25519` without a passphrase, never over a key that is there.
async fn create_key(call: Call) -> Result<Reply, Fault> {
    let HowParams { how } = params(&call)?;
    let dir = joined(&how.home, &[".ssh"]);
    let key = joined(&dir, &["id_ed25519"]);
    let there = {
        let key = key.clone();
        blocking(move || {
            make_dir(&dir)?;
            Ok(std::fs::metadata(&key).is_ok())
        })
        .await?
    };
    if there {
        return Reply::json(&Done {});
    }
    let tools = Tools {
        how: &how,
        scope: call.scope.clone(),
    };
    let args = [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "ompdesk",
        "-f",
        key.as_str(),
    ];
    let made = tools.run(&how.ssh_keygen, &args).await?;
    if made.is_none_or(|output| output.code != 0) {
        return Err(Fault::new("ssh_failed", "ssh-keygen failed"));
    }
    Reply::json(&Done {})
}

/// "Add keys to the agent": `ssh-add` for every private key in `~/.ssh` that has its `.pub` beside it.
async fn load_keys(call: Call) -> Result<Reply, Fault> {
    let HowParams { how } = params(&call)?;
    let home = how.home.clone();
    let keys = blocking(move || {
        Ok(public_keys(&home)
            .iter()
            .map(|name| joined(&home, &[".ssh", &name[..name.len() - ".pub".len()]]))
            .filter(|key| std::fs::metadata(key).is_ok())
            .collect::<Vec<_>>())
    })
    .await?;
    let tools = Tools {
        how: &how,
        scope: call.scope.clone(),
    };
    for key in keys {
        let keychain = ["--apple-use-keychain", key.as_str()];
        let args = if cfg!(target_os = "macos") {
            &keychain[..]
        } else {
            &keychain[1..]
        };
        tools.run(&how.ssh_add, args).await?;
    }
    Reply::json(&Done {})
}

#[derive(Deserialize)]
struct ForgetParams {
    how: How,
    target: Target,
}

/// Drops the saved key of a host and of every ProxyJump hop on the way to it from OMPdesk's known_hosts, so the next
/// connection asks again.
async fn forget_host_key(call: Call) -> Result<Reply, Fault> {
    let ForgetParams { how, target } = params(&call)?;
    let destination = target.destination()?;
    let config = config_of(&how).await?;
    let tools = Tools {
        how: &how,
        scope: call.scope.clone(),
    };
    let resolve = destination.resolve_args();
    let mut args = vec!["-F", config.file.as_str()];
    args.extend(resolve.iter().map(String::as_str));
    let resolved = tools
        .run(&how.ssh, &args)
        .await?
        .map(|output| output.text())
        .unwrap_or_default();
    for name in rules::known_host_names(&resolved, destination.host()) {
        let args = ["-R", name.as_str(), "-f", config.known_hosts.as_str()];
        tools.run(&how.ssh_keygen, &args).await?;
    }
    Reply::json(&Done {})
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

    use super::*;

    fn temp(name: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-ssh-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn makes_tokens_from_the_system_s_random_generator() {
        let tokens: HashSet<String> = (0..200).map(|_| random_hex(24).unwrap()).collect();
        assert_eq!(tokens.len(), 200);
        assert!(
            tokens.iter().all(
                |token| token.len() == 48 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
            )
        );
        assert_eq!(random_hex(6).unwrap().len(), 12);
    }

    #[test]
    fn picks_the_wanted_local_port_when_it_is_free() {
        let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        let other = free_port(port).unwrap();
        assert_ne!(other, port);
        drop(taken);
        assert_eq!(free_port(port).unwrap(), port);
    }

    #[test]
    fn writes_the_config_once_and_again_when_it_changed() {
        let root = temp("config");
        let dir = joined(&root, &["user", "ssh"]);
        let config = write_config(&dir, "/home/me").unwrap();
        assert_eq!(config.file, joined(&dir, &["config"]));
        assert_eq!(config.known_hosts, joined(&dir, &["known_hosts"]));
        let text = std::fs::read_to_string(&config.file).unwrap();
        assert!(text.contains(&format!(
            "UserKnownHostsFile \"{}\"",
            config.known_hosts.replace('\\', "/")
        )));
        assert!(text.contains("Include \"/home/me/.ssh/config\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &str| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&config.file), 0o600);
            assert_eq!(mode(&dir), 0o700);
        }
        // What already reads so is left alone; what was changed is written again.
        let written = std::fs::metadata(&config.file).unwrap().modified().unwrap();
        write_config(&dir, "/home/me").unwrap();
        assert_eq!(
            std::fs::metadata(&config.file).unwrap().modified().unwrap(),
            written
        );
        std::fs::write(&config.file, "Host *\n  StrictHostKeyChecking no\n").unwrap();
        write_config(&dir, "/home/me").unwrap();
        assert_eq!(std::fs::read_to_string(&config.file).unwrap(), text);
        // A file where the folder belongs fails in node's words, and is not remembered.
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::write(&dir, "in the way").unwrap();
        let fault = write_config(&dir, "/home/me").err().unwrap();
        assert_eq!(
            fault.message,
            format!("EEXIST: file already exists, mkdir '{dir}'")
        );
        std::fs::remove_file(&dir).unwrap();
        write_config(&dir, "/home/me").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_public_keys_in_javascript_s_order() {
        let home = temp("keys");
        let dir = joined(&home, &[".ssh"]);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "b.pub",
            "a.pub",
            "id_ed25519",
            "Z.pub",
            "config",
            "é.pub",
            "pub",
        ] {
            std::fs::write(joined(&dir, &[name]), "x").unwrap();
        }
        assert_eq!(public_keys(&home), ["Z.pub", "a.pub", "b.pub", "é.pub"]);
        assert_eq!(
            public_keys(&joined(&home, &["missing"])),
            Vec::<String>::new()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    type Lines = BufReader<ReadHalf<DuplexStream>>;

    /// The core over an in-process pipe, as main speaks to it.
    async fn core() -> (Lines, WriteHalf<DuplexStream>) {
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        tokio::spawn(crate::serve(server_read, server_write, crate::registry()));
        let (client_read, client_write) = tokio::io::split(client);
        let mut lines = BufReader::new(client_read);
        let ready = next(&mut lines).await;
        assert_eq!(ready["event"], "ready");
        (lines, client_write)
    }

    async fn next(lines: &mut Lines) -> Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(30), lines.read_line(&mut line))
            .await
            .expect("the core sent nothing for 30 s")
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn send(write: &mut WriteHalf<DuplexStream>, id: u64, method: &str, params: Value) {
        let frame = format!(
            "{}\n",
            json!({ "id": id, "method": method, "params": params })
        );
        write.write_all(frame.as_bytes()).await.unwrap();
    }

    /// The answer to request `id` and the events that came before it.
    async fn answer_to(lines: &mut Lines, id: u64) -> (Value, Vec<Value>) {
        let mut events = Vec::new();
        loop {
            let frame = next(lines).await;
            if frame["id"] == id {
                return (frame, events);
            }
            events.push(frame);
        }
    }

    fn how(root: &str, ssh: &str) -> Value {
        json!({
            "ssh": ssh,
            "sshAdd": joined(root, &["no-such-ssh-add"]),
            "sshKeygen": joined(root, &["no-such-ssh-keygen"]),
            "env": {},
            "home": joined(root, &["home"]),
            "dir": joined(root, &["user", "ssh"]),
            "timeoutMs": 10_000,
        })
    }

    #[tokio::test]
    async fn starts_no_ssh_for_a_hostile_host_and_reports_one_that_cannot_start() {
        let root = temp("wire");
        let missing = joined(&root, &["no-such-ssh"]);
        let (mut lines, mut write) = core().await;
        let target = json!({ "name": "box", "host": "box.example" });
        let hostile = json!({ "name": "box", "host": "-oProxyCommand=touch pwned" });
        let run = |target: &Value, run: &str| {
            json!({
                "service": "wire", "run": run, "how": how(&root, &missing), "target": target,
                "promptTimeoutMs": 60_000, "localPort": 18080, "remotePort": 80, "pollSeconds": 5,
            })
        };

        send(
            &mut write,
            1,
            "ssh.plan",
            json!({ "target": hostile, "remotePort": 80, "localPort": 80 }),
        )
        .await;
        send(&mut write, 2, "ssh.forward", run(&hostile, "a")).await;
        send(&mut write, 3, "ssh.watch", run(&hostile, "b")).await;
        send(
            &mut write,
            4,
            "ssh.forgetHostKey",
            json!({ "how": how(&root, &missing), "target": hostile }),
        )
        .await;
        send(
            &mut write,
            5,
            "ssh.plan",
            json!({ "target": target, "remotePort": 80, "localPort": 70_000 }),
        )
        .await;
        for id in 1..=5 {
            let (answer, events) = answer_to(&mut lines, id).await;
            assert_eq!(answer["error"]["code"], "invalid_request", "{answer}");
            let message = if id == 5 {
                "Invalid port"
            } else {
                "Invalid host"
            };
            assert_eq!(answer["error"]["message"], message);
            assert!(events.is_empty(), "{events:?}");
        }
        // Nothing was made for a refused request: no folder, no config.
        assert!(!Path::new(&joined(&root, &["user"])).exists());

        send(
            &mut write,
            6,
            "ssh.plan",
            json!({ "target": target, "remotePort": 80, "localPort": 80 }),
        )
        .await;
        let (planned, _) = answer_to(&mut lines, 6).await;
        assert!(
            planned["result"]["localPort"].as_u64().unwrap() > 0,
            "{planned}"
        );

        // An ssh that is not there: the run starts, and its end says so in node's words.
        send(&mut write, 7, "ssh.forward", run(&target, "c")).await;
        let (started, mut events) = answer_to(&mut lines, 7).await;
        assert_eq!(started["ok"], true, "{started}");
        while !events.iter().any(|event| event["event"] == "ssh.exit") {
            events.push(next(&mut lines).await);
        }
        let exit = events
            .iter()
            .find(|event| event["event"] == "ssh.exit")
            .unwrap();
        assert_eq!(
            exit["data"],
            json!({
                "service": "wire", "run": "c",
                "failure": { "kind": "dropped", "message": format!("spawn {missing} ENOENT") },
            })
        );
        let config = std::fs::read_to_string(joined(&root, &["user", "ssh", "config"])).unwrap();
        assert!(config.starts_with("# Written by OMPdesk"));

        // A stop of a run that is gone and an answer to no question do nothing; a closed service starts nothing.
        send(
            &mut write,
            8,
            "ssh.stop",
            json!({ "service": "wire", "run": "c" }),
        )
        .await;
        send(
            &mut write,
            9,
            "ssh.answer",
            json!({ "service": "wire", "id": "none", "value": "x" }),
        )
        .await;
        send(&mut write, 10, "ssh.close", json!({ "service": "wire" })).await;
        for id in 8..=10 {
            assert_eq!(answer_to(&mut lines, id).await.0["ok"], true);
        }
        send(&mut write, 11, "ssh.watch", run(&target, "d")).await;
        assert_eq!(
            answer_to(&mut lines, 11).await.0["error"]["code"],
            "ssh_closed"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A stand-in ssh at `<root>/ssh`: a shell script that ignores ssh's arguments. It is written by a process of its
    /// own, so that no process this test binary starts meanwhile holds it open for writing (exec would refuse it).
    #[cfg(unix)]
    fn stand_in(root: &str, script: &str) -> String {
        std::fs::create_dir_all(root).unwrap();
        let path = joined(root, &["ssh"]);
        let written = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "printf '#!/bin/sh\\n%s\\n' \"$1\" > \"$2\" && chmod 755 \"$2\"",
                "sh",
                script,
                &path,
            ])
            .status()
            .unwrap();
        assert!(written.success());
        path
    }

    #[cfg(unix)]
    async fn event(lines: &mut Lines, name: &str) -> Value {
        loop {
            let frame = next(lines).await;
            if frame["event"] == name {
                return frame["data"].clone();
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_watch_tells_its_listings_and_is_gone_when_its_stop_is_answered_by_its_exit() {
        let root = temp("watch");
        let pid_file = joined(&root, &["pid"]);
        let ssh = stand_in(
            &root,
            &format!(
                "echo $$ > '{pid_file}'
printf 'LISTEN 0 1 127.0.0.1:22 x\\n__ompdesk_ports__\\nLISTEN 0 1 127.0.0.1:22 x\\n__ompdesk_ports__\\n'
printf 'LISTEN 0 1 [::]:3000 x\\nLISTEN 0 1 127.0.0.1:22 x\\n__ompdesk_ports__\\n'
echo 'debug1: noise' >&2
echo 'Connection to box closed by remote host.' >&2
exec sleep 600"
            ),
        );
        let (mut lines, mut write) = core().await;
        let start = json!({
            "service": "watching", "run": "w", "how": how(&root, &ssh),
            "target": { "name": "box", "host": "box.example" }, "promptTimeoutMs": 60_000, "pollSeconds": 5,
        });
        send(&mut write, 1, "ssh.watch", start).await;
        let first = event(&mut lines, "ssh.ports").await;
        assert_eq!(
            first,
            json!({ "service": "watching", "run": "w", "ports": [22], "opened": [] })
        );
        // The listing that repeats the first is not told.
        let second = event(&mut lines, "ssh.ports").await;
        assert_eq!(second["ports"], json!([22, 3000]));
        assert_eq!(second["opened"], json!([3000]));
        send(
            &mut write,
            2,
            "ssh.stop",
            json!({ "service": "watching", "run": "w" }),
        )
        .await;
        let exit = event(&mut lines, "ssh.exit").await;
        assert_eq!(
            exit["failure"],
            json!({ "kind": "dropped", "message": "Connection to box closed by remote host." })
        );
        let pid = std::fs::read_to_string(&pid_file).unwrap();
        let alive = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the ssh outlived the report of its end");
        send(&mut write, 3, "ssh.close", json!({ "service": "watching" })).await;
        assert_eq!(answer_to(&mut lines, 3).await.0["ok"], true);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_forward_that_ends_by_itself_says_why_and_a_close_ends_the_rest() {
        let root = temp("forward");
        let ssh = stand_in(
            &root,
            "case \"$*\" in
*refused.example*) echo 'me@box: Permission denied (publickey).' >&2; exit 255;;
*) exec sleep 600;;
esac",
        );
        let (mut lines, mut write) = core().await;
        let start = |run: &str, host: &str| {
            json!({
                "service": "forwarding", "run": run, "how": how(&root, &ssh),
                "target": { "name": "box", "host": host }, "promptTimeoutMs": 60_000,
                "localPort": 18081, "remotePort": 80,
            })
        };
        send(&mut write, 1, "ssh.forward", start("stays", "box.example")).await;
        send(
            &mut write,
            2,
            "ssh.forward",
            start("refused", "refused.example"),
        )
        .await;
        let exit = event(&mut lines, "ssh.exit").await;
        assert_eq!(
            exit,
            json!({
                "service": "forwarding", "run": "refused",
                "failure": { "kind": "refused", "message": "me@box: Permission denied (publickey)." },
            })
        );
        // The service's close ends the one that stays.
        send(
            &mut write,
            3,
            "ssh.close",
            json!({ "service": "forwarding" }),
        )
        .await;
        let exit = event(&mut lines, "ssh.exit").await;
        assert_eq!(exit["run"], "stays");
        assert_eq!(
            exit["failure"],
            json!({ "kind": "dropped", "message": "ssh exited" })
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn refuses_a_request_without_repeating_anything_of_it() {
        const SECRET: &str = "correct-horse-battery-staple";
        let root = temp("refusals");
        let (mut lines, mut write) = core().await;
        let mut env = how(&root, "ssh");
        env["env"] = json!({ "SSH_AUTH_TOKEN": SECRET, "BROKEN": 5 });
        let requests = [
            (
                "ssh.answer",
                json!({ "service": "s", "id": 7, "value": SECRET }),
            ),
            (
                "ssh.answer",
                json!({ "service": "s", "id": "p", "value": [SECRET] }),
            ),
            (
                "ssh.answer",
                json!({ "service": "s", "id": "p", "value": SECRET.repeat(200) }),
            ),
            ("ssh.answer", json!({ "service": "s", "value": SECRET })),
            ("ssh.agent", json!({ "how": env })),
            (
                "ssh.forward",
                json!({ "service": "s", "run": "r", "how": env, "target": { "name": SECRET, "host": 5 } }),
            ),
            (
                "ssh.plan",
                json!({ "target": { "name": "n", "host": SECRET, "port": SECRET }, "remotePort": 1, "localPort": 1 }),
            ),
        ];
        for (id, (method, params)) in (1..).zip(requests) {
            send(&mut write, id, method, params).await;
            let (answer, events) = answer_to(&mut lines, id).await;
            assert_eq!(
                answer["error"],
                json!({ "code": "invalid_request", "message": "Invalid SSH tools request" }),
                "{method}"
            );
            assert!(events.is_empty());
        }
    }
}
