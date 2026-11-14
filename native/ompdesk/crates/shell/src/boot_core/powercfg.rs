//! Windows: a lid close follows the power scheme's "lid close action". While work runs on AC, the active scheme's AC
//! value is set to 0 (do nothing) with `powercfg` (no admin needed) and the person's own value is put back when it
//! stops. The battery (DC) value is never touched, and a person who already chose "do nothing" is left alone. The value
//! changed is written to the marker file before the change, so a crash or kill is undone at the next launch. Was
//! `src/main/power/lid-backend-windows.ts`; the runner is injected, so every OS tests it.

use std::path::PathBuf;

use serde_json::{Map, Value, json};

use super::js_space;
use super::lid::{Backend, Outcome};

/// `SUB_BUTTONS` and `LIDACTION` by GUID: the aliases are English only in some powercfg builds.
pub const SUB_BUTTONS: &str = "4f971e89-eebd-4455-a8de-9e59040e7347";
pub const LIDACTION: &str = "5ca83367-6e45-459f-a27b-476b1d01c936";
const DO_NOTHING: u64 = 0;

/// What this process changed: the scheme and the AC value it had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub scheme: String,
    pub ac: u64,
    pub at: u64,
}

impl Marker {
    /// `JSON.stringify({scheme, ac, at})`, the file's exact form.
    fn to_json(&self) -> String {
        format!(
            r#"{{"scheme":{},"ac":{},"at":{}}}"#,
            Value::String(self.scheme.clone()),
            self.ac,
            self.at
        )
    }
}

/// What a multiline `$` stops before.
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The first GUID in `text` (`/[0-9a-f]{8}-…-[0-9a-f]{12}/i`), lowercased.
fn first_guid(text: &str) -> Option<String> {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let bytes = text.as_bytes();
    'start: for start in 0..bytes.len() {
        let mut at = start;
        for (index, len) in GROUPS.iter().enumerate() {
            if index > 0 {
                if bytes.get(at) != Some(&b'-') {
                    continue 'start;
                }
                at += 1;
            }
            for _ in 0..*len {
                if !bytes.get(at).is_some_and(u8::is_ascii_hexdigit) {
                    continue 'start;
                }
                at += 1;
            }
        }
        return Some(text[start..at].to_ascii_lowercase());
    }
    None
}

/// The active scheme's GUID from `powercfg /getactivescheme`.
pub fn parse_active_scheme(output: &str) -> Result<String, String> {
    first_guid(output).ok_or_else(|| {
        // `output.slice(0, 200)`: UTF-16 units, as JavaScript cut it.
        let units: Vec<u16> = output.encode_utf16().take(200).collect();
        format!(
            "powercfg /getactivescheme: no scheme GUID in {}",
            Value::String(String::from_utf16_lossy(&units))
        )
    })
}

/// Every value of `/:\s*0x([0-9a-f]+)\s*$/gim` in `output`, in order.
fn hex_values(output: &str) -> Vec<u64> {
    let chars: Vec<char> = output.chars().collect();
    let mut values = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != ':' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && js_space(chars[j]) {
            j += 1;
        }
        let prefixed = j + 1 < chars.len() && chars[j] == '0' && matches!(chars[j + 1], 'x' | 'X');
        let digits_start = j + 2;
        let mut k = digits_start;
        while prefixed && k < chars.len() && chars[k].is_ascii_hexdigit() {
            k += 1;
        }
        if !prefixed || k == digits_start {
            i += 1;
            continue;
        }
        // `\s*$`: whitespace up to a line end or the end of the text (backtracking stops at the last line end in it).
        let mut m = k;
        let mut matched_end = (m == chars.len()).then_some(m);
        while m < chars.len() && js_space(chars[m]) {
            if line_end(chars[m]) {
                matched_end = Some(m);
            }
            m += 1;
        }
        if m == chars.len() {
            matched_end = Some(m);
        }
        let Some(end) = matched_end else {
            i += 1;
            continue;
        };
        let hex: String = chars[digits_start..k].iter().collect();
        values.push(u64::from_str_radix(&hex, 16).unwrap_or(u64::MAX));
        i = end.max(i + 1);
    }
    values
}

/// The AC value from `powercfg /query <scheme> <sub> <setting>`. The labels are localized ("Current AC Power Setting
/// Index", "현재 AC 전원 설정 인덱스"), so it reads the two `0x` values an index setting prints, AC first, then DC.
pub fn parse_ac_value(output: &str) -> Result<u64, String> {
    let values = hex_values(output);
    if values.len() != 2 {
        return Err(format!(
            "powercfg /query: expected AC and DC values, found {}",
            values.len()
        ));
    }
    Ok(values[0])
}

fn query_args(scheme: &str) -> Vec<String> {
    ["/query", scheme, SUB_BUTTONS, LIDACTION]
        .map(String::from)
        .to_vec()
}

/// The commands that put `marker`'s value back, given the scheme's current query output: none when the person changed
/// the value themselves meanwhile (it no longer reads "do nothing").
pub fn restore_commands(marker: &Marker, current_query: &str) -> Result<Vec<Vec<String>>, String> {
    if parse_ac_value(current_query)? != DO_NOTHING {
        return Ok(Vec::new());
    }
    Ok(vec![
        vec![
            "/setacvalueindex".into(),
            marker.scheme.clone(),
            SUB_BUTTONS.into(),
            LIDACTION.into(),
            marker.ac.to_string(),
        ],
        vec!["/setactive".into(), "SCHEME_CURRENT".into()],
    ])
}

/// `powercfg <args>`: its stdout, or why it failed.
pub type Runner = Box<dyn FnMut(&[String]) -> Result<String, String> + Send>;

pub struct WindowsLid {
    pub run: Runner,
    /// At least one battery: a desktop has no lid to close.
    pub has_battery: Box<dyn FnMut() -> Result<bool, String> + Send>,
    pub marker_file: PathBuf,
    pub now: Box<dyn FnMut() -> u64 + Send>,
    held: Option<Marker>,
}

impl WindowsLid {
    pub fn new(
        run: Runner,
        has_battery: Box<dyn FnMut() -> Result<bool, String> + Send>,
        marker_file: PathBuf,
        now: Box<dyn FnMut() -> u64 + Send>,
    ) -> WindowsLid {
        WindowsLid {
            run,
            has_battery,
            marker_file,
            now,
            held: None,
        }
    }

    fn query(&mut self, scheme: &str) -> Result<String, String> {
        (self.run)(&query_args(scheme))
    }

    fn apply(&mut self, scheme: &str) -> Result<(), String> {
        (self.run)(&[
            "/setacvalueindex".into(),
            scheme.into(),
            SUB_BUTTONS.into(),
            LIDACTION.into(),
            DO_NOTHING.to_string(),
        ])?;
        (self.run)(&["/setactive".into(), "SCHEME_CURRENT".into()])?;
        Ok(())
    }

    /// Puts back the person's value. The marker stays until that succeeded, so a failure is retried, not forgotten.
    fn restore(&mut self) -> Result<(), String> {
        let Some(marker) = self.held.clone() else {
            return Ok(());
        };
        let current = self.query(&marker.scheme)?;
        for command in restore_commands(&marker, &current)? {
            (self.run)(&command)?;
        }
        self.held = None;
        self.remove_marker();
        Ok(())
    }

    fn read_marker(&mut self) -> Option<Marker> {
        let text = std::fs::read_to_string(&self.marker_file).ok()?;
        let parsed = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
            let scheme = value.get("scheme")?.as_str()?;
            first_guid(scheme)?;
            // `Number.isInteger(ac) && ac >= 0`: an integral JSON number, `1.0` included.
            let ac = value.get("ac")?.as_f64()?;
            if ac.fract() != 0.0 || ac < 0.0 {
                return None;
            }
            let at = value.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            Some(Marker {
                scheme: scheme.to_string(),
                ac: ac as u64,
                at: at as u64,
            })
        });
        if parsed.is_none() {
            // Unreadable: nothing to restore from; never guess a value.
            self.remove_marker();
        }
        parsed
    }

    fn write_marker(&self, marker: &Marker) -> Result<(), String> {
        write_atomic(&self.marker_file, marker.to_json().as_bytes())
    }

    fn remove_marker(&self) {
        let _ = std::fs::remove_file(&self.marker_file);
    }
}

/// A sibling temp file renamed over the target (`src/main/atomic-file.ts`'s rule): Windows refuses the rename while
/// another process has the target open, so a refusal is tried again for about half a second.
fn write_atomic(file: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    let mut last = None;
    for wait in [0, 10, 20, 40, 80, 160, 320] {
        std::thread::sleep(std::time::Duration::from_millis(wait));
        match std::fs::rename(&temp, file) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                last = Some(error)
            }
            Err(error) => {
                last = Some(error);
                break;
            }
        }
    }
    let _ = std::fs::remove_file(&temp);
    Err(last.map_or_else(|| "rename failed".into(), |e| e.to_string()))
}

impl Backend for WindowsLid {
    fn name(&self) -> &'static str {
        "powercfg"
    }

    fn is_laptop(&mut self) -> Result<bool, String> {
        (self.has_battery)()
    }

    fn recover(&mut self) -> Result<Option<Map<String, Value>>, String> {
        let Some(marker) = self.read_marker() else {
            return Ok(None);
        };
        let current = self.query(&marker.scheme)?;
        let commands = restore_commands(&marker, &current)?;
        let restored = !commands.is_empty();
        for command in commands {
            (self.run)(&command)?;
        }
        self.remove_marker();
        Ok(
            json!({ "scheme": marker.scheme, "ac": marker.ac, "restored": restored })
                .as_object()
                .cloned(),
        )
    }

    fn hold(&mut self) -> Result<Outcome, String> {
        let details = |marker: &Marker| {
            json!({ "scheme": marker.scheme, "ac": marker.ac })
                .as_object()
                .cloned()
                .unwrap_or_default()
        };
        // A restore that failed still owns the person's value: never read the 0 it left as theirs.
        if let Some(held) = self.held.clone() {
            self.apply(&held.scheme)?;
            return Ok(Outcome {
                changed: true,
                details: details(&held),
            });
        }
        let scheme = parse_active_scheme(&(self.run)(&["/getactivescheme".into()])?)?;
        let ac = parse_ac_value(&self.query(&scheme)?)?;
        let marker = Marker {
            scheme: scheme.clone(),
            ac,
            at: (self.now)(),
        };
        if ac == DO_NOTHING {
            return Ok(Outcome {
                changed: false,
                details: details(&marker),
            });
        }
        self.write_marker(&marker)?;
        self.held = Some(marker.clone());
        if let Err(error) = self.apply(&scheme) {
            // Half a hold is undone now; if that fails too, the marker stays for release, quit or the next launch.
            let _ = self.restore();
            return Err(error);
        }
        Ok(Outcome {
            changed: true,
            details: details(&marker),
        })
    }

    fn release(&mut self) -> Result<(), String> {
        self.restore()
    }

    fn release_now(&mut self) -> Result<(), String> {
        self.restore()
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn replays_the_powercfg_readers_as_captured() {
        let captured: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        let readers = &captured["powercfg"];
        for case in readers["activeScheme"].as_array().unwrap() {
            let got = parse_active_scheme(case["input"].as_str().unwrap());
            match got {
                Ok(scheme) => assert_eq!(json!(scheme), case["ok"], "{case}"),
                Err(error) => assert_eq!(json!(error), case["error"], "{case}"),
            }
        }
        for case in readers["acValue"].as_array().unwrap() {
            match parse_ac_value(case["input"].as_str().unwrap()) {
                Ok(ac) => assert_eq!(json!(ac), case["ok"], "{case}"),
                Err(error) => assert_eq!(json!(error), case["error"], "{case}"),
            }
        }
        for case in readers["restore"].as_array().unwrap() {
            let m = &case["marker"];
            let marker = Marker {
                scheme: m["scheme"].as_str().unwrap().into(),
                ac: m["ac"].as_u64().unwrap(),
                at: m["at"].as_u64().unwrap(),
            };
            match restore_commands(&marker, case["query"].as_str().unwrap()) {
                Ok(commands) => assert_eq!(json!(commands), case["ok"], "{case}"),
                Err(error) => assert_eq!(json!(error), case["error"], "{case}"),
            }
        }
    }

    /// The capture's fake powercfg (`capture-boot.ts` `runWin`, in commit d8898998c): one scheme's lid values, every command recorded,
    /// `fail` makes the n-th call of a verb throw.
    #[derive(Default)]
    struct FakeState {
        ac: u64,
        dc: u64,
        commands: Vec<String>,
        fail: HashSet<String>,
        seen: HashMap<String, usize>,
    }

    const BALANCED: &str = "381b4222-f694-41f0-9685-ff5bb260df2e";

    fn query_output(ac: u64, dc: u64) -> String {
        [
            format!("Power Scheme GUID: {BALANCED}  (Balanced)"),
            "  GUID Alias: SCHEME_BALANCED".into(),
            format!("  Subgroup GUID: {SUB_BUTTONS}  (Power buttons and lid)"),
            "    GUID Alias: SUB_BUTTONS".into(),
            format!("    Power Setting GUID: {LIDACTION}  (Lid close action)"),
            "      GUID Alias: LIDACTION".into(),
            "      Possible Setting Index: 000".into(),
            "      Possible Setting Friendly Name: Do nothing".into(),
            "      Possible Setting Index: 001".into(),
            "      Possible Setting Friendly Name: Sleep".into(),
            format!("    Current AC Power Setting Index: 0x{ac:08x}"),
            format!("    Current DC Power Setting Index: 0x{dc:08x}"),
            String::new(),
        ]
        .join("\r\n")
    }

    fn fake_runner(state: Arc<Mutex<FakeState>>) -> Runner {
        Box::new(move |args: &[String]| {
            let mut s = state.lock().unwrap();
            s.commands.push(args.join(" "));
            let verb = args.first().cloned().unwrap_or_default();
            let nth = {
                let count = s.seen.entry(verb.clone()).or_insert(0);
                *count += 1;
                *count
            };
            if s.fail.remove(&format!("{verb}#{nth}")) {
                return Err(format!("powercfg {verb} failed"));
            }
            match verb.as_str() {
                "/getactivescheme" => Ok(format!("Power Scheme GUID: {BALANCED}  (Balanced)\r\n")),
                "/query" => Ok(query_output(s.ac, s.dc)),
                "/setacvalueindex" => {
                    s.ac = args[4].parse().unwrap();
                    Ok(String::new())
                }
                "/setactive" => Ok(String::new()),
                _ => Err(format!("unexpected powercfg {}", args.join(" "))),
            }
        })
    }

    #[test]
    fn replays_the_windows_lid_backend_as_captured() {
        let captured: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        let scenarios = captured["windowsLid"].as_array().unwrap();
        assert_eq!(scenarios.len(), 16);
        for (index, scenario) in scenarios.iter().enumerate() {
            let name = scenario["name"].as_str().unwrap();
            let dir = std::env::temp_dir().join(format!("boot-lid-{}-{index}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let marker_file = dir.join("lid-awake.json");
            let state = Arc::new(Mutex::new(FakeState {
                ac: scenario["initial"]["ac"].as_u64().unwrap(),
                dc: scenario["initial"]["dc"].as_u64().unwrap(),
                ..FakeState::default()
            }));
            let now = Rc::new(RefCell::new(1000u64));
            let make = |state: &Arc<Mutex<FakeState>>, at: u64| {
                WindowsLid::new(
                    fake_runner(state.clone()),
                    Box::new(|| Ok(true)),
                    marker_file.clone(),
                    Box::new(move || at),
                )
            };
            let mut backend = make(&state, *now.borrow());
            for expected in scenario["steps"].as_array().unwrap() {
                let step = expected["step"].as_str().unwrap();
                let mut result = Value::Null;
                let mut error = Value::Null;
                let outcome: Result<(), String> = match step {
                    "hold" => backend.hold().map(|o| {
                        result = json!({ "changed": o.changed, "details": o.details });
                    }),
                    "release" => backend.release(),
                    "releaseNow" => backend.release_now(),
                    "recover" => {
                        *now.borrow_mut() += 1000;
                        backend = make(&state, *now.borrow());
                        backend.recover().map(|found| {
                            result = found.map_or(Value::Null, Value::Object);
                        })
                    }
                    other => {
                        let mut s = state.lock().unwrap();
                        if let Some(ac) = other.strip_prefix("user:") {
                            s.ac = ac.parse().unwrap();
                        } else if let Some(fail) = other.strip_prefix("fail:") {
                            s.fail.insert(fail.into());
                        } else if let Some(text) = other.strip_prefix("marker:") {
                            std::fs::write(&marker_file, text).unwrap();
                        }
                        Ok(())
                    }
                };
                if let Err(e) = outcome {
                    error = json!(e);
                }
                let mut s = state.lock().unwrap();
                let commands = std::mem::take(&mut s.commands);
                let marker = std::fs::read_to_string(&marker_file).ok();
                let got = json!({
                    "step": step, "result": result, "error": error, "commands": commands,
                    "ac": s.ac, "dc": s.dc, "marker": marker,
                });
                assert_eq!(&got, expected, "{name}");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
