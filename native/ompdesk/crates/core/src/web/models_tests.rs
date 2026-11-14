use super::*;
use serde_json::json;

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ompdesk-model-editor-{}",
            super::super::router::uuid()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Schema {
    add_default: bool,
}
impl Validator for Schema {
    fn normalize(&self, mut config: Value) -> BoxFuture<'_, Result<Value, Fault>> {
        Box::pin(async move {
            if config
                .pointer("/providers/custom/models/0/id")
                .is_some_and(|id| !id.is_string())
            {
                return Err(invalid(
                    "models.yml does not satisfy stock omp ModelsConfigSchema",
                ));
            }
            if self.add_default {
                config["providers"]["custom"]["models"][0]["maxTokens"] = json!(4096);
            }
            Ok(config)
        })
    }
}
fn service(dir: &Path, add_default: bool) -> Service {
    Service::with_validator(dir.into(), Arc::new(Schema { add_default }))
}

#[tokio::test]
async fn missing_editor_and_raw_credentials_comments_roundtrip_without_masking() {
    let dir = Scratch::new();
    let service = service(&dir.0, false);
    let first = service.read_text().await.unwrap();
    assert!(!first.exists);
    assert_eq!(first.stamp, "missing");
    assert_eq!(first.text, SKELETON);
    let text = "# personal provider comment\nproviders:\n  custom:\n    apiKey: sample-fixture-only # retain credential comment\n    models: []\n# trailing comment\n";
    let stamp = service.write_text(text, &first.stamp).await.unwrap();
    let read = service.read_text().await.unwrap();
    assert!(read.exists);
    assert_eq!(read.text, text);
    assert_eq!(read.stamp, stamp);
    assert_ne!(stamp, "missing");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&read.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn normalized_nodes_keep_provider_model_and_credential_comments() {
    let dir = Scratch::new();
    let service = service(&dir.0, true);
    let text = "# document header\nproviders: # provider map\n  custom: # custom provider\n    apiKey: fixture-key # credential note\n    models:\n      - id: fixture-model # model note\n        maxTokens: 1 # limit note\n# document trailer\n";
    service.write_text(text, "missing").await.unwrap();
    let read = service.read_text().await.unwrap();
    for comment in [
        "document header",
        "provider map",
        "custom provider",
        "credential note",
        "model note",
        "limit note",
        "document trailer",
    ] {
        assert!(read.text.contains(comment), "lost {comment}: {}", read.text);
    }
    let config: Value = serde_saphyr::from_str(&read.text).unwrap();
    assert_eq!(config["providers"]["custom"]["apiKey"], "fixture-key");
    assert_eq!(
        config["providers"]["custom"]["models"][0]["maxTokens"],
        4096
    );
}

#[tokio::test]
async fn invalid_and_stale_writes_leave_the_existing_file_whole() {
    let dir = Scratch::new();
    let service = service(&dir.0, false);
    let path = dir.0.join("models.yaml");
    let initial = "providers: {}\n# kept\n";
    fs::write(&path, initial).unwrap();
    let opened = service.read_text().await.unwrap();
    assert_eq!(Path::new(&opened.path), path);
    assert!(
        service
            .write_text("providers: [", &opened.stamp)
            .await
            .is_err()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), initial);
    assert!(
        service
            .write_text("providers: {custom: {models: [{id: 42}]}}", &opened.stamp)
            .await
            .is_err()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), initial);
    fs::write(
        &path,
        "providers: {}\n# external edit with a different size\n",
    )
    .unwrap();
    let external = fs::read_to_string(&path).unwrap();
    assert!(
        service
            .write_text(initial, &opened.stamp)
            .await
            .unwrap_err()
            .message
            .contains("since it was opened")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), external);
    assert!(!dir.0.join("models.yml").exists());
}

struct EditDuringValidation {
    file: PathBuf,
}
impl Validator for EditDuringValidation {
    fn normalize(&self, config: Value) -> BoxFuture<'_, Result<Value, Fault>> {
        Box::pin(async move {
            fs::write(&self.file, "providers: {}\n# changed while validating\n").unwrap();
            Ok(config)
        })
    }
}
#[tokio::test]
async fn a_file_changed_during_stock_validation_is_never_overwritten() {
    let dir = Scratch::new();
    let file = dir.0.join("models.yml");
    fs::write(&file, "providers: {}\n").unwrap();
    let service = Service::with_validator(
        dir.0.clone(),
        Arc::new(EditDuringValidation { file: file.clone() }),
    );
    let opened = service.read_text().await.unwrap();
    assert!(
        service
            .write_text("providers: {}\n# edited\n", &opened.stamp)
            .await
            .unwrap_err()
            .message
            .contains("while it was being saved")
    );
    assert_eq!(
        fs::read_to_string(file).unwrap(),
        "providers: {}\n# changed while validating\n"
    );
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
}

#[tokio::test]
async fn two_saves_from_one_open_stamp_cannot_overwrite_each_other() {
    let dir = Scratch::new();
    let service = service(&dir.0, false);
    let (a, b) = tokio::join!(
        service.write_text("providers: {}\n# a\n", "missing"),
        service.write_text("providers: {}\n# b\n", "missing")
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let read = service.read_text().await.unwrap();
    assert!(read.text.ends_with("# a\n") || read.text.ends_with("# b\n"));
}

#[cfg(unix)]
#[tokio::test]
async fn linked_models_preserve_target_mode_and_a_dangling_link_is_not_replaced() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = Scratch::new();
    let target = dir.0.join("dotfiles.yml");
    fs::write(&target, "providers: {}\n").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    let file = dir.0.join("models.yml");
    symlink("dotfiles.yml", &file).unwrap();
    let service = service(&dir.0, false);
    let opened = service.read_text().await.unwrap();
    service
        .write_text("providers: {}\n# saved through link\n", &opened.stamp)
        .await
        .unwrap();
    assert!(
        fs::symlink_metadata(&file)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert!(
        fs::read_to_string(&target)
            .unwrap()
            .contains("saved through link")
    );
    fs::remove_file(&target).unwrap();
    let missing = service.read_text().await.unwrap();
    assert!(!missing.exists);
    assert!(
        service
            .write_text("providers: {}\n", &missing.stamp)
            .await
            .unwrap_err()
            .message
            .contains("does not exist")
    );
    assert!(fs::symlink_metadata(file).unwrap().file_type().is_symlink());
    assert!(!target.exists());
}
