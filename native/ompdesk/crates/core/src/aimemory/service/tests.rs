//! The service's parts against the TypeScript they replace: the tables of `captured.json` (captured from the
//! TypeScript before it was deleted), and the cases of `binary.test.ts`, `root.test.ts`, `terminal.test.ts`,
//! `unit.test.ts` and `recall-state.test.ts`, whose functions now live here.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

use super::binary::{self, Builds, BuiltAsset, SignatureCheck};
use super::root::{self, Ran, RunCommand};
use super::terminal::{self, Wiring};
use super::text::{self, Plan};
use super::unit::{self, Exec, Exit, LAUNCHD_LABEL, ServiceUnit, Unit};
use super::{Boxed, Failure, RecallFile, captured};

fn temp() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-aimemory-service-{}-{}-{}",
        std::process::id(),
        super::system_now(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn reads_setups_problems_plan_and_tail_as_the_typescript_did() {
    for row in captured("parseProblems") {
        let expected: Vec<String> = serde_json::from_value(row["problems"].clone()).unwrap();
        assert_eq!(
            text::parse_problems(text(&row["output"])),
            expected,
            "{row}"
        );
    }
    for row in captured("parsePlan") {
        let expected: Option<Plan> = row["plan"].as_object().map(|plan| Plan {
            data_dir: plan["dataDir"].as_str().map(str::to_owned),
            config_path: plan["configPath"].as_str().map(str::to_owned),
            fresh: plan["fresh"] == Value::Bool(true),
        });
        assert_eq!(text::parse_plan(text(&row["output"])), expected, "{row}");
    }
    for row in captured("tail") {
        let lines = row["lines"].as_u64().unwrap() as usize;
        assert_eq!(
            text::tail(text(&row["output"]), lines),
            text(&row["tail"]),
            "{row}"
        );
    }
    for row in captured("withoutLocalEmbeddings") {
        assert_eq!(
            text::without_local_embeddings(text(&row["toml"])).as_deref(),
            row["next"].as_str(),
            "{row}"
        );
    }
}

#[test]
fn folds_paths_as_node_did_on_both_systems() {
    for row in captured("withinPath") {
        let (posix, win32) = terminal::within_both(text(&row["command"]), text(&row["path"]));
        assert_eq!(
            (posix, win32),
            (row["posix"] == true, row["win32"] == true),
            "{row}"
        );
    }
}

/// A rewritten JSON file whose input holds a number JavaScript respells (`1.0`, `1e3`, `1e21`) or an integer-like key
/// it moves first: those rows differ on purpose (the ledger's 7b differences).
fn respelled(input: &str) -> bool {
    input.contains("1.0")
        || input.contains("1e3")
        || input.contains("1e21")
        || input.contains("\"1\":")
}

#[test]
fn reads_and_removes_the_terminal_wiring_as_the_typescript_did() {
    let root = temp();
    let mut respelled_rows = 0;
    for (index, row) in captured("wiring").into_iter().enumerate() {
        let agent = root.join(format!("a{index}"));
        fs::create_dir_all(agent.join("extensions")).unwrap();
        if let Some(extension) = row["extension"].as_str() {
            fs::write(agent.join(terminal::EXTENSION_FILE), extension).unwrap();
        }
        if let Some(mcp) = row["mcp"].as_str() {
            fs::write(agent.join(terminal::MCP_FILE), mcp).unwrap();
        }
        let read = &row["read"];
        let expected = Wiring {
            extension: read["extension"] == true,
            mcp: read["mcp"] == true,
            command: read["command"].as_str().map(str::to_owned),
        };
        assert_eq!(terminal::read_wiring(&agent), expected, "{row}");
        terminal::remove_wiring(&agent).unwrap();
        let after = |name: &str| fs::read_to_string(agent.join(name)).ok();
        assert_eq!(
            after(terminal::EXTENSION_FILE).as_deref(),
            row["extensionAfter"].as_str(),
            "{row}"
        );
        let mcp_after = after(terminal::MCP_FILE);
        if respelled(row["mcp"].as_str().unwrap_or_default())
            && mcp_after.as_deref() != row["mcpAfter"].as_str()
        {
            respelled_rows += 1;
            continue;
        }
        assert_eq!(mcp_after.as_deref(), row["mcpAfter"].as_str(), "{row}");
    }
    // The two inputs with respelled numbers and keys, under each of the eight extension texts.
    assert_eq!(respelled_rows, 16);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn names_the_overlay_by_its_content_as_the_typescript_did() {
    for row in captured("overlay") {
        let lists: Vec<Option<Vec<String>>> = serde_json::from_value(row["lists"].clone()).unwrap();
        let ids: Vec<String> = serde_json::from_value(row["ids"].clone()).unwrap();
        let (overlay, name) = text::overlay(&lists, 2, &ids);
        assert_eq!(
            (overlay.as_str(), name.as_str()),
            (text(&row["text"]), text(&row["name"])),
            "{row}"
        );
    }
}

#[test]
fn reads_the_logon_entry_and_versions_as_the_typescript_did() {
    for row in captured("commandProgram") {
        assert_eq!(
            unit::command_program(text(&row["line"])),
            text(&row["program"]),
            "{row}"
        );
    }
    for row in captured("runEntryCommand") {
        assert_eq!(
            unit::run_entry_command(text(&row["output"])).as_deref(),
            row["command"].as_str(),
            "{row}"
        );
    }
    for row in captured("version") {
        assert_eq!(
            binary::parse_version(text(&row["output"])).as_deref(),
            row["version"].as_str(),
            "{row}"
        );
    }
    for row in captured("recallText") {
        assert_eq!(row["env"].to_string(), text(&row["text"]));
    }
}

fn builds() -> Builds {
    serde_json::from_value(json!({
        "binaries": { "darwin-arm64": "ai-memory", "win32-x64": "ai-memory.exe" },
        "manifest": "ai-memory.build.json",
        "version": "3.1.1",
        "macStageKey": "current",
        "requirement": "identifier \"ai-memory\"",
    }))
    .unwrap()
}

#[test]
fn reads_the_build_record_as_the_typescript_did() {
    let root = temp();
    for (index, row) in captured("builtAsset").into_iter().enumerate() {
        let dir = root.join(format!("b{index}"));
        fs::create_dir_all(&dir).unwrap();
        if let Some(record) = row["record"].as_str() {
            fs::write(dir.join("ai-memory.build.json"), record).unwrap();
        }
        let read =
            binary::read_built_asset(&builds(), &dir, text(&row["platform"]), text(&row["arch"]));
        // `null` as the record: JavaScript threw reading `.binary` of it; here it is no build record.
        if row["record"] == "null" && !row["error"].is_null() {
            assert!(read.unwrap_err().contains("is not a build record"), "{row}");
            continue;
        }
        let shown = dir.to_string_lossy().into_owned();
        match (&read, row["answer"].as_object()) {
            (Ok(Some(asset)), Some(answer)) => {
                assert_eq!(asset.binary, text(&answer["binary"]));
                assert_eq!(asset.sha256, text(&answer["binarySha256"]));
                assert_eq!(asset.darwin, answer["platform"] == "darwin");
                assert_eq!(binary::stage_key(&builds(), asset), text(&row["key"]));
            }
            (Ok(None), None) if row["error"].is_null() => {}
            (Err(message), None) => {
                assert_eq!(
                    message.replace(&shown, "<dir>"),
                    // Captured on Windows: the record's path is joined with the platform's separator.
                    text(&row["error"])
                        .replace("<dir>\\", &format!("<dir>{}", std::path::MAIN_SEPARATOR)),
                    "{row}"
                );
            }
            _ => panic!("{row}: {read:?}"),
        }
    }
    let _ = fs::remove_dir_all(&root);
}

const CONTENT: &str = "#!/bin/sh\necho ai-memory fake\n";

fn asset(content: &str, darwin: bool) -> BuiltAsset {
    BuiltAsset {
        binary: "ai-memory".to_owned(),
        sha256: text::sha256_hex(content.as_bytes()),
        darwin,
    }
}

type Check = SignatureCheck<'static>;

/// A signature check that answers `problem` for every file and records which it was asked about.
fn requirement(problem: Option<&str>) -> (Arc<Mutex<Vec<String>>>, Box<Check>) {
    let checked = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&checked);
    let problem = problem.map(str::to_owned);
    let check: Box<Check> = Box::new(move |file| {
        seen.lock().unwrap().push(file);
        let problem = problem.clone();
        Box::pin(async move { Ok(problem) })
    });
    (checked, check)
}

struct Staging {
    root: PathBuf,
    tools: PathBuf,
    source: PathBuf,
}

fn staging() -> Staging {
    let root = temp();
    let source = root.join("shipped").join("ai-memory");
    write(&source, CONTENT);
    Staging {
        tools: root.join("tools"),
        source,
        root,
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

async fn stage(
    at: &Staging,
    source: &Path,
    asset: &BuiltAsset,
    check: Option<&Check>,
) -> Result<PathBuf, String> {
    binary::stage_binary(&builds(), source, asset, &at.tools, check).await
}

fn listed(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn stages_the_shipped_binary_into_its_own_folder() {
    let at = staging();
    let win = asset(CONTENT, false);
    let staged = stage(&at, &at.source, &win, None).await.unwrap();
    let key = binary::stage_key(&builds(), &win);
    assert_eq!(
        staged,
        at.tools.join("ai-memory").join(&key).join("ai-memory")
    );
    assert_eq!(fs::read_to_string(&staged).unwrap(), CONTENT);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(
            fs::metadata(&staged).unwrap().permissions().mode() & 0o111,
            0
        );
    }
    // Atomic: the temp folder was renamed into place, nothing else is left beside the version.
    assert_eq!(
        listed(&binary::staging_root(&at.tools)),
        std::slice::from_ref(&key)
    );
    // A matching staged copy is reused without reading the shipped file.
    fs::remove_file(&at.source).unwrap();
    let again = stage(&at, &at.root.join("no-such-file"), &win, None)
        .await
        .unwrap();
    assert_eq!(again, staged);
}

#[tokio::test]
async fn refuses_a_shipped_binary_that_is_not_the_recorded_one() {
    let at = staging();
    let win = asset(CONTENT, false);
    fs::write(&at.source, "tampered").unwrap();
    let refused = stage(&at, &at.source, &win, None).await.unwrap_err();
    assert_eq!(
        refused,
        format!(
            "The bundled ai-memory does not match its build record (expected {}, got {}). Reinstall OMPdesk.",
            win.sha256,
            text::sha256_hex(b"tampered")
        )
    );
    assert!(
        !listed(&binary::staging_root(&at.tools)).contains(&binary::stage_key(&builds(), &win))
    );
    let missing = stage(&at, &at.root.join("gone"), &win, None)
        .await
        .unwrap_err();
    assert!(
        missing.contains("bundled ai-memory is missing"),
        "{missing}"
    );
}

#[tokio::test]
async fn replaces_a_torn_staged_copy_and_keeps_a_good_one() {
    let at = staging();
    let win = asset(CONTENT, false);
    let dest = at
        .tools
        .join("ai-memory")
        .join(binary::stage_key(&builds(), &win))
        .join("ai-memory");
    write(&dest, "torn");
    write(&dest.with_file_name("stray"), "left over");
    let staged = stage(&at, &at.source, &win, None).await.unwrap();
    assert_eq!(fs::read_to_string(&staged).unwrap(), CONTENT);
    assert_eq!(listed(dest.parent().unwrap()), ["ai-memory"]);
    // A good staged copy stays when the shipped file turns out wrong.
    fs::write(&at.source, "tampered").unwrap();
    assert_eq!(stage(&at, &at.source, &win, None).await.unwrap(), staged);
}

#[tokio::test]
async fn stages_every_macos_build_at_one_path_and_each_windows_build_apart() {
    let at = staging();
    let (_, check) = requirement(None);
    let first = stage(&at, &at.source, &asset(CONTENT, true), Some(&*check))
        .await
        .unwrap();
    assert_eq!(
        first,
        at.tools.join("ai-memory").join("current").join("ai-memory")
    );
    let next = "#!/bin/sh\necho the next release\n";
    fs::write(&at.source, next).unwrap();
    let second = stage(&at, &at.source, &asset(next, true), Some(&*check))
        .await
        .unwrap();
    assert_eq!(second, first);
    assert_eq!(fs::read_to_string(&second).unwrap(), next);

    let at = staging();
    let first = stage(&at, &at.source, &asset(CONTENT, false), None)
        .await
        .unwrap();
    fs::write(&at.source, next).unwrap();
    let second = stage(&at, &at.source, &asset(next, false), None)
        .await
        .unwrap();
    assert_ne!(second, first);
    assert_eq!(fs::read_to_string(&first).unwrap(), CONTENT);
}

#[cfg(unix)]
#[tokio::test]
async fn keeps_the_macos_binary_the_service_runs_when_its_replacement_cannot_be_put_in_place() {
    use std::os::unix::fs::PermissionsExt;
    let at = staging();
    let (_, check) = requirement(None);
    let dest = stage(&at, &at.source, &asset(CONTENT, true), Some(&*check))
        .await
        .unwrap();
    let next = "#!/bin/sh\necho the next release\n";
    fs::write(&at.source, next).unwrap();
    let folder = dest.parent().unwrap().to_owned();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
    let refused = stage(&at, &at.source, &asset(next, true), Some(&*check)).await;
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(refused.is_err());
    assert_eq!(fs::read_to_string(&dest).unwrap(), CONTENT);
    assert_eq!(listed(&binary::staging_root(&at.tools)), ["current"]);
}

#[tokio::test]
async fn macos_stages_a_binary_its_signature_vouches_for() {
    const SIGNED: &str = "#!/bin/sh\necho ai-memory fake, re-signed by the packager\n";
    let at = staging();
    let pinned = asset(CONTENT, false);
    fs::write(&at.source, SIGNED).unwrap();
    let source = at.source.to_string_lossy().into_owned();
    let (checked, check) = requirement(None);
    let staged = stage(&at, &at.source, &pinned, Some(&*check))
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&staged).unwrap(), SIGNED);
    // The next launch verifies the shipped file again and reuses the byte-identical copy.
    stage(&at, &at.source, &pinned, Some(&*check))
        .await
        .unwrap();
    assert_eq!(*checked.lock().unwrap(), [source.clone(), source]);

    // A staged copy is never trusted by itself: one that differs from the verified shipped file is replaced.
    fs::write(&staged, "#!/bin/sh\necho planted\n").unwrap();
    stage(&at, &at.source, &pinned, Some(&*check))
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&staged).unwrap(), SIGNED);
    // An update re-signed the shipped file: staged again.
    fs::write(&at.source, format!("{SIGNED}# signed again\n")).unwrap();
    stage(&at, &at.source, &pinned, Some(&*check))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(&staged).unwrap(),
        format!("{SIGNED}# signed again\n")
    );
}

#[tokio::test]
async fn macos_refuses_a_binary_neither_recorded_nor_signed_and_never_asks_for_the_recorded_one() {
    let at = staging();
    let pinned = asset(CONTENT, false);
    let (_, failing) = requirement(Some("failed to satisfy"));
    fs::write(&at.source, "tampered").unwrap();
    let refused = stage(&at, &at.source, &pinned, Some(&*failing))
        .await
        .unwrap_err();
    assert_eq!(
        refused,
        format!(
            "The bundled ai-memory is neither the built binary (expected {}, got {}) nor signed with OMPdesk's certificate (failed to satisfy). Reinstall OMPdesk.",
            pinned.sha256,
            text::sha256_hex(b"tampered")
        )
    );
    assert!(listed(&binary::staging_root(&at.tools)).is_empty());

    // The recorded bytes (a dev build's own copy) stage by hash, without asking codesign.
    let at = staging();
    let (checked, check) = requirement(Some("not signed by OMPdesk"));
    let staged = stage(&at, &at.source, &pinned, Some(&*check))
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&staged).unwrap(), CONTENT);
    assert!(checked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn prunes_other_versions_and_temp_folders() {
    let at = staging();
    let win = asset(CONTENT, false);
    let root = binary::staging_root(&at.tools);
    // Nothing staged yet: nothing to do.
    binary::prune_staged(&builds(), &at.tools, &win);
    stage(&at, &at.source, &win, None).await.unwrap();
    write(&root.join("3.0.0").join("ai-memory"), "old");
    fs::create_dir_all(root.join(".stage-123-456")).unwrap();
    binary::prune_staged(&builds(), &at.tools, &win);
    assert_eq!(listed(&root), [binary::stage_key(&builds(), &win)]);

    // An install moves off the per-build macOS folders it staged before.
    let at = staging();
    let root = binary::staging_root(&at.tools);
    write(&root.join("3.1.1-cd334dd2").join("ai-memory"), "old");
    let mac = asset(CONTENT, true);
    stage(&at, &at.source, &mac, None).await.unwrap();
    binary::prune_staged(&builds(), &at.tools, &mac);
    assert_eq!(listed(&root), ["current"]);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn the_real_codesign_refuses_any_other_valid_signature() {
    let signing: Value = serde_json::from_str(include_str!(
        "../../../../../../../scripts/mac-signing.json"
    ))
    .unwrap();
    let requirement = format!(
        "identifier \"ai-memory\" and certificate root = H\"{}\"",
        text(&signing["certificateSha1"])
    );
    let problem = binary::code_requirement_problem("/usr/bin/true", &requirement).await;
    assert!(problem.unwrap().contains("failed to satisfy"));
    let at = staging();
    let unsigned =
        binary::code_requirement_problem(&at.source.to_string_lossy(), &requirement).await;
    assert!(unsigned.unwrap().contains("not signed"));
}

/// Stands in for ai-memory's three generators: each writes only the file its flag names, as the real ones do.
fn generators(
    skip: Option<&'static str>,
    version: &'static str,
    stray: bool,
    entry: Value,
) -> Box<RunCommand<'static>> {
    Box::new(move |args| {
        let entry = entry.clone();
        Box::pin(async move {
            let at = |flag: &str| {
                PathBuf::from(&args[args.iter().position(|arg| arg == flag).unwrap() + 1])
            };
            if Some(args[0].as_str()) == skip {
                return Ok(Ran {
                    ok: false,
                    cancelled: false,
                    output: "boom".to_owned(),
                });
            }
            match args[0].as_str() {
                "install-hooks" => {
                    write(&at("--config-file"), &format!("// ext {version}\n"));
                    if stray {
                        let backup = format!("{}.bak-123", at("--config-file").to_string_lossy());
                        write(Path::new(&backup), "backup");
                    }
                }
                "install-mcp" => write(
                    &at("--config-file"),
                    &json!({ "mcpServers": { "ai-memory": entry } }).to_string(),
                ),
                _ => write(
                    &at("--target-dir")
                        .join("ai-memory-handoff")
                        .join("SKILL.md"),
                    "s",
                ),
            }
            Ok(Ran {
                ok: true,
                cancelled: false,
                output: String::new(),
            })
        })
    })
}

fn hub() -> Value {
    json!({ "type": "http", "url": "${OMP_GUI_MCP_HUB}/memory", "headers": { "Authorization": "${OMP_GUI_MCP_AUTH}" } })
}

async fn generate(root: &Path, run: &RunCommand<'static>) -> Result<bool, String> {
    root::generate_root(root, &hub(), run, |output| format!("<{output}>"))
        .await
        .map_err(|failure| failure.message())
}

fn next_of(root: &Path) -> PathBuf {
    PathBuf::from(format!("{}.next", root.to_string_lossy()))
}

#[tokio::test]
async fn generates_the_root_beside_it_and_swaps_it_in_only_when_it_changed() {
    let base = temp();
    let root = base.join("ai-memory").join("omp-ext");
    assert_eq!(
        generate(&root, &*generators(None, "1", true, json!({}))).await,
        Ok(true)
    );
    assert_eq!(listed(&root), [".mcp.json", "index.ts", "skills"]);
    assert!(root::root_complete(&root));
    assert!(!next_of(&root).exists());

    // An unchanged result leaves the files where they are.
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    fs::File::options()
        .write(true)
        .open(root.join("index.ts"))
        .unwrap()
        .set_modified(old)
        .unwrap();
    generate(&root, &*generators(None, "1", false, json!({})))
        .await
        .unwrap();
    assert_eq!(
        fs::metadata(root.join("index.ts"))
            .unwrap()
            .modified()
            .unwrap(),
        old
    );

    // A changed result replaces the root whole.
    generate(&root, &*generators(None, "2", false, json!({})))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("index.ts")).unwrap(),
        "// ext 2\n"
    );

    // A failing generator names itself and its output and leaves the earlier root alone.
    let failed = generate(
        &root,
        &*generators(Some("install-skills"), "3", false, json!({})),
    )
    .await;
    assert_eq!(failed, Err("install-skills failed: <boom>".to_owned()));
    assert_eq!(
        fs::read_to_string(root.join("index.ts")).unwrap(),
        "// ext 2\n"
    );
    assert!(!next_of(&root).exists());
    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn a_cancelled_generator_writes_nothing() {
    let base = temp();
    let root = base.join("omp-ext");
    let run = |_: Vec<String>| -> Boxed<'static, Result<Ran, Failure>> {
        Box::pin(async {
            Ok(Ran {
                ok: false,
                cancelled: true,
                output: String::new(),
            })
        })
    };
    assert_eq!(generate(&root, &run).await, Ok(false));
    assert!(!root.exists());
    assert!(!next_of(&root).exists());
    let _ = fs::remove_dir_all(&base);
}

#[tokio::test]
async fn serves_the_mcp_entry_from_the_hub_as_the_typescript_did() {
    let base = temp();
    for (index, row) in captured("mountHub").into_iter().enumerate() {
        let root = base.join(format!("r{index}")).join("omp-ext");
        let generated = text(&row["generated"]).to_owned();
        let run = move |args: Vec<String>| -> Boxed<'static, Result<Ran, Failure>> {
            let generated = generated.clone();
            Box::pin(async move {
                let at = |flag: &str| {
                    PathBuf::from(&args[args.iter().position(|arg| arg == flag).unwrap() + 1])
                };
                match args[0].as_str() {
                    "install-hooks" => write(&at("--config-file"), "// x\n"),
                    "install-mcp" => write(&at("--config-file"), &generated),
                    _ => write(&at("--target-dir").join("s").join("SKILL.md"), "s"),
                }
                Ok(Ran {
                    ok: true,
                    cancelled: false,
                    output: String::new(),
                })
            })
        };
        let made = root::generate_root(&root, &hub(), &run, str::to_owned).await;
        match row["error"].as_str() {
            Some(error) => assert_eq!(made.unwrap_err().message(), error, "{row}"),
            None => assert!(made.unwrap(), "{row}"),
        }
        let mcp = fs::read_to_string(root.join(".mcp.json")).ok();
        if respelled(text(&row["generated"])) {
            assert_ne!(mcp.as_deref(), row["mcp"].as_str(), "{row}");
            continue;
        }
        assert_eq!(mcp.as_deref(), row["mcp"].as_str(), "{row}");
    }
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn reads_the_terminal_wiring_by_its_signatures() {
    let root = temp();
    assert_eq!(terminal::read_wiring(&root), Wiring::default());
    write(&root.join("mcp.json"), "{broken");
    terminal::remove_wiring(&root).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("mcp.json")).unwrap(),
        "{broken"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn takes_back_only_the_shared_skills_setup_newly_created() {
    let home = temp();
    let skills = home.join(".agents").join("skills");
    let managed = |name: &str| {
        write(
            &skills.join(name).join("SKILL.md"),
            "<!-- ai-memory-managed: x -->\n",
        )
    };
    managed("ai-memory-old");
    let before = terminal::list_shared_skills(&home);
    managed("ai-memory-new");
    write(
        &skills.join("ai-memory-theirs").join("SKILL.md"),
        "no marker: a person's own skill\n",
    );
    terminal::remove_new_shared_skills(&home, &before);
    assert!(skills.join("ai-memory-old").exists());
    assert!(!skills.join("ai-memory-new").exists());
    assert!(skills.join("ai-memory-theirs").exists());

    // An .agents/skills that ai-memory created and nothing else uses goes away.
    let home = temp();
    let before = terminal::list_shared_skills(&home);
    write(
        &home
            .join(".agents")
            .join("skills")
            .join("ai-memory-new")
            .join("SKILL.md"),
        "<!-- ai-memory-managed: x -->\n",
    );
    terminal::remove_new_shared_skills(&home, &before);
    assert!(!home.join(".agents").exists());
}

#[test]
fn an_entry_counts_as_the_legacy_wiring_only_when_it_runs_an_owned_binary() {
    let wiring = Wiring {
        extension: true,
        mcp: true,
        command: Some("/t/ai-memory/3.1.1/ai-memory".to_owned()),
    };
    let owned = |paths: &[&str]| {
        paths
            .iter()
            .map(|path| (*path).to_owned())
            .collect::<Vec<_>>()
    };
    assert!(terminal::legacy_owned(&wiring, &owned(&["/t/ai-memory"])));
    assert!(!terminal::legacy_owned(&wiring, &owned(&["/elsewhere"])));
    let no_entry = Wiring {
        mcp: false,
        ..wiring.clone()
    };
    assert!(!terminal::legacy_owned(
        &no_entry,
        &owned(&["/t/ai-memory"])
    ));
    let no_command = Wiring {
        command: None,
        ..wiring
    };
    assert!(!terminal::legacy_owned(
        &no_command,
        &owned(&["/t/ai-memory"])
    ));
}

/// A stand-in for the system's commands: records each and answers what `answer` says.
fn recorder(
    answer: impl Fn(&str) -> (i32, String) + Send + Sync + 'static,
) -> (Arc<Mutex<Vec<String>>>, Exec) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&calls);
    let exec: Exec = Arc::new(move |file, args| {
        let call = std::iter::once(file)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        let (code, stdout) = answer(&call);
        seen.lock().unwrap().push(call);
        Box::pin(async move {
            Exit {
                code,
                stdout,
                stderr: String::new(),
            }
        })
    });
    (calls, exec)
}

fn unit_of(installed: bool, ours: bool) -> ServiceUnit {
    ServiceUnit { installed, ours }
}

#[tokio::test]
async fn reads_and_removes_the_launch_agent() {
    let home = temp();
    let staged = Path::new("/tools")
        .join("ai-memory")
        .to_string_lossy()
        .into_owned();
    let (calls, exec) = recorder(|_| (0, String::new()));
    let unit = Unit::launchd(&home, 501, exec);
    assert_eq!(
        unit.inspect(std::slice::from_ref(&staged)).await,
        unit_of(false, false)
    );
    let plist = home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    let in_staged = Path::new(&staged).join("3.1.1").join("ai-memory");
    write(
        &plist,
        &format!("<string>{}</string>", in_staged.to_string_lossy()),
    );
    assert_eq!(
        unit.inspect(std::slice::from_ref(&staged)).await,
        unit_of(true, true)
    );
    write(&plist, "<string>/opt/homebrew/bin/ai-memory</string>");
    assert_eq!(
        unit.inspect(std::slice::from_ref(&staged)).await,
        unit_of(true, false)
    );
    // The binary in use counts as owned too.
    write(&plist, "<string>/dev/build/ai-memory</string>");
    assert_eq!(
        unit.inspect(&[staged, "/dev/build/ai-memory".to_owned()])
            .await,
        unit_of(true, true)
    );
    unit.remove(None).await;
    assert_eq!(
        *calls.lock().unwrap(),
        [format!("launchctl bootout gui/501/{LAUNCHD_LABEL}")]
    );
    assert!(!plist.exists());
    let _ = fs::remove_dir_all(&home);
}

#[cfg(windows)]
fn query(command: &str) -> String {
    format!(
        "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ai-memory    REG_SZ    {command}\r\n\r\n"
    )
}

#[cfg(windows)]
#[tokio::test]
async fn reads_the_logon_entry() {
    let staged = r"C:\Users\me\AppData\Local\ompdesk\tools\ai-memory".to_owned();
    let bin = r"C:\Temp\bin\ai-memory.exe";
    let answer = query(&format!(
        r#""{bin}" --data-dir "C:\d" --config "C:\d\config.toml" service-host"#
    ));
    let (_, exec) = recorder(move |_| (0, answer.clone()));
    let unit = Unit::logon(exec);
    assert_eq!(
        unit.inspect(&[staged.clone(), bin.to_owned()]).await,
        unit_of(true, true)
    );
    assert_eq!(
        unit.inspect(std::slice::from_ref(&staged)).await,
        unit_of(true, false)
    );

    let answers = Mutex::new(vec![
        (1, String::new()),
        (
            0,
            query(&format!(r#""{staged}\3.1.1\ai-memory.exe" service-host"#)),
        ),
        (
            0,
            query(&format!(
                r#""{}/3.1.1/ai-memory.exe" service-host"#,
                staged.to_uppercase().replace('\\', "/")
            )),
        ),
        (
            0,
            query(r#""C:\Users\me\.local\bin\ai-memory.exe" service-host"#),
        ),
    ]);
    let (calls, exec) = recorder(move |_| answers.lock().unwrap().remove(0));
    let unit = Unit::logon(exec);
    for expected in [
        unit_of(false, false),
        unit_of(true, true),
        unit_of(true, true),
        unit_of(true, false),
    ] {
        assert_eq!(unit.inspect(std::slice::from_ref(&staged)).await, expected);
    }
    assert_eq!(
        calls.lock().unwrap()[0],
        r"reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v ai-memory"
    );
}

#[tokio::test]
async fn removes_the_logon_entry_then_ends_what_it_recorded_never_by_image_name() {
    let dir = temp();
    let shown = dir.to_string_lossy().into_owned();
    fs::write(
        dir.join("service-host.json"),
        r#"{"supervisor_pid":4001,"server_pid":4002}"#,
    )
    .unwrap();
    let (calls, exec) = recorder(|_| (0, String::new()));
    Unit::logon(exec).remove(Some(&shown)).await;
    assert_eq!(
        *calls.lock().unwrap(),
        [
            r"reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v ai-memory /f",
            "taskkill /PID 4001 /T /F",
            "taskkill /PID 4002 /T /F",
        ]
    );
    // Without a readable service-host.json only the entry goes.
    let (calls, exec) = recorder(|_| (0, String::new()));
    let unit = Unit::logon(exec);
    unit.remove(Some(&dir.join("none").to_string_lossy())).await;
    fs::write(dir.join("service-host.json"), "{broken").unwrap();
    unit.remove(Some(&shown)).await;
    assert_eq!(calls.lock().unwrap().len(), 2);
    assert!(
        calls
            .lock()
            .unwrap()
            .iter()
            .all(|call| !call.starts_with("taskkill"))
    );
    let _ = fs::remove_dir_all(&dir);
}

async fn settled(file: &Path, expected: &str) {
    for _ in 0..200 {
        if fs::read_to_string(file).ok().as_deref() == Some(expected) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{} never held {expected}", file.display());
}

#[tokio::test]
async fn writes_the_recall_address_owner_only_and_keeps_an_earlier_one_until_the_data_folder_is_known()
 {
    let dir = temp();
    let file = dir.join("ai-memory").join("recall.json");
    let env = json!({ "url": "http://127.0.0.1:49374", "dataDir": "/data" });
    RecallFile::open(file.clone()).update(&env);
    settled(&file, &env.to_string()).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // A relaunch that has not found the data folder yet leaves what the last launch wrote.
    let relaunched = RecallFile::open(file.clone());
    relaunched.update(&Value::Null);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(fs::read_to_string(&file).unwrap(), env.to_string());
    // Quick updates end on the last.
    for port in [49999, 50000] {
        relaunched
            .update(&json!({ "url": format!("http://127.0.0.1:{port}"), "dataDir": "/data" }));
    }
    settled(
        &file,
        &json!({ "url": "http://127.0.0.1:50000", "dataDir": "/data" }).to_string(),
    )
    .await;
    let _ = fs::remove_dir_all(&dir);
}
