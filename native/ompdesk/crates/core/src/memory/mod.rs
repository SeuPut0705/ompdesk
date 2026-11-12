//! This computer's memory, for idle release (was the OS reads and their rules in `src/main/memory-sampler.ts` and, on
//! Windows, the stock helper's `process-memory.ts`): the OS's reading (`memory.reading`) and every process with its
//! parent and resident bytes (`memory.processes`). Main keeps the watch's timer, the sessions' state and the choice
//! of what to release (`memory-watch.ts`, `idle-release.ts`).
//!
//! macOS reads through the two programs the TypeScript ran: one `sysctl` for `kern.memorystatus_vm_pressure_level`
//! (1 normal, 2 warn, 4 critical: the level `memory_pressure` and the kernel's jetsam act on),
//! `kern.memorystatus_level` (the "memory free percentage" `memory_pressure` prints) and `hw.memsize`, and one
//! `ps -axo pid=,ppid=,rss=`. Windows has no pressure level: `GlobalMemoryStatusEx`'s available physical memory and
//! the share of RAM still available decide it, and the processes come from a Toolhelp32 snapshot with each one's
//! working set (`sys.rs`; no WMI, which answers "call cancelled" on a loaded machine). Any other system (the Linux
//! that runs the tests) reads `/proc/meminfo` under the Windows rule and runs `ps`.
//!
//! `timeoutMs` is main's (`SAMPLE_TIMEOUT_MS`): how long `sysctl` or `ps` may run. A read that fails is a fault, which
//! main counts as no sample, never as memory being fine.

use serde::{Deserialize, Serialize};

use crate::server::{Fault, Registry, Reply, Scope};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "lowercase")]
pub enum Pressure {
    Normal,
    Warn,
    Critical,
}

#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    total_bytes: u64,
    /// What the OS can hand out without paging: macOS `kern.memorystatus_level` % of RAM, Windows' available
    /// physical memory.
    available_bytes: u64,
    pressure: Pressure,
}

#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
pub struct ProcessRow {
    pid: u32,
    ppid: u32,
    /// Resident bytes.
    bytes: u64,
    /// Image name (`conhost.exe`), Windows only: `ps` names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    timeout_ms: u64,
}

pub fn register(registry: &mut Registry) {
    registry.add("memory.reading", |call| {
        Box::pin(async move {
            let params: Params = call.params()?;
            Reply::json(&reading(params.timeout_ms, call.scope).await?)
        })
    });
    registry.add("memory.processes", |call| {
        Box::pin(async move {
            let params: Params = call.params()?;
            Reply::json(&processes(params.timeout_ms, call.scope).await?)
        })
    });
}

/// A number as `sysctl`, `ps` and `/proc/meminfo` print one: decimal digits. `Number()` also read `1e3`, `0x10`,
/// `1.5` and a sign, which none of them prints.
#[cfg(any(unix, test))]
pub(crate) fn digits<T: std::str::FromStr>(text: &str) -> Option<T> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level hw.memsize`, one value a line; none when a
/// value is missing. The percentage is a C `int`, so it may carry a minus sign: below zero is zero.
#[cfg(any(target_os = "macos", test))]
fn mac_reading(text: &str) -> Option<Reading> {
    let mut values = text.split_whitespace();
    let (level, percent, memsize) = (values.next()?, values.next()?, values.next()?);
    let total_bytes = digits::<u64>(memsize).filter(|total| *total > 0)?;
    let percent = match percent.strip_prefix('-') {
        Some(below) => digits::<u64>(below).map(|_| 0)?,
        None => digits::<u64>(percent)?.min(100),
    };
    Some(Reading {
        total_bytes,
        // `Math.round` of the same doubles.
        available_bytes: (total_bytes as f64 * percent as f64 / 100.0).round() as u64,
        pressure: match level {
            "2" => Pressure::Warn,
            "4" => Pressure::Critical,
            _ => Pressure::Normal,
        },
    })
}

/// Windows: under 5 % of RAM available is critical and under 10 % a warning. Windows signals its own low-memory
/// resource notification near those shares on a 16 GB machine, and the incident's WindowServer stall began when macOS
/// had paged through its last tenth. In whole KB, as Electron's `process.getSystemMemoryInfo()` gave them.
#[cfg(any(not(target_os = "macos"), test))]
fn share_reading(total_kb: u64, free_kb: u64) -> Option<Reading> {
    if total_kb == 0 {
        return None;
    }
    let share = free_kb as f64 / total_kb as f64;
    Some(Reading {
        total_bytes: total_kb.saturating_mul(1024),
        available_bytes: free_kb.saturating_mul(1024),
        pressure: if share < 0.05 {
            Pressure::Critical
        } else if share < 0.1 {
            Pressure::Warn
        } else {
            Pressure::Normal
        },
    })
}

/// `ps -axo pid=,ppid=,rss=` (rss in KB); a line that is not three numbers is no row.
#[cfg(any(unix, test))]
fn parse_ps(text: &str) -> Vec<ProcessRow> {
    text.split('\n')
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (pid, ppid, kb) = (fields.next()?, fields.next()?, fields.next()?);
            Some(ProcessRow {
                pid: digits(pid)?,
                ppid: digits(ppid)?,
                bytes: digits::<u64>(kb)?.checked_mul(1024)?,
                name: None,
            })
        })
        .collect()
}

/// Runs `bin` as `execFile` did: no shell, in main's folder with main's environment (this process has both from
/// main), its output up to `max_bytes`. A non-zero exit, a cut output and a run past `timeout_ms` are faults.
#[cfg(unix)]
pub(crate) async fn program(
    bin: &str,
    args: &[&str],
    max_bytes: usize,
    timeout_ms: u64,
    scope: Scope,
) -> Result<String, Fault> {
    use crate::run::{Exec, Opts, Runner};

    let runner = Runner {
        bin: bin.to_owned(),
        args: Vec::new(),
        env: std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect(),
        timeout_ms,
        max_bytes,
    };
    let output = Exec::new(runner, scope, "memory")
        .run(".", args, Opts::default())
        .await?;
    if output.code != 0 || output.truncated {
        return Err(Fault::new(
            "memory_read",
            format!(
                "{bin} failed (exit {}): {}",
                output.code,
                output.stderr.trim()
            ),
        ));
    }
    Ok(output.text())
}

/// An OS call on tokio's blocking pool.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The memory read panicked"))?
        .map_err(|error| Fault::new("memory_read", error.to_string()))
}

/// Physical memory and what of it is available, in whole KB.
#[cfg(windows)]
fn physical_kb() -> std::io::Result<(u64, u64)> {
    let (total, available) = crate::sys::physical_memory()?;
    Ok((total / 1024, available / 1024))
}

/// `MemTotal` and `MemFree`, the two Electron's `process.getSystemMemoryInfo()` answered there.
#[cfg(all(unix, not(target_os = "macos")))]
fn physical_kb() -> std::io::Result<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/meminfo")?;
    let field = |name: &str| {
        text.lines().find_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next()? == name).then(|| digits::<u64>(fields.next()?))?
        })
    };
    field("MemTotal:")
        .zip(field("MemFree:"))
        .ok_or_else(|| std::io::Error::other("/proc/meminfo names no MemTotal and MemFree"))
}

/// The OS's reading now; none when its values are missing.
#[cfg(target_os = "macos")]
async fn reading(timeout_ms: u64, scope: Scope) -> Result<Option<Reading>, Fault> {
    let text = program(
        "/usr/sbin/sysctl",
        &[
            "-n",
            "kern.memorystatus_vm_pressure_level",
            "kern.memorystatus_level",
            "hw.memsize",
        ],
        // `execFile`'s default `maxBuffer`.
        1024 * 1024,
        timeout_ms,
        scope,
    )
    .await?;
    Ok(mac_reading(&text))
}

/// The OS's reading now; none when it reports no memory at all.
#[cfg(not(target_os = "macos"))]
async fn reading(_timeout_ms: u64, _scope: Scope) -> Result<Option<Reading>, Fault> {
    let (total_kb, free_kb) = blocking(physical_kb).await?;
    Ok(share_reading(total_kb, free_kb))
}

/// Every process with its parent and resident bytes.
#[cfg(unix)]
async fn processes(timeout_ms: u64, scope: Scope) -> Result<Vec<ProcessRow>, Fault> {
    let text = program(
        "/bin/ps",
        &["-axo", "pid=,ppid=,rss="],
        8 * 1024 * 1024,
        timeout_ms,
        scope,
    )
    .await?;
    Ok(parse_ps(&text))
}

/// Every process with its parent, working set and image name. A process this user may not open counts 0 bytes.
#[cfg(windows)]
async fn processes(_timeout_ms: u64, _scope: Scope) -> Result<Vec<ProcessRow>, Fault> {
    let entries = blocking(|| crate::sys::processes(false)).await?;
    Ok(entries
        .into_iter()
        .map(|entry| ProcessRow {
            pid: entry.pid,
            ppid: entry.parent,
            bytes: entry.working_set,
            name: Some(entry.image),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// Rows captured from the TypeScript (`parseMacSysctl`, `parsePs`, `windowsReading`) before it was deleted.
    fn captured(table: &str) -> Vec<Value> {
        let rows: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        rows[table].as_array().unwrap().clone()
    }

    fn expected<T: serde::de::DeserializeOwned>(value: &Value) -> T {
        serde_json::from_value(value.clone()).unwrap()
    }

    #[test]
    fn reads_sysctl_as_the_typescript_did() {
        for row in captured("sysctl") {
            let text = row[0].as_str().unwrap();
            assert_eq!(
                mac_reading(text),
                expected::<Option<Reading>>(&row[1]),
                "{text:?}"
            );
        }
    }

    #[test]
    fn reads_ps_as_the_typescript_did() {
        for row in captured("ps") {
            let text = row[0].as_str().unwrap();
            assert_eq!(
                parse_ps(text),
                expected::<Vec<ProcessRow>>(&row[1]),
                "{text:?}"
            );
        }
    }

    #[test]
    fn rates_the_available_share_as_the_typescript_did() {
        for row in captured("share") {
            let (total, free) = (row[0].as_u64().unwrap(), row[1].as_u64().unwrap());
            assert_eq!(
                share_reading(total, free),
                expected::<Option<Reading>>(&row[2]),
                "{total} {free}"
            );
        }
    }

    /// The difference: `Number()` read these spellings, which neither program prints; here they are no value.
    #[test]
    fn reads_only_decimal_digits() {
        for row in captured("sysctlNumberForms") {
            assert!(!row[1].is_null(), "{row}");
            assert_eq!(mac_reading(row[0].as_str().unwrap()), None, "{row}");
        }
        for row in captured("psNumberForms") {
            assert!(!row[1].as_array().unwrap().is_empty(), "{row}");
            assert_eq!(parse_ps(row[0].as_str().unwrap()), Vec::new(), "{row}");
        }
    }

    #[tokio::test]
    async fn reads_this_computer() {
        let reading = reading(4_000, Scope::detached())
            .await
            .unwrap()
            .expect("this computer has memory");
        assert!(reading.total_bytes >= 1 << 30, "{reading:?}");
        assert!(
            reading.available_bytes <= reading.total_bytes,
            "{reading:?}"
        );

        let rows = processes(4_000, Scope::detached()).await.unwrap();
        let own = rows
            .iter()
            .find(|row| row.pid == std::process::id())
            .expect("this process is listed");
        assert!(own.bytes >= 1 << 20, "{own:?}");
        #[cfg(unix)]
        {
            assert_eq!(own.ppid, std::os::unix::process::parent_id());
            assert_eq!(own.name, None);
        }
        #[cfg(windows)]
        {
            let image = std::env::current_exe().unwrap();
            let image = image.file_name().unwrap().to_string_lossy();
            assert!(
                own.name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&image)),
                "{own:?}"
            );
            assert!(rows.iter().any(|row| row.pid == own.ppid), "{own:?}");
        }
    }
}
