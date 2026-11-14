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

#[test]
fn archives_the_canonical_typescript_credential_cases_but_not_its_false_positives() {
    // src/main/redactor.test.ts credential and false-positive inputs, consumed as Latin1 bytes.
    for text in [
        "key sk-ant-api03-AbCdEf0123456789_xyz-AbCdEf",
        "sk-proj-0123456789abcdefABCDEF",
        "header Bearer 8f14e45fceea167a",
        "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end",
        "AKIAIOSFODNN7EXAMPLE",
        "xoxb-1234567890-abcdefghij",
        "OPENAI_API_KEY=hunter2hunter2",
        "password: correcthorse",
        r#"{"client_secret":"abc def","a":1}"#,
        r#"{"message":"got \"token\":\"abcd1234\" back"}"#,
        "GET /x?access_token=abc123&other=1",
        "refreshToken = 'a b c'",
        "blob aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kL9n",
    ] {
        assert!(secret_in("data.txt", text.as_bytes(), true), "{text}");
    }
    for text in [
        "OMPdesk 0.35.1 omp 18.11.1 Electron 36.4.0 Chrome 136.0.7103.113 Node 22.16.0",
        "session 550e8400-e29b-41d4-a716-446655440000 and 550E8400-E29B-41D4-A716-446655440000",
        "maxTokens: 4096 totalTokens=1234 tokens: 12 hasToken: false token: null",
        "ordinary words stay: password manager, secret santa, tokenizer",
        "~/.omp/wt/gui-orca-hygiene-540bd7d/node_modules/@oh-my-pi/pi-coding-agent/src/UpdatesSectionRow2 useMachineSetupStoreForTheWholeApp",
        "token=<token> password=",
        "mail alice@example.com from /Users/alice/work on 100.64.0.1 and 192.168.1.5 via box.tail1234.ts.net",
    ] {
        assert!(!secret_in("data.txt", text.as_bytes(), true), "{text}");
    }
}
