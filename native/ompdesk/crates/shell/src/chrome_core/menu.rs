//! The application menu and the text field's context menu (were `src/main/menu.ts` and `editable-context-menu.ts`):
//! the templates as menu items, what each item does when chosen, and the zoom steps. `modules/chrome/menu.rs` shows
//! them and carries the actions out; `captured/menu.json` holds the TypeScript's own templates and clicks.
//!
//! Item ids are this module's: `page:<action>` (a `chrome.menuAction` for the page), `window:new`, `window:close`,
//! `app:about`, `app:docs`, `role:<name>` (an Electron role the shell runs itself), `native:<role>` (a role the
//! platform's menu runs), and for the context menu `spell:<n>`, `spell:add`, `image:copy`.

use serde_json::{Value, json};

use crate::menu_model::{Item, Kind};

/// The text of `key` (with `{name}` placeholders filled from the pairs): `labels::label` in the shell, a captured
/// table in the tests. A function so the pure rules never hold text of their own.
pub type Text<'a> = &'a dyn Fn(&str, &[(&str, &str)]) -> String;

/// The chords of `src/shared/hotkeys.ts` `NATIVE_CHORDS` the menu shows, as Electron accelerators (Node sends them
/// with `chrome.menu`: the renderer shares that file, so it stays TypeScript).
#[derive(Clone, Debug, PartialEq)]
pub struct Accelerators {
    pub session_new: String,
    pub window_new: String,
    pub window_close: String,
    pub session_export_html: String,
}

impl Accelerators {
    /// `chrome.menu`'s data: `{sessionNew, windowNew, windowClose, sessionExportHtml}`.
    pub fn from_value(data: &Value) -> Option<Self> {
        let text = |key: &str| data.get(key)?.as_str().map(String::from);
        Some(Self {
            session_new: text("sessionNew")?,
            window_new: text("windowNew")?,
            window_close: text("windowClose")?,
            session_export_html: text("sessionExportHtml")?,
        })
    }
}

/// An Electron role the shell runs itself (the platform runs `services`, `hide`, … itself: those keep `Item::role`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Reload,
    ForceReload,
    ToggleDevTools,
    ResetZoom,
    ZoomIn,
    ZoomOut,
    ToggleFullScreen,
    Minimize,
    Quit,
}

const ROLES: [(Role, &str); 15] = [
    (Role::Undo, "undo"),
    (Role::Redo, "redo"),
    (Role::Cut, "cut"),
    (Role::Copy, "copy"),
    (Role::Paste, "paste"),
    (Role::SelectAll, "selectAll"),
    (Role::Reload, "reload"),
    (Role::ForceReload, "forceReload"),
    (Role::ToggleDevTools, "toggleDevTools"),
    (Role::ResetZoom, "resetZoom"),
    (Role::ZoomIn, "zoomIn"),
    (Role::ZoomOut, "zoomOut"),
    (Role::ToggleFullScreen, "togglefullscreen"),
    (Role::Minimize, "minimize"),
    (Role::Quit, "quit"),
];

impl Role {
    pub fn name(self) -> &'static str {
        ROLES
            .iter()
            .find(|(r, _)| *r == self)
            .map_or("", |(_, n)| n)
    }

    fn from_name(name: &str) -> Option<Self> {
        ROLES.iter().find(|(_, n)| *n == name).map(|(r, _)| *r)
    }

    /// The accelerator Electron gives the role (`MenuItem` of the shim's `ROLES`).
    fn accelerator(self, mac: bool) -> Option<&'static str> {
        Some(match self {
            Role::Undo => "CommandOrControl+Z",
            Role::Redo if mac => "Shift+CommandOrControl+Z",
            Role::Redo => "Control+Y",
            Role::Cut => "CommandOrControl+X",
            Role::Copy => "CommandOrControl+C",
            Role::Paste => "CommandOrControl+V",
            Role::SelectAll => "CommandOrControl+A",
            Role::Reload => "CommandOrControl+R",
            Role::ForceReload => "Shift+CommandOrControl+R",
            Role::ToggleDevTools if mac => "Alt+Command+I",
            Role::ToggleDevTools => "Control+Shift+I",
            Role::ResetZoom => "CommandOrControl+0",
            Role::ZoomIn => "CommandOrControl+Plus",
            Role::ZoomOut => "CommandOrControl+-",
            Role::ToggleFullScreen if mac => "Control+Command+F",
            Role::ToggleFullScreen => "F11",
            Role::Minimize => "CommandOrControl+M",
            Role::Quit if mac => "Command+Q",
            Role::Quit => return None,
        })
    }
}

/// `webContents.setZoomFactor(Math.min(5, factor * 1.2))` of the View menu's Zoom In.
pub fn zoom_in(factor: f64) -> f64 {
    (factor * 1.2).min(5.0)
}

/// `Math.max(0.25, factor / 1.2)`: Zoom Out.
pub fn zoom_out(factor: f64) -> f64 {
    (factor / 1.2).max(0.25)
}

fn item(id: &str, label: String) -> Item {
    Item {
        id: id.to_string(),
        label,
        kind: Kind::Normal,
        enabled: true,
        visible: true,
        checked: false,
        accelerator: None,
        sublabel: None,
        tool_tip: None,
        role: None,
        submenu: Vec::new(),
    }
}

fn separator() -> Item {
    Item {
        kind: Kind::Separator,
        ..item("", String::new())
    }
}

fn submenu(label: String, items: Vec<Item>) -> Item {
    Item {
        kind: Kind::Submenu,
        submenu: items,
        ..item("", label)
    }
}

fn page(action: &str, label: String) -> Item {
    item(&format!("page:{action}"), label)
}

fn with_accelerator(mut item: Item, accelerator: &str) -> Item {
    item.accelerator = Some(accelerator.to_string());
    item
}

/// A role the platform's menu runs itself (macOS `about`, `services`, `hide`, `hideOthers`, `unhide`, `zoom`, `front`).
fn native(role: &str, label: String) -> Item {
    Item {
        role: Some(role.to_string()),
        ..item(&format!("native:{role}"), label)
    }
}

fn role_item(role: Role, label: String, mac: bool) -> Item {
    Item {
        accelerator: role.accelerator(mac).map(String::from),
        ..item(&format!("role:{}", role.name()), label)
    }
}

/// The native edit items, shared by the Edit menu and a text field's context menu.
pub fn edit_role_items(text: Text, mac: bool) -> Vec<Item> {
    let t = |key: &str| text(key, &[]);
    vec![
        role_item(Role::Undo, t("menu.undo"), mac),
        role_item(Role::Redo, t("menu.redo"), mac),
        separator(),
        role_item(Role::Cut, t("menu.cut"), mac),
        role_item(Role::Copy, t("menu.copy"), mac),
        role_item(Role::Paste, t("menu.paste"), mac),
        role_item(Role::SelectAll, t("menu.selectAll"), mac),
    ]
}

/// The whole application menu for the platform. Chord rule (kept from `menu.ts`): a shortcut the renderer keymap owns
/// must NOT also be a menu accelerator. A menu accelerator is resolved before the keydown reaches the page, so the
/// duplicate would fire while the user's remap of the same action stayed dead. Menu-only chords come from
/// `shared/hotkeys.ts` (`accelerators`), which the keymap reads as reserved; every item below without one is on
/// purpose (⌘, ⌘T ⇧⌘T ⌘B ⌘J ⌘W belong to the keymap; ⌘⇧O to the window-toggle global shortcut, which would otherwise
/// fire twice on macOS and be swallowed on Windows).
pub fn application_template(
    mac: bool,
    app_name: &str,
    text: Text,
    accelerators: &Accelerators,
) -> Vec<Item> {
    let t = |key: &str| text(key, &[]);
    let mut menus = Vec::new();
    if mac {
        menus.push(submenu(
            app_name.to_string(),
            vec![
                native("about", t("menu.about")),
                page("check-updates", t("menu.checkUpdates")),
                separator(),
                page("open-settings", t("menu.settings")),
                separator(),
                native("services", t("menu.services")),
                separator(),
                native("hide", t("menu.hide")),
                native("hideOthers", t("menu.hideOthers")),
                native("unhide", t("menu.showAll")),
                separator(),
                role_item(Role::Quit, t("menu.quit"), mac),
            ],
        ));
    }
    let mut file = vec![
        page("open-project", t("menu.openProject")),
        separator(),
        with_accelerator(
            page("new-session", t("menu.newSession")),
            &accelerators.session_new,
        ),
        page("new-tab", t("menu.newTab")),
        page("new-chat-tab", t("menu.newChatTab")),
        with_accelerator(
            item("window:new", t("menu.newWindow")),
            &accelerators.window_new,
        ),
    ];
    if !mac {
        file.push(separator());
        file.push(page("open-settings", t("menu.settings")));
    }
    menus.push(submenu(t("menu.file"), file));
    menus.push(submenu(t("menu.edit"), edit_role_items(text, mac)));
    menus.push(submenu(
        t("menu.view"),
        vec![
            page("open-command-center", t("menu.commandCenter")),
            page("open-context-report", t("menu.contextReport")),
            page("open-stats", t("menu.stats")),
            page("open-jobs", t("menu.jobs")),
            page("open-hotkeys", t("menu.hotkeys")),
            separator(),
            page("toggle-sidebar", t("menu.toggleSidebar")),
            page("toggle-panel", t("menu.togglePanel")),
            separator(),
            role_item(Role::Reload, t("menu.reload"), mac),
            role_item(Role::ForceReload, t("menu.forceReload"), mac),
            role_item(Role::ToggleDevTools, t("menu.toggleDevTools"), mac),
            separator(),
            role_item(Role::ResetZoom, t("menu.actualSize"), mac),
            role_item(Role::ZoomIn, t("menu.zoomIn"), mac),
            role_item(Role::ZoomOut, t("menu.zoomOut"), mac),
            separator(),
            role_item(Role::ToggleFullScreen, t("menu.toggleFullScreen"), mac),
        ],
    ));
    // The macOS habit this serves: ⌘W closes a TAB, ⇧⌘W closes the window. A window-level `close` role in File would
    // make the first ⌘W kill the whole window, every tab and sidecar in it.
    let mut window = vec![
        page("close-tab", t("menu.closeTab")),
        with_accelerator(
            item("window:close", t("menu.closeWindow")),
            &accelerators.window_close,
        ),
        separator(),
        role_item(Role::Minimize, t("menu.minimize"), mac),
    ];
    if mac {
        window.push(native("zoom", t("menu.zoom")));
        window.push(separator());
        window.push(native("front", t("menu.bringAllToFront")));
    }
    menus.push(submenu(t("menu.window"), window));
    menus.push(submenu(
        t("menu.session"),
        vec![
            page("open-import", t("menu.importSession")),
            page("open-branch-picker", t("menu.branchPicker")),
            page("open-session-tree", t("menu.sessionTree")),
            separator(),
            page("open-session-info", t("menu.sessionInfo")),
            page("open-share-session", t("menu.shareSession")),
            with_accelerator(
                page("export-html", t("menu.exportHtml")),
                &accelerators.session_export_html,
            ),
            page("handoff", t("menu.handoff")),
        ],
    ));
    menus.push(submenu(
        t("menu.tools"),
        vec![
            page("open-agent-hub", t("menu.agentHub")),
            page("open-modes", t("menu.modes")),
            page("open-providers", t("menu.providers")),
            page("open-model-roles", t("menu.modelRoles")),
            page("open-model-picker", t("menu.modelPicker")),
            page("open-capabilities", t("menu.capabilities")),
            page("open-usage", t("menu.usage")),
            separator(),
            page("open-extensions", t("menu.extensions")),
            page("open-inventory", t("menu.inventory")),
            page("open-pr-center", t("menu.prCenter")),
            page("open-workspace-dirs", t("menu.workspaceDirs")),
            page("open-git", t("menu.workspaceChanges")),
            page("restart-sidecar", t("menu.restartCore")),
            separator(),
            page("open-debug", t("menu.debugConsole")),
        ],
    ));
    let mut help = vec![item("app:about", t("menu.about"))];
    // macOS has it in the app menu; Windows has no app menu.
    if !mac {
        help.push(page("check-updates", t("menu.checkUpdates")));
    }
    help.push(page("open-feedback", t("menu.reportIssue")));
    help.push(item("app:docs", t("menu.documentation")));
    menus.push(submenu(t("menu.help"), help));
    menus
}

/// The page the Documentation item opens.
pub const DOCUMENTATION_URL: &str = "https://github.com/SeuPut0705/ompdesk";

/// What choosing an item of the application menu does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// `chrome.menuAction` to the target window (a window is opened first when none is).
    Page(String),
    /// A window in the target window's project.
    NewWindow,
    CloseWindow,
    About,
    Documentation,
    Role(Role),
}

/// The action of the application menu's item `id`; `None` for a role the platform runs itself.
pub fn action_of(id: &str) -> Option<Action> {
    if let Some(action) = id.strip_prefix("page:") {
        return Some(Action::Page(action.to_string()));
    }
    if let Some(name) = id.strip_prefix("role:") {
        return Role::from_name(name).map(Action::Role);
    }
    match id {
        "window:new" => Some(Action::NewWindow),
        "window:close" => Some(Action::CloseWindow),
        "app:about" => Some(Action::About),
        "app:docs" => Some(Action::Documentation),
        _ => None,
    }
}

/// `ContextMenuParams` as far as the menu reads them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContextParams {
    pub is_editable: bool,
    pub misspelled_word: String,
    pub suggestions: Vec<String>,
    pub image: bool,
    pub x: f64,
    pub y: f64,
}

impl ContextParams {
    /// Electron's `context-menu` details (PROTOCOL.md §4). `image` is `mediaType === "image" && hasImageContents`.
    pub fn from_value(params: &Value) -> Self {
        let flag = |key: &str| params.get(key).and_then(Value::as_bool).unwrap_or(false);
        Self {
            is_editable: flag("isEditable"),
            misspelled_word: params
                .get("misspelledWord")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            suggestions: params
                .get("dictionarySuggestions")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            image: params.get("mediaType").and_then(Value::as_str) == Some("image")
                && flag("hasImageContents"),
            x: params.get("x").and_then(Value::as_f64).unwrap_or(0.0),
            y: params.get("y").and_then(Value::as_f64).unwrap_or(0.0),
        }
    }

    /// `[...new Set(suggestions)].slice(0, 5)`: the replacements offered, first occurrence first.
    pub fn offered(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for suggestion in &self.suggestions {
            if !out.contains(&suggestion.as_str()) {
                out.push(suggestion);
            }
        }
        out.truncate(5);
        out
    }
}

/// Native edit menu with the platform spellchecker's suggestions for editable fields; on an image (a reply's picture,
/// an attachment preview) a "Copy image" item. Anything else gets no native menu.
pub fn context_template(params: &ContextParams, text: Text, mac: bool) -> Vec<Item> {
    if !params.is_editable {
        if !params.image {
            return Vec::new();
        }
        return vec![item("image:copy", text("menu.copyImage", &[]))];
    }
    let mut items: Vec<Item> = params
        .offered()
        .into_iter()
        .enumerate()
        .map(|(n, suggestion)| item(&format!("spell:{n}"), suggestion.to_string()))
        .collect();
    if !params.misspelled_word.is_empty() {
        items.push(item("spell:add", text("menu.addToDictionary", &[])));
    }
    if !items.is_empty() {
        items.push(separator());
    }
    items.extend(edit_role_items(text, mac));
    items
}

/// What choosing an item of the context menu does.
#[derive(Clone, Debug, PartialEq)]
pub enum ContextAction {
    ReplaceMisspelling(String),
    AddToDictionary(String),
    CopyImageAt(f64, f64),
    Role(Role),
}

pub fn context_action(params: &ContextParams, id: &str) -> Option<ContextAction> {
    if let Some(n) = id.strip_prefix("spell:") {
        if n == "add" {
            return Some(ContextAction::AddToDictionary(
                params.misspelled_word.clone(),
            ));
        }
        let n: usize = n.parse().ok()?;
        return params
            .offered()
            .get(n)
            .map(|s| ContextAction::ReplaceMisspelling(s.to_string()));
    }
    if id == "image:copy" {
        return Some(ContextAction::CopyImageAt(params.x, params.y));
    }
    id.strip_prefix("role:")
        .and_then(Role::from_name)
        .map(ContextAction::Role)
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Normal => "normal",
        Kind::Separator => "separator",
        Kind::Submenu => "submenu",
        Kind::Checkbox => "checkbox",
        Kind::Radio => "radio",
    }
}

/// The items as the wire's `MenuItem[]` (PROTOCOL.md §7), for `chrome.menuProbe`.
pub fn to_wire(items: &[Item]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| {
                let mut wire = json!({
                    "id": item.id, "label": item.label, "type": kind_name(item.kind),
                    "enabled": item.enabled, "visible": item.visible, "checked": item.checked,
                });
                if let Some(accelerator) = &item.accelerator {
                    wire["accelerator"] = json!(accelerator);
                }
                if let Some(role) = &item.role {
                    wire["role"] = json!(role);
                }
                if item.kind == Kind::Submenu {
                    wire["submenu"] = to_wire(&item.submenu);
                }
                wire
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::chrome_core::captured::{of, steps};
    use crate::menu_model::parse_template;

    /// `NATIVE_CHORDS`' accelerators as of the capture.
    fn accelerators() -> Accelerators {
        Accelerators {
            session_new: "CmdOrCtrl+N".into(),
            window_new: "CmdOrCtrl+Shift+N".into(),
            window_close: "CmdOrCtrl+Shift+W".into(),
            session_export_html: "CmdOrCtrl+E".into(),
        }
    }

    /// The label tables the capture recorded (`src/main/i18n-text.ts` and `tray-labels.ts` in each language).
    fn tables() -> HashMap<String, HashMap<String, String>> {
        let step = &of("menu", "src/main/i18n-text.ts#labels")[0];
        serde_json::from_value(step.output.clone()).expect("a table per language")
    }

    fn text_of(table: &HashMap<String, String>) -> impl Fn(&str, &[(&str, &str)]) -> String + '_ {
        |key, params| {
            crate::labels::fill(
                table.get(key).unwrap_or_else(|| panic!("no label {key}")),
                params,
            )
        }
    }

    fn blank_ids(items: &mut [Item]) {
        for item in items {
            item.id.clear();
            blank_ids(&mut item.submenu);
        }
    }

    fn captured_items(wire: &Value) -> Vec<Item> {
        let mut items = parse_template(wire).expect("the captured template parses");
        blank_ids(&mut items);
        items
    }

    #[test]
    fn the_application_menu_is_the_typescripts_for_each_platform_and_language() {
        let tables = tables();
        let created = of("menu", "src/main/menu.ts#createMenu");
        assert_eq!(created.len(), 4);
        for step in created {
            let mac = step.input["platform"] == "darwin";
            let language = step.input["language"].as_str().unwrap();
            let table = &tables[language];
            let text = text_of(table);
            let app = step.output["appName"].as_str().unwrap();
            let mut mine = application_template(mac, app, &text, &accelerators());
            blank_ids(&mut mine);
            let captured = captured_items(&step.output["template"]);
            assert_eq!(mine.len(), captured.len(), "{}", step.input);
            for (mine, captured) in mine.iter().zip(&captured) {
                assert_eq!(mine, captured, "{}", step.input);
            }
        }
    }

    /// What a captured click did, as the facts the shell must reproduce: `page:<action>`, `spawn:<cwd>`, `wc.op:<op>`.
    fn signature(output: &Value) -> Vec<String> {
        let mut out = Vec::new();
        for cwd in output["spawned"].as_array().into_iter().flatten() {
            out.push(format!("spawn:{}", cwd.as_str().unwrap_or("")));
        }
        for frame in output["frames"].as_array().into_iter().flatten() {
            let params = &frame["params"];
            match frame["method"].as_str().unwrap() {
                "wc.send" => {
                    assert_eq!(params["channel"], "menu:action");
                    out.push(format!(
                        "page:{}",
                        params["args"][0]["action"].as_str().unwrap()
                    ));
                }
                "wc.op" => out.push(format!("wc.op:{}", params["op"].as_str().unwrap())),
                "win.op" => out.push(format!("win.op:{}", params["op"].as_str().unwrap())),
                "win.create" => {}
                "app.showAboutPanel" => out.push("about".into()),
                "shell.openExternal" => {
                    out.push(format!("open:{}", params["url"].as_str().unwrap()))
                }
                other => panic!("an unexpected frame {other}"),
            }
        }
        out
    }

    /// The same facts from an action of ours (the capture's window sat in `/work/project`).
    fn expected(action: &Action) -> Vec<String> {
        vec![match action {
            Action::Page(page) => format!("page:{page}"),
            Action::NewWindow => "spawn:/work/project".into(),
            Action::CloseWindow => "win.op:close".into(),
            Action::About => "about".into(),
            Action::Documentation => format!("open:{DOCUMENTATION_URL}"),
            // The shim's quit closes every window first; the shell's own is `quit::quit`.
            Action::Role(Role::Quit) => "win.op:close".into(),
            Action::Role(Role::Reload) => "wc.op:reload".into(),
            Action::Role(Role::ForceReload) => "wc.op:reloadIgnoringCache".into(),
            Action::Role(Role::ToggleDevTools) => "wc.op:openDevTools".into(),
            Action::Role(Role::ResetZoom | Role::ZoomIn | Role::ZoomOut) => {
                "wc.op:setZoomFactor".into()
            }
            Action::Role(Role::ToggleFullScreen) => "win.op:setFullScreen".into(),
            Action::Role(Role::Minimize) => "win.op:minimize".into(),
            Action::Role(role) => format!("wc.op:{}", role.name()),
        }]
    }

    #[test]
    fn every_item_does_what_it_did() {
        let tables = tables();
        let clicks = of("menu", "src/main/menu.ts#click");
        assert!(clicks.len() > 200);
        for step in clicks {
            let mac = step.input["platform"] == "darwin";
            let language = step.input["language"].as_str().unwrap();
            let text = text_of(&tables[language]);
            let template = application_template(mac, "ompdesk", &text, &accelerators());
            let at = &step.input["at"];
            let found = &template[at[0].as_u64().unwrap() as usize].submenu
                [at[1].as_u64().unwrap() as usize];
            assert_eq!(
                found.label,
                step.input["label"].as_str().unwrap(),
                "{}",
                step.input
            );
            if let Some(role) = step.output.get("native") {
                assert_eq!(found.role.as_deref(), role.as_str(), "{}", step.input);
                assert_eq!(action_of(&found.id), None);
            } else {
                let action =
                    action_of(&found.id).unwrap_or_else(|| panic!("{}: no action", step.input));
                assert_eq!(expected(&action), signature(&step.output), "{}", step.input);
            }
        }
    }

    #[test]
    fn an_item_pressed_with_no_window_opens_one_and_waits_for_its_first_paint() {
        for step in of("menu", "src/main/menu.ts#noWindow") {
            assert_eq!(step.output["spawned"], json!([null]));
            assert_eq!(
                signature(&json!({ "frames": step.output["after"], "spawned": [] })),
                vec!["page:open-settings".to_string()]
            );
        }
    }

    #[test]
    fn every_item_has_an_action_or_a_native_role() {
        let text = |key: &str, _: &[(&str, &str)]| key.to_string();
        for mac in [true, false] {
            let template = application_template(mac, "x", &text, &accelerators());
            for menu in &template {
                for item in &menu.submenu {
                    if item.kind == Kind::Separator {
                        continue;
                    }
                    assert!(
                        item.role.is_some() != action_of(&item.id).is_some(),
                        "{}",
                        item.id
                    );
                    assert!(!item.label.is_empty());
                }
            }
        }
    }

    #[test]
    fn zoom_steps_are_the_typescripts() {
        assert_eq!(zoom_in(1.0), 1.2);
        assert_eq!(zoom_in(4.5), 5.0);
        assert_eq!(zoom_out(1.2), 1.0);
        assert!((zoom_out(1.0) - 1.0 / 1.2).abs() < 1e-12);
        assert_eq!(zoom_out(0.25), 0.25);
    }

    fn params(value: &Value) -> ContextParams {
        ContextParams::from_value(value)
    }

    /// What a captured context-menu click called, as `[kind, argument]`.
    fn call_of(action: &ContextAction) -> Value {
        match action {
            ContextAction::ReplaceMisspelling(s) => json!({ "replaceMisspelling": s }),
            ContextAction::AddToDictionary(w) => json!({ "addToDictionary": w }),
            // JSON has no 40.0: a whole number is the integer the page sent.
            ContextAction::CopyImageAt(x, y) => {
                let num = |n: f64| {
                    if n.fract() == 0.0 {
                        json!(n as i64)
                    } else {
                        json!(n)
                    }
                };
                json!({ "copyImageAt": [num(*x), num(*y)] })
            }
            ContextAction::Role(_) => unreachable!("roles have no click handler of their own"),
        }
    }

    #[test]
    fn the_context_menu_is_the_typescripts_for_every_kind_of_click() {
        let tables = tables();
        let cases = of(
            "menu",
            "src/main/editable-context-menu.ts#editableContextMenuTemplate",
        );
        assert_eq!(cases.len(), 48);
        for step in cases {
            let mac = step.input["platform"] == "darwin";
            let language = step.input["language"].as_str().unwrap();
            let text = text_of(&tables[language]);
            let p = params(&step.input["params"]);
            let mut mine = context_template(&p, &text, mac);
            let template = mine.clone();
            blank_ids(&mut mine);
            assert_eq!(
                mine,
                captured_items(&step.output["template"]),
                "{}",
                step.input
            );
            // The items the TypeScript gave a click handler: spellings, the dictionary, the image.
            let clicks = step.output["clicks"].as_array().unwrap();
            let mine: Vec<Value> = template
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    let action = context_action(&p, &item.id)?;
                    (!matches!(action, ContextAction::Role(_)))
                        .then(|| json!({ "index": index, "calls": [call_of(&action)] }))
                })
                .collect();
            assert_eq!(&mine, clicks, "{}", step.input);
        }
    }

    #[test]
    fn every_role_item_is_named_in_the_ui_language() {
        // native-labels.test.ts: no role item without a label of the UI language.
        let text = |key: &str, _: &[(&str, &str)]| key.to_string();
        for mac in [true, false] {
            for item in application_template(mac, "x", &text, &accelerators())
                .iter()
                .flat_map(|menu| &menu.submenu)
                .chain(&edit_role_items(&text, mac))
            {
                if item.kind != Kind::Separator {
                    assert!(
                        item.label.starts_with("menu.") || item.label == "x",
                        "{}",
                        item.id
                    );
                }
            }
        }
    }

    #[test]
    fn captured_steps_exist_for_both_platforms() {
        let all = steps("menu");
        for platform in ["darwin", "win32"] {
            assert!(all.iter().any(|s| s.input["platform"] == platform));
        }
    }

    #[test]
    fn the_wire_form_round_trips_through_the_parser() {
        let text = |key: &str, _: &[(&str, &str)]| key.to_string();
        for mac in [true, false] {
            let template = application_template(mac, "x", &text, &accelerators());
            assert_eq!(parse_template(&to_wire(&template)).unwrap(), template);
        }
    }
}
