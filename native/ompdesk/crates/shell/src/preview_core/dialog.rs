//! JS dialogs of a viewer's offscreen page (port of `src/main/web/preview-dialog.ts`). A page without a window to
//! show `alert`, `confirm` and `prompt` on stays blocked in them for good, and a debugger on the page would turn the
//! `choose` gate off. So the viewers' sessions carry one fixed preload script that replaces those three functions in
//! the page's main world with calls that ask the shell synchronously, and so block the page exactly as a real dialog
//! does, until the viewer answers on its phone. The shell answers the channel only for a page it streams, and always
//! answers. `beforeunload` is not a dialog here: the page is let leave.

use serde_json::Value;

use super::input::Refusal;

/// The channel the preload asks on (the shell's own, never the web registry: a page is no caller).
pub const DIALOG_CHANNEL: &str = "preview-web:dialog";

/// The longest message or initial text, in UTF-16 units (what the preload's `slice` and the schema count).
pub const MESSAGE_MAX: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DialogKind {
    Alert,
    Confirm,
    Prompt,
}

/// What the page's dialog function asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialogRequest {
    pub kind: DialogKind,
    pub message: String,
    pub initial: Option<String>,
}

/// What the viewer answered (`accept`, and the typed text for a prompt).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialogAnswer {
    pub accept: bool,
    pub text: Option<String>,
}

/// What the synchronous call returns to the replaced function.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DialogReturn {
    Null,
    Bool(bool),
    Text(String),
}

impl DialogReturn {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(accepted) => Value::Bool(*accepted),
            Self::Text(text) => Value::String(text.clone()),
        }
    }
}

fn text(value: &Value, refusal: &'static str) -> Result<String, Refusal> {
    match value.as_str() {
        Some(text) if text.encode_utf16().count() <= MESSAGE_MAX => Ok(text.to_owned()),
        _ => Err(Refusal(refusal)),
    }
}

/// `dialogRequestSchema.safeParse`: `kind` one of the three, `message` a string and `initial` a string or null (both
/// required; unknown keys ignored, as zod's object does), each at most [`MESSAGE_MAX`] UTF-16 units.
pub fn parse_request(value: &Value) -> Result<DialogRequest, Refusal> {
    let object = value.as_object().ok_or(Refusal("not an object"))?;
    let kind = match object.get("kind").and_then(Value::as_str) {
        Some("alert") => DialogKind::Alert,
        Some("confirm") => DialogKind::Confirm,
        Some("prompt") => DialogKind::Prompt,
        _ => return Err(Refusal("unknown dialog kind")),
    };
    let message = text(object.get("message").unwrap_or(&Value::Null), "message")?;
    let initial = match object.get("initial") {
        Some(Value::Null) => None,
        Some(initial) => Some(text(initial, "initial")?),
        None => return Err(Refusal("initial is missing")),
    };
    Ok(DialogRequest {
        kind,
        message,
        initial,
    })
}

/// What `sendSync` returns to the replaced function: null for `alert` (a reply is always set), a boolean for
/// `confirm`, a string or null for `prompt`.
pub fn dialog_return_value(request: &DialogRequest, answer: &DialogAnswer) -> DialogReturn {
    match request.kind {
        DialogKind::Alert => DialogReturn::Null,
        DialogKind::Confirm => DialogReturn::Bool(answer.accept),
        DialogKind::Prompt if answer.accept => DialogReturn::Text(
            answer
                .text
                .clone()
                .or_else(|| request.initial.clone())
                .unwrap_or_default(),
        ),
        DialogKind::Prompt => DialogReturn::Null,
    }
}

/// The one fixed script the viewers' sessions load before any page script: it takes `__ompdeskSendSync` (which the
/// shell gives a registered preload script) and removes it, so the page never sees it, then replaces the three
/// functions. Byte for byte the TypeScript's `DIALOG_PRELOAD_SOURCE` (tabs and the final newline included).
pub const DIALOG_PRELOAD_SOURCE: &str = concat!(
    "(() => {\n",
    "\t\"use strict\";\n",
    "\tconst send = globalThis.__ompdeskSendSync;\n",
    "\tdelete globalThis.__ompdeskSendSync;\n",
    "\tif (typeof send !== \"function\") return;\n",
    "\tconst clip = value => String(value === undefined || value === null ? \"\" : value).slice(0, 2000);\n",
    "\tconst ask = (kind, message, initial) =>\n",
    "\t\tsend(\"preview-web:dialog\", { kind, message: clip(message), initial: initial === null ? null : clip(initial) });\n",
    "\twindow.alert = message => {\n",
    "\t\task(\"alert\", message, null);\n",
    "\t};\n",
    "\twindow.confirm = message => ask(\"confirm\", message, null) === true;\n",
    "\twindow.prompt = (message, initial) => {\n",
    "\t\tconst answer = ask(\"prompt\", message, initial === undefined ? \"\" : initial);\n",
    "\t\treturn typeof answer === \"string\" ? answer : null;\n",
    "\t};\n",
    "})();\n",
);

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::captured;
    use super::*;

    fn request(value: Value) -> DialogRequest {
        parse_request(&value).unwrap_or_else(|refusal| panic!("{value}: {refusal:?}"))
    }

    #[test]
    fn replays_the_captured_returns() {
        let rows = captured("dialog")["returns"].as_array().unwrap();
        assert_eq!(rows.len(), 16);
        for row in rows {
            let answer = DialogAnswer {
                accept: row["answer"]["accept"].as_bool().unwrap(),
                text: row["answer"]["text"].as_str().map(str::to_owned),
            };
            let got = dialog_return_value(&request(row["request"].clone()), &answer).to_json();
            assert_eq!(got, row["out"], "{row}");
        }
    }

    #[test]
    fn replays_the_captured_schema() {
        let rows = captured("dialog")["schema"].as_array().unwrap();
        assert_eq!(rows.len(), 5);
        for row in rows {
            let ok = row["ok"].as_bool().unwrap();
            assert_eq!(parse_request(&row["value"]).is_ok(), ok, "{}", row["value"]);
        }
    }

    #[test]
    fn the_channel_and_the_preload_are_the_captured_ones_byte_for_byte() {
        assert_eq!(
            DIALOG_CHANNEL,
            captured("dialog")["channel"].as_str().unwrap()
        );
        assert_eq!(
            DIALOG_PRELOAD_SOURCE,
            captured("dialog")["preload"].as_str().unwrap()
        );
        assert!(DIALOG_PRELOAD_SOURCE.contains(&format!("slice(0, {MESSAGE_MAX})")));
        assert!(DIALOG_PRELOAD_SOURCE.contains(&format!("send(\"{DIALOG_CHANNEL}\"")));
    }

    #[test]
    fn parses_what_the_preload_sends_and_counts_utf16_units() {
        let parsed =
            request(json!({ "kind": "prompt", "message": "m", "initial": "init", "extra": 1 }));
        assert_eq!(
            parsed,
            DialogRequest {
                kind: DialogKind::Prompt,
                message: "m".into(),
                initial: Some("init".into())
            }
        );
        assert!(
            parse_request(
                &json!({ "kind": "alert", "message": "😀".repeat(1000), "initial": null })
            )
            .is_ok()
        );
        assert!(
            parse_request(
                &json!({ "kind": "alert", "message": "😀".repeat(1001), "initial": null })
            )
            .is_err()
        );
        assert!(parse_request(&json!({ "kind": "prompt", "message": "m", "initial": 3 })).is_err());
        assert!(parse_request(&json!("alert")).is_err());
    }

    #[test]
    fn an_empty_typed_answer_is_an_answer_not_a_missing_one() {
        let prompt = request(json!({ "kind": "prompt", "message": "m", "initial": "init" }));
        let typed = |text: Option<&str>| DialogAnswer {
            accept: true,
            text: text.map(str::to_owned),
        };
        assert_eq!(
            dialog_return_value(&prompt, &typed(Some(""))),
            DialogReturn::Text(String::new())
        );
        assert_eq!(
            dialog_return_value(&prompt, &typed(None)),
            DialogReturn::Text("init".into())
        );
        let bare = request(json!({ "kind": "prompt", "message": "m", "initial": null }));
        assert_eq!(
            dialog_return_value(&bare, &typed(None)),
            DialogReturn::Text(String::new())
        );
    }
}
