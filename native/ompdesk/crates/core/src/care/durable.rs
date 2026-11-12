//! Which memory pages are durable (7d): a Rust copy of `isDurablePath` and `DURABLE_MEMORY_FOLDERS` of
//! `src/main/remote/app-protocol.ts`. It is a copy because that file stays TypeScript until the remote program moves
//! (the page-side schema `MemoryPageWire` and the sync read the same function there); the captured table
//! `durable-captured.json` (44 paths run through the TypeScript) pins this copy to it.

/// The page folders that cross between computers and that care tidies: decisions, rules, gotchas, procedures,
/// preferences and the profile, of any project (`_global` included). Never `sessions/`, never raw observations.
pub const DURABLE_MEMORY_FOLDERS: [&str; 6] = [
    "decisions",
    "_rules",
    "gotchas",
    "procedures",
    "preferences",
    "profile",
];

/// A page in a durable folder, written as markdown, with no empty, `.` or `..` part and no backslash.
pub fn is_durable_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() >= 2
        && DURABLE_MEMORY_FOLDERS.contains(&parts[0])
        && path.ends_with(".md")
        && !parts.iter().any(|part| matches!(*part, "" | "." | ".."))
        && !path.contains('\\')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn durable_paths_match_the_captured_rows() {
        let rows: Vec<Value> = serde_json::from_str(include_str!("durable-captured.json")).unwrap();
        assert_eq!(rows.len(), 44);
        for row in &rows {
            let path = row["path"].as_str().unwrap();
            assert_eq!(
                is_durable_path(path),
                row["durable"].as_bool().unwrap(),
                "{path:?}"
            );
        }
        assert!(rows.iter().any(|row| row["durable"] == true));
        assert!(rows.iter().any(|row| row["durable"] == false));
    }
}
