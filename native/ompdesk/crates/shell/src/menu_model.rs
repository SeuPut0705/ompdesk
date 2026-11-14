//! Menu templates (PROTOCOL.md §7) as the shell walks them: parsed once, then turned into what a platform's popup
//! needs (visible items only, separators tidied, a command number per clickable item) or into the accelerator
//! bindings the application menu installs. Pure: the Win32 / AppKit code takes these types.

use serde_json::Value;

use crate::accelerator::{self, Accelerator, Mods};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Normal,
    Separator,
    Submenu,
    Checkbox,
    Radio,
}

/// One `MenuItem` of the wire.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub enabled: bool,
    pub visible: bool,
    pub checked: bool,
    pub accelerator: Option<String>,
    pub sublabel: Option<String>,
    pub tool_tip: Option<String>,
    pub role: Option<String>,
    pub submenu: Vec<Item>,
}

/// A template: `MenuItem[]`. Anything that is not the documented shape is an error that names what is wrong.
pub fn parse_template(value: &Value) -> Result<Vec<Item>, String> {
    let Some(items) = value.as_array() else {
        return Err("a menu template is an array of items".into());
    };
    items.iter().map(parse_item).collect()
}

fn parse_item(value: &Value) -> Result<Item, String> {
    let Some(object) = value.as_object() else {
        return Err("a menu item is an object".into());
    };
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(String::from);
    let flag =
        |key: &str, default: bool| object.get(key).and_then(Value::as_bool).unwrap_or(default);
    let submenu = match object.get("submenu") {
        None | Some(Value::Null) => Vec::new(),
        Some(inner) => parse_template(inner)?,
    };
    let has_submenu = matches!(object.get("submenu"), Some(Value::Array(_)));
    let id = text("id").unwrap_or_default();
    let kind = match object.get("type").and_then(Value::as_str) {
        Some("separator") => Kind::Separator,
        Some("checkbox") => Kind::Checkbox,
        Some("radio") => Kind::Radio,
        Some("submenu") => Kind::Submenu,
        Some("normal") | None => {
            if has_submenu {
                Kind::Submenu
            } else {
                Kind::Normal
            }
        }
        Some(other) => {
            return Err(format!(
                "menu item \"{id}\" has the unknown type \"{other}\""
            ));
        }
    };
    Ok(Item {
        id,
        label: text("label").unwrap_or_default(),
        kind,
        enabled: flag("enabled", true),
        visible: flag("visible", true),
        checked: flag("checked", false),
        accelerator: text("accelerator").filter(|a| !a.is_empty()),
        sublabel: text("sublabel").filter(|s| !s.is_empty()),
        tool_tip: text("toolTip").filter(|s| !s.is_empty()),
        role: text("role").filter(|s| !s.is_empty()),
        submenu,
    })
}

/// The check mark an item shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    None,
    Checkbox(bool),
    Radio(bool),
}

/// A clickable entry of a popup: `cmd` is the number the platform's menu reports (1-based, unique in one popup).
#[derive(Clone, Debug, PartialEq)]
pub struct ItemEntry {
    pub cmd: u32,
    pub label: String,
    pub accelerator: Option<Accelerator>,
    pub enabled: bool,
    pub mark: Mark,
    pub sublabel: Option<String>,
    pub tool_tip: Option<String>,
    pub role: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Separator,
    Item(ItemEntry),
    Submenu {
        label: String,
        enabled: bool,
        role: Option<String>,
        entries: Vec<Entry>,
    },
}

/// A template ready to be shown: the entries and, at index `cmd - 1`, the wire id of each command.
#[derive(Clone, Debug, PartialEq)]
pub struct Popup {
    pub entries: Vec<Entry>,
    pub ids: Vec<String>,
}

impl Popup {
    pub fn id_of(&self, cmd: u32) -> Option<&str> {
        let index = usize::try_from(cmd).ok()?.checked_sub(1)?;
        self.ids.get(index).map(String::as_str)
    }
}

/// Visible items only; separators that would lead, trail or repeat are dropped; accelerators are parsed for `mac`
/// (an invalid one is not shown, as Electron does not show what it cannot parse).
pub fn build_popup(items: &[Item], mac: bool) -> Popup {
    let mut ids = Vec::new();
    let entries = build_entries(items, mac, &mut ids);
    Popup { entries, ids }
}

fn build_entries(items: &[Item], mac: bool, ids: &mut Vec<String>) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::with_capacity(items.len());
    for item in items.iter().filter(|i| i.visible) {
        match item.kind {
            Kind::Separator => {
                if !matches!(entries.last(), None | Some(Entry::Separator)) {
                    entries.push(Entry::Separator);
                }
            }
            Kind::Submenu => {
                let inner = build_entries(&item.submenu, mac, ids);
                entries.push(Entry::Submenu {
                    label: item.label.clone(),
                    enabled: item.enabled,
                    role: item.role.clone(),
                    entries: inner,
                });
            }
            Kind::Normal | Kind::Checkbox | Kind::Radio => {
                ids.push(item.id.clone());
                let cmd = u32::try_from(ids.len()).unwrap_or(u32::MAX);
                let mark = match item.kind {
                    Kind::Checkbox => Mark::Checkbox(item.checked),
                    Kind::Radio => Mark::Radio(item.checked),
                    _ => Mark::None,
                };
                entries.push(Entry::Item(ItemEntry {
                    cmd,
                    label: item.label.clone(),
                    accelerator: item
                        .accelerator
                        .as_deref()
                        .and_then(|a| accelerator::parse(a, mac).ok()),
                    enabled: item.enabled,
                    mark,
                    sublabel: item.sublabel.clone(),
                    tool_tip: item.tool_tip.clone(),
                    role: item.role.clone(),
                }));
            }
        }
    }
    while matches!(entries.last(), Some(Entry::Separator)) {
        entries.pop();
    }
    entries
}

/// `label` as a Windows menu draws it: a literal `&` is doubled so it is not taken for a mnemonic.
pub fn escape_mnemonics(label: &str) -> String {
    label.replace('&', "&&")
}

/// An accelerator of the application menu. Items that are hidden still fire, as in Electron.
#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub accelerator: Accelerator,
    pub id: String,
    pub enabled: bool,
    pub kind: Kind,
    pub checked: bool,
}

pub fn collect_bindings(items: &[Item], mac: bool, out: &mut Vec<Binding>) {
    for item in items {
        match item.kind {
            Kind::Separator => {}
            Kind::Submenu => collect_bindings(&item.submenu, mac, out),
            Kind::Normal | Kind::Checkbox | Kind::Radio => {
                if let Some(accelerator) = item
                    .accelerator
                    .as_deref()
                    .and_then(|a| accelerator::parse(a, mac).ok())
                {
                    out.push(Binding {
                        accelerator,
                        id: item.id.clone(),
                        enabled: item.enabled,
                        kind: item.kind,
                        checked: item.checked,
                    });
                }
            }
        }
    }
}

/// What an application-menu accelerator (or a macOS menu click) did: the item to report and, for a checkbox or radio,
/// its new state.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub id: String,
    pub checked: Option<bool>,
}

/// The first enabled binding that is this key press.
pub fn find_binding(bindings: &[Binding], vk: u16, held: Mods) -> Option<usize> {
    bindings
        .iter()
        .position(|b| b.enabled && b.accelerator.matches(vk, held))
}

/// What a click on item `id` of `items` did to its own state, as the shell must remember it: a checkbox flipped
/// (`Some(Some(new state))`), a radio became the checked one of its consecutive group (`Some(Some(true))`), another
/// item changed nothing (`Some(None)`); `None` when no item has that id.
pub fn activate(items: &mut [Item], id: &str) -> Option<Option<bool>> {
    if let Some(index) = items
        .iter()
        .position(|i| i.id == id && i.kind != Kind::Separator && i.kind != Kind::Submenu)
    {
        return Some(match items[index].kind {
            Kind::Checkbox => {
                items[index].checked = !items[index].checked;
                Some(items[index].checked)
            }
            Kind::Radio => {
                let mut start = index;
                while start > 0 && items[start - 1].kind == Kind::Radio {
                    start -= 1;
                }
                let mut end = index;
                while end + 1 < items.len() && items[end + 1].kind == Kind::Radio {
                    end += 1;
                }
                for (i, item) in items[start..=end].iter_mut().enumerate() {
                    item.checked = start + i == index;
                }
                Some(true)
            }
            _ => None,
        });
    }
    items
        .iter_mut()
        .find_map(|item| activate(&mut item.submenu, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> Vec<Item> {
        parse_template(&value).unwrap()
    }

    #[test]
    fn a_template_is_read_with_its_defaults() {
        let items = parse(json!([
            { "id": "i1", "label": "Open", "accelerator": "CmdOrCtrl+O" },
            { "id": "i2", "type": "separator" },
            { "id": "i3", "label": "More", "submenu": [{ "id": "i4", "label": "Inner", "type": "checkbox", "checked": true, "enabled": false }] },
            { "id": "i5", "label": "Hidden", "visible": false, "toolTip": "t", "sublabel": "s", "role": "zoom" },
        ]));
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].kind, Kind::Normal);
        assert!(items[0].enabled && items[0].visible && !items[0].checked);
        assert_eq!(items[1].kind, Kind::Separator);
        assert_eq!(items[2].kind, Kind::Submenu);
        assert_eq!(items[2].submenu[0].kind, Kind::Checkbox);
        assert!(items[2].submenu[0].checked && !items[2].submenu[0].enabled);
        assert!(!items[3].visible);
        assert_eq!(items[3].tool_tip.as_deref(), Some("t"));
        assert_eq!(items[3].sublabel.as_deref(), Some("s"));
        assert_eq!(items[3].role.as_deref(), Some("zoom"));
    }

    #[test]
    fn a_wrong_shape_is_an_error() {
        assert!(parse_template(&json!({ "id": "x" })).is_err());
        assert!(parse_template(&json!(["x"])).is_err());
        assert!(parse_template(&json!([{ "id": "x", "type": "fancy" }])).is_err());
    }

    fn item(id: &str, kind: Kind) -> Item {
        Item {
            id: id.into(),
            label: id.into(),
            kind,
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

    #[test]
    fn a_popup_numbers_the_clickable_items_depth_first() {
        let mut more = item("more", Kind::Submenu);
        more.submenu = vec![item("a", Kind::Normal), item("b", Kind::Normal)];
        let popup = build_popup(
            &[
                item("first", Kind::Normal),
                more,
                item("last", Kind::Normal),
            ],
            false,
        );
        assert_eq!(popup.ids, ["first", "a", "b", "last"]);
        assert_eq!(popup.id_of(1), Some("first"));
        assert_eq!(popup.id_of(3), Some("b"));
        assert_eq!(popup.id_of(0), None);
        assert_eq!(popup.id_of(5), None);
        let Entry::Submenu { entries, .. } = &popup.entries[1] else {
            panic!("a submenu")
        };
        let Entry::Item(b) = &entries[1] else {
            panic!("an item")
        };
        assert_eq!(b.cmd, 3);
    }

    #[test]
    fn a_popup_drops_hidden_items_and_tidies_separators() {
        let mut hidden = item("hidden", Kind::Normal);
        hidden.visible = false;
        let popup = build_popup(
            &[
                item("s0", Kind::Separator),
                item("a", Kind::Normal),
                item("s1", Kind::Separator),
                hidden,
                item("s2", Kind::Separator),
                item("b", Kind::Normal),
                item("s3", Kind::Separator),
            ],
            false,
        );
        assert_eq!(popup.ids, ["a", "b"]);
        assert_eq!(popup.entries.len(), 3);
        assert!(matches!(popup.entries[1], Entry::Separator));
        assert!(!matches!(popup.entries.last(), Some(Entry::Separator)));
    }

    #[test]
    fn marks_accelerators_and_disabled_items_reach_the_entries() {
        let mut check = item("c", Kind::Checkbox);
        check.checked = true;
        let mut radio = item("r", Kind::Radio);
        radio.accelerator = Some("Ctrl+Shift+K".into());
        radio.enabled = false;
        let mut bad = item("bad", Kind::Normal);
        bad.accelerator = Some("Ctrl+Hyper+K".into());
        let popup = build_popup(&[check, radio, bad], false);
        let entry = |i: usize| match &popup.entries[i] {
            Entry::Item(e) => e.clone(),
            _ => panic!("an item"),
        };
        assert_eq!(entry(0).mark, Mark::Checkbox(true));
        assert_eq!(entry(1).mark, Mark::Radio(false));
        assert!(!entry(1).enabled);
        assert_eq!(entry(1).accelerator.unwrap().display(), "Ctrl+Shift+K");
        assert_eq!(entry(2).accelerator, None);
    }

    #[test]
    fn mnemonic_markers_are_escaped() {
        assert_eq!(escape_mnemonics("Save & Close"), "Save && Close");
        assert_eq!(escape_mnemonics("Plain"), "Plain");
    }

    #[test]
    fn bindings_include_hidden_items_and_nested_submenus() {
        let mut a = item("a", Kind::Normal);
        a.accelerator = Some("CmdOrCtrl+N".into());
        let mut hidden = item("h", Kind::Normal);
        hidden.accelerator = Some("F12".into());
        hidden.visible = false;
        let mut off = item("off", Kind::Checkbox);
        off.accelerator = Some("Alt+O".into());
        off.enabled = false;
        off.checked = true;
        let mut menu = item("menu", Kind::Submenu);
        menu.accelerator = Some("Ctrl+Q".into());
        menu.submenu = vec![hidden, off, item("plain", Kind::Normal)];
        let mut bindings = Vec::new();
        collect_bindings(&[a, menu], false, &mut bindings);
        assert_eq!(
            bindings.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
            ["a", "h", "off"]
        );
        let ctrl = Mods {
            ctrl: true,
            ..Mods::default()
        };
        assert_eq!(find_binding(&bindings, 0x4E, ctrl), Some(0));
        assert_eq!(find_binding(&bindings, 0x7B, Mods::default()), Some(1));
        // A disabled item does not fire, so the key is the page's.
        assert_eq!(
            find_binding(
                &bindings,
                0x4F,
                Mods {
                    alt: true,
                    ..Mods::default()
                }
            ),
            None
        );
        assert_eq!(find_binding(&bindings, 0x4E, Mods::default()), None);
    }

    #[test]
    fn the_first_enabled_binding_of_a_key_wins() {
        let mut first = item("first", Kind::Normal);
        first.accelerator = Some("Ctrl+K".into());
        first.enabled = false;
        let mut second = item("second", Kind::Normal);
        second.accelerator = Some("Ctrl+K".into());
        let mut bindings = Vec::new();
        collect_bindings(&[first, second], false, &mut bindings);
        assert_eq!(
            find_binding(
                &bindings,
                0x4B,
                Mods {
                    ctrl: true,
                    ..Mods::default()
                }
            ),
            Some(1)
        );
    }

    #[test]
    fn a_checkbox_flips_and_a_radio_takes_its_group() {
        let mut items = vec![
            item("box", Kind::Checkbox),
            item("sep", Kind::Separator),
            item("r1", Kind::Radio),
            item("r2", Kind::Radio),
            item("r3", Kind::Radio),
            item("plain", Kind::Normal),
        ];
        items[3].checked = true;
        assert_eq!(activate(&mut items, "box"), Some(Some(true)));
        assert!(items[0].checked);
        assert_eq!(activate(&mut items, "box"), Some(Some(false)));
        assert_eq!(activate(&mut items, "r1"), Some(Some(true)));
        assert_eq!(
            [items[2].checked, items[3].checked, items[4].checked],
            [true, false, false]
        );
        assert_eq!(activate(&mut items, "plain"), Some(None));
        assert_eq!(activate(&mut items, "missing"), None);
    }

    #[test]
    fn a_click_finds_items_in_submenus() {
        let mut inner = item("inner", Kind::Checkbox);
        inner.checked = true;
        let mut menu = item("menu", Kind::Submenu);
        menu.submenu = vec![inner];
        let mut items = vec![menu];
        assert_eq!(activate(&mut items, "inner"), Some(Some(false)));
        assert!(!items[0].submenu[0].checked);
        assert_eq!(activate(&mut items, "menu"), None);
    }
}
