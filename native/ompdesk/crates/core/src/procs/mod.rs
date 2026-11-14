//! The processes of OMPdesk's sessions (`procs.list`, `procs.end`). Main gives every omp it spawns an environment
//! variable holding the session's tag. Every descendant inherits it, however deep and after its parent died, so a
//! process's environment names its session where its parentage no longer can. `procs.list` names every process of
//! this computer with its tag, so main can say whose the largest processes are when memory runs short; `procs.end`
//! ends what a closed session left running, asking politely first and forcing what is left.
//!
//! Reading another process's environment and command line: Windows reads the process's own memory (its PEB's
//! `RTL_USER_PROCESS_PARAMETERS`, `sys.rs`), macOS asks `sysctl(KERN_PROCARGS2)`, Linux (tests and CI) reads
//! `/proc/<pid>/environ` and `cmdline`. The list is a Toolhelp32 snapshot on Windows and
//! `ps -axo pid=,ppid=,rss=,etime=,comm=` elsewhere. A process this user may not read (another user's, an elevated or
//! a protected one), a zombie and one that exited have no readable environment and so no tag: never a target, and a
//! target that becomes one counts as gone. macOS and Linux show the environment a process was started with, Windows
//! the one it holds now.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::memory::blocking;
use crate::server::{Fault, Registry, Reply, Scope};

/// How many times `procs.end` scans and ends: a supervisor may start a tagged process again once its child ended.
const ROUNDS: usize = 5;
/// How often the polite wait looks whether what was asked is gone.
const GRACE_POLL: Duration = Duration::from_millis(100);
/// How often the wait after the force looks: a killed process is gone within milliseconds.
const FORCED_POLL: Duration = Duration::from_millis(10);
/// Never signalled: the idle process and `System` (Windows), the kernel and init or launchd (Unix).
const PROTECTED: [u32; 3] = [0, 1, 4];
/// `ps` output kept, as `memory.processes` keeps.
#[cfg(unix)]
const PS_MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListParams {
    pub(crate) env: String,
    pub(crate) timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EndParams {
    pub(crate) env: String,
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) keep_arg: Option<String>,
    pub(crate) grace_ms: u64,
    pub(crate) timeout_ms: u64,
}

/// One process as a scan saw it, and a row of `procs.list`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Row {
    pid: u32,
    ppid: u32,
    /// Resident bytes (Windows: the working set); 0 when unreadable.
    bytes: u64,
    /// When it started, in ms since the Unix epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    started_ms: Option<u64>,
    /// Its executable's file name.
    name: String,
    /// The asked variable's value in its environment, when that could be read and holds one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tag: Option<String>,
    /// Its command line's arguments, read only where `procs.end` checks `keepArg`.
    #[serde(skip)]
    args: Vec<String>,
    /// The handle its environment was read through, which `procs.end` ends it through.
    #[cfg(windows)]
    #[serde(skip)]
    process: Option<crate::sys::Process>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Ended {
    pub(crate) pid: u32,
    pub(crate) name: String,
    pub(crate) bytes: u64,
    /// It still ran when the force reached it.
    pub(crate) forced: bool,
}

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct Named {
    pub(crate) pid: u32,
    pub(crate) name: String,
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct Report {
    pub(crate) ended: Vec<Ended>,
    /// Targets still running at the end.
    pub(crate) left: Vec<Named>,
    /// Shared workers (`keepArg`) and what they started, never signalled.
    pub(crate) kept: Vec<Named>,
    /// Asked tags this process or one of its ancestors carries: the app itself runs under them, so nothing with one
    /// of them was touched.
    pub(crate) own: Vec<String>,
}

pub fn register(registry: &mut Registry) {
    registry.add("procs.list", |call| {
        Box::pin(async move {
            let params: ListParams = call.params()?;
            Reply::json(&list(params, call.scope).await?)
        })
    });
    registry.add("procs.end", |call| {
        Box::pin(async move {
            let params: EndParams = call.params()?;
            Reply::json(&end(params, call.scope).await?)
        })
    });
}

/// A name a variable can have: not empty, no `=` (which ends a name) and no NUL (which ends an entry).
fn check_env(env: &str) -> Result<(), Fault> {
    if env.is_empty() || env.contains(['=', '\0']) {
        return Err(Fault::new(
            "invalid_params",
            format!("{env:?} is no environment variable name"),
        ));
    }
    Ok(())
}

/// A session's tag as main makes them: 32 lowercase hex digits. Anything else is a caller's mistake, refused before it
/// can end anything.
fn check_tag(tag: &str) -> Result<(), Fault> {
    if tag.len() == 32
        && tag
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Ok(());
    }
    Err(Fault::new(
        "invalid_params",
        format!("{tag:?} is no session tag"),
    ))
}

pub(crate) async fn list(params: ListParams, scope: Scope) -> Result<Vec<Row>, Fault> {
    check_env(&params.env)?;
    scan(&params.env, params.timeout_ms, scope, HashSet::new()).await
}

pub(crate) async fn end(params: EndParams, scope: Scope) -> Result<Report, Fault> {
    check_env(&params.env)?;
    for tag in &params.tags {
        check_tag(tag)?;
    }
    if params.keep_arg.as_deref() == Some("") {
        return Err(Fault::new(
            "invalid_params",
            "keepArg is empty, which every argument starts with",
        ));
    }
    let deadline = Instant::now() + Duration::from_millis(params.timeout_ms);
    let grace = Duration::from_millis(params.grace_ms);
    let tags: HashSet<String> = params.tags.into_iter().collect();
    let args_of = if params.keep_arg.is_some() {
        tags.clone()
    } else {
        HashSet::new()
    };
    let me = std::process::id();
    let mut ender = Ender::new(&params.env);
    let mut report = Report::default();
    let mut own = BTreeSet::new();
    let mut running = Vec::new();
    for round in 0..=ROUNDS {
        if scope.cancelled() {
            return Err(Fault::cancelled());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if round > 0 && remaining.is_zero() {
            break;
        }
        let timeout_ms = u64::try_from(remaining.as_millis())
            .unwrap_or(u64::MAX)
            .max(1);
        let rows = match scan(&params.env, timeout_ms, scope.clone(), args_of.clone()).await {
            Ok(rows) => rows,
            Err(fault) if round == 0 => return Err(fault),
            // What earlier rounds left running is what is known.
            Err(_) => break,
        };
        let plan = plan(&rows, me, &tags, params.keep_arg.as_deref());
        own.extend(plan.own);
        for &kept in &plan.kept {
            let row = &rows[kept];
            if !report.kept.iter().any(|named| named.pid == row.pid) {
                report.kept.push(Named {
                    pid: row.pid,
                    name: row.name.clone(),
                });
            }
        }
        let targets: Vec<Target> = rows
            .into_iter()
            .enumerate()
            .filter(|(index, _)| plan.targets.binary_search(index).is_ok())
            .filter_map(|(_, row)| Target::of(row))
            .collect();
        if targets.is_empty() || round == ROUNDS {
            running = targets.into_iter().map(Target::named).collect();
            break;
        }
        let (ended, left) = end_round(&mut ender, targets, grace, deadline).await;
        report.ended.extend(ended);
        running = left;
    }
    report.left = running;
    report.own = own.into_iter().collect();
    Ok(report)
}

/// What one scan decides, by index into its rows.
#[derive(Debug, Default, PartialEq)]
struct Plan {
    /// To end, in index order.
    targets: Vec<usize>,
    /// Left alone for `keepArg`: each shared worker and what it started.
    kept: Vec<usize>,
    /// Asked tags this process or an ancestor carries.
    own: BTreeSet<String>,
}

/// Which of `rows` to end for `tags`, from this process `me`: a process carrying one of them, unless that tag is this
/// process's or an ancestor's own (the app runs under it), it is a shared worker or one of its descendants, or it is
/// this process, an ancestor or a protected pid.
fn plan(rows: &[Row], me: u32, tags: &HashSet<String>, keep_arg: Option<&str>) -> Plan {
    let lineage = lineage(rows, me);
    let own: BTreeSet<String> = lineage
        .iter()
        .filter_map(|&index| rows[index].tag.clone())
        .filter(|tag| tags.contains(tag))
        .collect();
    let wanted = |row: &Row| {
        row.tag
            .as_ref()
            .is_some_and(|tag| tags.contains(tag) && !own.contains(tag))
    };
    let keepers: Vec<usize> = keep_arg.map_or_else(Vec::new, |prefix| {
        (0..rows.len())
            .filter(|&index| {
                wanted(&rows[index]) && rows[index].args.iter().any(|arg| arg.starts_with(prefix))
            })
            .collect()
    });
    let kept = descendants(rows, &keepers);
    let targets = (0..rows.len())
        .filter(|index| {
            let row = &rows[*index];
            wanted(row)
                && !kept.contains(index)
                && !lineage.contains(index)
                && row.pid != me
                && !PROTECTED.contains(&row.pid)
        })
        .collect();
    Plan {
        targets,
        kept: kept.into_iter().collect(),
        own,
    }
}

/// Whether `parent` started `child`: its id is the child's parent id, and it did not start after the child (Windows
/// gives a dead process's id to a later one, which cannot be the parent of a process older than itself). A start that
/// could not be read does not count against it.
fn begot(parent: &Row, child: &Row) -> bool {
    parent.pid == child.ppid
        && parent.pid != child.pid
        && match (parent.started_ms, child.started_ms) {
            (Some(parent), Some(child)) => parent <= child,
            _ => true,
        }
}

/// `me` and its ancestors, nearest first, by index.
fn lineage(rows: &[Row], me: u32) -> Vec<usize> {
    let by_pid: HashMap<u32, usize> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| (row.pid, index))
        .collect();
    let mut chain = Vec::new();
    let mut at = by_pid.get(&me).copied();
    while let Some(index) = at {
        if chain.contains(&index) {
            break;
        }
        chain.push(index);
        at = by_pid
            .get(&rows[index].ppid)
            .copied()
            .filter(|&parent| begot(&rows[parent], &rows[index]));
    }
    chain
}

/// `roots` and every process they started, and so on down, by index.
fn descendants(rows: &[Row], roots: &[usize]) -> BTreeSet<usize> {
    let mut found: BTreeSet<usize> = roots.iter().copied().collect();
    if roots.is_empty() {
        return found;
    }
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        children.entry(row.ppid).or_default().push(index);
    }
    let mut stack = roots.to_vec();
    while let Some(index) = stack.pop() {
        for &child in children.get(&rows[index].pid).into_iter().flatten() {
            if begot(&rows[index], &rows[child]) && found.insert(child) {
                stack.push(child);
            }
        }
    }
    found
}

/// What a process that is gone left behind, by index: each process whose parent id is `pid`, that started at or after
/// `started_ms` (when the gone one did), and that no process holding `pid` now started. Windows keeps a dead parent's
/// id in its children and hands the id to a later process, which did not start what is older than itself. A start
/// that could not be read never makes an orphan.
#[cfg(any(windows, test))]
fn orphans(rows: &[Row], pid: u32, started_ms: u64) -> Vec<usize> {
    (0..rows.len())
        .filter(|&index| {
            let row = &rows[index];
            row.ppid == pid
                && row.pid != pid
                && row.started_ms.is_some_and(|started| started >= started_ms)
                && !rows
                    .iter()
                    .any(|holder| holder.pid == pid && begot(holder, row))
        })
        .collect()
}

/// Every process of this computer at one moment, each opened to end it where this user may: what `taskkill /t`
/// walks, read without it (which needs WMI). A process is ended through the handle taken here, so a pid that names
/// another process later is never hit.
#[cfg(windows)]
pub(crate) struct Snapshot {
    rows: Vec<Row>,
}

#[cfg(windows)]
impl Snapshot {
    pub(crate) fn take() -> std::io::Result<Snapshot> {
        let rows = crate::sys::processes(true)?
            .into_iter()
            .map(|entry| Row {
                pid: entry.pid,
                ppid: entry.parent,
                bytes: entry.working_set,
                started_ms: entry.started_ms,
                name: entry.image,
                tag: None,
                args: Vec::new(),
                process: entry.process,
            })
            .collect();
        Ok(Snapshot { rows })
    }

    pub(crate) fn pid(&self, index: usize) -> u32 {
        self.rows[index].pid
    }

    /// The process `pid` that started at `started_ms`, if it runs.
    pub(crate) fn find(&self, pid: u32, started_ms: u64) -> Option<usize> {
        self.rows
            .iter()
            .position(|row| row.pid == pid && row.started_ms == Some(started_ms))
    }

    /// What the process `pid` that started at `started_ms` and is gone left behind (`orphans`), of that only the
    /// processes whose command line holds `text`. One whose command line cannot be read is not among them.
    pub(crate) fn orphans_holding(&self, pid: u32, started_ms: u64, text: &str) -> Vec<usize> {
        orphans(&self.rows, pid, started_ms)
            .into_iter()
            .filter(|&index| {
                self.rows[index]
                    .process
                    .as_ref()
                    .and_then(crate::sys::Process::command_line)
                    .is_some_and(|line| String::from_utf16_lossy(&line).contains(text))
            })
            .collect()
    }

    /// `root` and every process it started, and so on down, each taken out of the snapshot to end it, the root first.
    /// Empty when the root cannot be opened to end it; a descendant that cannot be is left out.
    pub(crate) fn take_tree(&mut self, root: usize) -> Vec<crate::sys::Process> {
        let found = descendants(&self.rows, &[root]);
        let Some(first) = self.rows[root].process.take() else {
            return Vec::new();
        };
        let mut tree = vec![first];
        tree.extend(
            found
                .into_iter()
                .filter_map(|index| self.rows[index].process.take()),
        );
        tree
    }
}

/// A process one round ends.
struct Target {
    pid: u32,
    name: String,
    bytes: u64,
    /// Its tag when scanned: Unix signals the pid only while it still carries it.
    #[cfg(unix)]
    tag: String,
    /// The handle its environment was read through: Windows ends it through that.
    #[cfg(windows)]
    process: crate::sys::Process,
}

impl Target {
    fn of(row: Row) -> Option<Target> {
        Some(Target {
            pid: row.pid,
            name: row.name,
            bytes: row.bytes,
            #[cfg(unix)]
            tag: row.tag?,
            #[cfg(windows)]
            process: row.process?,
        })
    }

    fn named(self) -> Named {
        Named {
            pid: self.pid,
            name: self.name,
        }
    }
}

/// Asks the targets to end, waits up to `grace` for those asked to go, forces the rest and waits for those forced,
/// never past `deadline`: what ended, and what still runs.
async fn end_round(
    ender: &mut Ender,
    targets: Vec<Target>,
    grace: Duration,
    deadline: Instant,
) -> (Vec<Ended>, Vec<Named>) {
    let asked = ender.ask(&targets);
    let polite_until = deadline.min(Instant::now() + grace);
    while asked.iter().any(|&index| ender.running(&targets[index])) {
        if !sleep_until(polite_until, GRACE_POLL).await {
            break;
        }
    }
    let forced: Vec<bool> = targets.iter().map(|target| ender.force(target)).collect();
    while targets
        .iter()
        .zip(&forced)
        .any(|(target, &forced)| forced && ender.running(target))
    {
        if !sleep_until(deadline, FORCED_POLL).await {
            break;
        }
    }
    let mut ended = Vec::new();
    let mut left = Vec::new();
    for (target, forced) in targets.into_iter().zip(forced) {
        if ender.running(&target) {
            left.push(target.named());
        } else {
            ended.push(Ended {
                pid: target.pid,
                name: target.name,
                bytes: target.bytes,
                forced,
            });
        }
    }
    (ended, left)
}

/// Sleeps `step`, or until `until` when that is sooner; false, without sleeping, once `until` passed.
async fn sleep_until(until: Instant, step: Duration) -> bool {
    let now = Instant::now();
    if now >= until {
        return false;
    }
    tokio::time::sleep(step.min(until - now)).await;
    true
}

/// How a round asks, looks at and forces its targets.
#[cfg(unix)]
struct Ender {
    env: String,
    reader: Reader,
}

#[cfg(unix)]
impl Ender {
    fn new(env: &str) -> Ender {
        Ender {
            env: env.to_owned(),
            reader: Reader::default(),
        }
    }

    /// Whether the target's pid still carries its tag, read again at the point of risk: a pid that exited, became a
    /// zombie or now names another process does not, and is never signalled.
    fn running(&mut self, target: &Target) -> bool {
        self.reader.tag(target.pid, &self.env).as_deref() == Some(target.tag.as_str())
    }

    /// SIGTERM to every target still running; the indices of those that got it.
    fn ask(&mut self, targets: &[Target]) -> Vec<usize> {
        (0..targets.len())
            .filter(|&index| {
                self.running(&targets[index]) && crate::sys::signal(targets[index].pid, false)
            })
            .collect()
    }

    /// SIGKILL to the target if it still runs; whether it got it.
    fn force(&mut self, target: &Target) -> bool {
        self.running(target) && crate::sys::signal(target.pid, true)
    }
}

/// How a round asks, looks at and forces its targets.
#[cfg(windows)]
struct Ender;

#[cfg(windows)]
impl Ender {
    fn new(_env: &str) -> Ender {
        Ender
    }

    fn running(&mut self, target: &Target) -> bool {
        !target.process.exited()
    }

    /// `WM_CLOSE` to the targets' windows; the indices of those that had one. A console program cannot be asked, so a
    /// round with only those forces at once.
    fn ask(&mut self, targets: &[Target]) -> Vec<usize> {
        let pids: Vec<u32> = targets.iter().map(|target| target.pid).collect();
        let asked = crate::sys::ask_to_close(&pids);
        (0..targets.len())
            .filter(|&index| asked.contains(&targets[index].pid))
            .collect()
    }

    /// `TerminateProcess` through the handle the target was read through, if it still runs; whether Windows took it.
    fn force(&mut self, target: &Target) -> bool {
        !target.process.exited() && target.process.terminate()
    }
}

/// Every process of this computer with `env`'s value from its environment, and the command line of each whose tag is
/// in `args_of`. `timeout_ms` is how long `ps` may run.
#[cfg(unix)]
async fn scan(
    env: &str,
    timeout_ms: u64,
    scope: Scope,
    args_of: HashSet<String>,
) -> Result<Vec<Row>, Fault> {
    let text = crate::memory::program(
        "/bin/ps",
        &["-axo", "pid=,ppid=,rss=,etime=,comm="],
        PS_MAX_BYTES,
        timeout_ms,
        scope,
    )
    .await?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        });
    let env = env.to_owned();
    blocking(move || {
        let mut reader = Reader::default();
        let mut rows = parse_ps(&text, now_ms);
        for row in &mut rows {
            row.tag = reader.tag(row.pid, &env);
            if row.tag.as_ref().is_some_and(|tag| args_of.contains(tag)) {
                row.args = reader.arguments(row.pid);
            }
        }
        Ok(rows)
    })
    .await
}

/// Every process of this computer with `env`'s value from its environment, and the command line of each whose tag is
/// in `args_of`.
#[cfg(windows)]
async fn scan(
    env: &str,
    _timeout_ms: u64,
    _scope: Scope,
    args_of: HashSet<String>,
) -> Result<Vec<Row>, Fault> {
    let name: Vec<u16> = env.encode_utf16().collect();
    blocking(move || {
        Ok(crate::sys::processes(true)?
            .into_iter()
            .map(|entry| {
                let tag = entry
                    .process
                    .as_ref()
                    .and_then(crate::sys::Process::environment)
                    .and_then(|block| block_tag(&block, &name));
                let args = match (&entry.process, &tag) {
                    (Some(process), Some(tag)) if args_of.contains(tag) => process
                        .command_line()
                        .map(|line| command_line_args(&line))
                        .unwrap_or_default(),
                    _ => Vec::new(),
                };
                Row {
                    pid: entry.pid,
                    ppid: entry.parent,
                    bytes: entry.working_set,
                    started_ms: entry.started_ms,
                    name: entry.image,
                    tag,
                    args,
                    process: entry.process,
                }
            })
            .collect())
    })
    .await
}

/// Reads a process's environment and arguments by its pid.
#[cfg(unix)]
#[derive(Default)]
pub(crate) struct Reader {
    /// `KERN_PROCARGS2`'s buffer (`KERN_ARGMAX` bytes), kept from one process to the next.
    #[cfg(target_os = "macos")]
    buffer: Vec<u8>,
}

#[cfg(target_os = "macos")]
impl Reader {
    fn procargs(&mut self, pid: u32) -> Option<Procargs<'_>> {
        if self.buffer.is_empty() {
            self.buffer = vec![0; crate::sys::argmax().unwrap_or(1 << 20)];
        }
        parse_procargs(crate::sys::procargs(pid, &mut self.buffer)?)
    }

    fn tag(&mut self, pid: u32, env: &str) -> Option<String> {
        tag_in(self.procargs(pid)?.environment, env)
    }

    pub(crate) fn arguments(&mut self, pid: u32) -> Vec<String> {
        self.procargs(pid).map_or_else(Vec::new, |procargs| {
            procargs
                .arguments
                .iter()
                .map(|arg| String::from_utf8_lossy(arg).into_owned())
                .collect()
        })
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
impl Reader {
    fn tag(&mut self, pid: u32, env: &str) -> Option<String> {
        let environ = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
        tag_in(environ.split(|byte| *byte == 0), env)
    }

    pub(crate) fn arguments(&mut self, pid: u32) -> Vec<String> {
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            return Vec::new();
        };
        let cmdline = cmdline.strip_suffix(b"\0").unwrap_or(&cmdline);
        if cmdline.is_empty() {
            return Vec::new();
        }
        cmdline
            .split(|byte| *byte == 0)
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect()
    }
}

/// `env`'s value among `NAME=value` entries, the name compared exactly as Unix compares it; none when absent or empty.
/// The first entry of that name counts, as `getenv` reads it.
#[cfg(any(unix, test))]
fn tag_in<'a>(entries: impl IntoIterator<Item = &'a [u8]>, env: &str) -> Option<String> {
    entries
        .into_iter()
        .find_map(|entry| entry.strip_prefix(env.as_bytes())?.strip_prefix(b"="))
        .filter(|value| !value.is_empty())
        .map(|value| String::from_utf8_lossy(value).into_owned())
}

/// `env`'s value in a Windows environment block (UTF-16 `NAME=value` entries, each ended by a NUL, the block by an
/// empty one), the name compared without regard to ASCII case as Windows compares it; none when absent or empty. An
/// entry the read cut off before its NUL does not count.
#[cfg(any(windows, test))]
fn block_tag(block: &[u16], env: &[u16]) -> Option<String> {
    let lower = |unit: u16| {
        if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
            unit + 32
        } else {
            unit
        }
    };
    let terminated = &block[..block.iter().rposition(|unit| *unit == 0).unwrap_or(0)];
    terminated
        .split(|unit| *unit == 0)
        .take_while(|entry| !entry.is_empty())
        .find_map(|entry| {
            let name = entry.get(..env.len())?;
            let same = entry.get(env.len()) == Some(&u16::from(b'='))
                && name.iter().zip(env).all(|(a, b)| lower(*a) == lower(*b));
            same.then(|| &entry[env.len() + 1..])
        })
        .filter(|value| !value.is_empty())
        .map(String::from_utf16_lossy)
}

/// A Windows command line's arguments, split as the C runtime and `CommandLineToArgvW` split them (the rules of
/// Rust's own `std::env::args` there): the program name ends at the first space or tab outside quotes and has no
/// escapes; after it, a `\` escapes only before a `"`: 2n of them and a quote are n and a toggle of quoting, 2n+1 and
/// a quote are n and a literal quote, and `""` inside quotes is one quote.
#[cfg(any(windows, test))]
fn command_line_args(line: &[u16]) -> Vec<String> {
    const TAB: u16 = 9;
    const SPACE: u16 = 32;
    const QUOTE: u16 = 34;
    const BACKSLASH: u16 = 92;
    let blank = |unit: u16| unit == SPACE || unit == TAB;
    let mut args = Vec::new();
    let mut current = Vec::new();
    let mut quoted = false;
    let mut at = 0;
    while let Some(&unit) = line.get(at) {
        at += 1;
        match unit {
            QUOTE => quoted = !quoted,
            unit if blank(unit) && !quoted => break,
            unit => current.push(unit),
        }
    }
    args.push(String::from_utf16_lossy(&current));
    while line.get(at).is_some_and(|&unit| blank(unit)) {
        at += 1;
    }
    current.clear();
    quoted = false;
    while let Some(&unit) = line.get(at) {
        at += 1;
        match unit {
            unit if blank(unit) && !quoted => {
                args.push(String::from_utf16_lossy(&current));
                current.clear();
                while line.get(at).is_some_and(|&unit| blank(unit)) {
                    at += 1;
                }
            }
            BACKSLASH => {
                let mut count = 1;
                while line.get(at) == Some(&BACKSLASH) {
                    count += 1;
                    at += 1;
                }
                if line.get(at) == Some(&QUOTE) {
                    current.extend(std::iter::repeat_n(BACKSLASH, count / 2));
                    if count % 2 == 1 {
                        current.push(QUOTE);
                        at += 1;
                    }
                } else {
                    current.extend(std::iter::repeat_n(BACKSLASH, count));
                }
            }
            QUOTE if quoted => match line.get(at) {
                Some(&QUOTE) => {
                    current.push(QUOTE);
                    at += 1;
                }
                Some(_) => quoted = false,
                None => break,
            },
            QUOTE => quoted = true,
            unit => current.push(unit),
        }
    }
    if !current.is_empty() || quoted {
        args.push(String::from_utf16_lossy(&current));
    }
    args
}

/// What a `KERN_PROCARGS2` buffer holds: the arguments and the environment, each string without its NUL.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq)]
struct Procargs<'a> {
    arguments: Vec<&'a [u8]>,
    environment: Vec<&'a [u8]>,
}

/// Reads a `KERN_PROCARGS2` buffer: the argument count (a native-endian `i32`), the executable's path and its NUL, NULs
/// up to an aligned start, the arguments, then the environment up to an empty string (the loader's `apple` strings
/// follow). A string the buffer cuts off before its NUL is dropped, so a count past the strings there are leaves the
/// environment empty; a buffer too short for the count or the path is none.
#[cfg(any(target_os = "macos", test))]
fn parse_procargs(buffer: &[u8]) -> Option<Procargs<'_>> {
    let count = usize::try_from(i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?)).ok()?;
    let rest = &buffer[4..];
    let mut at = rest.iter().position(|byte| *byte == 0)?;
    while rest.get(at) == Some(&0) {
        at += 1;
    }
    let tail = &rest[at..];
    let strings: Vec<&[u8]> = match tail.iter().rposition(|byte| *byte == 0) {
        Some(last) => tail[..last].split(|byte| *byte == 0).collect(),
        None => Vec::new(),
    };
    let mut strings = strings.into_iter();
    let arguments = strings.by_ref().take(count).collect();
    let environment = strings.take_while(|string| !string.is_empty()).collect();
    Some(Procargs {
        arguments,
        environment,
    })
}

/// `ps`'s `etime`, `[[dd-]hh:]mm:ss`, in seconds.
#[cfg(any(unix, test))]
fn elapsed_secs(etime: &str) -> Option<u64> {
    use crate::memory::digits;
    let (days, clock) = match etime.split_once('-') {
        Some((days, clock)) => (Some(digits::<u64>(days)?), clock),
        None => (None, etime),
    };
    let parts: Vec<u64> = clock.split(':').map(digits).collect::<Option<_>>()?;
    let (hours, minutes, seconds) = match (days, parts.as_slice()) {
        (None, &[minutes, seconds]) => (0, minutes, seconds),
        (_, &[hours, minutes, seconds]) => (hours, minutes, seconds),
        _ => return None,
    };
    days.unwrap_or(0)
        .checked_mul(24)?
        .checked_add(hours)?
        .checked_mul(60)?
        .checked_add(minutes)?
        .checked_mul(60)?
        .checked_add(seconds)
}

/// The first whitespace-separated word of `text` and what follows it.
#[cfg(any(unix, test))]
fn word(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    (end > 0).then(|| text.split_at(end))
}

/// `ps -axo pid=,ppid=,rss=,etime=,comm=` (rss in KB; `comm` last, as it may hold spaces, and a path on macOS); a line
/// without the three numbers, an elapsed time and a command is no row. `now_ms` is when `ps` ran.
#[cfg(any(unix, test))]
fn parse_ps(text: &str, now_ms: u64) -> Vec<Row> {
    use crate::memory::digits;
    text.lines()
        .filter_map(|line| {
            let (pid, rest) = word(line)?;
            let (ppid, rest) = word(rest)?;
            let (kb, rest) = word(rest)?;
            let (etime, rest) = word(rest)?;
            let command = rest.trim();
            if command.is_empty() {
                return None;
            }
            let name = match command.rsplit_once('/') {
                Some((_, name)) if !name.is_empty() => name,
                _ => command,
            };
            Some(Row {
                pid: digits(pid)?,
                ppid: digits(ppid)?,
                bytes: digits::<u64>(kb)?.checked_mul(1024)?,
                started_ms: elapsed_secs(etime)
                    .and_then(|secs| now_ms.checked_sub(secs.checked_mul(1000)?)),
                name: name.to_owned(),
                tag: None,
                args: Vec::new(),
                #[cfg(windows)]
                process: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::process::{Child, Command, Stdio};

    use super::*;

    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Random hex, so a test's variable and tags match nothing but what it started.
    fn hex(bytes: usize) -> String {
        let mut random = vec![0; bytes];
        crate::sys::random(&mut random).unwrap();
        random.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn new_env() -> String {
        format!("OMPDESK_TEST_TAG_{}", hex(6).to_uppercase())
    }

    fn new_tag() -> String {
        hex(16)
    }

    /// Processes a test started. Whatever of them still runs is ended when the test ends, failed or not: its children
    /// through their handles, a process it found (`strays`) only while it still carries the tag it was found by.
    struct Started {
        env: String,
        children: Vec<Child>,
        strays: Vec<(u32, String)>,
    }

    impl Started {
        fn new(env: &str) -> Started {
            Started {
                env: env.to_owned(),
                children: Vec::new(),
                strays: Vec::new(),
            }
        }

        fn spawn(&mut self, mut command: Command) -> u32 {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let child = command.spawn().unwrap();
            let pid = child.id();
            self.children.push(child);
            pid
        }

        fn child(&mut self, pid: u32) -> &mut Child {
            self.children
                .iter_mut()
                .find(|child| child.id() == pid)
                .unwrap()
        }

        fn running(&mut self, pid: u32) -> bool {
            self.child(pid).try_wait().unwrap().is_none()
        }

        fn wait(&mut self, pid: u32) {
            self.child(pid).wait().unwrap();
        }
    }

    impl Drop for Started {
        fn drop(&mut self) {
            for child in &mut self.children {
                let _ = child.kill();
                let _ = child.wait();
            }
            for (pid, tag) in &self.strays {
                end_if_tagged(*pid, &self.env, tag);
            }
        }
    }

    #[cfg(unix)]
    fn end_if_tagged(pid: u32, env: &str, tag: &str) {
        if Reader::default().tag(pid, env).as_deref() == Some(tag) {
            crate::sys::signal(pid, true);
        }
    }

    #[cfg(windows)]
    fn end_if_tagged(pid: u32, env: &str, tag: &str) {
        let name: Vec<u16> = env.encode_utf16().collect();
        let Ok(entries) = crate::sys::processes(true) else {
            return;
        };
        for entry in entries {
            if let (true, Some(process)) = (entry.pid == pid, entry.process) {
                let carried = process
                    .environment()
                    .and_then(|block| block_tag(&block, &name));
                if carried.as_deref() == Some(tag) {
                    process.terminate();
                }
            }
        }
    }

    /// A process that runs two minutes doing nothing: `sleep`, or on Windows (which has none) `ping`.
    fn long(env: &str, tag: Option<&str>) -> Command {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("ping");
            command.args(["-n", "120", "127.0.0.1"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("120");
            command
        };
        if let Some(tag) = tag {
            command.env(env, tag);
        }
        command
    }

    fn is_long(name: &str) -> bool {
        name.eq_ignore_ascii_case(if cfg!(windows) { "PING.EXE" } else { "sleep" })
    }

    /// A shell that starts `long` in the background and exits at once, leaving it to the system.
    fn orphaning(env: &str, tag: &str) -> Command {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "(sleep 120 &) ; exit 0"]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("cmd");
            command.raw_arg(r#"/d /c start "" /b ping -n 120 127.0.0.1"#);
            command
        };
        command.env(env, tag);
        command
    }

    /// A shell whose command line has `arg` and that waits on a `long` it started: a shared worker.
    fn keeping(env: &str, tag: &str, arg: &str) -> Command {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 120; exit 0", arg]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("cmd");
            command.raw_arg(format!("/d /c ping -n 120 127.0.0.1 >nul & rem {arg}"));
            command
        };
        command.env(env, tag);
        command
    }

    fn tagged<'a>(rows: &'a [Row], tag: &str) -> Vec<&'a Row> {
        rows.iter()
            .filter(|row| row.tag.as_deref() == Some(tag))
            .collect()
    }

    async fn listed(env: &str) -> Vec<Row> {
        list(
            ListParams {
                env: env.to_owned(),
                timeout_ms: 10_000,
            },
            Scope::detached(),
        )
        .await
        .unwrap()
    }

    /// Lists until `ready` holds, for up to 20 s: a process takes a moment to start and to exec.
    async fn listed_until(env: &str, ready: impl Fn(&[Row]) -> bool) -> Vec<Row> {
        let started = Instant::now();
        loop {
            let rows = listed(env).await;
            if ready(&rows) {
                return rows;
            }
            let seen: Vec<&Row> = rows.iter().filter(|row| row.tag.is_some()).collect();
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the list never showed it: {seen:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn ending(env: &str, tags: &[&str], keep_arg: Option<&str>, grace_ms: u64) -> EndParams {
        EndParams {
            env: env.to_owned(),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            keep_arg: keep_arg.map(str::to_owned),
            grace_ms,
            timeout_ms: 30_000,
        }
    }

    /// The pids among `(pid, name)` but the console hosts: Windows starts a `conhost.exe` under every console program,
    /// which inherits its environment, and so its tag, like any child.
    fn but_console_hosts<'a>(named: impl IntoIterator<Item = (u32, &'a str)>) -> BTreeSet<u32> {
        named
            .into_iter()
            .filter(|(_, name)| !name.eq_ignore_ascii_case("conhost.exe"))
            .map(|(pid, _)| pid)
            .collect()
    }

    fn ended_pids(report: &Report) -> BTreeSet<u32> {
        but_console_hosts(
            report
                .ended
                .iter()
                .map(|ended| (ended.pid, ended.name.as_str())),
        )
    }

    /// The incident's shape: a session's shell started a server and exited, so only the tag still ties the server to
    /// the session.
    #[tokio::test]
    async fn ends_a_tagged_tree_with_an_orphan_and_nothing_else() {
        let env = new_env();
        let (mine, other) = (new_tag(), new_tag());
        let mut started = Started::new(&env);
        let launcher = started.spawn(orphaning(&env, &mine));
        started.wait(launcher);
        let held = started.spawn(long(&env, Some(&mine)));
        let other_pid = started.spawn(long(&env, Some(&other)));
        let untagged = started.spawn(long(&env, None));
        let rows = listed_until(&env, |rows| {
            tagged(rows, &mine)
                .iter()
                .filter(|row| is_long(&row.name))
                .count()
                == 2
                && rows
                    .iter()
                    .any(|row| row.pid == other_pid && is_long(&row.name))
                && rows
                    .iter()
                    .any(|row| row.pid == untagged && is_long(&row.name))
        })
        .await;
        let orphan = tagged(&rows, &mine)
            .into_iter()
            .find(|row| row.pid != held && is_long(&row.name))
            .unwrap()
            .pid;
        started.strays.push((orphan, mine.clone()));
        let row = |pid: u32| rows.iter().find(|row| row.pid == pid).unwrap();
        assert_eq!(row(other_pid).tag.as_deref(), Some(other.as_str()));
        assert_eq!(row(untagged).tag, None);
        let wire = serde_json::to_value(row(held)).unwrap();
        let keys: BTreeSet<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            BTreeSet::from(["pid", "ppid", "bytes", "startedMs", "name", "tag"]),
            "{wire}"
        );
        assert_eq!(wire["tag"], mine.as_str());
        assert!(wire["bytes"].as_u64().unwrap() > 0, "{wire}");

        let report = end(ending(&env, &[&mine], None, 2_000), Scope::detached())
            .await
            .unwrap();
        assert_eq!(
            ended_pids(&report),
            BTreeSet::from([held, orphan]),
            "{report:?}"
        );
        let others: BTreeSet<u32> = rows
            .iter()
            .filter(|row| row.pid == untagged || row.tag.as_deref() == Some(other.as_str()))
            .map(|row| row.pid)
            .collect();
        assert!(
            report
                .ended
                .iter()
                .all(|ended| !others.contains(&ended.pid)),
            "{report:?}"
        );
        assert!(
            report.left.is_empty() && report.kept.is_empty() && report.own.is_empty(),
            "{report:?}"
        );
        assert!(!started.running(held));
        assert!(started.running(other_pid) && started.running(untagged));
        assert!(tagged(&listed(&env).await, &mine).is_empty());
    }

    #[tokio::test]
    async fn keeps_a_shared_worker_and_what_it_started() {
        let env = new_env();
        let mine = new_tag();
        let prefix = format!("__ompdesk_test_keep_{}", hex(4));
        let mut started = Started::new(&env);
        let keeper = started.spawn(keeping(&env, &mine, &format!("{prefix}_broker")));
        let sibling = started.spawn(long(&env, Some(&mine)));
        let carries = |row: &Row| row.tag.as_deref() == Some(mine.as_str());
        let rows = listed_until(&env, |rows| {
            rows.iter()
                .any(|row| row.ppid == keeper && is_long(&row.name) && carries(row))
                && rows
                    .iter()
                    .any(|row| row.pid == sibling && is_long(&row.name))
        })
        .await;
        let worker = rows
            .iter()
            .find(|row| row.ppid == keeper && is_long(&row.name))
            .unwrap()
            .pid;
        started.strays.push((worker, mine.clone()));

        let report = end(
            ending(&env, &[&mine], Some(&prefix), 2_000),
            Scope::detached(),
        )
        .await
        .unwrap();
        assert_eq!(
            but_console_hosts(
                report
                    .kept
                    .iter()
                    .map(|kept| (kept.pid, kept.name.as_str()))
            ),
            BTreeSet::from([keeper, worker]),
            "{report:?}"
        );
        assert_eq!(ended_pids(&report), BTreeSet::from([sibling]), "{report:?}");
        assert!(report.left.is_empty(), "{report:?}");
        assert!(started.running(keeper));
        assert!(
            listed(&env)
                .await
                .iter()
                .any(|row| row.pid == worker && carries(row))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn asks_first_and_forces_only_what_ignores_it() {
        let env = new_env();
        let mine = new_tag();
        let folder = std::env::temp_dir().join(format!("ompdesk-procs-{}", hex(4)));
        std::fs::create_dir_all(&folder).unwrap();
        let (bye, polite_ready, stubborn_ready) = (
            folder.join("bye"),
            folder.join("polite"),
            folder.join("stubborn"),
        );
        let mut started = Started::new(&env);
        let mut polite = Command::new("sh");
        polite
            .args([
                "-c",
                r#"trap 'echo bye > "$1"; exit 0' TERM; sleep 120 & : > "$2"; wait"#,
                "sh",
            ])
            .arg(&bye)
            .arg(&polite_ready)
            .env(&env, &mine);
        let polite = started.spawn(polite);
        let mut stubborn = Command::new("sh");
        stubborn
            .args(["-c", r#"trap '' TERM; : > "$1"; exec sleep 120"#, "sh"])
            .arg(&stubborn_ready)
            .env(&env, &mine);
        let stubborn = started.spawn(stubborn);
        let waiting = Instant::now();
        while !(polite_ready.exists() && stubborn_ready.exists()) {
            assert!(
                waiting.elapsed() < Duration::from_secs(20),
                "the shells never started"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let report = end(ending(&env, &[&mine], None, 1_000), Scope::detached())
            .await
            .unwrap();
        let said = std::fs::read_to_string(&bye);
        let _ = std::fs::remove_dir_all(&folder);
        let forced = |pid: u32| {
            report
                .ended
                .iter()
                .find(|ended| ended.pid == pid)
                .map(|ended| ended.forced)
        };
        assert_eq!(forced(polite), Some(false), "{report:?}");
        assert_eq!(forced(stubborn), Some(true), "{report:?}");
        assert!(report.left.is_empty(), "{report:?}");
        assert_eq!(said.unwrap(), "bye\n", "the TERM trap did not run");
        assert!(!started.running(polite) && !started.running(stubborn));
    }

    const OWN_ENV: &str = "OMPDESK_TEST_OWN_ENV";

    /// A tag this process carries is the app's own session: refused whole, though another process carries it too.
    #[test]
    fn refuses_a_tag_this_process_carries() {
        let env = new_env();
        let tag = new_tag();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "procs::tests::carrying_its_own_tag",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env(OWN_ENV, &env)
            .env(&env, &tag);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command.output().unwrap();
        let printed = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.status.success() && printed.contains("1 passed"),
            "{printed}"
        );
    }

    #[tokio::test]
    #[ignore = "run by refuses_a_tag_this_process_carries, in a process that carries the tag"]
    async fn carrying_its_own_tag() {
        let env = std::env::var(OWN_ENV).unwrap();
        let tag = std::env::var(&env).unwrap();
        let mut started = Started::new(&env);
        let held = started.spawn(long(&env, Some(&tag)));
        listed_until(&env, |rows| {
            rows.iter().any(|row| {
                row.pid == held && is_long(&row.name) && row.tag.as_deref() == Some(tag.as_str())
            })
        })
        .await;
        let report = end(ending(&env, &[&tag], None, 0), Scope::detached())
            .await
            .unwrap();
        assert_eq!(report.own, vec![tag.clone()], "{report:?}");
        assert!(
            report.ended.is_empty() && report.left.is_empty(),
            "{report:?}"
        );
        assert!(started.running(held));
    }

    #[tokio::test]
    async fn refuses_what_is_no_variable_name_tag_or_prefix() {
        let tag = new_tag();
        for (env, tag, keep_arg) in [
            ("", tag.as_str(), None),
            ("A=B", tag.as_str(), None),
            ("OK", "0123456789ABCDEF0123456789ABCDEF", None),
            ("OK", "abc", None),
            ("OK", tag.as_str(), Some("")),
        ] {
            let fault = end(ending(env, &[tag], keep_arg, 0), Scope::detached())
                .await
                .unwrap_err();
            assert_eq!(fault.code, "invalid_params", "{env:?} {tag:?} {keep_arg:?}");
        }
        let fault = list(
            ListParams {
                env: String::new(),
                timeout_ms: 1_000,
            },
            Scope::detached(),
        )
        .await
        .unwrap_err();
        assert_eq!(fault.code, "invalid_params");
    }

    fn row(pid: u32, ppid: u32, started_ms: u64, tag: Option<&str>) -> Row {
        Row {
            pid,
            ppid,
            bytes: 0,
            started_ms: Some(started_ms),
            name: format!("p{pid}"),
            tag: tag.map(str::to_owned),
            args: Vec::new(),
            #[cfg(windows)]
            process: None,
        }
    }

    fn at(rows: &[Row], indices: &[usize]) -> Vec<u32> {
        indices.iter().map(|&index| rows[index].pid).collect()
    }

    #[test]
    fn refuses_the_tags_of_this_process_and_its_ancestors() {
        let [a, b, c, d] = ["a", "b", "c", "d"].map(|digit| digit.repeat(32));
        let rows = [
            // Took the id of 30's dead parent: it started after 30, so it is no ancestor.
            row(20, 1, 3_000, Some(&c)),
            row(30, 20, 2_000, None),
            row(40, 30, 2_500, Some(&b)),
            // This process.
            row(50, 40, 2_600, Some(&a)),
            row(45, 40, 2_550, Some(&c)),
            row(60, 1, 1_000, Some(&d)),
            row(70, 60, 1_100, Some(&a)),
            row(1, 0, 0, Some(&d)),
        ];
        let tags: HashSet<String> = [&a, &b, &c, &d].map(String::clone).into();
        let plan = plan(&rows, 50, &tags, None);
        assert_eq!(plan.own, BTreeSet::from([a, b]));
        assert_eq!(at(&rows, &plan.targets), [20, 45, 60]);
        assert!(plan.kept.is_empty());
    }

    #[test]
    fn keeps_a_worker_and_its_descendants_but_not_a_reused_id() {
        let tag = "a".repeat(32);
        let mut worker = row(80, 1, 1_000, Some(&tag));
        worker.args = vec!["bun".into(), "__omp_worker_daemon_broker".into()];
        let rows = [
            worker,
            row(81, 80, 1_100, Some(&tag)),
            row(82, 81, 1_200, None),
            // Took the id of a dead child of 80's: it started before 80, so 80 did not start it.
            row(83, 80, 900, Some(&tag)),
            row(84, 1, 1_000, Some(&tag)),
        ];
        let plan = plan(
            &rows,
            50,
            &HashSet::from([tag]),
            Some("__omp_worker_daemon"),
        );
        assert_eq!(at(&rows, &plan.kept), [80, 81, 82]);
        assert_eq!(at(&rows, &plan.targets), [83, 84]);
        assert!(plan.own.is_empty());
    }

    #[test]
    fn finds_what_a_gone_process_left_and_not_what_a_later_holder_of_its_id_started() {
        let left = || {
            let mut unread = row(94, 70, 0, None);
            unread.started_ms = None;
            vec![
                // 70 started at 1 000 and is gone: these are what it left.
                row(90, 70, 1_000, None),
                row(91, 70, 1_500, None),
                // Older than the gone 70: an earlier holder of the id started it.
                row(92, 70, 900, None),
                // Another parent.
                row(93, 71, 1_500, None),
                unread,
            ]
        };
        let rows = left();
        assert_eq!(at(&rows, &orphans(&rows, 70, 1_000)), [90, 91]);

        // A later program took the id 70 at 2 000 and started 95: 90 and 91 are older than it, 95 is its own.
        let mut reused = left();
        reused.push(row(70, 1, 2_000, None));
        reused.push(row(95, 70, 2_100, None));
        assert_eq!(at(&reused, &orphans(&reused, 70, 1_000)), [90, 91]);

        // The process itself still runs: what it started is its own, not left behind.
        let mut running = left();
        running.push(row(70, 1, 1_000, None));
        assert!(orphans(&running, 70, 1_000).is_empty());

        // A holder of the id whose start cannot be read may have started any of them: none is taken for an orphan.
        let mut unknown = row(70, 1, 0, None);
        unknown.started_ms = None;
        let mut held = left();
        held.push(unknown);
        assert!(orphans(&held, 70, 1_000).is_empty());
    }

    fn procargs(count: i32, rest: &[u8]) -> Vec<u8> {
        let mut buffer = count.to_ne_bytes().to_vec();
        buffer.extend_from_slice(rest);
        buffer
    }

    #[test]
    fn reads_procargs2() {
        let full = procargs(
            2,
            b"/bin/sh\0\0\0\0\0sh\0-c\0A=1\0OMP_TAG=abc\0\0executable_path=/bin/sh\0",
        );
        assert_eq!(
            parse_procargs(&full),
            Some(Procargs {
                arguments: vec![b"sh", b"-c"],
                environment: vec![b"A=1", b"OMP_TAG=abc"],
            })
        );
        let cut = procargs(1, b"/bin/sh\0sh\0A=1\0OMP_TAG=ab");
        assert_eq!(
            parse_procargs(&cut),
            Some(Procargs {
                arguments: vec![b"sh"],
                environment: vec![b"A=1"],
            })
        );
        let short = procargs(4, b"/bin/sh\0\0sh\0-c\0");
        assert_eq!(
            parse_procargs(&short),
            Some(Procargs {
                arguments: vec![b"sh", b"-c"],
                environment: vec![],
            })
        );
        let no_environment = procargs(1, b"/bin/sh\0sh\0\0executable_path=/bin/sh\0");
        assert_eq!(
            parse_procargs(&no_environment),
            Some(Procargs {
                arguments: vec![b"sh"],
                environment: vec![],
            })
        );
        assert_eq!(parse_procargs(&[2, 0]), None);
        assert_eq!(parse_procargs(&procargs(1, b"/bin/sh")), None);
        assert_eq!(parse_procargs(&procargs(-1, b"/bin/sh\0sh\0")), None);
        assert_eq!(
            tag_in(parse_procargs(&full).unwrap().environment, "OMP_TAG"),
            Some("abc".into())
        );
    }

    #[test]
    fn finds_a_tag_among_unix_entries() {
        let entries: [&[u8]; 4] = [b"A=1", b"OMP_TAG=", b"OMP_TAG=abc", b"omp_tag=def"];
        assert_eq!(tag_in(entries, "OMP_TAG"), None);
        assert_eq!(tag_in(entries, "omp_tag"), Some("def".into()));
        assert_eq!(tag_in(entries, "OMP"), None);
        assert_eq!(
            tag_in(b"A=1\0OMP_TAG=abc\0".split(|b| *b == 0), "OMP_TAG"),
            Some("abc".into())
        );
    }

    #[test]
    fn finds_a_tag_in_a_windows_block() {
        let units = |text: &str| -> Vec<u16> { text.encode_utf16().collect() };
        let block = units("=C:=C:\\work\0Path=C:\\bin\0omp_tag=abc\0OMP_TAGX=no\0\0");
        assert_eq!(block_tag(&block, &units("OMP_TAG")), Some("abc".into()));
        assert_eq!(block_tag(&block, &units("PATH")), Some("C:\\bin".into()));
        assert_eq!(block_tag(&block, &units("OMP")), None);
        assert_eq!(block_tag(&units("OMP_TAG=\0\0"), &units("OMP_TAG")), None);
        assert_eq!(
            block_tag(&units("A=1\0OMP_TAG=ab"), &units("OMP_TAG")),
            None
        );
        assert_eq!(block_tag(&units("\0\0"), &units("OMP_TAG")), None);
        assert_eq!(block_tag(&[], &units("OMP_TAG")), None);
    }

    #[test]
    fn splits_a_windows_command_line() {
        let args = |line: &str| command_line_args(&line.encode_utf16().collect::<Vec<_>>());
        assert_eq!(
            args(r#""C:\Program Files\nodejs\node.exe" C:\x\cli.js __omp_worker_daemon_broker"#),
            [
                r"C:\Program Files\nodejs\node.exe",
                r"C:\x\cli.js",
                "__omp_worker_daemon_broker"
            ]
        );
        assert_eq!(args(r#"C:\a\"b c d"#), [r#"C:\a\b c d"#]);
        assert_eq!(args("prog \"a b\"  c\td"), ["prog", "a b", "c", "d"]);
        assert_eq!(
            args(r#"prog "ab\"c" "\\" d"#),
            ["prog", r#"ab"c"#, r"\", "d"]
        );
        assert_eq!(
            args(r#"prog a\\\b d"e f"g h"#),
            ["prog", r"a\\\b", "de fg", "h"]
        );
        assert_eq!(args(r#"prog a\\\"b c d"#), ["prog", r#"a\"b"#, "c", "d"]);
        assert_eq!(
            args(r#"prog a\\\\"b c" d e"#),
            ["prog", r"a\\b c", "d", "e"]
        );
        assert_eq!(args(r#"prog a"b"" c d"#), ["prog", r#"ab" c d"#]);
        assert_eq!(args(r#"prog "" """#), ["prog", "", ""]);
        assert_eq!(args("prog "), ["prog"]);
    }

    #[test]
    fn reads_elapsed_times() {
        assert_eq!(elapsed_secs("05:07"), Some(307));
        assert_eq!(elapsed_secs("1:02:03"), Some(3_723));
        assert_eq!(elapsed_secs("2-01:00:00"), Some(176_400));
        assert_eq!(elapsed_secs("2-01:00"), None);
        assert_eq!(elapsed_secs("01:02:03:04"), None);
        assert_eq!(elapsed_secs("1e3:00"), None);
        assert_eq!(elapsed_secs(""), None);
        assert_eq!(elapsed_secs("99999999999999999999-00:00:00"), None);
    }

    #[test]
    fn reads_ps_lines() {
        let text = "  612     1  20480    01:02:03 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome  \n\
                    45 612 8 00:05 sleep\n\
                    46 612 8 later node\n\
                    1 0 4\n\
                    x 1 4 00:01 sh\r\n";
        let rows = parse_ps(text, 10_000_000);
        let read: Vec<(u32, u32, u64, Option<u64>, &str)> = rows
            .iter()
            .map(|row| {
                (
                    row.pid,
                    row.ppid,
                    row.bytes,
                    row.started_ms,
                    row.name.as_str(),
                )
            })
            .collect();
        assert_eq!(
            read,
            [
                (
                    612,
                    1,
                    20_480 * 1024,
                    Some(10_000_000 - 3_723_000),
                    "Google Chrome"
                ),
                (45, 612, 8 * 1024, Some(10_000_000 - 5_000), "sleep"),
                (46, 612, 8 * 1024, None, "node"),
            ]
        );
    }
}
