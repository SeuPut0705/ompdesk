use std::sync::Arc;

use serde_json::{Value, json};
use super::*;
use super::super::test_support::{repo, runner, sh};
use crate::sidecar::application::EffectFuture;

pub(in crate::worktree_lifecycle::manual) struct Bridge { root: String }
impl Sidecar for Bridge {
    type Error = Fault;
    fn facts(&self) -> Value { json!({}) }
    fn generation(&self) -> u64 { 7 }
    fn bridge_connected(&self) -> bool { true }
    fn before_response(&self) {}
    fn start(&self) {}
    fn restart(&self, _: Option<&str>) {}
    fn sleep(&self) {}
    fn adopt_cwd(&self, _: &str) -> bool { false }
    fn send_now(&self, _: Value) -> Result<(), Fault> { Ok(()) }
    fn send(&self, _: Value) -> EffectFuture<'_, Result<(), Fault>> { Box::pin(async { Ok(()) }) }
    fn stock(&self, _: Value) -> EffectFuture<'static, Result<Value, Fault>> { Box::pin(async { Err(Fault::new("unused", "unused")) }) }
    fn send_for_generation(&self, _: u64, _: Value) -> EffectFuture<'static, Result<(), Fault>> { Box::pin(async { Ok(()) }) }
    fn stock_for_generation(&self, _: u64, _: Value) -> EffectFuture<'static, Result<Value, Fault>> { Box::pin(async { Err(Fault::new("unused", "unused")) }) }
    fn bridge_for_generation(&self, generation: u64, method: String, _: Option<Value>, _: Option<u64>) -> EffectFuture<'static, Result<Value, Fault>> {
        assert_eq!(generation, 7);
        assert_eq!(method, "git.worktree_location");
        let root = self.root.clone();
        Box::pin(async move { Ok(json!({"root":root,"hash":"123abcd"})) })
    }
    fn bridge(&self, method: String, params: Option<Value>, timeout: Option<u64>) -> EffectFuture<'static, Result<Value, Fault>> { self.bridge_for_generation(7, method, params, timeout) }
    fn exit_waiter(&self) -> EffectFuture<'static, Result<(), Fault>> { Box::pin(async { Ok(()) }) }
    fn remove_listeners(&self) {}
    fn dispose(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> { Box::pin(async {}) }
}

pub(in crate::worktree_lifecycle::manual) fn session(root: &std::path::Path, cwd: &std::path::Path) -> Session<Bridge> {
    Session::from_captured(Arc::new(Bridge { root: root.to_string_lossy().into_owned() }), Arc::from("test"), 7)
        .with_captured_cwd(cwd.to_string_lossy().into_owned())
}

fn config() -> super::super::prepare::Config {
    super::super::prepare::Config { env: std::env::vars().collect(), supervisor: "missing-supervisor".into() }
}

#[tokio::test]
async fn create_skips_folder_and_branch_collisions_and_remove_keeps_branch() {
    let repo = repo("manual-collision");
    let root = repo.join("trees");
    std::fs::create_dir_all(root.join("gui-feature-123abcd")).unwrap();
    sh(&repo, &["branch", "omp/gui/feature-2"]);
    let session = session(&root, &repo);
    let result = create(&session, runner(), &config(), Scope::detached(), json!({"name":"Feature"}).as_object().unwrap()).await.unwrap();
    assert_eq!(result["branch"], "omp/gui/feature-3");
    let path = result["path"].as_str().unwrap();
    assert!(std::path::Path::new(path).join("README.md").exists());
    assert_eq!(remove(&session, runner(), Scope::detached(), json!({"path":path}).as_object().unwrap()).await.unwrap(), json!({"removed":true}));
    assert_eq!(sh(&repo, &["branch", "--list", "omp/gui/feature-3"]), "omp/gui/feature-3");
    std::fs::remove_dir_all(repo).unwrap();
}

#[tokio::test]
async fn invalid_base_and_outside_root_are_refused() {
    let repo = repo("manual-guards");
    let root = repo.join("trees");
    std::fs::create_dir_all(&root).unwrap();
    let session = session(&root, &repo);
    let err = create(&session, runner(), &config(), Scope::detached(), json!({"name":"work","baseRef":"-bad"}).as_object().unwrap()).await.unwrap_err();
    assert!(matches!(err, CommandError::Local { code, .. } if code == "invalid_base"));
    let err = remove(&session, runner(), Scope::detached(), json!({"path":repo}).as_object().unwrap()).await.unwrap_err();
    assert!(matches!(err, CommandError::Local { code, .. } if code == "worktree_outside_root"));
    std::fs::remove_dir_all(repo).unwrap();
}

#[tokio::test]
async fn malformed_named_branch_falls_back_to_generated_prefix() {
    let repo = repo("manual-branch");
    let root = repo.join("trees");
    let session = session(&root, &repo);
    let result = create(&session, runner(), &config(), Scope::detached(), json!({"name":"task", "branchPrefix":"team/", "branch":{"name":"topic","mode":"remote"}}).as_object().unwrap()).await.unwrap();
    assert_eq!(result["branch"], "team/task");
    remove(&session, runner(), Scope::detached(), json!({"path":result["path"]}).as_object().unwrap()).await.unwrap();
    std::fs::remove_dir_all(repo).unwrap();
}
