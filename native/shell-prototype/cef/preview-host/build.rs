fn main() {
    // Windows only: embed app.manifest (supportedOS + PerMonitorV2); without it CEF's GPU process crash-loops.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let m = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../app.manifest");
    println!("cargo:rerun-if-changed={}", m.display());
    println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}", m.display());
}
