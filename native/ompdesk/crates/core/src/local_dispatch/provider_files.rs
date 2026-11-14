use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;

use super::protocol::CommandError;
use super::provider_yaml::ModelsDocument;
use crate::disk::tree;
use crate::server::Scope;

type R<T> = Result<T, CommandError>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    modified: SystemTime,
    size: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    created: SystemTime,
}

pub struct Snapshot {
    file: PathBuf,
    stamp: Option<Stamp>,
    text: String,
    pub raw: Value,
}

impl Snapshot {
    pub fn exists(&self) -> bool { self.stamp.is_some() }
}

/// One instance per actual machine's agent directory. The service's mutation lock covers reads, stock schema
/// awaits and this final write, so concurrent edits from windows and paired devices cannot overwrite each other.
#[derive(Clone)]
pub struct ProviderFiles {
    agent_dir: PathBuf,
}

impl ProviderFiles {
    pub fn new(agent_dir: PathBuf) -> Self { Self { agent_dir } }

    pub fn path(&self) -> PathBuf {
        let preferred = self.agent_dir.join("models.yml");
        if preferred.exists() { return preferred; }
        let legacy = self.agent_dir.join("models.yaml");
        if legacy.exists() { legacy } else { preferred }
    }

    pub fn read(&self) -> R<Snapshot> {
        let file = self.path();
        let stamp = stamp(&file)?;
        let text = if stamp.is_some() { fs::read_to_string(&file).map_err(|error| io_error(&file, error))? } else { String::new() };
        let document = ModelsDocument::parse(&text)?;
        Ok(Snapshot { file, stamp, text, raw: document.raw })
    }

    /// `normalized` is the installed stock ModelsConfigSchema's result, never a locally reimplemented schema.
    pub fn save(&self, snapshot: Snapshot, normalized: &Value, scope: &Scope) -> R<()> {
        if scope.cancelled() { return Err(CommandError::from(crate::server::Fault::cancelled())); }
        let document = ModelsDocument::parse(&snapshot.text)?;
        let rendered = document.render(normalized)?;
        let file = self.path();
        if file != snapshot.file || stamp(&file)? != snapshot.stamp {
            return Err(changed(&file));
        }
        if snapshot.stamp.is_none() {
            if let Ok(metadata) = fs::symlink_metadata(&file) {
                if metadata.file_type().is_symlink() {
                    let link = fs::read_link(&file).map_err(|error| io_error(&file, error))?;
                    let target = if link.is_absolute() { link } else { file.parent().unwrap_or(Path::new("")).join(link) };
                    return Err(CommandError::Other(format!("{} links to {}, which does not exist. Nothing was written; fix or remove the link.", file.display(), target.display())));
                }
            }
        }
        let (target, mode) = match snapshot.stamp.as_ref() {
            Some(_) => {
                let target = fs::canonicalize(&file).map_err(|error| io_error(&file, error))?;
                let metadata = fs::metadata(&target).map_err(|error| io_error(&target, error))?;
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.permissions().mode() & 0o7777
                };
                #[cfg(not(unix))]
                let mode = { let _ = metadata; 0o600 };
                (target, mode)
            }
            None => (file.clone(), 0o600),
        };
        let written = tree::write_atomic_if(&target, rendered.as_bytes(), Some(mode), 0o777, &|| {
            !scope.cancelled() && self.path() == file && stamp(&file).ok() == Some(snapshot.stamp.clone())
        }).map_err(CommandError::from)?;
        if written { Ok(()) }
        else if scope.cancelled() { Err(crate::server::Fault::cancelled().into()) }
        else { Err(changed(&file)) }
    }
}

fn changed(file: &Path) -> CommandError {
    CommandError::Other(format!("{} changed on disk while it was being saved. Nothing was written; try again.", file.display()))
}

fn io_error(file: &Path, error: std::io::Error) -> CommandError {
    CommandError::Other(format!("{}: {error}", file.display()))
}

fn stamp(file: &Path) -> R<Option<Stamp>> {
    let metadata = match fs::metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(file, error)),
    };
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(Some(Stamp {
        modified: metadata.modified().map_err(|error| io_error(file, error))?,
        size: metadata.len(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(windows)]
        created: metadata.created().map_err(|error| io_error(file, error))?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ompdesk-provider-files-{}-{name}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn an_external_edit_during_stock_validation_is_never_overwritten() {
        let dir = fixture("changed");
        let files = ProviderFiles::new(dir.clone());
        fs::write(files.path(), "providers: {}\n").unwrap();
        let snapshot = files.read().unwrap();
        fs::write(files.path(), "providers: {}\n# external edit\n").unwrap();
        assert!(files.save(snapshot, &json!({"providers":{"custom":{"api":"openai-completions","models":[]}}}), &Scope::detached()).is_err());
        assert_eq!(fs::read_to_string(files.path()).unwrap(), "providers: {}\n# external edit\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn saves_follow_symlinks_preserve_mode_and_never_replace_a_dangling_link() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = fixture("symlink");
        let target = dir.join("target.yml");
        fs::write(&target, "# own config\nproviders: {}\n").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&target, dir.join("models.yml")).unwrap();
        let files = ProviderFiles::new(dir.clone());
        let snapshot = files.read().unwrap();
        files.save(snapshot, &json!({"providers":{"custom":{"api":"openai-completions","models":[]}}}), &Scope::detached()).unwrap();
        assert!(fs::symlink_metadata(files.path()).unwrap().file_type().is_symlink());
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(files.read().unwrap().raw["providers"]["custom"]["api"], "openai-completions");
        fs::remove_file(&target).unwrap();
        let snapshot = files.read().unwrap();
        assert!(files.save(snapshot, &json!({"providers":{}}), &Scope::detached()).is_err());
        assert!(fs::symlink_metadata(files.path()).unwrap().file_type().is_symlink());
        fs::remove_dir_all(dir).unwrap();
    }
}
