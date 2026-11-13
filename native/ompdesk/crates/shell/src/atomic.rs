//! A file the shell replaces in one step (`src/main/atomic-file.ts` `writeFileAtomicSync`'s rule): written beside
//! the target, then renamed over it. On Windows the rename fails (`ERROR_ACCESS_DENIED`, a sharing violation) while
//! any process (a virus scan, a backup, an indexer) has the target open, so it is retried on a short backoff (under
//! 0.6 s in all) before the write gives up.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

const RETRY_MS: [u64; 6] = [10, 30, 60, 100, 150, 220];

pub fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let mut last = std::fs::rename(&temp, path);
        for ms in RETRY_MS {
            if last.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(ms));
            last = std::fs::rename(&temp, path);
        }
        last
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn replaces_the_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("shell-atomic-{}", std::process::id()));
        let path = dir.join("nested").join("state.json");
        super::write(&path, b"one").unwrap();
        super::write(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
