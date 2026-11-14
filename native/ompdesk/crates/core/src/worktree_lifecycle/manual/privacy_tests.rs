use super::secret_in;

#[test]
fn names_and_incomplete_reads_are_private() {
    for path in [".env", "folder/ID_ED25519.pub", "credentials.json", "some-secret.txt", "x.p12"] {
        assert!(secret_in(path, b"ordinary", true), "{path}");
    }
    assert!(secret_in("ordinary.txt", b"ordinary", false));
    assert!(!secret_in("ordinary.txt", b"ordinary", true));
}

#[test]
fn detects_credential_markers_but_not_inert_fields() {
    for bytes in [
        &b"password=horse-battery"[..],
        &b"Authorization: Bearer abcd1234"[..],
        &b"https://user:password@example.test"[..],
        &b"0123456789abcdef0123456789abcdef"[..],
        &b"ghp_abcdefghijklmnopqrstuvwxyz"[..],
        &b"-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----"[..],
    ] {
        assert!(secret_in("data.txt", bytes, true), "{:?}", bytes);
    }
    for bytes in [&b"tokens=42"[..], &b"password=false"[..], &b"password=<secret>"[..], &b"<secret> <token>"[..]] {
        assert!(!secret_in("data.txt", bytes, true), "{:?}", bytes);
    }
}

#[test]
fn replacement_order_counts_new_markers_not_just_matches() {
    assert!(!secret_in("x", b"-----BEGIN KEY-----<secret>-----END KEY-----", true));
    assert!(!secret_in("x", b"-----BEGIN KEY-----<token> <secret>-----END KEY-----", true));
    assert!(secret_in("x", b"token=ghp_abcdefghijklmnopqrstuvwxyz", true));
    assert!(secret_in("x", b"Bearer\xa0abcdefgh", true));
}

#[test]
fn missing_and_oversized_files_are_private() {
    let root = std::env::temp_dir().join(format!("ompdesk-manual-private-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    assert!(super::looks_secret(&root.to_string_lossy(), "missing"));
    let file = std::fs::File::create(root.join("large")).unwrap();
    file.set_len(super::MAX + 1).unwrap();
    assert!(super::looks_secret(&root.to_string_lossy(), "large"));
    drop(file);
    std::fs::remove_dir_all(root).unwrap();
}
