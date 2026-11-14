//! Tailscale, for Mobile web and for sharing this computer with other OMPdesk computers (was the logic of
//! `src/main/tailscale/`): finding the CLI (`locate.rs`), running it, reading what it prints (`status.rs`, `whois.rs`,
//! `serve.rs`, `text.rs`) and the rules of publishing the page with `serve`; and Mobile web's state machine over them
//! (`service.rs`: the phases, the poll tick, install, sign-in, publish, unpublish). Main keeps what is its own: the
//! prefs, the setup item, the page's server and the browser the machine asks it for, the chain that runs its steps
//! one at a time and the poll's timer (`service.ts`). Computer sharing's brief caches of these reads are
//! `remote/tailnet.rs`'s.
//!
//! Main decides how the CLI runs and hands it over with every request (`tailscale`: the binary a lookup found, its
//! whole environment with the located CLI's own variables over it, the 10 s ceiling and the 4 MiB cap). This side
//! spawns and supervises through `run.rs`: no shell (a `.cmd` stand-in goes through cmd.exe, as std runs one), a
//! process past its ceiling asked to end, killed 2 s later and waited for. A run is reported as the TypeScript's
//! executor reported one (`Ran`): a CLI that fails, cannot start or is cut short is an answer, never a fault, because
//! Mobile web's phases are read from exactly that. Only a cancelled request fails.
//!
//! Decisions are made from `--json` output alone. Nothing here logs a request, an address, a login or the serve
//! secret; the secret travels in `target`, `current` and `secret` and goes nowhere but the CLI's own argument.

mod json;
mod locate;
mod serve;
mod service;
mod status;
mod text;
pub(crate) mod version;
mod whois;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fs::order::js_trim;
use crate::run::{Exec, Opts, Runner};
use crate::server::{Fault, Registry, Reply, Scope};

/// One run of the CLI, as the TypeScript's executor (`execFile`) reported one.
struct Ran {
    /// The exit code; none when the process did not exit by itself (its ceiling, an output past the cap) or could
    /// not start. A process a signal ended reads 1, as everywhere in this crate (node read none).
    code: Option<i32>,
    stdout: String,
    /// What it wrote there; when it wrote nothing and has no exit code, what node's error said.
    stderr: String,
    /// It could not be started (`ENOENT`, `EACCES`), or its output passed the cap.
    spawn_error: Option<String>,
}

impl Ran {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }

    fn line(&self) -> Option<String> {
        text::first_line(&self.stderr, &self.stdout).map(str::to_owned)
    }

    /// The `login.tailscale.com` link in what it said.
    fn login_url(&self) -> Option<String> {
        text::login_url(&format!("{}\n{}", self.stderr, self.stdout)).map(str::to_owned)
    }
}

/// The CLI runs of one request: main's runner, held to the request's scope.
struct Cli {
    exec: Exec,
    bin: String,
    scope: Scope,
}

impl Cli {
    fn new(runner: Runner, scope: Scope) -> Cli {
        Cli {
            bin: runner.bin.clone(),
            exec: Exec::new(runner, scope.clone(), "tailscale"),
            scope,
        }
    }

    async fn run(&self, args: &[&str], timeout_ms: Option<u64>) -> Result<Ran, Fault> {
        let opts = Opts {
            timeout_ms,
            ..Opts::default()
        };
        let ended = match self.exec.run_kept(".", args, opts).await {
            Ok(ended) => ended,
            // `spawn <bin> <code>`: node's own words, and its code.
            Err(fault) if fault.code == "spawn_failed" => {
                let code = fault.message.rsplit(' ').next().unwrap_or("UNKNOWN");
                return Ok(Ran {
                    code: None,
                    stdout: String::new(),
                    spawn_error: Some(code.to_owned()),
                    stderr: fault.message,
                });
            }
            Err(fault) => return Err(fault),
        };
        if self.scope.cancelled() {
            return Err(Fault::cancelled());
        }
        let stdout = ended.output.text();
        let (code, silent, spawn_error) = if ended.timed_out {
            let mut command = self.bin.clone();
            for arg in args {
                command.push(' ');
                command.push_str(arg);
            }
            (None, format!("Command failed: {command}\n"), None)
        } else if ended.output.truncated {
            (
                None,
                "stdout maxBuffer length exceeded".to_owned(),
                Some("ERR_CHILD_PROCESS_STDIO_MAXBUFFER".to_owned()),
            )
        } else {
            (Some(ended.output.code), String::new(), None)
        };
        let said = ended.output.stderr;
        Ok(Ran {
            code,
            stdout,
            stderr: if said.is_empty() { silent } else { said },
            spawn_error,
        })
    }

    /// `serve status --json` and the config it holds; none when the call failed or printed something else.
    async fn serve_config(&self) -> Result<(Ran, Option<serve::Config>), Fault> {
        let read = self.run(&["serve", "status", "--json"], None).await?;
        let config = read.ok().then(|| serve::parse(&read.stdout)).flatten();
        Ok((read, config))
    }
}

/// The CLI a lookup found: what every later request runs.
#[derive(Serialize)]
struct Located {
    path: String,
    variant: locate::Variant,
    /// The app bundle on macOS; none for a CLI-only daemon.
    app: Option<String>,
    /// Added to every call's environment (`TAILSCALE_BE_CLI=1` for a macOS app binary).
    env: BTreeMap<&'static str, &'static str>,
}

/// Which Tailscale a found CLI is and what its calls need in their environment: a Mac's app binary is a CLI only
/// with `TAILSCALE_BE_CLI=1`.
fn variant_and_env(
    platform: locate::Platform,
    app: Option<&str>,
    bundle_id: Option<&str>,
) -> (locate::Variant, Vec<(&'static str, &'static str)>) {
    match (platform, app) {
        (locate::Platform::Win32, _) => (locate::Variant::Windows, Vec::new()),
        (locate::Platform::Darwin, None) => (locate::Variant::MacCli, Vec::new()),
        (locate::Platform::Darwin, Some(_)) => (
            locate::mac_variant(bundle_id),
            vec![("TAILSCALE_BE_CLI", "1")],
        ),
    }
}

/// What a run outside the located CLI gets (`plutil`, the app's starter): main's environment and its limits.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    env: BTreeMap<String, String>,
    timeout_ms: u64,
    max_bytes: usize,
}

impl Rules {
    fn cli(self, bin: &str, scope: Scope) -> Cli {
        let runner = Runner {
            bin: bin.to_owned(),
            args: Vec::new(),
            env: self.env,
            timeout_ms: self.timeout_ms,
            max_bytes: self.max_bytes,
        };
        Cli::new(runner, scope)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocateParams {
    platform: locate::Platform,
    forced: Option<String>,
    pref: Option<String>,
    program_files: [Option<String>; 2],
    path_env: String,
    /// Whether to ask the app's bundle which Tailscale it is (machine setup only needs the path).
    bundle: bool,
    rules: Rules,
}

async fn locate(params: LocateParams, scope: Scope) -> Result<Option<Located>, Fault> {
    let LocateParams {
        platform,
        forced,
        pref,
        program_files,
        path_env,
        bundle,
        rules,
    } = params;
    let found = tokio::task::spawn_blocking(move || {
        let inputs = locate::Inputs {
            platform,
            forced: forced.as_deref(),
            pref: pref.as_deref(),
            program_files: [program_files[0].as_deref(), program_files[1].as_deref()],
            path_env: &path_env,
        };
        locate::find(&locate::Machine(platform), &inputs)
    })
    .await
    .map_err(|_| Fault::new("internal", "The lookup panicked"))?;
    let Some(found) = found else {
        return Ok(None);
    };
    // `CFBundleIdentifier`, read with `plutil` (it reads binary and XML plists alike).
    let bundle_id = match &found.app {
        Some(app) if bundle => {
            let plist = format!("{app}/Contents/Info.plist");
            let args = ["-extract", "CFBundleIdentifier", "raw", "-o", "-", &plist];
            let read = rules.cli("/usr/bin/plutil", scope).run(&args, None).await?;
            Some(js_trim(&read.stdout).to_owned()).filter(|id| read.ok() && !id.is_empty())
        }
        _ => None,
    };
    let (variant, env) = variant_and_env(platform, found.app.as_deref(), bundle_id.as_deref());
    Ok(Some(Located {
        path: found.path,
        variant,
        app: found.app,
        env: env.into_iter().collect(),
    }))
}

#[derive(Deserialize)]
struct CliParams {
    tailscale: Runner,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusAnswer {
    code: Option<i32>,
    spawn_error: Option<String>,
    /// The first line of what the call said, for a status that could not be read.
    line: Option<String>,
    /// The document it printed, whatever its exit code.
    status: Option<status::Status>,
    /// Why `serve` over HTTPS cannot work on the tailnet that document describes; none when it can.
    https_problem: Option<&'static str>,
}

async fn status(params: CliParams, scope: Scope) -> Result<StatusAnswer, Fault> {
    let read = Cli::new(params.tailscale, scope)
        .run(&["status", "--json"], None)
        .await?;
    let status = status::parse(&read.stdout);
    Ok(StatusAnswer {
        line: read.line(),
        https_problem: status.as_ref().and_then(status::Status::https_problem),
        status,
        code: read.code,
        spawn_error: read.spawn_error,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhoisParams {
    tailscale: Runner,
    /// A tailnet address; main checked that it is one.
    ip: String,
    timeout_ms: u64,
}

async fn whois(params: WhoisParams, scope: Scope) -> Result<Option<whois::Peer>, Fault> {
    // Whatever main checked, text that the CLI would read as an option never reaches it.
    if params.ip.starts_with('-') {
        return Err(Fault::new("invalid_params", "whois takes an address"));
    }
    let read = Cli::new(params.tailscale, scope)
        .run(&["whois", "--json", &params.ip], Some(params.timeout_ms))
        .await?;
    Ok(read.ok().then(|| whois::parse(&read.stdout)).flatten())
}

/// `status --json` for computer sharing's cache (`remote/tailnet.rs`): the document when the CLI exited 0 and
/// printed one, as the JSON main's `TailscaleStatus` types; none otherwise (a failed or unreadable run is the same to
/// it, and so is a cancelled one).
pub(crate) async fn read_status(runner: Runner, scope: Scope) -> Option<Value> {
    let answer = status(CliParams { tailscale: runner }, scope).await.ok()?;
    if answer.code != Some(0) {
        return None;
    }
    serde_json::to_value(answer.status?).ok()
}

/// `whois` of a tailnet address for the same cache: `{nodeId, nodeName, login}`, none when the CLI did not say.
pub(crate) async fn read_whois(runner: Runner, ip: &str, scope: Scope) -> Option<Value> {
    let params = WhoisParams {
        tailscale: runner,
        ip: ip.to_owned(),
        timeout_ms: WHOIS_TIMEOUT_MS,
    };
    serde_json::to_value(whois(params, scope).await.ok()??).ok()
}

/// A whois answers from the daemon's own netmap: slower than this is a daemon in trouble (`cli.ts`'s `WHOIS_TIMEOUT_MS`).
const WHOIS_TIMEOUT_MS: u64 = 4_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpParams {
    tailscale: Runner,
    /// `up --json` reports the sign-in link while it waits, so it is cut short at its ceiling and read then.
    json: bool,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpAnswer {
    code: Option<i32>,
    line: Option<String>,
    /// `AuthURL` of the first `--json` line that has one.
    auth_url: Option<String>,
    /// The `login.tailscale.com` link in what it said.
    login_url: Option<String>,
}

async fn up(params: UpParams, scope: Scope) -> Result<UpAnswer, Fault> {
    let args: &[&str] = if params.json {
        &["up", "--json"]
    } else {
        &["up"]
    };
    let ran = Cli::new(params.tailscale, scope)
        .run(args, params.timeout_ms)
        .await?;
    Ok(UpAnswer {
        code: ran.code,
        line: ran.line(),
        auth_url: params.json.then(|| text::auth_url(&ran.stdout)).flatten(),
        login_url: ran.login_url(),
    })
}

/// Read-only: the host of the control server this Tailscale signs in to, for a self-hosted tailnet's sign-in page.
async fn control_host(params: CliParams, scope: Scope) -> Result<Option<String>, Fault> {
    let read = Cli::new(params.tailscale, scope)
        .run(&["debug", "prefs"], None)
        .await?;
    Ok(read
        .ok()
        .then(|| text::control_host(&read.stdout))
        .flatten())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionParams {
    tailscale: Runner,
    timeout_ms: u64,
}

/// The installed version, for machine setup; none when the CLI does not say.
async fn version(params: VersionParams, scope: Scope) -> Result<Option<String>, Fault> {
    let read = Cli::new(params.tailscale, scope)
        .run(&["version"], Some(params.timeout_ms))
        .await?;
    Ok(read
        .ok()
        .then(|| text::version(&read.stdout).map(str::to_owned))
        .flatten())
}

#[derive(Deserialize)]
struct PublishParams {
    tailscale: Runner,
    /// This machine's MagicDNS name.
    host: String,
    /// The full proxy URL, secret path included.
    target: String,
    /// `target` without the secret path: what a record holds.
    base: String,
    /// The pref `mobileWeb.serve`, whatever it holds.
    record: Value,
    /// The first port to try.
    first: u32,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Publish {
    /// The serve configuration could not be read, or no port is free.
    Blocked { detail: String },
    /// The internet may reach the port: nothing is served there. `ours`: the handler on it is OMPdesk's.
    Exposed { port: u32, ours: bool },
    /// `serve` refused; `guide` is the page it named ("enable HTTPS").
    Refused {
        detail: String,
        guide: Option<String>,
    },
    /// Our handler is already there with this target.
    Reuse { port: u32 },
    /// `serve` took the command; `tailscale.confirm` says whether the handler is in place.
    Published { port: u32 },
}

/// Publishes `https://<host>:<port>` to the tailnet, proxied to `target`: reads the configuration, picks the port
/// (ours again, else the first free one) and runs `serve --bg --https=<port> <target>`. Only ever our own port.
async fn publish(params: PublishParams, scope: Scope) -> Result<Publish, Fault> {
    let cli = Cli::new(params.tailscale, scope);
    let (read, config) = cli.serve_config().await?;
    let Some(config) = config else {
        let detail = read.line();
        return Ok(Publish::Blocked {
            detail: detail.unwrap_or_else(|| "Could not read the serve configuration".into()),
        });
    };
    let record = serve::read_record(&params.record);
    let host = params.host.as_str();
    let port = match config.plan(host, &params.target, record.as_ref(), params.first) {
        serve::Plan::None => {
            return Ok(Publish::Blocked {
                detail: "No free port for the page on this machine".into(),
            });
        }
        serve::Plan::Reuse(port) | serve::Plan::Publish(port) if config.exposed(host, port) => {
            let here = serve::Record {
                host: params.host.clone(),
                port,
                target: params.base,
            };
            let ours = config.handler_is_ours(&here, &params.target);
            return Ok(Publish::Exposed { port, ours });
        }
        serve::Plan::Reuse(port) => return Ok(Publish::Reuse { port }),
        serve::Plan::Publish(port) => port,
    };
    let https = format!("--https={port}");
    let ran = cli
        .run(&["serve", "--bg", &https, &params.target], None)
        .await?;
    if !ran.ok() {
        return Ok(Publish::Refused {
            detail: ran
                .line()
                .unwrap_or_else(|| "tailscale serve failed".into()),
            guide: ran.login_url(),
        });
    }
    Ok(Publish::Published { port })
}

#[derive(Deserialize)]
struct ConfirmParams {
    tailscale: Runner,
    host: String,
    port: u32,
    base: String,
    target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum Confirm {
    Ready,
    /// Tailscale accepted the command, but the handler is not in place.
    Missing,
    /// The handler is there and the internet may reach it.
    Exposed,
}

/// After a publish: the handler on our port proxies to exactly `target`, and only the tailnet reaches it.
async fn confirm(params: ConfirmParams, scope: Scope) -> Result<Confirm, Fault> {
    let (_, config) = Cli::new(params.tailscale, scope).serve_config().await?;
    let record = serve::Record {
        host: params.host,
        port: params.port,
        target: params.base,
    };
    let in_place = config
        .as_ref()
        .is_some_and(|config| config.own_proxy(&record, &params.target) == Some(&params.target));
    Ok(match config {
        Some(config) if in_place => {
            if config.exposed(&record.host, record.port) {
                Confirm::Exposed
            } else {
                Confirm::Ready
            }
        }
        _ => Confirm::Missing,
    })
}

#[derive(Deserialize)]
struct UnpublishParams {
    tailscale: Runner,
    /// The pref `mobileWeb.serve`, whatever it holds.
    record: Value,
    /// The secret path now in force.
    secret: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Unpublish {
    /// No record: nothing was published.
    None,
    /// The handler is no longer exactly what the record says: only the record goes.
    RecordDropped,
    Removed,
    /// `off`: the handler was taken down before this failed, so the record goes; else it stays (the handler may
    /// still be there).
    Failed {
        detail: String,
        off: bool,
    },
}

/// Takes our handler down (`serve --https=<port> off`): only when the record matches what is there exactly, and then
/// checks that the user's other handlers are as they were.
async fn unpublish(params: UnpublishParams, scope: Scope) -> Result<Unpublish, Fault> {
    let Some(record) = serve::read_record(&params.record) else {
        return Ok(Unpublish::None);
    };
    let cli = Cli::new(params.tailscale, scope);
    let failed = |detail: Option<String>, fallback: &str, off: bool| Unpublish::Failed {
        detail: detail.unwrap_or_else(|| fallback.to_owned()),
        off,
    };
    let (read, before) = cli.serve_config().await?;
    let Some(before) = before else {
        return Ok(failed(
            read.line(),
            "Could not read the serve configuration",
            false,
        ));
    };
    let current = format!("{}/{}", record.target, params.secret);
    if !before.handler_is_ours(&record, &current) {
        return Ok(Unpublish::RecordDropped);
    }
    let https = format!("--https={}", record.port);
    let off = cli.run(&["serve", &https, "off"], None).await?;
    if !off.ok() {
        return Ok(failed(off.line(), "tailscale serve off failed", false));
    }
    let (_, after) = cli.serve_config().await?;
    Ok(match after {
        None => failed(
            None,
            "Could not confirm that the serve handler was removed",
            true,
        ),
        Some(after) if !after.same(&before.without_port(record.port)) => failed(
            None,
            "Tailscale's serve configuration is not what it should be after removing OMPdesk's handler",
            true,
        ),
        Some(_) => Unpublish::Removed,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    platform: locate::Platform,
    /// A test's stand-in for "start the Tailscale app", run instead, so a test never starts the user's own.
    stand_in: Option<String>,
    /// The located CLI's app bundle.
    app: Option<String>,
    rules: Rules,
}

#[derive(Serialize)]
struct Started {
    code: Option<i32>,
    line: Option<String>,
}

/// Starts the Tailscale app: `open -a <bundle>` on macOS. Windows' tray app has to outlive OMPdesk, and every
/// process this one starts ends with it, so main starts that one itself.
async fn start_app(params: StartParams, scope: Scope) -> Result<Started, Fault> {
    let ran = match (params.stand_in, params.platform, params.app) {
        (Some(stand_in), ..) => params.rules.cli(&stand_in, scope).run(&[], None).await?,
        (None, locate::Platform::Darwin, Some(app)) => {
            let open = params.rules.cli("/usr/bin/open", scope);
            open.run(&["-a", &app], None).await?
        }
        (None, locate::Platform::Darwin, None) => {
            return Ok(Started {
                code: Some(1),
                line: Some(
                    "This Tailscale has no app to start: start its daemon (tailscaled) yourself"
                        .into(),
                ),
            });
        }
        (None, locate::Platform::Win32, _) => {
            return Err(Fault::new(
                "unsupported",
                "Windows' Tailscale app is started by main",
            ));
        }
    };
    Ok(Started {
        code: ran.code,
        line: ran.line(),
    })
}

/// A method whose handler is an async function from its params and the request's scope to its answer.
macro_rules! method {
    ($registry:expr, $name:literal, $handler:path) => {
        $registry.add($name, |call| {
            Box::pin(async move {
                let params = call.params()?;
                Reply::json(&$handler(params, call.scope).await?)
            })
        })
    };
}

pub fn register(registry: &mut Registry) {
    method!(registry, "tailscale.locate", locate);
    method!(registry, "tailscale.status", status);
    method!(registry, "tailscale.whois", whois);
    method!(registry, "tailscale.up", up);
    method!(registry, "tailscale.controlHost", control_host);
    method!(registry, "tailscale.version", version);
    method!(registry, "tailscale.publish", publish);
    method!(registry, "tailscale.confirm", confirm);
    method!(registry, "tailscale.unpublish", unpublish);
    method!(registry, "tailscale.startApp", start_app);
    service::register(registry);
}

#[cfg(test)]
mod tests {
    use serde::de::DeserializeOwned;

    use super::*;

    /// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted.
    pub fn captured<T: DeserializeOwned>(table: &str) -> T {
        let mut tables: BTreeMap<String, Value> =
            serde_json::from_str(include_str!("captured.json")).unwrap();
        serde_json::from_value(tables.remove(table).unwrap())
            .unwrap_or_else(|error| panic!("{table}: {error}"))
    }

    fn runner(bin: &str, args: &[&str], timeout_ms: u64, max_bytes: usize) -> Runner {
        Runner {
            bin: bin.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: std::env::vars().collect(),
            timeout_ms,
            max_bytes,
        }
    }

    #[tokio::test]
    async fn reports_a_cli_that_cannot_start_as_node_did() {
        let missing = std::env::temp_dir().join("ompdesk-core-no-such-tailscale");
        let missing = missing.to_string_lossy().into_owned();
        let cli = Cli::new(runner(&missing, &[], 10_000, 1024), Scope::detached());
        let ran = cli.run(&["status", "--json"], None).await.unwrap();
        assert_eq!(ran.code, None);
        assert_eq!(ran.spawn_error.as_deref(), Some("ENOENT"));
        assert_eq!(ran.stderr, format!("spawn {missing} ENOENT"));
        assert_eq!(ran.line(), Some(format!("spawn {missing} ENOENT")));
        let answer = status(
            CliParams {
                tailscale: runner(&missing, &[], 10_000, 1024),
            },
            Scope::detached(),
        )
        .await
        .unwrap();
        assert!(answer.status.is_none());
        assert_eq!(answer.spawn_error.as_deref(), Some("ENOENT"));
    }

    /// A stand-in CLI: `sh -c <script>` with the call's own arguments after it.
    #[cfg(unix)]
    fn shell(script: &str, timeout_ms: u64, max_bytes: usize) -> Runner {
        runner("/bin/sh", &["-c", script], timeout_ms, max_bytes)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_a_run_as_the_typescript_s_executor_did() {
        let run = async |script: &str, timeout_ms: u64, max_bytes: usize| {
            Cli::new(shell(script, timeout_ms, max_bytes), Scope::detached())
                .run(&["serve", "status"], None)
                .await
                .unwrap()
        };
        let ok = run("printf out; printf err >&2", 10_000, 1024).await;
        assert_eq!(
            (ok.code, ok.stdout.as_str(), ok.stderr.as_str()),
            (Some(0), "out", "err")
        );
        assert!(ok.ok() && ok.spawn_error.is_none());
        let failed = run("printf o; printf 'e\\n' >&2; exit 3", 10_000, 1024).await;
        assert_eq!(
            (failed.code, failed.line().as_deref()),
            (Some(3), Some("e"))
        );
        let quiet = run("exit 3", 10_000, 1024).await;
        assert_eq!((quiet.code, quiet.line()), (Some(3), None));
        // Past its ceiling: what it printed is kept, and with nothing on stderr node's message stands in.
        let cut = run("echo printed; exec sleep 30", 300, 1024).await;
        assert_eq!((cut.code, cut.stdout.as_str()), (None, "printed\n"));
        assert_eq!(cut.stderr, "Command failed: /bin/sh serve status\n");
        assert!(cut.spawn_error.is_none());
        let waiting = run("echo waiting >&2; exec sleep 30", 300, 1024).await;
        assert_eq!(
            (waiting.code, waiting.line().as_deref()),
            (None, Some("waiting"))
        );
        // Past the cap: node's code and words.
        let flood = run("printf 0123456789; exec sleep 30", 10_000, 5).await;
        assert_eq!((flood.code, flood.stdout.as_str()), (None, "01234"));
        assert_eq!(
            flood.spawn_error.as_deref(),
            Some("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        );
        assert_eq!(flood.stderr, "stdout maxBuffer length exceeded");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_the_sign_in_link_of_an_up_that_is_cut_short() {
        let script = r#"echo '{"BackendState":"NeedsLogin"}'; echo '{"AuthURL":"https://login.tailscale.com/a/1"}'; printf '{"Auth'; exec sleep 30"#;
        let params = UpParams {
            tailscale: shell(script, 10_000, 1024),
            json: true,
            timeout_ms: Some(300),
        };
        let answer = up(params, Scope::detached()).await.unwrap();
        assert_eq!(answer.code, None);
        assert_eq!(
            answer.auth_url.as_deref(),
            Some("https://login.tailscale.com/a/1")
        );
        assert_eq!(
            answer.login_url.as_deref(),
            Some("https://login.tailscale.com/a/1")
        );
        let plain = UpParams {
            tailscale: shell(
                "printf '\\nTo authenticate, visit:\\n\\n\\thttps://login.tailscale.com/a/2\\n' >&2",
                10_000,
                1024,
            ),
            json: false,
            timeout_ms: None,
        };
        let answer = up(plain, Scope::detached()).await.unwrap();
        assert_eq!((answer.code, answer.auth_url), (Some(0), None));
        assert_eq!(
            answer.login_url.as_deref(),
            Some("https://login.tailscale.com/a/2")
        );
        assert_eq!(answer.line.as_deref(), Some("To authenticate, visit:"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_request_fails_and_an_option_is_never_an_address() {
        let scope = Scope::detached();
        scope.cancel();
        let fault = Cli::new(shell("echo x", 10_000, 1024), scope)
            .run(&[], None)
            .await
            .err()
            .unwrap();
        assert_eq!(fault, Fault::cancelled());
        let params = WhoisParams {
            tailscale: shell("echo ran", 10_000, 1024),
            ip: "--help".into(),
            timeout_ms: 4_000,
        };
        let fault = whois(params, Scope::detached()).await.err().unwrap();
        assert_eq!(fault.code, "invalid_params");
    }
}
