use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::var_os("OMPDESK_RUN_TEMP").map_or_else(std::env::temp_dir, PathBuf::from);
        let path = root.join(format!(
            "runtime-log-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn writer(path: PathBuf) -> Writer {
    Writer::new(
        path,
        RuntimeLogContext {
            app_version: "1.2".into(),
            platform: "darwin".into(),
            pid: 42,
            window_id: None,
            cwd: None,
        },
    )
}

#[test]
fn normalizes_untrusted_fields_and_detail_limit() {
    let input = json!({"source":"not-a-source", "message": "x".repeat(8193), "stack": 4,
        "line": "3", "column": 2, "details": {"one": true, "two": [1], "three": null, "four": "z".repeat(4097)}});
    let result = normalize_runtime_error_report(&input);
    assert_eq!(result["source"], "unknown");
    assert_eq!(result["message"], format!("{}…", "x".repeat(8192)));
    assert!(result.get("stack").is_none());
    assert!(result.get("line").is_none());
    assert_eq!(result["column"], 2);
    assert_eq!(result["details"]["one"], true);
    assert_eq!(result["details"]["three"], Value::Null);
    assert!(result["details"].get("two").is_none());
    assert_eq!(result["details"]["four"], format!("{}…", "z".repeat(4096)));
    let values: Map<String, Value> = (0..25).map(|i| (format!("key{i}"), json!(i))).collect();
    assert_eq!(
        normalize_runtime_error_report(&json!({"details":values}))["details"]
            .as_object()
            .unwrap()
            .len(),
        24
    );
}

#[test]
fn writes_and_rotates_real_files() {
    let fixture = Fixture::new();
    let path = fixture.0.join("logs/gui-runtime.jsonl");
    let writer = writer(path.clone());
    let report = RuntimeLogReport::new(RuntimeErrorSource::ShellBoot, "started");
    writer.write(&report, Some(7.0), Some("/workspace"));
    let line = fs::read_to_string(&path).unwrap();
    let value: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(value["source"], "shell-boot");
    assert_eq!(value["windowId"], 7.0);
    assert_eq!(value["cwd"], "/workspace");
    assert_eq!(value["appVersion"], "1.2");
    fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();
    fs::write(fixture.0.join("logs/gui-runtime.jsonl.1"), b"old").unwrap();
    writer.write(&report, None, None);
    assert_eq!(
        fs::metadata(fixture.0.join("logs/gui-runtime.jsonl.1"))
            .unwrap()
            .len(),
        MAX_LOG_BYTES
    );
    assert_eq!(tail_log_lines(&path, 2, 256 * 1024).len(), 1);
}

#[test]
fn log_json_preserves_utf16_slice_surrogates() {
    use serde_json::value::RawValue;
    use std::collections::HashMap;

    let fixture = Fixture::new();
    let path = fixture.0.join("log");
    let mut report = RuntimeLogReport::new(
        RuntimeErrorSource::WindowError,
        format!("{}😀tail", "m".repeat(8191)),
    );
    report.stack = Some(format!("{}😀tail", "s".repeat(32767)));
    report.component_stack = Some(format!("{}😀tail", "c".repeat(32767)));
    report.url = Some(format!("{}😀tail", "u".repeat(4095)));
    report.details = Some(json!({ "note": format!("{}😀tail", "d".repeat(4095)) }));
    writer(path.clone()).write(&report, None, None);

    let bytes = fs::read(path).unwrap();
    let fields: HashMap<String, Box<RawValue>> = serde_json::from_slice(&bytes).unwrap();
    for (key, prefix, count) in [
        ("message", "m", 8191),
        ("stack", "s", 32767),
        ("componentStack", "c", 32767),
        ("url", "u", 4095),
    ] {
        assert_eq!(
            fields[key].get(),
            format!("\"{}\\ud83d…\"", prefix.repeat(count))
        );
    }
    let details: HashMap<String, Box<RawValue>> =
        serde_json::from_str(fields["details"].get()).unwrap();
    assert_eq!(
        details["note"].get(),
        format!("\"{}\\ud83d…\"", "d".repeat(4095))
    );
}

#[test]
fn tails_only_the_bounded_suffix_and_keeps_final_fragment() {
    let fixture = Fixture::new();
    let path = fixture.0.join("log");
    fs::write(&path, "first\nsecond\nthird\nlast").unwrap();
    assert_eq!(tail_log_lines(&path, 2, 100), ["third", "last"]);
    assert_eq!(tail_log_lines(&path, 8, 10), ["last"]);
    assert!(tail_log_lines(&fixture.0.join("missing"), 3, 100).is_empty());
}

#[test]
fn inaccessible_destination_is_dropped() {
    let fixture = Fixture::new();
    let path = fixture.0.join("file");
    fs::write(&path, "not a directory").unwrap();
    writer(path.join("log")).write(
        &RuntimeLogReport::new(RuntimeErrorSource::Unknown, "failure"),
        None,
        None,
    );
}
