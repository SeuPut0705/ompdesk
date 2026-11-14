use serde_json::json;

use super::{image_sites, journal_tail, slim};

#[test]
fn transcript_page_keeps_content_without_provider_bookkeeping() {
    let mut messages = vec![json!({
        "role":"assistant",
        "inputTransformations":[{"kind":"dropped-thinking"}],
        "requestControls":{"tools":[]},
        "contextSnapshot":{"tokens":41000},
        "content":[{"type":"thinking","thinking":"hello","thinkingSignature":"secret"},
                   {"type":"toolCall","id":"one","arguments":{"thinkingSignature":"kept"}}],
        "stopReason":"toolUse"
    })];
    slim(&mut messages);
    assert_eq!(messages, vec![json!({
        "role":"assistant",
        "content":[{"type":"thinking","thinking":"hello"},
                   {"type":"toolCall","id":"one","arguments":{"thinkingSignature":"kept"}}],
        "stopReason":"toolUse"
    })]);
}

#[test]
fn image_replacements_only_touch_stock_image_positions() {
    let reference = format!("blob:sha256:{}", "a".repeat(64));
    let mut messages = json!([{"content":[{"type":"image","data":reference},
        {"type":"text","data":reference}],"details":{"images":[{"mimeType":"image/png","data":reference}]},
        "other":{"data":reference}}]);
    let mut sites = Vec::new();
    image_sites(&mut messages, None, &mut sites);
    for site in sites { *site = json!("image bytes"); }
    assert_eq!(messages[0]["content"][0]["data"], "image bytes");
    assert_eq!(messages[0]["details"]["images"][0]["data"], "image bytes");
    assert_eq!(messages[0]["content"][1]["data"], reference);
    assert_eq!(messages[0]["other"]["data"], reference);
}

#[test]
fn empty_cursor_has_a_tail_without_a_journal() {
    assert_eq!(journal_tail("", 0).as_deref(), Some("0"));
    assert_eq!(journal_tail("", 1), None);
}
