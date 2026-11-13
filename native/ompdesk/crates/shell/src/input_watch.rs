//! `input-event` for a page whose Node side listens to it (the Preview's C143 gate: a `gui_visualize` choice and a
//! visual's link offer count only right after the person's own mouse or key release on that page). CEF reports no
//! mouse input of a page to the browser process, so the page reports it: a script in an isolated world of its own
//! (the page's scripts can neither see nor call it) sends each trusted `pointerup` and `keyup` through a DevTools
//! binding that exists only in that world. A script's `dispatchEvent` is not trusted and never counts; browser-process
//! input (a person's, `sendInputEvent`'s DevTools input) is, as Electron's `input-event` saw both.

use serde_json::{Value, json};

/// The isolated world the script runs in, and the binding only that world has.
pub const WORLD: &str = "ompdesk-input";
pub const BINDING: &str = "__ompdeskInput";

/// Registered once per world: a second registration (the shell arms the page again after a debugger let it go) finds
/// the mark and adds nothing.
const SCRIPT: &str = r#"(() => {
	if (globalThis.__ompdeskInputArmed) return;
	globalThis.__ompdeskInputArmed = true;
	const report = type => event => {
		if (event.isTrusted && typeof globalThis.__ompdeskInput === "function") globalThis.__ompdeskInput(type);
	};
	addEventListener("pointerup", report("mouseUp"), true);
	addEventListener("keyup", report("keyUp"), true);
})();"#;

/// The DevTools commands that arm a page, in order. Bindings exist only while `Runtime` is enabled, and a debugger
/// that disables `Runtime` or `Page` drops them, so the shell sends all four again when a debugger detaches.
pub fn arm_commands() -> [(&'static str, Value); 4] {
    [
        ("Runtime.enable", json!({})),
        (
            "Runtime.addBinding",
            json!({ "name": BINDING, "executionContextName": WORLD }),
        ),
        ("Page.enable", json!({})),
        (
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": SCRIPT, "worldName": WORLD, "runImmediately": true }),
        ),
    ]
}

/// The `input-event` type a DevTools event reports, when it is this binding's call (`Runtime.bindingCalled`).
pub fn input_event(method: &str, params: &Value) -> Option<&'static str> {
    if method != "Runtime.bindingCalled"
        || params.get("name").and_then(Value::as_str) != Some(BINDING)
    {
        return None;
    }
    match params.get("payload").and_then(Value::as_str) {
        Some("mouseUp") => Some("mouseUp"),
        Some("keyUp") => Some("keyUp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_this_bindings_releases() {
        let call = |name: &str, payload: &str| json!({ "name": name, "payload": payload, "executionContextId": 3 });
        assert_eq!(
            input_event("Runtime.bindingCalled", &call(BINDING, "mouseUp")),
            Some("mouseUp")
        );
        assert_eq!(
            input_event("Runtime.bindingCalled", &call(BINDING, "keyUp")),
            Some("keyUp")
        );
        assert_eq!(
            input_event("Runtime.bindingCalled", &call(BINDING, "mouseDown")),
            None
        );
        assert_eq!(
            input_event("Runtime.bindingCalled", &call("other", "mouseUp")),
            None
        );
        assert_eq!(
            input_event("Runtime.consoleAPICalled", &call(BINDING, "mouseUp")),
            None
        );
        assert_eq!(
            input_event("Runtime.bindingCalled", &json!({ "name": BINDING })),
            None
        );
    }
}
