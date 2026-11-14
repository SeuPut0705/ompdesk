//! Electron accelerator strings for *global* shortcuts (`CommandOrControl+Shift+K`), parsed into modifiers and a
//! canonical key name, then mapped to a Windows virtual-key code or a macOS key code. Independent of the menu code's
//! parser (`accelerator.rs`): it only serves `shortcut.register`.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Windows key / Command.
    pub meta: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hotkey {
    pub mods: Mods,
    /// Canonical key: one uppercase letter or digit, `F1`..`F24`, a punctuation character or a name from `NAMED`.
    pub key: String,
}

const NAMED: &[&str] = &[
    "Space",
    "Tab",
    "Enter",
    "Escape",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Up",
    "Down",
    "Left",
    "Right",
    "Plus",
    "PrintScreen",
    "CapsLock",
    "NumLock",
    "ScrollLock",
    "VolumeUp",
    "VolumeDown",
    "VolumeMute",
    "MediaNextTrack",
    "MediaPreviousTrack",
    "MediaStop",
    "MediaPlayPause",
    "numadd",
    "numsub",
    "nummult",
    "numdiv",
    "numdec",
];

fn canonical_key(token: &str) -> Option<String> {
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphanumeric() {
            return Some(c.to_ascii_uppercase().to_string());
        }
        if ";=,-./`[]\\'".contains(c) {
            return Some(c.to_string());
        }
        return None;
    }
    let lower = token.to_ascii_lowercase();
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then(|| format!("F{n}"));
    }
    if let Some(d) = lower
        .strip_prefix("num")
        .and_then(|n| n.parse::<u32>().ok())
    {
        return (d <= 9).then(|| format!("num{d}"));
    }
    match lower.as_str() {
        "return" => Some("Enter".to_string()),
        "esc" => Some("Escape".to_string()),
        _ => NAMED
            .iter()
            .find(|n| n.eq_ignore_ascii_case(token))
            .map(|n| (*n).to_string()),
    }
}

/// `mac` decides what `CommandOrControl` means. `None` for anything Electron would refuse: no key, two keys, an
/// unknown token or an empty one.
pub fn parse(text: &str, mac: bool) -> Option<Hotkey> {
    let mut mods = Mods::default();
    let mut key: Option<String> = None;
    for token in text.split('+') {
        let token = token.trim();
        match token.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" => {
                if mac {
                    mods.meta = true;
                } else {
                    mods.ctrl = true;
                }
            }
            "command" | "cmd" | "super" | "meta" => mods.meta = true,
            "control" | "ctrl" => mods.ctrl = true,
            "alt" | "option" => mods.alt = true,
            "altgr" => {
                mods.ctrl = true;
                mods.alt = true;
            }
            "shift" => mods.shift = true,
            _ => {
                if key.is_some() {
                    return None;
                }
                key = Some(canonical_key(token)?);
            }
        }
    }
    Some(Hotkey { mods, key: key? })
}

/// `RegisterHotKey` modifier bits, always with `MOD_NOREPEAT`.
pub fn win_mods(mods: Mods) -> u32 {
    let mut bits = 0x4000;
    if mods.alt {
        bits |= 0x1;
    }
    if mods.ctrl {
        bits |= 0x2;
    }
    if mods.shift {
        bits |= 0x4;
    }
    if mods.meta {
        bits |= 0x8;
    }
    bits
}

pub fn win_vk(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.len() == 1 {
        let c = bytes[0];
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            return Some(u32::from(c));
        }
        return Some(match c {
            b';' => 0xBA,
            b'=' => 0xBB,
            b',' => 0xBC,
            b'-' => 0xBD,
            b'.' => 0xBE,
            b'/' => 0xBF,
            b'`' => 0xC0,
            b'[' => 0xDB,
            b'\\' => 0xDC,
            b']' => 0xDD,
            b'\'' => 0xDE,
            _ => return None,
        });
    }
    if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return Some(0x70 + n - 1);
    }
    if let Some(d) = key.strip_prefix("num").and_then(|n| n.parse::<u32>().ok()) {
        return Some(0x60 + d);
    }
    Some(match key {
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Enter" => 0x0D,
        "CapsLock" => 0x14,
        "Escape" => 0x1B,
        "Space" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "Left" => 0x25,
        "Up" => 0x26,
        "Right" => 0x27,
        "Down" => 0x28,
        "PrintScreen" => 0x2C,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "nummult" => 0x6A,
        "numadd" => 0x6B,
        "numsub" => 0x6D,
        "numdec" => 0x6E,
        "numdiv" => 0x6F,
        "NumLock" => 0x90,
        "ScrollLock" => 0x91,
        "VolumeMute" => 0xAD,
        "VolumeDown" => 0xAE,
        "VolumeUp" => 0xAF,
        "MediaNextTrack" => 0xB0,
        "MediaPreviousTrack" => 0xB1,
        "MediaStop" => 0xB2,
        "MediaPlayPause" => 0xB3,
        "Plus" => 0xBB,
        _ => return None,
    })
}

/// Carbon modifier bits (`cmdKey`, `shiftKey`, `optionKey`, `controlKey`).
pub fn mac_mods(mods: Mods) -> u32 {
    let mut bits = 0;
    if mods.meta {
        bits |= 0x100;
    }
    if mods.shift {
        bits |= 0x200;
    }
    if mods.alt {
        bits |= 0x800;
    }
    if mods.ctrl {
        bits |= 0x1000;
    }
    bits
}

/// ANSI virtual key codes (`kVK_*`).
pub fn mac_keycode(key: &str) -> Option<u32> {
    if key.len() == 1 {
        let c = key.as_bytes()[0];
        return Some(match c {
            b'A' => 0,
            b'S' => 1,
            b'D' => 2,
            b'F' => 3,
            b'H' => 4,
            b'G' => 5,
            b'Z' => 6,
            b'X' => 7,
            b'C' => 8,
            b'V' => 9,
            b'B' => 11,
            b'Q' => 12,
            b'W' => 13,
            b'E' => 14,
            b'R' => 15,
            b'Y' => 16,
            b'T' => 17,
            b'1' => 18,
            b'2' => 19,
            b'3' => 20,
            b'4' => 21,
            b'6' => 22,
            b'5' => 23,
            b'=' => 24,
            b'9' => 25,
            b'7' => 26,
            b'-' => 27,
            b'8' => 28,
            b'0' => 29,
            b']' => 30,
            b'O' => 31,
            b'U' => 32,
            b'[' => 33,
            b'I' => 34,
            b'P' => 35,
            b'L' => 37,
            b'J' => 38,
            b'\'' => 39,
            b'K' => 40,
            b';' => 41,
            b'\\' => 42,
            b',' => 43,
            b'/' => 44,
            b'N' => 45,
            b'M' => 46,
            b'.' => 47,
            b'`' => 50,
            _ => return None,
        });
    }
    if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<usize>().ok()) {
        const F: [u32; 20] = [
            122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80,
            90,
        ];
        return F.get(n.checked_sub(1)?).copied();
    }
    Some(match key {
        "Enter" => 36,
        "Tab" => 48,
        "Space" => 49,
        "Backspace" => 51,
        "Escape" => 53,
        "Plus" => 24,
        "Delete" => 117,
        "Home" => 115,
        "PageUp" => 116,
        "End" => 119,
        "PageDown" => 121,
        "Left" => 123,
        "Right" => 124,
        "Down" => 125,
        "Up" => 126,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifiers_and_keys() {
        let a = parse("CommandOrControl+Shift+K", false).unwrap();
        assert_eq!(
            a.mods,
            Mods {
                ctrl: true,
                alt: false,
                shift: true,
                meta: false
            }
        );
        assert_eq!(a.key, "K");
        assert_eq!(win_mods(a.mods), 0x4000 | 0x2 | 0x4);
        assert_eq!(win_vk(&a.key), Some(0x4B));
        let m = parse("cmdorctrl+alt+5", true).unwrap();
        assert!(m.mods.meta && m.mods.alt && !m.mods.ctrl);
        assert_eq!(mac_mods(m.mods), 0x100 | 0x800);
        assert_eq!(mac_keycode(&m.key), Some(23));
    }

    #[test]
    fn parses_named_and_function_keys() {
        assert_eq!(parse("Alt+F24", false).unwrap().key, "F24");
        assert_eq!(win_vk("F24"), Some(0x87));
        assert_eq!(parse("Ctrl+esc", false).unwrap().key, "Escape");
        assert_eq!(win_vk("PageDown"), Some(0x22));
        assert!(parse("Super+Space", false).unwrap().mods.meta);
        assert_eq!(win_vk("num3"), Some(0x63));
        assert_eq!(parse("Ctrl+Plus", false).unwrap().key, "Plus");
        assert_eq!(parse("ctrl+pagedown", false).unwrap().key, "PageDown");
        assert_eq!(parse("Ctrl+;", false).unwrap().key, ";");
        assert_eq!(win_vk(";"), Some(0xBA));
        assert_eq!(parse("F5", false).unwrap().mods, Mods::default());
    }

    #[test]
    fn refuses_what_electron_refuses() {
        assert!(parse("", false).is_none());
        assert!(parse("Ctrl+Shift", false).is_none());
        assert!(parse("Ctrl+A+B", false).is_none());
        assert!(parse("Ctrl+F25", false).is_none());
        assert!(parse("Ctrl+Nonsense", false).is_none());
        assert!(parse("Ctrl++", false).is_none());
        assert!(parse("Ctrl+?", false).is_none());
    }

    #[test]
    fn every_named_key_has_a_windows_code() {
        for name in NAMED {
            assert!(win_vk(name).is_some(), "{name}");
            assert_eq!(canonical_key(name).as_deref(), Some(*name));
        }
    }
}
