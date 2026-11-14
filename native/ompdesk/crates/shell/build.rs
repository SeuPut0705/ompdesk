// Windows only: embed the application manifest (supportedOS + PerMonitorV2 + long paths + common controls 6; without
// it CEF's GPU process crash-loops, exit 0x80000003) and the app icon. The resource script is written here with
// absolute paths: the crate is built from a `subst` drive (CEF's wrapper paths pass MAX_PATH from a deep worktree), so
// a path relative to the crate would not find `resources/icon.ico`. `scripts/build-shell.ts` passes OMPDESK_ICON and
// OMPDESK_BRAND (`resources/brand`, the tray PNGs the chrome module embeds, as `OMPDESK_BRAND_DIR`).
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-env-changed=OMPDESK_ICON");
    println!("cargo:rerun-if-env-changed=OMPDESK_BRAND");
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let brand = match std::env::var("OMPDESK_BRAND") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => manifest_dir.join("../../../../resources/brand"),
    };
    for name in [
        "tray.png",
        "tray@2x.png",
        "trayTemplate.png",
        "trayTemplate@2x.png",
    ] {
        println!("cargo:rerun-if-changed={}", brand.join(name).display());
    }
    // Forward slashes: `concat!` joins a file name with `/`, which every platform's `include_bytes!` reads.
    println!(
        "cargo:rustc-env=OMPDESK_BRAND_DIR={}",
        brand.display().to_string().replace('\\', "/")
    );
    println!("cargo:rerun-if-changed=last-electron.json");
    // The macOS launcher restores this Electron release if the new shell never starts.
    // Set last-electron.json to the newest Electron release before landing the shell swap.
    let tag = std::fs::read_to_string("last-electron.json")
        .ok()
        .and_then(|text| {
            let after = text.split_once("\"tag\"")?.1;
            let value = after.split_once('"')?.1;
            Some(value.split_once('"')?.0.trim().to_string())
        })
        .unwrap_or_default();
    if tag.is_empty() && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        panic!(
            "last-electron.json has no \"tag\": the macOS launcher needs the last Electron release to restore"
        );
    }
    println!("cargo:rustc-env=OMPDESK_LAST_ELECTRON_TAG={tag}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let icon = match std::env::var("OMPDESK_ICON") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => manifest_dir.join("../../../../resources/icon.ico"),
    };
    let manifest = manifest_dir.join("app.manifest");
    let escape = |p: &PathBuf| p.display().to_string().replace('\\', "\\\\");
    let rc = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("shell.rc");
    std::fs::write(
        &rc,
        format!(
            "1 24 \"{}\"\n1 ICON \"{}\"\n",
            escape(&manifest),
            escape(&icon)
        ),
    )
    .expect("write shell.rc");
    embed_resource::compile(&rc, embed_resource::NONE)
        .manifest_required()
        .expect("embedding shell.rc (rc.exe from the Windows SDK)");
}
