use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

struct Fixture {
    root: PathBuf,
    dirs: Dirs,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("ompdesk-authoring-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        let dirs = Dirs { user: root.join("user"), project: root.join("project") };
        Self { root, dirs }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { fs::remove_dir_all(&self.root).unwrap(); }
}

fn command(value: Value) -> RpcCommand { serde_json::from_value(value).unwrap() }

fn text(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: agent\n---\n{body}\n")
}

async fn validate(content: String, _source: String) -> Result<Value, CommandError> {
    let name = content.lines().find_map(|line| line.strip_prefix("name: "));
    if !content.starts_with("---\n") || name.is_none() || !content.contains("description: ") {
        return Err(CommandError::Other("stock validation failure".into()));
    }
    Ok(json!({"fields":{"name":name},"body":content.split("---\n").nth(2).unwrap_or("")}))
}

fn code(error: CommandError) -> String {
    match error { CommandError::Local { code, .. } => code, CommandError::Other(message) => panic!("ordinary error: {message}") }
}

async fn call(fixture: &Fixture, value: Value) -> Result<Value, CommandError> {
    execute(&command(value), &fixture.dirs, &[], validate).await
}

#[tokio::test]
async fn create_read_edit_move_and_delete() {
    let fixture = Fixture::new();
    let created = call(&fixture, json!({"type":"write_agent_file","scope":"user","name":" helper ","content":text("helper","first")})).await.unwrap();
    let old = created["filePath"].as_str().unwrap();
    assert_eq!(Path::new(old), fixture.dirs.user.join("helper.md"));
    let read = call(&fixture, json!({"type":"read_agent_file","filePath":old})).await.unwrap();
    assert_eq!(read["scope"], "user");
    assert_eq!(read["content"], text("helper", "first"));
    assert_eq!(read["parsed"]["fields"]["name"], "helper");
    call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"helper","content":text("helper","edited"),"replacePath":old})).await.unwrap();
    assert_eq!(fs::read_to_string(old).unwrap(), text("helper", "edited"));
    let moved = call(&fixture, json!({"type":"write_agent_file","scope":"project","name":"other","content":text("other","moved"),"replacePath":old})).await.unwrap();
    assert!(!Path::new(old).exists());
    let new = moved["filePath"].as_str().unwrap();
    assert_eq!(fs::read_to_string(new).unwrap(), text("other", "moved"));
    assert_eq!(call(&fixture, json!({"type":"delete_agent_file","filePath":new})).await.unwrap()["deleted"], new);
    assert!(!Path::new(new).exists());
}

#[tokio::test]
async fn existing_files_and_failed_renames_are_preserved() {
    let fixture = Fixture::new();
    let one = call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"one","content":text("one","original")})).await.unwrap();
    let two = call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"two","content":text("two","existing")})).await.unwrap();
    let error = call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"two","content":text("two","new"),"replacePath":one["filePath"]})).await.unwrap_err();
    assert_eq!(code(error), "exists");
    assert_eq!(fs::read_to_string(one["filePath"].as_str().unwrap()).unwrap(), text("one","original"));
    assert_eq!(fs::read_to_string(two["filePath"].as_str().unwrap()).unwrap(), text("two","existing"));
    assert_eq!(fs::read_dir(&fixture.dirs.user).unwrap().count(), 2);
}

#[tokio::test]
async fn validates_scope_names_content_size_and_bridge_errors_before_writing() {
    let fixture = Fixture::new();
    for name in ["main", "SUB", "../escape", "a/b", "", ".hidden", &"a".repeat(65)] {
        assert_eq!(code(call(&fixture, json!({"type":"write_agent_file","scope":"user","name":name,"content":text("x","body")})).await.unwrap_err()), "invalid_name");
    }
    assert_eq!(code(call(&fixture, json!({"type":"write_agent_file","scope":"bad","name":"x","content":text("x","body")})).await.unwrap_err()), "invalid_scope");
    assert_eq!(code(call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"x","content":text("y","body")})).await.unwrap_err()), "invalid_content");
    assert_eq!(code(call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"x","content":"bad"})).await.unwrap_err()), "invalid_content");
    assert_eq!(code(call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"x","content":"a".repeat(512*1024+1)})).await.unwrap_err()), "invalid_content");
    let cmd = command(json!({"type":"write_agent_file","scope":"user","name":"x","content":text("x","body")}));
    let error = execute(&cmd, &fixture.dirs, &[], |_, _| async { Err(CommandError::Other("stock refused".into())) }).await.unwrap_err();
    assert_eq!(error, CommandError::local("invalid_content", "stock refused"));
    assert!(!fixture.dirs.user.exists());
}

#[tokio::test]
async fn confines_paths_and_keeps_parse_errors_and_filesystem_errors_distinct() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.dirs.user.join("nested")).unwrap();
    let outside = fixture.root.join("keep.md");
    fs::write(&outside, "keep").unwrap();
    for path in [outside.clone(), fixture.dirs.user.join("nested/a.md"), fixture.dirs.user.join("a.txt"), PathBuf::from("relative/a.md")] {
        assert_eq!(code(call(&fixture, json!({"type":"delete_agent_file","filePath":path})).await.unwrap_err()), "path_outside");
    }
    let error = call(&fixture, json!({"type":"write_agent_file","scope":"user","name":"x","content":text("x","body"),"replacePath":outside})).await.unwrap_err();
    assert_eq!(code(error), "path_outside");
    assert!(!fixture.dirs.user.join("x.md").exists());
    let bad = fixture.dirs.user.join("bad.md");
    fs::write(&bad, "invalid definition").unwrap();
    let read = call(&fixture, json!({"type":"read_agent_file","filePath":bad})).await.unwrap();
    assert_eq!(read["content"], "invalid definition");
    assert_eq!(read["parseError"], "stock validation failure");
    assert!(matches!(call(&fixture, json!({"type":"delete_agent_file","filePath":fixture.dirs.user.join("missing.md")})).await, Err(CommandError::Other(_))));
    assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
}

#[cfg(unix)]
#[tokio::test]
async fn recognizes_real_parent_of_symlinked_agent_directory() {
    let fixture = Fixture::new();
    let real = fixture.root.join("real");
    fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &fixture.dirs.user).unwrap();
    fs::write(real.join("agent.md"), text("agent", "body")).unwrap();
    let read = call(&fixture, json!({"type":"read_agent_file","filePath":real.join("agent.md")})).await.unwrap();
    assert_eq!(read["scope"], "user");
    assert_eq!(read["content"], text("agent", "body"));
}

#[tokio::test]
async fn template_install_filters_in_catalog_order_and_skips_existing_files() {
    let fixture = Fixture::new();
    let templates = [Template { name: "one".into(), content: text("one", "first") }, Template { name: "two".into(), content: text("two", "second") }];
    fs::create_dir(&fixture.dirs.user).unwrap();
    fs::write(fixture.dirs.user.join("one.md"), "mine").unwrap();
    let install = command(json!({"type":"install_agent_templates","scope":"user","names":["two",42,"one","unknown"]}));
    let result = execute(&install, &fixture.dirs, &templates, validate).await.unwrap();
    assert_eq!(result["installed"], json!(["two"]));
    assert_eq!(result["skipped"], json!(["one"]));
    assert_eq!(fs::read_to_string(fixture.dirs.user.join("one.md")).unwrap(), "mine");
    assert_eq!(fs::read_to_string(fixture.dirs.user.join("two.md")).unwrap(), text("two", "second"));
    let again = execute(&install, &fixture.dirs, &templates, validate).await.unwrap();
    assert_eq!(again["installed"], json!([]));
    assert_eq!(again["skipped"], json!(["one","two"]));
}

#[tokio::test]
async fn template_validation_failure_is_not_mapped_to_a_local_error_or_skipped() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.dirs.user).unwrap();
    fs::write(fixture.dirs.user.join("one.md"), "mine").unwrap();
    let templates = [Template { name: "one".into(), content: text("one", "body") }];
    let install = command(json!({"type":"install_agent_templates","scope":"user"}));
    let error = execute(&install, &fixture.dirs, &templates, |_, _| async {
        Err(CommandError::Other("stock refused".into()))
    }).await.unwrap_err();
    assert_eq!(error, CommandError::Other("stock refused".into()));
    assert_eq!(fs::read_to_string(fixture.dirs.user.join("one.md")).unwrap(), "mine");
}
