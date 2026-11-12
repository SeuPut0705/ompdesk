//! The handoff installer: what `ompdesk-windows-setup.exe` is when the release carries a new shell. Electron's
//! updater (electron-updater's NSIS flow, `OmpNsisUpdater`) downloads it, checks its SHA-512 and runs it with
//! `--updated` (plus `/S`, `--force-run` when asked) after the app quit. It installs over the Electron app in
//! place, keeping what an electron-builder per-user install recorded:
//! - the install folder (`HKCU\Software\<guid>\InstallLocation`, else `%LOCALAPPDATA%\Programs\<product>`),
//! - the exe name (`<product>.exe`: shortcuts, pins and protocol handlers keep pointing at it),
//! - the uninstall entry `HKCU\...\Uninstall\<guid>` (version, uninstaller, icon updated; the rest kept),
//! - userData (never touched; the new shell reads it as it is).
//! A move that fails at any step puts the Electron folder back and starts it again.
//!
//! `handoff-setup pack <payload-dir> <identity.json> <out.exe>` appends the payload (a zip) and the identity to a
//! copy of this exe. `--uninstall` (the copy written as `Uninstall <product>.exe`) removes the folder and entries.
use serde::Deserialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};

const MAGIC: &[u8; 8] = b"OMPHAND1";

#[derive(Deserialize, Clone)]
struct Identity {
    guid: String,
    product: String,
    version: String,
}

struct Log(fs::File);
impl Log {
    fn line(&mut self, event: &str, fields: serde_json::Value) {
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let _ = writeln!(self.0, "{}", serde_json::json!({ "at": ms as u64, "event": event, "fields": fields }));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("pack") {
        pack(Path::new(&args[2]), Path::new(&args[3]), Path::new(&args[4]));
        return;
    }
    let me = std::env::current_exe().unwrap();
    let (identity, payload) = read_tail(&me).expect("no payload: run `pack` first");
    let log_path = std::env::var("HANDOFF_LOG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join(format!("{}-handoff.jsonl", identity.guid)));
    let mut log = Log(fs::OpenOptions::new().create(true).append(true).open(&log_path).unwrap());
    log.line("start", serde_json::json!({ "args": args, "version": identity.version }));
    if args.iter().any(|a| a == "--uninstall") {
        uninstall(&identity, &mut log);
        return;
    }
    let code = match install(&identity, &payload, &args, &mut log) {
        Ok(()) => 0,
        Err(error) => {
            log.line("failed", serde_json::json!({ "error": error }));
            1
        }
    };
    std::process::exit(code);
}

fn pack(payload: &Path, identity: &Path, out: &Path) {
    let identity_bytes = fs::read(identity).unwrap();
    let _: Identity = serde_json::from_slice(&identity_bytes).expect("identity.json");
    let mut zip_bytes = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for entry in walkdir::WalkDir::new(payload).min_depth(1) {
            let entry = entry.unwrap();
            let rel = entry.path().strip_prefix(payload).unwrap().to_string_lossy().replace('\\', "/");
            if entry.file_type().is_dir() {
                zip.add_directory(rel, options).unwrap();
            } else {
                zip.start_file(rel, options.large_file(entry.metadata().unwrap().len() > u32::MAX as u64)).unwrap();
                zip.write_all(&fs::read(entry.path()).unwrap()).unwrap();
            }
        }
        zip.finish().unwrap();
    }
    let mut bytes = fs::read(std::env::current_exe().unwrap()).unwrap();
    let stub = bytes.len() as u64;
    bytes.extend_from_slice(&zip_bytes);
    bytes.extend_from_slice(&identity_bytes);
    bytes.extend_from_slice(&stub.to_le_bytes());
    bytes.extend_from_slice(&(zip_bytes.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(identity_bytes.len() as u64).to_le_bytes());
    bytes.extend_from_slice(MAGIC);
    fs::write(out, bytes).unwrap();
    println!("{} bytes ({} payload)", fs::metadata(out).unwrap().len(), zip_bytes.len());
}

/// Identity and payload zip from this exe's tail; the stub length lets the uninstaller copy only the program.
fn read_tail(exe: &Path) -> Option<(Identity, Vec<u8>)> {
    let mut file = fs::File::open(exe).ok()?;
    let len = file.metadata().ok()?.len();
    if len < 32 {
        return None;
    }
    file.seek(SeekFrom::End(-32)).ok()?;
    let mut tail = [0u8; 32];
    file.read_exact(&mut tail).ok()?;
    if &tail[24..] != MAGIC {
        return None;
    }
    let stub = u64::from_le_bytes(tail[0..8].try_into().ok()?);
    let zip_len = u64::from_le_bytes(tail[8..16].try_into().ok()?);
    let id_len = u64::from_le_bytes(tail[16..24].try_into().ok()?);
    let mut zip = vec![0u8; zip_len as usize];
    file.seek(SeekFrom::Start(stub)).ok()?;
    file.read_exact(&mut zip).ok()?;
    let mut id = vec![0u8; id_len as usize];
    file.read_exact(&mut id).ok()?;
    Some((serde_json::from_slice(&id).ok()?, zip))
}

fn stub_bytes(exe: &Path) -> Vec<u8> {
    // The uninstaller keeps the program and the identity, not the payload.
    let bytes = fs::read(exe).unwrap();
    let tail = &bytes[bytes.len() - 32..];
    let stub = u64::from_le_bytes(tail[0..8].try_into().unwrap()) as usize;
    let zip_len = u64::from_le_bytes(tail[8..16].try_into().unwrap()) as usize;
    let id_len = u64::from_le_bytes(tail[16..24].try_into().unwrap()) as usize;
    let mut out = bytes[..stub].to_vec();
    out.extend_from_slice(&bytes[stub + zip_len..stub + zip_len + id_len]);
    out.extend_from_slice(&(stub as u64).to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&(id_len as u64).to_le_bytes());
    out.extend_from_slice(MAGIC);
    out
}

fn install_dir(identity: &Identity, args: &[String]) -> PathBuf {
    if let Some(dir) = args.iter().find_map(|a| a.strip_prefix("/D=")) {
        return PathBuf::from(dir);
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey(format!("Software\\{}", identity.guid))
        && let Ok(dir) = key.get_value::<String, _>("InstallLocation")
    {
        return PathBuf::from(dir);
    }
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("Programs").join(&identity.product)
}

fn fail_at(step: &str) -> bool {
    std::env::var("HANDOFF_FAIL_AT").is_ok_and(|v| v == step)
}

fn install(identity: &Identity, payload: &[u8], args: &[String], log: &mut Log) -> Result<(), String> {
    let dir = install_dir(identity, args);
    let exe = dir.join(format!("{}.exe", identity.product));
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let staged = dir.with_extension(format!("new-{stamp}"));
    let old = dir.with_extension(format!("old-{stamp}"));
    log.line("dir", serde_json::json!({ "dir": dir, "existed": dir.is_dir() }));

    // 1. Stage the new files beside the old ones; any failure here leaves the old folder untouched.
    let staged_result = (|| -> Result<(), String> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(payload)).map_err(|e| e.to_string())?;
        archive.extract(&staged).map_err(|e| format!("extract: {e}"))?;
        if fail_at("extract") {
            return Err("HANDOFF_FAIL_AT=extract".into());
        }
        Ok(())
    })();
    if let Err(error) = staged_result {
        let _ = fs::remove_dir_all(&staged);
        relaunch(&exe, log, "old");
        return Err(error);
    }
    log.line("staged", serde_json::json!({ "staged": staged }));

    // 2. The old app has quit (electron-updater runs us before it exits): wait until its folder can move.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match fs::rename(&dir, &old) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) if Instant::now() > deadline => {
                let _ = fs::remove_dir_all(&staged);
                relaunch(&exe, log, "old");
                return Err(format!("the old app never let go of {}: {e}", dir.display()));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    log.line("moved-old", serde_json::json!({ "old": old }));

    // 3. Swap in the new folder; on failure put the old one back and start it.
    let swap = (|| -> Result<(), String> {
        if fail_at("swap") {
            return Err("HANDOFF_FAIL_AT=swap".into());
        }
        fs::rename(&staged, &dir).map_err(|e| format!("swap: {e}"))?;
        let uninstaller = dir.join(format!("Uninstall {}.exe", identity.product));
        fs::write(&uninstaller, stub_bytes(&std::env::current_exe().unwrap())).map_err(|e| e.to_string())?;
        if fail_at("registry") {
            return Err("HANDOFF_FAIL_AT=registry".into());
        }
        write_uninstall_entry(identity, &dir, &uninstaller).map_err(|e| format!("registry: {e}"))?;
        Ok(())
    })();
    if let Err(error) = swap {
        let _ = fs::remove_dir_all(&dir).or_else(|_| fs::remove_dir_all(&staged));
        let restored = old.is_dir() && fs::rename(&old, &dir).is_ok();
        log.line("rolled-back", serde_json::json!({ "restored": restored }));
        relaunch(&exe, log, "old");
        return Err(error);
    }
    log.line("swapped", serde_json::json!({}));
    let _ = fs::remove_dir_all(&old);

    // electron-builder's one-click installer starts the app after `--updated` unless silent without --force-run.
    let silent = args.iter().any(|a| a == "/S");
    if !silent || args.iter().any(|a| a == "--force-run") {
        relaunch(&exe, log, "new");
    }
    Ok(())
}

fn write_uninstall_entry(identity: &Identity, dir: &Path, uninstaller: &Path) -> std::io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
        identity.guid
    ))?;
    let quoted = format!("\"{}\" /currentuser", uninstaller.display());
    key.set_value("DisplayName", &format!("{} {}", identity.product, identity.version))?;
    key.set_value("DisplayVersion", &identity.version)?;
    key.set_value("UninstallString", &format!("{quoted} --uninstall"))?;
    key.set_value("QuietUninstallString", &format!("{quoted} --uninstall /S"))?;
    key.set_value("DisplayIcon", &format!("{},0", dir.join(format!("{}.exe", identity.product)).display()))?;
    let size: u64 = walkdir::WalkDir::new(dir).into_iter().flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum();
    key.set_value("EstimatedSize", &((size / 1024) as u32))?;
    let (loc, _) = hkcu.create_subkey(format!("Software\\{}", identity.guid))?;
    loc.set_value("InstallLocation", &dir.display().to_string())?;
    Ok(())
}

fn relaunch(exe: &Path, log: &mut Log, which: &str) {
    // Test seam: the old app restarts on the test profile it ran on (`--user-data-dir`), never on the real one.
    let extra: Vec<String> = match (which, std::env::var("HANDOFF_RELAUNCH_ARGS")) {
        ("old", Ok(args)) => args.split('|').filter(|a| !a.is_empty()).map(String::from).collect(),
        _ => Vec::new(),
    };
    let started = Command::new(exe).args(&extra).current_dir(exe.parent().unwrap()).spawn().map(|c| c.id());
    log.line("relaunch", serde_json::json!({ "which": which, "exe": exe, "pid": started.as_ref().ok(), "error": started.err().map(|e| e.to_string()) }));
}

fn uninstall(identity: &Identity, log: &mut Log) {
    let me = std::env::current_exe().unwrap();
    let dir = me.parent().unwrap().to_path_buf();
    // A running exe cannot delete its own folder: run a copy from %TEMP%.
    if !std::env::args().any(|a| a == "--from-temp") {
        let copy = std::env::temp_dir().join(format!("{}-uninstall.exe", identity.guid));
        fs::copy(&me, &copy).unwrap();
        let _ = Command::new(&copy).args(["--uninstall", "--from-temp", &dir.display().to_string()]).spawn();
        return;
    }
    let dir = PathBuf::from(std::env::args().last().unwrap());
    std::thread::sleep(Duration::from_millis(500));
    let removed = fs::remove_dir_all(&dir).is_ok();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let entry = hkcu
        .open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", KEY_ALL_ACCESS)
        .and_then(|k| k.delete_subkey_all(&identity.guid))
        .is_ok();
    let loc = hkcu.delete_subkey_all(format!("Software\\{}", identity.guid)).is_ok();
    log.line("uninstalled", serde_json::json!({ "dir": dir, "removed": removed, "entry": entry, "location": loc }));
}
