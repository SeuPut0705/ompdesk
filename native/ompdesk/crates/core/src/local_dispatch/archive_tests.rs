use super::*;

struct Root(PathBuf);
impl Root {
    fn new() -> Self { Self(crate::fs::disk::make_temp_dir("omp-archive-").expect("fixture directory")) }
    fn file(&self, name: &str) -> PathBuf { self.0.join(name) }
}
impl Drop for Root {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn stock(root: &Root, entries: &[(&str, &[u8])]) -> Value {
    let path = root.file("stock.zip");
    let file = File::create(&path).expect("stock fixture");
    let mut zip = ZipWriter::new(file);
    for (name, bytes) in entries {
        zip.start_file(*name, SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)).expect("member");
        zip.write_all(bytes).expect("member bytes");
    }
    zip.finish().expect("stock ZIP");
    json!({"path":path,"files":entries.iter().map(|entry|entry.0).collect::<Vec<_>>(),"subagentCount":1,"anonymized":false,"subagentError":"one unreadable"})
}
fn contents(path: &Path) -> Map<String, Value> {
    let mut zip = ZipArchive::new(File::open(path).expect("redacted ZIP")).expect("valid ZIP");
    let mut files = Map::new();
    for index in 0..zip.len() {
        let mut member = zip.by_index(index).expect("member");
        let name = String::from_utf8_lossy(member.name_raw()).into_owned();
        let mut text = String::new();
        member.read_to_string(&mut text).expect("UTF8 text member");
        files.insert(name, json!(text));
    }
    files
}

#[tokio::test]
async fn redacts_real_nested_zip_before_publishing_and_discards_only_owned_outputs() {
    let root = Root::new();
    let input = stock(&root, &[
        ("request.json", br#"{"apiKey":"fictional-secret","messages":[{"text":"mail jane@example.com"}],"tokens":3}"#),
        ("subagents/A/session.JSONL", b"{\"token\":[\"fictional-secret\"]}\nraw /Users/jane/work\n"),
        ("notes.md", "한글 🦀 192.168.1.20 token=fictional-secret\n".as_bytes()),
        ("bom.json", b"\xef\xbb\xbf{\"password\":[\"fictional-secret\"]}"),
        ("invalid.bin", &[0xff, 0xfe]),
        ("nul.txt", b"looks like text\0but is binary"),
    ]);
    let service = Archives::default();
    let output = service.redact(input, Scope::detached()).await.expect("redacted result");
    assert!(!root.file("stock.zip").exists());
    assert_eq!(output["files"], json!(["request.json","subagents/A/session.JSONL","notes.md","bom.json"]));
    assert_eq!(output["dropped"], json!(["invalid.bin","nul.txt"]));
    assert_eq!(output["subagentCount"], 1);
    assert_eq!(output["subagentError"], "one unreadable");
    assert_eq!(output["redacted"], true);
    let path = Path::new(output["path"].as_str().expect("output path"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(path).expect("output metadata").permissions().mode() & 0o777, 0o600);
    }
    let files = contents(path);
    assert_eq!(serde_json::from_str::<Value>(files["request.json"].as_str().expect("JSON member")).expect("valid JSON"), json!({"apiKey":"<secret>","messages":[{"text":"mail <email>"}],"tokens":3}));
    assert_eq!(files["subagents/A/session.JSONL"], "{\"token\":[\"<secret>\"]}\nraw ~/work\n");
    assert_eq!(files["notes.md"], "한글 🦀 <lan-ip> token=<secret>\n");
    assert_eq!(files["bom.json"], "{\"password\":[\"<secret>\"]}");
    let unrelated = root.file("unrelated.txt");
    fs::write(&unrelated, "keep this file").expect("unrelated fixture");
    assert!(!service.discard(&unrelated).expect("not owned"));
    assert_eq!(fs::read_to_string(&unrelated).expect("unrelated survives"), "keep this file");
    assert!(service.discard(path).expect("owned discard"));
    assert!(!path.exists());
    assert!(!service.discard(path).expect("only once"));
}

#[tokio::test]
async fn removes_raw_stock_file_when_zip_is_malformed() {
    let root = Root::new();
    let path = root.file("stock.zip");
    fs::write(&path, "not a ZIP").expect("malformed fixture");
    let result = Archives::default().redact(json!({"path":path}), Scope::detached()).await;
    assert!(result.is_err());
    assert!(!path.exists());
    assert_eq!(fs::read_dir(&root.0).expect("fixture directory").count(), 0);
}

#[test]
fn write_failure_removes_stock_file_without_deleting_the_failed_destination() {
    let root = Root::new();
    let original = stock(&root, &[("session.md", b"token=fictional-secret")]);
    let destination = root.file("occupied-directory");
    fs::create_dir(&destination).expect("write failure fixture");
    let result = consume(RawArchive(root.file("stock.zip")), original, &Scope::detached(), Some(destination.clone()));
    assert!(result.is_err());
    assert!(!root.file("stock.zip").exists());
    assert!(destination.is_dir());
    assert_eq!(fs::read_dir(&root.0).expect("fixture directory").count(), 1);
}

#[tokio::test]
async fn cancellation_waits_for_raw_cleanup_and_publishes_no_output() {
    let root = Root::new();
    let original = stock(&root, &[("session.md", b"token=fictional-secret")]);
    let scope = Scope::detached();
    scope.cancel();
    let result = Archives::default().redact(original, scope).await;
    assert!(matches!(result, Err(CommandError::Other(message)) if message == Fault::cancelled().message));
    assert!(!root.file("stock.zip").exists());
    assert_eq!(fs::read_dir(&root.0).expect("fixture directory").count(), 0);
}

#[test]
fn an_unpublished_blocking_result_cleans_its_redacted_output_on_drop() {
    let root = Root::new();
    let original = stock(&root, &[("session.md", b"token=fictional-secret")]);
    let output = root.file("unpublished.zip");
    let pending = consume(RawArchive(root.file("stock.zip")), original, &Scope::detached(), Some(output.clone())).expect("completed ZIP work");
    assert_eq!(contents(&output)["session.md"], "token=<secret>");
    assert!(!root.file("stock.zip").exists());
    drop(pending);
    assert!(!output.exists());
}

#[tokio::test]
async fn matches_jszip_normalized_last_duplicate_and_object_key_order() {
    let root = Root::new();
    let original = stock(&root, &[("3", b"three"), ("nested/../request.json", br#"{"token":"first"}"#), ("1", b"one"), ("request.json", br#"{"token":"last"}"#)]);
    let service = Archives::default();
    let output = service.redact(original, Scope::detached()).await.expect("normalized archive");
    assert_eq!(output["files"], json!(["1","3","request.json"]));
    let path = Path::new(output["path"].as_str().expect("path"));
    assert_eq!(contents(path)["request.json"], "{\"token\":\"<secret>\"}");
    assert!(service.discard(path).expect("cleanup"));
}

#[tokio::test]
async fn bom_json_escaped_secret_key_is_redacted_before_publish() {
    let root = Root::new();
    let original = stock(&root, &[("request.json", b"\xef\xbb\xbf{\"api\\u004bey\":\"sample-secret\"}")]);
    let service = Archives::default();
    let output = service.redact(original, Scope::detached()).await.expect("redacted BOM archive");
    assert_eq!(output["redacted"], true);
    let path = Path::new(output["path"].as_str().expect("path"));
    let files = contents(path);
    assert_eq!(serde_json::from_str::<Value>(files["request.json"].as_str().expect("JSON member")).expect("valid redacted JSON"), json!({"apiKey":"<secret>"}));
    assert!(!files["request.json"].as_str().expect("JSON member").contains("sample-secret"));
    assert!(!root.file("stock.zip").exists());
    assert!(service.discard(path).expect("owned cleanup"));
}
