use std::path::{Path, PathBuf};

use super::plans::join;
use super::types::Platform;

const TAG: &str = ".ompdesk-compiled-";

pub struct SetAside {
    pub launcher: PathBuf,
    pub aside: PathBuf,
}

pub fn set_aside(
    bun_install: &str,
    platform: Platform,
    now: f64,
    is_compiled: impl FnOnce(&Path) -> bool,
) -> Option<SetAside> {
    let launcher = PathBuf::from(join(
        platform,
        bun_install,
        &[
            "bin",
            if platform == Platform::Win32 {
                "omp.exe"
            } else {
                "omp"
            },
        ],
    ));
    if let (Some(parent), Some(name)) = (launcher.parent(), launcher.file_name()) {
        let prefix = format!("{}{TAG}", name.to_string_lossy());
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    if !is_compiled(&launcher) {
        return None;
    }
    let aside = PathBuf::from(format!("{}{TAG}{now}", launcher.display()));
    std::fs::rename(&launcher, &aside).ok()?;
    Some(SetAside { launcher, aside })
}

pub fn settle(moved: &SetAside) {
    if moved.launcher.exists() {
        let _ = std::fs::remove_file(&moved.aside);
    } else {
        let _ = std::fs::rename(&moved.aside, &moved.launcher);
    }
}
