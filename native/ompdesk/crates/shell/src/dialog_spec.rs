//! `dialog.*` parameters (PROTOCOL.md §8) as typed specs, and the pure decisions both platforms share: the button
//! plan of a message box, the file-type filters, the default-path split. No OS calls in here, so `cargo test` covers it.

use serde_json::Value;

// ------------------------------------------------------------------ message box

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MessageType {
    None,
    Info,
    Warning,
    Error,
    Question,
}

#[derive(Clone, Debug)]
pub struct MessageBoxSpec {
    pub kind: MessageType,
    /// Never empty: a box without buttons gets `OK`.
    pub buttons: Vec<String>,
    pub default_id: usize,
    pub cancel_id: usize,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub checkbox_label: Option<String>,
    pub checkbox_checked: bool,
    pub no_link: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct MessageBoxResult {
    pub response: usize,
    pub checkbox_checked: bool,
}

fn text(options: &Value, key: &str) -> String {
    options
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn non_empty(options: &Value, key: &str) -> Option<String> {
    options
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn flag(options: &Value, key: &str) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// What Electron treats as "the button that backs out": a label of `cancel` or `no`.
fn is_cancel_label(label: &str) -> bool {
    matches!(label.trim().to_ascii_lowercase().as_str(), "cancel" | "no")
}

impl MessageBoxSpec {
    /// `options` of `dialog.messageBox`, every key optional as in Electron.
    pub fn from_json(options: &Value) -> Self {
        let kind = match options.get("type").and_then(Value::as_str) {
            Some("info") => MessageType::Info,
            Some("warning") => MessageType::Warning,
            Some("error") => MessageType::Error,
            Some("question") => MessageType::Question,
            _ => MessageType::None,
        };
        let mut buttons: Vec<String> = options
            .get("buttons")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        if buttons.is_empty() {
            buttons.push("OK".into());
        }
        let in_range = |key: &str| {
            options
                .get(key)
                .and_then(Value::as_i64)
                .filter(|n| *n >= 0 && (*n as usize) < buttons.len())
                .map(|n| n as usize)
        };
        let default_id = in_range("defaultId").unwrap_or(0);
        // Electron: an explicit `cancelId` wins; else the first button called Cancel/No; else 0.
        let cancel_id = in_range("cancelId")
            .or_else(|| buttons.iter().position(|b| is_cancel_label(b)))
            .unwrap_or(0);
        Self {
            kind,
            default_id,
            cancel_id,
            title: text(options, "title"),
            message: text(options, "message"),
            detail: text(options, "detail"),
            checkbox_label: non_empty(options, "checkboxLabel"),
            checkbox_checked: flag(options, "checkboxChecked"),
            no_link: flag(options, "noLink"),
            buttons,
        }
    }
}

// Windows' TaskDialog identifiers (IDOK … IDCLOSE) and common-button flags (TDCBF_*).
pub const ID_OK: i32 = 1;
pub const ID_CANCEL: i32 = 2;
pub const ID_RETRY: i32 = 4;
pub const ID_YES: i32 = 6;
pub const ID_NO: i32 = 7;
pub const ID_CLOSE: i32 = 8;
/// A custom button `i` has id `CUSTOM_BASE + i`: far from every IDxxx the system uses.
pub const CUSTOM_BASE: i32 = 1000;

fn common_button(label: &str) -> Option<(i32, i32)> {
    // (id, TDCBF flag)
    match label.trim().to_ascii_lowercase().as_str() {
        "ok" => Some((ID_OK, 0x1)),
        "yes" => Some((ID_YES, 0x2)),
        "no" => Some((ID_NO, 0x4)),
        "cancel" => Some((ID_CANCEL, 0x8)),
        "retry" => Some((ID_RETRY, 0x10)),
        "close" => Some((ID_CLOSE, 0x20)),
        _ => None,
    }
}

/// How the buttons map onto a TaskDialog: Electron shows the ones named like a system button (`OK`, `Yes`, `No`,
/// `Cancel`, `Retry`, `Close`) as common buttons and the others as custom ones (command links unless `noLink`).
/// With `noLink` every button is custom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ButtonPlan {
    pub common_flags: i32,
    /// `(id, label)` in the order the buttons were given.
    pub custom: Vec<(i32, String)>,
    /// Button id → index in `buttons`.
    pub ids: Vec<(i32, usize)>,
    pub default_button: i32,
    pub cancel_id: usize,
}

impl ButtonPlan {
    pub fn new(spec: &MessageBoxSpec) -> Self {
        let mut common_flags = 0;
        let mut custom = Vec::new();
        let mut ids: Vec<(i32, usize)> = Vec::new();
        for (index, label) in spec.buttons.iter().enumerate() {
            let common = if spec.no_link {
                None
            } else {
                common_button(label)
            };
            match common {
                Some((id, bit)) if common_flags & bit == 0 => {
                    common_flags |= bit;
                    ids.push((id, index));
                }
                _ => {
                    let id = CUSTOM_BASE + index as i32;
                    custom.push((id, label.clone()));
                    ids.push((id, index));
                }
            }
        }
        let default_button = ids
            .iter()
            .find(|(_, i)| *i == spec.default_id)
            .map(|(id, _)| *id)
            .unwrap_or(0);
        Self {
            common_flags,
            custom,
            ids,
            default_button,
            cancel_id: spec.cancel_id,
        }
    }

    /// The `response` for the button id TaskDialog answered; the Esc key, the close box and any id the plan does not
    /// know give `cancelId`.
    pub fn index_for(&self, id: i32) -> usize {
        self.ids
            .iter()
            .find(|(known, _)| *known == id)
            .map(|(_, i)| *i)
            .unwrap_or(self.cancel_id)
    }
}

// ------------------------------------------------------------------ file dialogs

/// One file-type filter: the shown name and the Windows pattern list (`*.png;*.jpg`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filter {
    pub name: String,
    pub pattern: String,
    /// The extensions as given, without dot; `*` stays `*`.
    pub extensions: Vec<String>,
}

/// `["png", ".jpg", "*.gif", "*"]` → `*.png;*.jpg;*.gif;*.*`. An empty list means every file.
pub fn filter_pattern(extensions: &[String]) -> String {
    let parts: Vec<String> = extensions
        .iter()
        .map(|ext| ext.trim().trim_start_matches('*').trim_start_matches('.'))
        .map(|ext| {
            if ext.is_empty() {
                "*.*".to_string()
            } else {
                format!("*.{ext}")
            }
        })
        .collect();
    if parts.is_empty() {
        "*.*".into()
    } else {
        parts.join(";")
    }
}

fn clean_extension(ext: &str) -> String {
    let trimmed = ext.trim().trim_start_matches("*.").trim_start_matches('.');
    trimmed.to_string()
}

pub fn parse_filters(options: &Value) -> Vec<Filter> {
    let Some(list) = options.get("filters").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .map(|entry| {
            let extensions: Vec<String> = entry
                .get("extensions")
                .and_then(Value::as_array)
                .map(|exts| {
                    exts.iter()
                        .filter_map(Value::as_str)
                        .map(clean_extension)
                        .collect()
                })
                .unwrap_or_default();
            let pattern = filter_pattern(&extensions);
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .map(String::from)
                .unwrap_or_else(|| pattern.clone());
            Filter {
                name,
                pattern,
                extensions,
            }
        })
        .collect()
}

/// The extension a save dialog appends when the user types none: the first filter's first real one (`*` is none).
pub fn default_extension(filters: &[Filter]) -> Option<&str> {
    filters
        .first()?
        .extensions
        .iter()
        .map(String::as_str)
        .find(|e| !e.is_empty() && *e != "*")
}

#[derive(Clone, Debug, Default)]
pub struct FileDialogSpec {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub button_label: Option<String>,
    pub filters: Vec<Filter>,
    pub message: Option<String>,
    pub name_field_label: Option<String>,
    pub open_file: bool,
    pub open_directory: bool,
    pub multi_selections: bool,
    pub show_hidden: bool,
    pub create_directory: bool,
    pub prompt_to_create: bool,
    pub treat_package_as_directory: bool,
    pub dont_add_to_recent: bool,
}

impl FileDialogSpec {
    pub fn from_json(options: &Value) -> Self {
        let props: Vec<&str> = options
            .get("properties")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let has = |name: &str| props.contains(&name);
        Self {
            title: non_empty(options, "title"),
            default_path: non_empty(options, "defaultPath"),
            button_label: non_empty(options, "buttonLabel"),
            filters: parse_filters(options),
            message: non_empty(options, "message"),
            name_field_label: non_empty(options, "nameFieldLabel"),
            open_file: has("openFile"),
            open_directory: has("openDirectory"),
            multi_selections: has("multiSelections"),
            show_hidden: has("showHiddenFiles"),
            create_directory: has("createDirectory"),
            prompt_to_create: has("promptToCreate"),
            treat_package_as_directory: has("treatPackageAsDirectory"),
            dont_add_to_recent: has("dontAddToRecent"),
        }
    }
}

/// `defaultPath` split into the folder to start in and the file name to prefill. A path that is a folder gives only
/// the folder; anything else gives its parent (when it names one) and its last component.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct DefaultPath {
    pub folder: Option<String>,
    pub name: Option<String>,
}

pub fn split_default_path(path: &str, is_dir: impl Fn(&str) -> bool) -> DefaultPath {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return DefaultPath::default();
    }
    let ends_with_separator = trimmed.ends_with(['/', '\\']);
    if ends_with_separator || is_dir(trimmed) {
        return DefaultPath {
            folder: Some(trimmed.to_string()),
            name: None,
        };
    }
    match trimmed.rfind(['/', '\\']) {
        Some(at) => {
            let (folder, name) = (&trimmed[..at], &trimmed[at + 1..]);
            // `C:` alone is a drive-relative path: keep the separator that makes it the drive's root.
            let folder = if folder.ends_with(':') {
                format!("{folder}\\")
            } else {
                folder.to_string()
            };
            DefaultPath {
                folder: (!folder.is_empty()).then_some(folder),
                name: (!name.is_empty()).then(|| name.to_string()),
            }
        }
        None => DefaultPath {
            folder: None,
            name: Some(trimmed.to_string()),
        },
    }
}

// ------------------------------------------------------------------ closing a box from outside

type Closer = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct CancelState {
    cancelled: bool,
    closer: Option<Closer>,
}

/// A message box that Node may cancel (`{cancel: id}`, Electron's `signal`): the box then closes as if the person
/// backed out, and the answer is `cancelId`. The OS code `arm`s it with what closes its box once the box exists and
/// `disarm`s it once the box returned; `cancel` comes from the host's reader thread at any moment, also before the
/// box exists (the box then closes as soon as it is armed) or after it returned (nothing happens).
#[derive(Default)]
pub struct DialogCancel {
    state: std::sync::Mutex<CancelState>,
}

impl DialogCancel {
    pub fn cancel(&self) {
        let closer = {
            let mut state = self.state.lock().unwrap();
            state.cancelled = true;
            state.closer.take()
        };
        if let Some(close) = closer {
            close();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.lock().unwrap().cancelled
    }

    /// The box is up and `close` closes it. Runs `close` at once when the box was cancelled already.
    pub fn arm(&self, close: impl FnOnce() + Send + 'static) {
        let mut state = self.state.lock().unwrap();
        if state.cancelled {
            drop(state);
            close();
        } else {
            state.closer = Some(Box::new(close));
        }
    }

    /// The box is gone: a later `cancel` closes nothing.
    pub fn disarm(&self) {
        self.state.lock().unwrap().closer = None;
    }
}

/// One modal session, for a close that can only be queued to the main thread (macOS `abortModal` ends whatever modal
/// session is running, not a given one). The session `end`s on the main thread right after its modal call returned; a
/// queued close runs on the main thread too and acts only while its own session is live, so a close that arrives late
/// never ends the next box's session.
#[derive(Clone)]
pub struct ModalSession(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl ModalSession {
    pub fn begin() -> Self {
        Self(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            true,
        )))
    }

    pub fn end(&self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Runs `abort` when this session is still live. Main thread only, as `end`.
    pub fn abort_if_live(&self, abort: impl FnOnce()) {
        if self.0.load(std::sync::atomic::Ordering::SeqCst) {
            abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(options: Value) -> MessageBoxSpec {
        MessageBoxSpec::from_json(&options)
    }

    #[test]
    fn a_cancel_closes_an_armed_box_once() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let closed = Arc::new(AtomicUsize::new(0));
        let cancel = DialogCancel::default();
        let count = closed.clone();
        cancel.arm(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(closed.load(Ordering::SeqCst), 0);
        cancel.cancel();
        cancel.cancel();
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn a_cancel_before_the_box_is_up_closes_it_when_armed() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        let cancel = DialogCancel::default();
        cancel.cancel();
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        cancel.arm(move || flag.store(true, Ordering::SeqCst));
        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn a_cancel_after_the_box_returned_closes_nothing() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        let cancel = DialogCancel::default();
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        cancel.arm(move || flag.store(true, Ordering::SeqCst));
        cancel.disarm();
        cancel.cancel();
        assert!(!closed.load(Ordering::SeqCst));
    }

    /// Two boxes in a row; the first one's cancel is queued but reaches the main thread only after that box returned
    /// and the next one is up: it must not end the second box's session.
    #[test]
    fn a_late_queued_close_never_ends_the_next_boxs_session() {
        let aborted = std::cell::Cell::new(Vec::<&str>::new());
        let abort = |which: &'static str| {
            let mut seen = aborted.take();
            seen.push(which);
            aborted.set(seen);
        };
        let mut main_queue: Vec<Box<dyn FnOnce() + '_>> = Vec::new();

        let first = ModalSession::begin();
        let queued = first.clone();
        main_queue.push(Box::new(move || queued.abort_if_live(|| abort("first"))));
        first.end();
        let second = ModalSession::begin();
        for job in main_queue.drain(..) {
            job();
        }
        assert!(
            aborted.take().is_empty(),
            "the late close ended the second box"
        );

        let queued = second.clone();
        main_queue.push(Box::new(move || queued.abort_if_live(|| abort("second"))));
        for job in main_queue.drain(..) {
            job();
        }
        second.end();
        assert_eq!(aborted.take(), vec!["second"]);
    }

    #[test]
    fn message_box_defaults() {
        let s = spec(json!({ "message": "Quit?" }));
        assert_eq!(s.buttons, vec!["OK"]);
        assert_eq!((s.default_id, s.cancel_id), (0, 0));
        assert_eq!(s.kind, MessageType::None);
        assert!(s.checkbox_label.is_none() && !s.no_link);
    }

    #[test]
    fn cancel_id_is_the_first_cancel_or_no_button_unless_given() {
        assert_eq!(
            spec(json!({ "buttons": ["Save", "Don't save", "Cancel"] })).cancel_id,
            2
        );
        assert_eq!(spec(json!({ "buttons": ["Yes", " no "] })).cancel_id, 1);
        assert_eq!(spec(json!({ "buttons": ["A", "B"] })).cancel_id, 0);
        assert_eq!(
            spec(json!({ "buttons": ["A", "B", "Cancel"], "cancelId": 1 })).cancel_id,
            1
        );
        // out of range ids are ignored
        assert_eq!(
            spec(json!({ "buttons": ["A", "B"], "cancelId": 9, "defaultId": -1 })).cancel_id,
            0
        );
        assert_eq!(
            spec(json!({ "buttons": ["A", "B"], "defaultId": 1 })).default_id,
            1
        );
    }

    #[test]
    fn plan_maps_system_named_buttons_to_common_buttons() {
        let s = spec(json!({ "buttons": ["Delete permanently", "Cancel"], "defaultId": 0 }));
        let plan = ButtonPlan::new(&s);
        assert_eq!(plan.common_flags, 0x8);
        assert_eq!(
            plan.custom,
            vec![(CUSTOM_BASE, "Delete permanently".to_string())]
        );
        assert_eq!(plan.default_button, CUSTOM_BASE);
        assert_eq!(plan.index_for(CUSTOM_BASE), 0);
        assert_eq!(plan.index_for(ID_CANCEL), 1);
        // The close box also answers IDCANCEL; an unknown id falls back to cancelId
        assert_eq!(plan.index_for(0), 1);
    }

    #[test]
    fn plan_without_cancel_button_answers_cancel_id_for_esc() {
        let s = spec(json!({ "buttons": ["Keep working", "Quit anyway"], "cancelId": 0 }));
        let plan = ButtonPlan::new(&s);
        assert_eq!(plan.common_flags, 0);
        assert_eq!(plan.index_for(ID_CANCEL), 0);
        assert_eq!(plan.index_for(CUSTOM_BASE + 1), 1);
    }

    #[test]
    fn no_link_makes_every_button_custom() {
        let s = spec(json!({ "buttons": ["OK", "Cancel"], "noLink": true, "defaultId": 1 }));
        let plan = ButtonPlan::new(&s);
        assert_eq!(plan.common_flags, 0);
        assert_eq!(plan.custom.len(), 2);
        assert_eq!(plan.default_button, CUSTOM_BASE + 1);
        assert_eq!(plan.index_for(ID_CANCEL), 1);
    }

    #[test]
    fn duplicate_system_labels_stay_distinct() {
        let s = spec(json!({ "buttons": ["OK", "ok"] }));
        let plan = ButtonPlan::new(&s);
        assert_eq!(plan.common_flags, 0x1);
        assert_eq!(plan.custom, vec![(CUSTOM_BASE + 1, "ok".to_string())]);
        assert_eq!(plan.index_for(ID_OK), 0);
        assert_eq!(plan.index_for(CUSTOM_BASE + 1), 1);
    }

    #[test]
    fn filters_become_windows_patterns() {
        assert_eq!(
            filter_pattern(&["png".into(), ".jpg".into(), "*.gif".into()]),
            "*.png;*.jpg;*.gif"
        );
        assert_eq!(filter_pattern(&["*".into()]), "*.*");
        assert_eq!(filter_pattern(&[]), "*.*");
    }

    #[test]
    fn filters_parse_with_names_and_default_extension() {
        let filters = parse_filters(&json!({ "filters": [
            { "name": "Images", "extensions": ["png", "jpg"] },
            { "name": "", "extensions": ["*"] },
        ] }));
        assert_eq!(
            filters[0],
            Filter {
                name: "Images".into(),
                pattern: "*.png;*.jpg".into(),
                extensions: vec!["png".into(), "jpg".into()]
            }
        );
        assert_eq!(filters[1].name, "*.*");
        assert_eq!(default_extension(&filters), Some("png"));
        assert_eq!(default_extension(&filters[1..]), None);
        assert_eq!(default_extension(&[]), None);
    }

    #[test]
    fn file_properties_are_read() {
        let s = FileDialogSpec::from_json(&json!({
            "title": "Pick", "defaultPath": "", "properties": ["openFile", "multiSelections", "showHiddenFiles", "dontAddToRecent"],
        }));
        assert_eq!(s.title.as_deref(), Some("Pick"));
        assert!(s.default_path.is_none());
        assert!(s.open_file && s.multi_selections && s.show_hidden && s.dont_add_to_recent);
        assert!(!s.open_directory && !s.prompt_to_create);
    }

    #[test]
    fn default_path_splits_folder_and_name() {
        let none = |_: &str| false;
        let dir = |p: &str| p == "C:\\Users\\me";
        assert_eq!(
            split_default_path("report.txt", none),
            DefaultPath {
                folder: None,
                name: Some("report.txt".into())
            }
        );
        assert_eq!(
            split_default_path("C:\\Users\\me\\report.txt", none),
            DefaultPath {
                folder: Some("C:\\Users\\me".into()),
                name: Some("report.txt".into())
            }
        );
        assert_eq!(
            split_default_path("C:\\Users\\me", dir),
            DefaultPath {
                folder: Some("C:\\Users\\me".into()),
                name: None
            }
        );
        assert_eq!(
            split_default_path("/tmp/out/", none),
            DefaultPath {
                folder: Some("/tmp/out/".into()),
                name: None
            }
        );
        assert_eq!(
            split_default_path("C:\\x.txt", none),
            DefaultPath {
                folder: Some("C:\\".into()),
                name: Some("x.txt".into())
            }
        );
        assert_eq!(split_default_path("  ", none), DefaultPath::default());
    }
}
