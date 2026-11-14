use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use super::*;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ompdesk-prefs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn empty_profile_and_unknown_values_round_trip_with_conf_bytes() {
    let dir = Scratch::new();
    let prefs = Prefs::open(&dir.0).unwrap();
    assert_eq!(prefs.snapshot(), json!({}));
    assert_eq!(prefs.get("missing").unwrap(), None);
    assert!(!dir.0.join("prefs.json").exists());
    std::fs::write(
        dir.0.join("prefs.json"),
        "{\"unknown\":{\"x\":1},\"theme\":\"dark\"}",
    )
    .unwrap();
    let prefs = Prefs::open(&dir.0).unwrap();
    prefs.set("theme", json!("light")).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.0.join("prefs.json")).unwrap(),
        "{\n\t\"unknown\": {\n\t\t\"x\": 1\n\t},\n\t\"theme\": \"light\"\n}"
    );
    assert_eq!(
        Prefs::open(&dir.0).unwrap().get("unknown.x").unwrap(),
        Some(json!(1))
    );
}

#[test]
fn dotted_paths_arrays_null_and_deletion() {
    let dir = Scratch::new();
    let prefs = Prefs::open(&dir.0).unwrap();
    prefs.set("a.b[1].c", json!(null)).unwrap();
    prefs.set(r"literal\.key", json!(true)).unwrap();
    assert!(prefs.has("a.b[1].c").unwrap());
    assert_eq!(prefs.get("a.b[1].c").unwrap(), Some(Value::Null));
    assert_eq!(prefs.get(r"literal\.key").unwrap(), Some(json!(true)));
    prefs.delete("a.b[1].c").unwrap();
    assert!(!prefs.has("a.b[1].c").unwrap());
    assert_eq!(
        prefs.snapshot(),
        json!({"a":{"b":[null,{}]},"literal.key":true})
    );
}

#[test]
fn non_disk_full_error_rejects_mutation_without_losing_previous_state() {
    let dir = Scratch::new();
    let prefs = Prefs::open(&dir.0).unwrap();
    prefs.set("value", json!(1)).unwrap();
    std::fs::remove_file(dir.0.join("prefs.json")).unwrap();
    std::fs::create_dir(dir.0.join("prefs.json")).unwrap();
    assert!(prefs.set("value", json!(2)).is_err());
    assert_eq!(prefs.get("value").unwrap(), Some(json!(1)));
    assert!(prefs.delete("value").is_err());
    assert_eq!(prefs.get("value").unwrap(), Some(json!(1)));
}

#[test]
fn concurrent_mutations_share_the_same_snapshot_and_file() {
    let dir = Scratch::new();
    let prefs = Prefs::open(&dir.0).unwrap();
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let prefs = Arc::clone(&prefs);
            std::thread::spawn(move || prefs.set(&format!("key{i}"), json!(i)).unwrap())
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.0.join("prefs.json")).unwrap()).unwrap();
    assert_eq!(disk, prefs.snapshot());
    for i in 0..8 {
        assert_eq!(prefs.get(&format!("key{i}")).unwrap(), Some(json!(i)));
    }
}

#[test]
fn malformed_file_is_not_silently_replaced() {
    let dir = Scratch::new();
    std::fs::write(dir.0.join("prefs.json"), "not json").unwrap();
    assert!(Prefs::open(&dir.0).is_err());
    assert_eq!(
        std::fs::read(dir.0.join("prefs.json")).unwrap(),
        b"not json"
    );
}
