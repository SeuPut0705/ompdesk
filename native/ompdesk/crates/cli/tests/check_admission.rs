//! `ompdesk check` fails closed: when a heavy slot cannot be taken (the pool folder cannot be written, as on a full
//! disk), the command never starts.

use std::path::PathBuf;
use std::process::Command;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ompdesk-admission-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_check_that_cannot_take_a_heavy_slot_never_runs_its_command() {
    let dir = temp("closed");
    // A file where the pool's folder should be: the pool cannot be made, as when the disk refuses its files.
    let blocked = dir.join("heavy");
    std::fs::write(&blocked, "not a folder").unwrap();
    let marker = dir.join("ran");
    let (program, args): (&str, Vec<String>) = if cfg!(windows) {
        (
            "cmd",
            vec!["/c".into(), format!("type nul > \"{}\"", marker.display())],
        )
    } else {
        ("touch", vec![marker.display().to_string()])
    };
    let out = Command::new(env!("CARGO_BIN_EXE_ompdesk"))
        .args(["check", "--"])
        .arg(program)
        .args(&args)
        .current_dir(&dir)
        .env("OMPDESK_HEAVY_DIR", &blocked)
        .env("OMPDESK_CHECKS_DIR", dir.join("store"))
        .env_remove("OMPDESK_HEAVY_HELD")
        .env_remove("OMPDESK_CHECK_RUN")
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_ne!(out.status.code(), Some(0), "{text}");
    assert!(text.contains("the command does not start"), "{text}");
    assert!(!marker.exists(), "the command ran: {text}");
    let _ = std::fs::remove_dir_all(dir);
}
