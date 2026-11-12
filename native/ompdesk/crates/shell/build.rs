// Windows only: embed the application manifest (supportedOS + PerMonitorV2 + long paths + common controls 6; without
// it CEF's GPU process crash-loops, exit 0x80000003) and the app icon. The resource script is written here with
// absolute paths: the crate is built from a `subst` drive (CEF's wrapper paths pass MAX_PATH from a deep worktree), so
// a path relative to the crate would not find `resources/icon.ico`. `scripts/build-shell.ts` passes OMPDESK_ICON.
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-env-changed=OMPDESK_ICON");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
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
