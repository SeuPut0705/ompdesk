use super::*;

#[test]
fn snippets_prefer_conversation_and_keep_original_case() {
    let raw =
        "{\"title\":\"needle title\"}\n{\"message\":{\"content\":\"A Needle in conversation\"}}\n";
    assert_eq!(
        snippet(raw, &raw.to_lowercase(), "needle").as_deref(),
        Some("A Needle in conversation")
    );
}

#[test]
fn snippets_fall_back_to_non_message_entries() {
    let raw = "{\"title\":\"Needle title\"}\n";
    assert_eq!(
        snippet(raw, &raw.to_lowercase(), "needle").as_deref(),
        Some("Needle title")
    );
}

#[test]
fn oversized_entry_remains_searchable_without_consuming_cache() {
    let mut cache = ContentCache::new(1);
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-search-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("session.jsonl");
    std::fs::write(
        &path,
        "{\"message\":{\"content\":\"OVERSIZED_ENTRY_REMAINS_SEARCHABLE\"}}\n",
    )
    .unwrap();
    let hits = cache.search(
        "oversized_entry_remains_searchable",
        std::slice::from_ref(&path),
    );
    assert_eq!(hits.len(), 1);
    assert_eq!(cache.used, 0);
    assert_eq!(
        hits[0].snippet.as_deref(),
        Some("OVERSIZED_ENTRY_REMAINS_SEARCHABLE")
    );
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
