use super::*;

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ompdesk-web-actions-{}",
            super::super::router::uuid()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn listing_keeps_directories_first_numeric_names_hidden_and_filter_contract() {
    let dir = Scratch::new();
    std::fs::create_dir(dir.0.join("folder10")).unwrap();
    std::fs::create_dir(dir.0.join("folder2")).unwrap();
    for name in ["file10", "file2", ".hidden"] {
        std::fs::write(dir.0.join(name), b"bytes").unwrap();
    }
    let dirs = list_dirs(&dir.0, &dir.0, "", false, "en-US").unwrap();
    assert_eq!(
        dirs["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["folder2", "folder10"]
    );
    let all = list_dirs(&dir.0, &dir.0, "", true, "en-US").unwrap();
    assert_eq!(
        all["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["folder2", "folder10", "file2", "file10"]
    );
    assert_eq!(all["entries"][2]["size"], 5);
    assert_eq!(
        list_dirs(&dir.0, &dir.0, " FILE2 ", true, "en-US").unwrap()["entries"][0]["name"],
        "file2"
    );
    assert_eq!(
        list_dirs(&dir.0.join("missing"), &dir.0, "", false, "en-US")
            .unwrap_err()
            .code,
        "file_not_found"
    );
    assert_eq!(
        list_dirs(&dir.0.join("file2"), &dir.0, "", false, "en-US")
            .unwrap_err()
            .code,
        "not_a_directory"
    );
}

#[test]
fn save_refuses_overwrite_and_keeps_uploaded_files_available() {
    let dir = Scratch::new();
    let target = dir.0.join("kept.txt");
    let source = dir.0.join("upload.txt");
    std::fs::write(&target, b"old").unwrap();
    std::fs::write(&source, b"uploaded").unwrap();
    assert_eq!(
        save(&target, Save::Bytes(b"new".to_vec()), false)["code"],
        "exists"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    assert_eq!(
        save(&target, Save::Upload(source.clone()), false)["code"],
        "exists"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    assert_eq!(
        save(&target, Save::Upload(source.clone()), true)["ok"],
        true
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"uploaded");
    assert_eq!(std::fs::read(source).unwrap(), b"uploaded");
    let new = dir.0.join("new.bin");
    assert_eq!(
        save(&new, Save::Bytes(decode_base64("AA EC-_8=")), false)["ok"],
        true
    );
    assert_eq!(std::fs::read(new).unwrap(), [0, 1, 2, 251, 255]);
}

#[test]
fn schema_rejects_null_options_and_names_that_escape_the_chosen_folder() {
    for name in [
        ".",
        "..",
        "../outside",
        "a/b",
        "a\\b",
        " leading",
        "trailing ",
        "a\0b",
        "a\u{85}b",
    ] {
        assert!(!valid_name(name), "{name:?}");
    }
    assert!(valid_name("한글.txt"));
    let request = json!({"path":null,"files":null});
    let map = request.as_object().unwrap();
    assert_eq!(
        optional_string(map, "path", 4096).unwrap_err().code,
        "invalid_content"
    );
    assert_eq!(
        optional_bool(map, "files").unwrap_err().code,
        "invalid_content"
    );
    assert_eq!(
        strip_code("[invalid_content] model config changed"),
        "model config changed"
    );
    assert_eq!(strip_code("[Provider] rejected"), "[Provider] rejected");
}

#[test]
fn blob_read_refuses_missing_directory_and_oversized_file_before_loading_it() {
    let dir = Scratch::new();
    assert_eq!(blob_file(&dir.0).unwrap_err().code, "file_not_found");
    let file = dir.0.join("video");
    std::fs::write(&file, b"0123456789").unwrap();
    let (_, header, size) = blob_file(&file).unwrap();
    assert_eq!(header, b"0123456789");
    assert_eq!(size, 10);
    let huge = dir.0.join("huge");
    std::fs::File::create(&huge)
        .unwrap()
        .set_len(BINARY_MAX + 1)
        .unwrap();
    assert_eq!(blob_file(&huge).unwrap_err().code, "file_too_large");
}

#[test]
fn external_links_cannot_launch_custom_file_or_script_handlers() {
    for url in [
        "https://example.invalid",
        "http://example.invalid",
        "mailto:fixture@example.invalid",
        "MAILTO:?subject=Hello",
    ] {
        assert!(is_openable_external_url(url), "{url:?}");
    }
    for url in [
        "file:///secret",
        "javascript:alert(1)",
        "custom-app://run",
        "mailto:",
        "mailto:a b",
        "mailto:a\u{feff}b",
        "mailto:a\u{0000}b",
    ] {
        assert!(!is_openable_external_url(url), "{url:?}");
    }
}
