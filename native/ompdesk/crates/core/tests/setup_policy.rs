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
    let root = PathBuf::from(
        std::env::var_os("OMP_SETUP_SCRATCH").expect("isolated fixture root must be supplied"),
    )
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
