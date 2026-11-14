//! Electron accelerator strings (`CommandOrControl+Shift+K`, `Alt+F4`, `Ctrl+Plus`) as modifiers plus a key, with the
//! three things the shell does with them: the text a Windows menu shows right-aligned, the Windows virtual key a
//! keyboard hook compares with, and the character a macOS key equivalent takes. Pure: no OS in here.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The Windows key, ⌘ on macOS.
    pub meta: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// A letter (stored upper case), a digit or a punctuation character (`+` is `Plus`).
    Char(char),
    /// `F1`..`F24`.
    F(u8),
    Space,
    Tab,
    Backspace,
    Delete,
    Insert,
    Enter,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    CapsLock,
    NumLock,
    ScrollLock,
    PrintScreen,
    VolumeUp,
    VolumeDown,
    VolumeMute,
    MediaNext,
    MediaPrevious,
    MediaStop,
    MediaPlayPause,
    /// `num0`..`num9`.
    Num(u8),
    NumDecimal,
    NumAdd,
    NumSubtract,
    NumMultiply,
    NumDivide,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accelerator {
    pub mods: Mods,
    pub key: Key,
}

/// Parses an Electron accelerator. `mac` decides what `CommandOrControl` means (⌘ there, Ctrl elsewhere).
pub fn parse(text: &str, mac: bool) -> Result<Accelerator, String> {
    let text = text.trim();
    // `Ctrl++` and a lone `+` name the plus key by the character: the separator cannot be split on.
    let (head, key_token) = if text == "+" {
        ("", "+")
    } else if let Some(head) = text.strip_suffix("++") {
        (head, "+")
    } else if text.ends_with('+') {
        return Err(format!("accelerator \"{text}\" ends with a separator"));
    } else {
        match text.rsplit_once('+') {
            Some((head, key)) => (head, key),
            None => ("", text),
        }
    };
    if key_token.is_empty() {
        return Err("accelerator is empty".into());
    }
    let mut mods = Mods::default();
    if !head.is_empty() {
        for token in head.split('+') {
            match token.trim().to_ascii_lowercase().as_str() {
                "commandorcontrol" | "cmdorctrl" => {
                    if mac {
                        mods.meta = true;
                    } else {
                        mods.ctrl = true;
                    }
                }
                "control" | "ctrl" => mods.ctrl = true,
                "alt" | "option" => mods.alt = true,
                "altgr" => {
                    mods.ctrl = true;
                    mods.alt = true;
                }
                "shift" => mods.shift = true,
                "command" | "cmd" | "super" | "meta" => mods.meta = true,
                other => {
                    return Err(format!(
                        "unknown modifier \"{other}\" in accelerator \"{text}\""
                    ));
                }
            }
        }
    }
    let key = parse_key(key_token)
        .ok_or_else(|| format!("unknown key \"{key_token}\" in accelerator \"{text}\""))?;
    Ok(Accelerator { mods, key })
}

fn parse_key(token: &str) -> Option<Key> {
    let lower = token.to_ascii_lowercase();
    let named = match lower.as_str() {
        "plus" => Some(Key::Char('+')),
        "space" => Some(Key::Space),
        "tab" => Some(Key::Tab),
        "backspace" => Some(Key::Backspace),
        "delete" | "del" => Some(Key::Delete),
        "insert" | "ins" => Some(Key::Insert),
        "return" | "enter" => Some(Key::Enter),
        "escape" | "esc" => Some(Key::Escape),
        "up" => Some(Key::Up),
        "down" => Some(Key::Down),
        "left" => Some(Key::Left),
        "right" => Some(Key::Right),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "pageup" => Some(Key::PageUp),
        "pagedown" => Some(Key::PageDown),
        "capslock" => Some(Key::CapsLock),
        "numlock" | "numlk" => Some(Key::NumLock),
        "scrolllock" | "scrolllk" => Some(Key::ScrollLock),
        "printscreen" => Some(Key::PrintScreen),
        "volumeup" => Some(Key::VolumeUp),
        "volumedown" => Some(Key::VolumeDown),
        "volumemute" => Some(Key::VolumeMute),
        "medianexttrack" => Some(Key::MediaNext),
        "mediaprevioustrack" => Some(Key::MediaPrevious),
        "mediastop" => Some(Key::MediaStop),
        "mediaplaypause" => Some(Key::MediaPlayPause),
        "numdec" => Some(Key::NumDecimal),
        "numadd" => Some(Key::NumAdd),
        "numsub" => Some(Key::NumSubtract),
        "nummult" => Some(Key::NumMultiply),
        "numdiv" => Some(Key::NumDivide),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    if let Some(digit) = lower.strip_prefix("num")
        && digit.len() == 1
        && let Some(n) = digit.chars().next().and_then(|c| c.to_digit(10))
    {
        return Some(Key::Num(n as u8));
    }
    if let Some(number) = lower.strip_prefix('f')
        && let Ok(n) = number.parse::<u8>()
    {
        return (1..=24).contains(&n).then_some(Key::F(n));
    }
    let mut chars = token.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    if c.is_ascii_alphanumeric() {
        return Some(Key::Char(c.to_ascii_uppercase()));
    }
    "+=-,./;`[]\\'".contains(c).then_some(Key::Char(c))
}

impl Key {
    /// The Windows virtual-key code of the key (a US layout's for punctuation, as Chromium maps accelerators).
    pub fn windows_vk(self) -> u16 {
        match self {
            Key::Char(c) => match c {
                'A'..='Z' | '0'..='9' => c as u16,
                '+' | '=' => 0xBB,
                ',' => 0xBC,
                '-' => 0xBD,
                '.' => 0xBE,
                '/' => 0xBF,
                '`' => 0xC0,
                '[' => 0xDB,
                '\\' => 0xDC,
                ']' => 0xDD,
                '\'' => 0xDE,
                ';' => 0xBA,
                // `parse_key` admits nothing else.
                _ => 0,
            },
            Key::F(n) => 0x6F + u16::from(n),
            Key::Space => 0x20,
            Key::Tab => 0x09,
            Key::Backspace => 0x08,
            Key::Delete => 0x2E,
            Key::Insert => 0x2D,
            Key::Enter => 0x0D,
            Key::Escape => 0x1B,
            Key::Left => 0x25,
            Key::Up => 0x26,
            Key::Right => 0x27,
            Key::Down => 0x28,
            Key::PageUp => 0x21,
            Key::PageDown => 0x22,
            Key::End => 0x23,
            Key::Home => 0x24,
            Key::CapsLock => 0x14,
            Key::NumLock => 0x90,
            Key::ScrollLock => 0x91,
            Key::PrintScreen => 0x2C,
            Key::VolumeMute => 0xAD,
            Key::VolumeDown => 0xAE,
            Key::VolumeUp => 0xAF,
            Key::MediaNext => 0xB0,
            Key::MediaPrevious => 0xB1,
            Key::MediaStop => 0xB2,
            Key::MediaPlayPause => 0xB3,
            Key::Num(n) => 0x60 + u16::from(n),
            Key::NumMultiply => 0x6A,
            Key::NumAdd => 0x6B,
            Key::NumSubtract => 0x6D,
            Key::NumDecimal => 0x6E,
            Key::NumDivide => 0x6F,
        }
    }

    fn label(self) -> String {
        match self {
            Key::Char('+') => "Plus".into(),
            Key::Char(c) => c.to_string(),
            Key::F(n) => format!("F{n}"),
            Key::Space => "Space".into(),
            Key::Tab => "Tab".into(),
            Key::Backspace => "Backspace".into(),
            Key::Delete => "Delete".into(),
            Key::Insert => "Insert".into(),
            Key::Enter => "Enter".into(),
            Key::Escape => "Esc".into(),
            Key::Up => "Up".into(),
            Key::Down => "Down".into(),
            Key::Left => "Left".into(),
            Key::Right => "Right".into(),
            Key::Home => "Home".into(),
            Key::End => "End".into(),
            Key::PageUp => "Page Up".into(),
            Key::PageDown => "Page Down".into(),
            Key::CapsLock => "Caps Lock".into(),
            Key::NumLock => "Num Lock".into(),
            Key::ScrollLock => "Scroll Lock".into(),
            Key::PrintScreen => "Print Screen".into(),
            Key::VolumeUp => "Volume Up".into(),
            Key::VolumeDown => "Volume Down".into(),
            Key::VolumeMute => "Volume Mute".into(),
            Key::MediaNext => "Media Next Track".into(),
            Key::MediaPrevious => "Media Previous Track".into(),
            Key::MediaStop => "Media Stop".into(),
            Key::MediaPlayPause => "Media Play/Pause".into(),
            Key::Num(n) => format!("Num {n}"),
            Key::NumDecimal => "Num .".into(),
            Key::NumAdd => "Num +".into(),
            Key::NumSubtract => "Num -".into(),
            Key::NumMultiply => "Num *".into(),
            Key::NumDivide => "Num /".into(),
        }
    }
}

impl Accelerator {
    /// The text a Windows menu shows after the item's TAB: `Ctrl+Shift+K`.
    pub fn display(&self) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(5);
        if self.mods.ctrl {
            parts.push("Ctrl".into());
        }
        if self.mods.alt {
            parts.push("Alt".into());
        }
        if self.mods.shift {
            parts.push("Shift".into());
        }
        if self.mods.meta {
            parts.push("Win".into());
        }
        parts.push(self.key.label());
        parts.join("+")
    }

    /// Whether a key press (`vk` with the modifiers held) is this accelerator. The modifiers must be exactly these,
    /// except that `Plus` also takes the Shift a US keyboard needs for `+` when the accelerator names none.
    pub fn matches(&self, vk: u16, held: Mods) -> bool {
        if self.key.windows_vk() != vk {
            return false;
        }
        let shift_free = self.key == Key::Char('+') && !self.mods.shift;
        self.mods.ctrl == held.ctrl
            && self.mods.alt == held.alt
            && self.mods.meta == held.meta
            && (shift_free || self.mods.shift == held.shift)
    }

    /// The character an `NSMenuItem` key equivalent takes: the lower-case letter, or the function-key private-use code
    /// AppKit defines (`NSF1FunctionKey` = U+F704, arrows U+F700…).
    pub fn mac_key_equivalent(&self) -> Option<char> {
        let c = match self.key {
            Key::Char(c) => c.to_ascii_lowercase(),
            Key::F(n) => char::from_u32(0xF704 + u32::from(n) - 1)?,
            Key::Space => ' ',
            Key::Tab => '\t',
            Key::Backspace => '\u{8}',
            Key::Delete => '\u{F728}',
            Key::Insert => '\u{F727}',
            Key::Enter => '\r',
            Key::Escape => '\u{1b}',
            Key::Up => '\u{F700}',
            Key::Down => '\u{F701}',
            Key::Left => '\u{F702}',
            Key::Right => '\u{F703}',
            Key::Home => '\u{F729}',
            Key::End => '\u{F72B}',
            Key::PageUp => '\u{F72C}',
            Key::PageDown => '\u{F72D}',
            Key::PrintScreen => '\u{F738}',
            Key::Num(n) => char::from_digit(u32::from(n), 10)?,
            Key::NumDecimal => '.',
            Key::NumAdd => '+',
            Key::NumSubtract => '-',
            Key::NumMultiply => '*',
            Key::NumDivide => '/',
            Key::CapsLock
            | Key::NumLock
            | Key::ScrollLock
            | Key::VolumeUp
            | Key::VolumeDown
            | Key::VolumeMute
            | Key::MediaNext
            | Key::MediaPrevious
            | Key::MediaStop
            | Key::MediaPlayPause => return None,
        };
        Some(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctrl() -> Mods {
        Mods {
            ctrl: true,
            ..Mods::default()
        }
    }

    #[test]
    fn command_or_control_follows_the_platform() {
        let win = parse("CommandOrControl+Shift+K", false).unwrap();
        assert_eq!(
            win.mods,
            Mods {
                ctrl: true,
                shift: true,
                ..Mods::default()
            }
        );
        assert_eq!(win.key, Key::Char('K'));
        let mac = parse("CmdOrCtrl+Shift+K", true).unwrap();
        assert_eq!(
            mac.mods,
            Mods {
                meta: true,
                shift: true,
                ..Mods::default()
            }
        );
    }

    #[test]
    fn modifiers_have_electrons_aliases() {
        let a = parse("Control+Alt+Shift+Super+X", false).unwrap();
        assert_eq!(
            a.mods,
            Mods {
                ctrl: true,
                alt: true,
                shift: true,
                meta: true
            }
        );
        assert_eq!(
            parse("Option+X", false).unwrap().mods,
            Mods {
                alt: true,
                ..Mods::default()
            }
        );
        assert_eq!(
            parse("Cmd+X", false).unwrap().mods,
            Mods {
                meta: true,
                ..Mods::default()
            }
        );
        assert_eq!(
            parse("Meta+X", true).unwrap().mods,
            Mods {
                meta: true,
                ..Mods::default()
            }
        );
        assert_eq!(
            parse("AltGr+Q", false).unwrap().mods,
            Mods {
                ctrl: true,
                alt: true,
                ..Mods::default()
            }
        );
        assert_eq!(parse("ctrl+shift+i", false).unwrap().key, Key::Char('I'));
    }

    #[test]
    fn keys_parse() {
        assert_eq!(parse("F5", false).unwrap().key, Key::F(5));
        assert_eq!(parse("Alt+F24", false).unwrap().key, Key::F(24));
        assert!(parse("F25", false).is_err());
        assert!(parse("F0", false).is_err());
        assert_eq!(parse("Ctrl+Space", false).unwrap().key, Key::Space);
        assert_eq!(parse("Ctrl+Left", false).unwrap().key, Key::Left);
        assert_eq!(parse("Ctrl+PageDown", false).unwrap().key, Key::PageDown);
        assert_eq!(
            parse("Escape", false).unwrap(),
            Accelerator {
                mods: Mods::default(),
                key: Key::Escape
            }
        );
        assert_eq!(parse("Ctrl+num7", false).unwrap().key, Key::Num(7));
        assert_eq!(parse("Ctrl+numadd", false).unwrap().key, Key::NumAdd);
        assert_eq!(parse("Ctrl+0", false).unwrap().key, Key::Char('0'));
        assert_eq!(
            parse("CommandOrControl+-", false).unwrap().key,
            Key::Char('-')
        );
        assert_eq!(parse("Ctrl+,", false).unwrap().key, Key::Char(','));
    }

    #[test]
    fn plus_is_a_key_and_a_separator() {
        assert_eq!(
            parse("CommandOrControl+Plus", false).unwrap().key,
            Key::Char('+')
        );
        let literal = parse("Ctrl++", false).unwrap();
        assert_eq!(literal.key, Key::Char('+'));
        assert_eq!(literal.mods, ctrl());
        assert_eq!(parse("+", false).unwrap().key, Key::Char('+'));
        assert!(parse("Ctrl+", false).is_err());
    }

    #[test]
    fn bad_strings_are_refused() {
        assert!(parse("", false).is_err());
        assert!(parse("Ctrl+Shift", false).is_err());
        assert!(parse("Hyper+X", false).is_err());
        assert!(parse("Ctrl+XY", false).is_err());
        assert!(parse("Ctrl+K+L", false).is_err());
    }

    #[test]
    fn menu_text_lists_modifiers_in_windows_order() {
        assert_eq!(
            parse("Shift+CommandOrControl+Z", false).unwrap().display(),
            "Ctrl+Shift+Z"
        );
        assert_eq!(parse("Control+Y", false).unwrap().display(), "Ctrl+Y");
        assert_eq!(
            parse("Alt+Super+Left", false).unwrap().display(),
            "Alt+Win+Left"
        );
        assert_eq!(
            parse("CommandOrControl+Plus", false).unwrap().display(),
            "Ctrl+Plus"
        );
        assert_eq!(
            parse("Ctrl+PageUp", false).unwrap().display(),
            "Ctrl+Page Up"
        );
        assert_eq!(parse("F11", false).unwrap().display(), "F11");
        assert_eq!(parse("Ctrl+Escape", false).unwrap().display(), "Ctrl+Esc");
    }

    #[test]
    fn virtual_keys_are_windows_codes() {
        assert_eq!(Key::Char('K').windows_vk(), 0x4B);
        assert_eq!(Key::Char('0').windows_vk(), 0x30);
        assert_eq!(Key::F(1).windows_vk(), 0x70);
        assert_eq!(Key::F(12).windows_vk(), 0x7B);
        assert_eq!(Key::F(24).windows_vk(), 0x87);
        assert_eq!(Key::Char('+').windows_vk(), 0xBB);
        assert_eq!(Key::Char('=').windows_vk(), 0xBB);
        assert_eq!(Key::Char('-').windows_vk(), 0xBD);
        assert_eq!(Key::Char(',').windows_vk(), 0xBC);
        assert_eq!(Key::Num(0).windows_vk(), 0x60);
        assert_eq!(Key::Num(9).windows_vk(), 0x69);
        assert_eq!(Key::Enter.windows_vk(), 0x0D);
        assert_eq!(Key::Delete.windows_vk(), 0x2E);
    }

    #[test]
    fn matching_needs_the_exact_modifiers() {
        let a = parse("Ctrl+Shift+K", false).unwrap();
        assert!(a.matches(
            0x4B,
            Mods {
                ctrl: true,
                shift: true,
                ..Mods::default()
            }
        ));
        assert!(!a.matches(0x4B, ctrl()));
        assert!(!a.matches(
            0x4B,
            Mods {
                ctrl: true,
                shift: true,
                alt: true,
                meta: false
            }
        ));
        assert!(!a.matches(
            0x4C,
            Mods {
                ctrl: true,
                shift: true,
                ..Mods::default()
            }
        ));
        let bare = parse("F11", false).unwrap();
        assert!(bare.matches(0x7A, Mods::default()));
        assert!(!bare.matches(0x7A, ctrl()));
    }

    #[test]
    fn plus_ignores_the_shift_a_us_keyboard_needs() {
        let zoom = parse("CommandOrControl+Plus", false).unwrap();
        assert!(zoom.matches(0xBB, ctrl()));
        assert!(zoom.matches(
            0xBB,
            Mods {
                ctrl: true,
                shift: true,
                ..Mods::default()
            }
        ));
        let explicit = parse("Ctrl+Shift+Plus", false).unwrap();
        assert!(!explicit.matches(0xBB, ctrl()));
    }

    #[test]
    fn mac_key_equivalents() {
        assert_eq!(
            parse("CmdOrCtrl+K", true).unwrap().mac_key_equivalent(),
            Some('k')
        );
        assert_eq!(
            parse("F5", true).unwrap().mac_key_equivalent(),
            Some('\u{F708}')
        );
        assert_eq!(
            parse("Cmd+Left", true).unwrap().mac_key_equivalent(),
            Some('\u{F702}')
        );
        assert_eq!(
            parse("Cmd+Plus", true).unwrap().mac_key_equivalent(),
            Some('+')
        );
        assert_eq!(parse("VolumeUp", true).unwrap().mac_key_equivalent(), None);
    }
}
