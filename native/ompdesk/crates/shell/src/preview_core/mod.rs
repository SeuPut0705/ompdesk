//! The Preview's rules (panels-sidebar › Preview, multi-viewer-web › Phone preview): the pure parts the `preview`
//! module drives (PROTOCOL.md §15.5). `captured.json` holds the tables read from the TypeScript they replace
//! (`scripts/shell-port/capture-preview.ts`); each module's tests replay its table.

pub mod dialog;
pub mod input;
pub mod js;
pub mod languages;
pub mod layout;
pub mod pacer;
pub mod page_tools;
pub mod relay_rules;
pub mod stream;
pub mod urls;
pub mod visuals;

#[cfg(test)]
pub(crate) fn captured(table: &str) -> &'static serde_json::Value {
    static TABLES: std::sync::LazyLock<serde_json::Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("captured.json")).expect("captured.json")
    });
    &TABLES[table]
}
