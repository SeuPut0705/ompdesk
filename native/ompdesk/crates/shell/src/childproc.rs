//! Electron's `app` event `child-process-gone`, for the helpers of the shell: CEF has no callback for the GPU or a utility
//! process ending (only `RequestHandler::on_render_process_terminated`, which is `render-process-gone`), so the OS is
//! watched (`sys::childproc` on Windows): the shell's child processes, their `--type=` and, when one is gone, its exit
//! code. This file is the pure half: which child is worth watching, Electron's `type`/`reason` words, the event's data,
//! and the bookkeeping of which child was seen.

use std::collections::HashMap;

use serde_json::{Value, json};

/// The value of a `--flag=value` token of a Windows command line (`"--type=gpu-process" --other`), quotes removed.
pub fn flag_value(command_line: &str, flag: &str) -> Option<String> {
    let prefix = format!("{flag}=");
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for c in command_line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        tokens.push(current);
    }
    tokens
        .into_iter()
        .find_map(|t| t.strip_prefix(prefix.as_str()).map(str::to_string))
}

/// The value of a `--flag=value` argument among `args` (macOS gives the arguments already split).
pub fn arg_value(args: &[String], flag: &str) -> Option<String> {
    let prefix = format!("{flag}=");
    args.iter()
        .find_map(|a| a.strip_prefix(prefix.as_str()).map(str::to_string))
}

/// What a watched child is: its Chromium process type (`--type=`) and, for a utility process, the service it hosts
/// (`--utility-sub-type=`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kind {
    pub process_type: String,
    pub service: Option<String>,
}

/// The kind of a child from its command line. `None` for a process that is not a Chromium helper (no `--type=`: a tool
/// the shell spawned), for the renderers (their death is `render-process-gone` already) and for the crash handler.
pub fn watched_kind(command_line: &str) -> Option<Kind> {
    kind_of(
        flag_value(command_line, "--type")?,
        flag_value(command_line, "--utility-sub-type"),
    )
}

/// `watched_kind` for arguments that are already split (macOS: `KERN_PROCARGS2`).
pub fn watched_kind_of_args(args: &[String]) -> Option<Kind> {
    kind_of(
        arg_value(args, "--type")?,
        arg_value(args, "--utility-sub-type"),
    )
}

fn kind_of(process_type: String, service: Option<String>) -> Option<Kind> {
    if process_type == "renderer" || process_type == "crashpad-handler" {
        return None;
    }
    Some(Kind {
        process_type,
        service: service.filter(|s| !s.is_empty()),
    })
}

/// Electron's `details.type` for a Chromium process type.
pub fn electron_type(process_type: &str) -> &'static str {
    match process_type {
        "gpu-process" => "GPU",
        "utility" => "Utility",
        "zygote" => "Zygote",
        "ppapi" => "Pepper Plugin",
        "ppapi-broker" => "Pepper Plugin Broker",
        "sandbox-helper" => "Sandbox helper",
        _ => "Unknown",
    }
}

/// The display name Electron gives a utility process of a known service (`details.name`).
fn service_name(service: &str) -> Option<&'static str> {
    Some(match service {
        "network.mojom.NetworkService" => "Network Service",
        "audio.mojom.AudioService" => "Audio Service",
        "storage.mojom.StorageService" => "Storage Service",
        "video_capture.mojom.VideoCaptureService" => "Video Capture",
        "data_decoder.mojom.DataDecoderService" => "Data Decoder Service",
        "proxy_resolver.mojom.ProxyResolverFactory" => "Proxy Resolver",
        _ => return None,
    })
}

/// Electron's `details.reason` for a Windows exit code (what `GetExitCodeProcess` returns; Chromium logs the same
/// number as an `int`, so a negative one is the same code). Chromium's own table (`base::GetTerminationStatus`), with
/// the codes seen in `cef.log` ("GPU process exited unexpectedly: exit_code=…"):
///
/// - `0` → `clean-exit`.
/// - `1` (`RESULT_CODE_KILLED`, what Chromium and Task Manager pass to `TerminateProcess`; a process that exits 1 by
///   itself cannot be told apart), `3` (`RESULT_CODE_KILLED_BAD_MESSAGE`), `STATUS_CONTROL_C_EXIT` and the debugger's
///   `DBG_TERMINATE_PROCESS`/`DBG_CONTROL_C` → `killed`.
/// - out of memory (`STATUS_NO_MEMORY`, `STATUS_COMMITMENT_LIMIT`, Chromium's `0xE0000008`) → `oom`.
/// - the loader could not start it (`STATUS_DLL_NOT_FOUND`, `STATUS_INVALID_IMAGE_FORMAT`, `STATUS_DLL_INIT_FAILED`,
///   entry-point and ordinal not found) → `launch-failed`; `STATUS_INVALID_IMAGE_HASH` → `integrity-failure`.
/// - any other error NTSTATUS (`0xC…`: access violation, stack overflow, fast-fail `0xC0000409`…), a breakpoint
///   (`0x80000003`, a `CHECK` failure) and the `0xE…` software exceptions → `crashed`.
/// - any other non-zero code (a deliberate `exit(n)`) → `abnormal-exit`.
pub fn reason(exit_code: u32) -> &'static str {
    match exit_code {
        0 => "clean-exit",
        1 | 3 | 0xC000_013A | 0x4001_0004 | 0x4001_0005 => "killed",
        0xC000_0017 | 0xC000_012D | 0xE000_0008 => "oom",
        0xC000_0135 | 0xC000_007B | 0xC000_0142 | 0xC000_0139 | 0xC000_0138 => "launch-failed",
        0xC000_0428 => "integrity-failure",
        0x8000_0003 | 0xC000_0000..=0xCFFF_FFFF | 0xE000_0000..=0xEFFF_FFFF => "crashed",
        _ => "abnormal-exit",
    }
}

/// The `app.childProcessGone` data: `{type, reason, exitCode, serviceName?, name?}` (Electron's `Details`).
pub fn details(kind: &Kind, exit_code: u32) -> Value {
    details_with(kind, reason(exit_code), exit_code as i32)
}

/// The data for a helper that is gone without a way to ask why (macOS: its parent is Chromium, which reaps it, so there
/// is no exit status to read): reported as a crash with exit code -1. A helper ending because the app quits is never
/// reported, so a disappearance while the app runs is not a clean exit.
pub fn details_unknown_exit(kind: &Kind) -> Value {
    details_with(kind, "crashed", -1)
}

fn details_with(kind: &Kind, reason: &str, exit_code: i32) -> Value {
    let mut data = json!({
        "type": electron_type(&kind.process_type),
        "reason": reason,
        "exitCode": exit_code,
    });
    if let Some(service) = &kind.service {
        data["serviceName"] = json!(service);
        if let Some(name) = service_name(service) {
            data["name"] = json!(name);
        }
    }
    data
}

/// The arguments of a process from a `KERN_PROCARGS2` buffer (macOS): a native-endian `i32` argument count, the
/// executable's path and its NULs, then that many NUL-terminated arguments (the environment follows and is not read).
/// None for a buffer too short for the count or the path.
pub fn procargs_arguments(buffer: &[u8]) -> Option<Vec<String>> {
    let count = usize::try_from(i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?)).ok()?;
    let rest = &buffer[4..];
    let mut at = rest.iter().position(|byte| *byte == 0)?;
    while rest.get(at) == Some(&0) {
        at += 1;
    }
    let tail = &rest[at..];
    let end = tail.iter().rposition(|byte| *byte == 0)?;
    Some(
        tail[..end]
            .split(|byte| *byte == 0)
            .take(count)
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect(),
    )
}

/// The children seen so far, by pid; `H` is what the OS layer keeps per child (a process handle).
#[derive(Debug)]
pub struct Tracker<H> {
    children: HashMap<u32, (Option<Kind>, H)>,
}

impl<H> Default for Tracker<H> {
    fn default() -> Self {
        Self {
            children: HashMap::new(),
        }
    }
}

impl<H> Tracker<H> {
    pub fn knows(&self, pid: u32) -> bool {
        self.children.contains_key(&pid)
    }

    /// A newly seen child; `kind` is `None` for one that is not reported (the pid is remembered so its command line is
    /// read once).
    pub fn add(&mut self, pid: u32, kind: Option<Kind>, handle: H) {
        self.children.insert(pid, (kind, handle));
    }

    /// Forgets every child `exit_code` says is over (`Some(code)`) and returns the watched ones with their codes, in pid
    /// order. A child that is not reported leaves silently.
    pub fn finished(
        &mut self,
        mut exit_code: impl FnMut(u32, &H) -> Option<u32>,
    ) -> Vec<(Kind, u32)> {
        let mut pids: Vec<u32> = self.children.keys().copied().collect();
        pids.sort_unstable();
        let mut gone = Vec::new();
        for pid in pids {
            let code = match self.children.get(&pid) {
                Some((_, handle)) => exit_code(pid, handle),
                None => None,
            };
            if let Some(code) = code
                && let Some((kind, _)) = self.children.remove(&pid)
                && let Some(kind) = kind
            {
                gone.push((kind, code));
            }
        }
        gone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_values_from_a_command_line() {
        let line = r#""C:\Program Files\OMPdesk\ompdesk-shell.exe" --type=gpu-process --gpu-preferences=UAAAAA== --field-trial-handle=1,i,2 /prefetch:2"#;
        assert_eq!(flag_value(line, "--type").as_deref(), Some("gpu-process"));
        assert_eq!(
            flag_value(
                r#"x.exe "--type=utility" --utility-sub-type=network.mojom.NetworkService"#,
                "--type"
            )
            .as_deref(),
            Some("utility")
        );
        assert_eq!(flag_value("x.exe --typeface=a", "--type"), None);
        assert_eq!(flag_value("x.exe", "--type"), None);
        assert_eq!(flag_value("x.exe --type=", "--type").as_deref(), Some(""));
    }

    #[test]
    fn only_helpers_that_are_not_renderers_are_watched() {
        assert_eq!(
            watched_kind("a.exe --type=gpu-process --x"),
            Some(Kind {
                process_type: "gpu-process".into(),
                service: None
            })
        );
        assert_eq!(
            watched_kind("a.exe --type=utility --utility-sub-type=audio.mojom.AudioService"),
            Some(Kind {
                process_type: "utility".into(),
                service: Some("audio.mojom.AudioService".into())
            })
        );
        assert_eq!(watched_kind("a.exe --type=renderer"), None);
        assert_eq!(watched_kind("a.exe --type=crashpad-handler"), None);
        assert_eq!(watched_kind("powershell.exe -NoProfile"), None);
    }

    #[test]
    fn arguments_come_from_a_procargs2_buffer() {
        let mut buffer = 4i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(
            b"/A/OMPdesk.app/Contents/Frameworks/OMPdesk Helper (GPU).app/Contents/MacOS/OMPdesk Helper (GPU)\0\0\0\0OMPdesk Helper (GPU)\0--type=gpu-process\0--x=1\0--y\0HOME=/Users/x\0\0apple\0",
        );
        let args = procargs_arguments(&buffer).unwrap();
        assert_eq!(args.len(), 4);
        assert_eq!(args[1], "--type=gpu-process");
        assert_eq!(
            watched_kind_of_args(&args),
            Some(Kind {
                process_type: "gpu-process".into(),
                service: None
            })
        );
        assert_eq!(procargs_arguments(&[1, 0]), None);
        assert_eq!(procargs_arguments(&1i32.to_ne_bytes()), None);
        let renderer = vec!["h".to_string(), "--type=renderer".to_string()];
        assert_eq!(watched_kind_of_args(&renderer), None);
        let utility = vec![
            "h".to_string(),
            "--type=utility".to_string(),
            "--utility-sub-type=audio.mojom.AudioService".to_string(),
        ];
        assert_eq!(
            watched_kind_of_args(&utility).unwrap().service.as_deref(),
            Some("audio.mojom.AudioService")
        );
        assert_eq!(watched_kind_of_args(&["tool".to_string()]), None);
    }

    #[test]
    fn a_helper_gone_without_a_status_is_a_crash_with_minus_one() {
        let kind = Kind {
            process_type: "gpu-process".into(),
            service: None,
        };
        assert_eq!(
            details_unknown_exit(&kind),
            serde_json::json!({ "type": "GPU", "reason": "crashed", "exitCode": -1 })
        );
    }

    #[test]
    fn electron_type_words() {
        assert_eq!(electron_type("gpu-process"), "GPU");
        assert_eq!(electron_type("utility"), "Utility");
        assert_eq!(electron_type("zygote"), "Zygote");
        assert_eq!(electron_type("broker"), "Unknown");
    }

    #[test]
    fn reasons_for_exit_codes() {
        assert_eq!(reason(0), "clean-exit");
        assert_eq!(reason(1), "killed");
        assert_eq!(reason(3), "killed");
        assert_eq!(reason(0xC000_013A), "killed");
        assert_eq!(reason(0xC000_0005), "crashed");
        assert_eq!(reason(0xC000_0409), "crashed");
        assert_eq!(reason(0xC000_00FD), "crashed");
        assert_eq!(reason(0x8000_0003), "crashed");
        assert_eq!(reason(0xE000_0001), "crashed");
        assert_eq!(reason(0xC000_0017), "oom");
        assert_eq!(reason(0xE000_0008), "oom");
        assert_eq!(reason(0xC000_0135), "launch-failed");
        assert_eq!(reason(0xC000_007B), "launch-failed");
        assert_eq!(reason(0xC000_0428), "integrity-failure");
        assert_eq!(reason(34), "abnormal-exit");
        assert_eq!(reason(2), "abnormal-exit");
        // The codes cef.log printed as signed ints.
        assert_eq!(reason(-1_073_741_205_i32 as u32), "crashed"); // 0xC000026B
        assert_eq!(reason(-2_147_483_645_i32 as u32), "crashed"); // 0x80000003
        assert_eq!(reason(1_073_807_364), "killed"); // 0x40010004
    }

    #[test]
    fn details_carry_electrons_fields() {
        let gpu = Kind {
            process_type: "gpu-process".into(),
            service: None,
        };
        assert_eq!(
            details(&gpu, 0xC000_0005),
            json!({ "type": "GPU", "reason": "crashed", "exitCode": -1_073_741_819 })
        );
        let net = Kind {
            process_type: "utility".into(),
            service: Some("network.mojom.NetworkService".into()),
        };
        assert_eq!(
            details(&net, 0),
            json!({
                "type": "Utility", "reason": "clean-exit", "exitCode": 0,
                "serviceName": "network.mojom.NetworkService", "name": "Network Service"
            })
        );
        let other = Kind {
            process_type: "utility".into(),
            service: Some("x.mojom.Y".into()),
        };
        let data = details(&other, 1);
        assert_eq!(data["serviceName"], "x.mojom.Y");
        assert!(data.get("name").is_none());
    }

    #[test]
    fn tracker_reports_each_watched_death_once() {
        let mut t: Tracker<u32> = Tracker::default();
        let gpu = Kind {
            process_type: "gpu-process".into(),
            service: None,
        };
        t.add(10, Some(gpu.clone()), 10);
        t.add(11, None, 11);
        assert!(t.knows(10) && t.knows(11) && !t.knows(12));
        // Nothing has ended.
        assert!(t.finished(|_, _| None).is_empty());
        // The tool the shell spawned ends: silent. Then the GPU dies.
        assert!(t.finished(|pid, _| (pid == 11).then_some(0)).is_empty());
        assert!(!t.knows(11));
        let gone = t.finished(|pid, _| (pid == 10).then_some(0xC000_0005));
        assert_eq!(gone, vec![(gpu, 0xC000_0005)]);
        assert!(!t.knows(10));
        assert!(t.finished(|_, _| Some(0)).is_empty());
    }
}
