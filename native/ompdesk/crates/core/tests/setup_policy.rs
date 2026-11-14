use std::path::PathBuf;

use ompdesk_core::setup::service::{trim_tail, update_detail};
use ompdesk_core::setup::types::*;
use ompdesk_core::setup::{compiled, plans};

fn context(platform: Platform) -> PlanContext {
    PlanContext {
        platform,
        arch: "x64".to_owned(),
        bun_install: "C:\\Users\\First Last\\.bun".to_owned(),
        tools_dir: "C:\\Users\\First Last\\tools".to_owned(),
        bun: Some("C:\\Users\\First Last\\.bun\\bin\\bun.exe".to_owned()),
        omp: Some("C:\\Users\\First Last\\npm\\omp.cmd".to_owned()),
        brew: None,
        winget: None,
        system_root: "C:\\Windows".to_owned(),
    }
}

#[test]
fn windows_first_install_requires_git_and_an_absolute_bun_package_install() {
    let ctx = context(Platform::Win32);
    assert!(Item::Git.required(ctx.platform));
    assert_eq!(
        plans::select_method(Item::Git, &Presence::Missing, &ctx),
        Some(Method::PortableGit)
    );
    let git = plans::build_plan(Item::Git, Method::PortableGit, &ctx, None, None).unwrap();
    assert_eq!(git.location, "C:\\Users\\First Last\\tools\\git");
    assert_eq!(
        git.spawn.file,
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    assert_eq!(git.prompt, None);
    let omp = plans::build_plan(Item::Omp, Method::BunGlobal, &ctx, None, None).unwrap();
    assert_eq!(omp.spawn.file, ctx.bun.unwrap());
    assert_eq!(
        omp.spawn.args,
        ["install", "-g", "@oh-my-pi/pi-coding-agent"]
    );
    assert!(!omp.spawn.shell);
}

#[test]
fn windows_omp_command_shim_keeps_space_quoting() {
    let ctx = context(Platform::Win32);
    let plan = plans::build_plan(Item::Omp, Method::OmpUpdate, &ctx, None, None).unwrap();
    assert!(plan.spawn.shell);
    assert_eq!(plan.spawn.file, "\"C:\\Users\\First Last\\npm\\omp.cmd\"");
    assert_eq!(plan.spawn.args, ["\"update\""]);
}

#[test]
fn automatic_and_manual_policy_do_not_ask_for_bun_or_omp_repair_commands() {
    for platform in [Platform::Darwin, Platform::Win32, Platform::Other] {
        for item in [Item::Bun, Item::Omp] {
            assert_eq!(plans::manual_steps(item, platform), (vec![], String::new()));
        }
        assert!(!Item::Tailscale.automatic());
        assert!(Item::Bun.required(platform));
        assert!(Item::Omp.required(platform));
    }
    let mut ctx = context(Platform::Win32);
    ctx.bun = None;
    assert!(plans::build_plan(Item::Omp, Method::BunGlobal, &ctx, None, None).is_none());
    assert!(plans::select_method(Item::Gh, &Presence::Missing, &ctx).is_none());
}

#[test]
fn compiled_launcher_is_restored_after_failed_install_and_removed_after_success() {
    let root = std::env::var_os("OMP_SETUP_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("compiled-{}", std::process::id()));
    std::fs::create_dir_all(root.join("bin")).unwrap();
    let launcher = root.join("bin/omp");
    std::fs::write(&launcher, b"compiled-omp").unwrap();
    let moved =
        compiled::set_aside(&root.to_string_lossy(), Platform::Darwin, 1.0, |_| true).unwrap();
    assert!(!launcher.exists());
    assert_eq!(std::fs::read(&moved.aside).unwrap(), b"compiled-omp");
    compiled::settle(&moved);
    assert_eq!(std::fs::read(&launcher).unwrap(), b"compiled-omp");
    let moved =
        compiled::set_aside(&root.to_string_lossy(), Platform::Darwin, 2.0, |_| true).unwrap();
    std::fs::write(&launcher, b"#!/usr/bin/env bun\n").unwrap();
    compiled::settle(&moved);
    assert_eq!(std::fs::read(&launcher).unwrap(), b"#!/usr/bin/env bun\n");
    assert!(!moved.aside.exists());
    assert!(
        compiled::set_aside(&root.to_string_lossy(), Platform::Darwin, 3.0, |_| false).is_none()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failure_detail_and_output_tail_keep_consumer_text_without_color_codes() {
    assert_eq!(
        update_detail("\u{1b}[31merror\u{1b}[0m\r\n\n second \rthird"),
        Some("error\nsecond\nthird".to_owned())
    );
    let mut text = "old한글😀new".to_owned();
    trim_tail(&mut text, 5);
    assert_eq!(text, "😀new");
    trim_tail(&mut text, 0);
    assert!(text.is_empty());
}

#[test]
fn aslr_records_keep_first_prior_and_reject_unrelated_images() {
    use ompdesk_core::setup::git_aslr::{Image, Prior, Record, own_image, parse_fix, parse_undo};
    let root = r"C:\Tools\Git";
    let mut record = Record::parse("");
    record.fixed(
        root,
        vec![Image {
            path: r"C:\Tools\Git\usr\bin\sh.exe".to_owned(),
            prior: Prior::On,
        }],
    );
    record.fixed(
        r"c:/tools/git/",
        vec![Image {
            path: r"c:\tools\git\usr\bin\sh.exe".to_owned(),
            prior: Prior::Notset,
        }],
    );
    assert_eq!(record.images(root).len(), 1);
    assert_eq!(record.images(root)[0].prior, Prior::On);
    assert!(own_image(root, r"C:\Tools\Git\usr\bin\sh.exe"));
    assert!(!own_image(root, r"C:\Tools\Git\usr\..\..\Other\app.exe"));
    assert!(!own_image(root, r"C:\Other\sh.exe"));
    assert!(parse_fix(r#"[{"path":"sh.exe","prior":2}]"#).is_empty());
    assert_eq!(
        parse_fix("\u{feff}{\"path\":\"sh.exe\",\"prior\":3}")[0].prior,
        Prior::OnRequireRelocs
    );
    assert!(parse_undo(r#"["sh.exe",5]"#).is_empty());
    record.restored(root, &[r"c:\tools\git\usr\bin\sh.exe".to_owned()]);
    assert!(record.images(root).is_empty());
}

#[test]
fn aslr_read_only_detection_matches_full_path_and_only_relocation_nibble() {
    use ompdesk_core::setup::git_aslr::git_aslr_overridden;
    let query = "FilterFullPath REG_SZ C:\\Tools\\Git\\usr\\bin\\sh.exe\r\nMitigationOptions REG_BINARY 00a2ffff\r\n\r\n";
    assert!(git_aslr_overridden(query, r"C:\Tools\Git"));
    assert!(!git_aslr_overridden(query, r"C:\Other\Git"));
    assert!(!git_aslr_overridden(
        &query.replace("00a2", "00a1"),
        r"C:\Tools\Git"
    ));
}

#[test]
fn windows_bat_shim_and_embedded_quotes_match_stock_spawn_contract() {
    let spec = plans::command(r"C:\First Last\tool.BAT", &["a\"b"], Platform::Win32);
    assert!(spec.shell);
    assert_eq!(spec.file, r#""C:\First Last\tool.BAT""#);
    assert_eq!(spec.args, [r#""a""b""#]);
}

#[cfg(unix)]
#[tokio::test]
async fn desktop_detection_uses_bundle_unless_managed_copy_is_new_enough() {
    use std::collections::BTreeMap;
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::var_os("OMP_SETUP_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("desktop-selection-{}", std::process::id()));
    let tools = root.join("tools");
    let bundle = root.join("bundle");
    std::fs::create_dir_all(tools.join("agent-desktop")).unwrap();
    std::fs::create_dir_all(&bundle).unwrap();
    let managed = tools.join("agent-desktop/agent-desktop");
    let bundled = bundle.join("agent-desktop");
    std::fs::write(&bundled, "fixture, not executed").unwrap();
    std::fs::write(
        bundle.join("agent-desktop.build.json"),
        r#"{"version":"1.3.0"}"#,
    )
    .unwrap();
    for (version, expected) in [
        ("1.1.0", &bundled),
        ("1.2.0", &bundled),
        ("1.4.0", &managed),
    ] {
        std::fs::write(
            &managed,
            format!("#!/bin/sh\nprintf 'agent-desktop {version}\\n'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o755)).unwrap();
        let presence = ompdesk_core::setup::detect_agent_desktop(
            Platform::Darwin,
            &tools,
            Some(&bundle),
            &BTreeMap::new(),
        )
        .await;
        match presence {
            Presence::Present {
                path: Some(path), ..
            } => assert_eq!(PathBuf::from(path), *expected),
            other => panic!("{other:?}"),
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}
