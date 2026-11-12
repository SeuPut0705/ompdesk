//! JavaScript's string rules the service's texts were written with: `\s`, `trim`, UTF-16 lengths and slices.
//! A text an agent reads is cut at UTF-16 units (`text.length`, `slice`), so the Rust port counts the same units: a
//! limit of 200 keeps the same characters it kept. A cut inside a surrogate pair cannot be held by a Rust string and
//! reads as U+FFFD (JavaScript kept the lone half; `head` and `cut` never cut a pair).

/// What `/\s/` and `String.prototype.trim` take for white space: the white space and line terminators of ECMAScript.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.trimEnd()`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

/// `text.trimStart()`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

/// `text.replace(/\s+/g, " ")`.
pub fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `text.length`: UTF-16 units.
pub fn len16(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `text.slice(from, to)` on UTF-16 units (both within the text).
pub fn slice16(text: &str, from: usize, to: usize) -> String {
    let all = units(text);
    let to = to.min(all.len());
    let from = from.min(to);
    String::from_utf16_lossy(&all[from..to])
}

/// `text.slice(-count)`: the last `count` units.
pub fn tail16(text: &str, count: usize) -> String {
    let all = units(text);
    let from = all.len().saturating_sub(count);
    String::from_utf16_lossy(&all[from..])
}

/// `text`'s first `max` UTF-16 units, one fewer when that would end on half an emoji (a lone surrogate).
pub fn head(text: &str, max: usize) -> String {
    let all = units(text);
    if max == 0 {
        return String::new();
    }
    let keep = match all.get(max - 1) {
        Some(last) if (0xd800..=0xdbff).contains(last) => max - 1,
        _ => max,
    };
    String::from_utf16_lossy(&all[..keep.min(all.len())])
}

/// `text` on one line (every run of white space one space), cut to `max` units with an ellipsis.
pub fn one_line(text: &str, max: usize) -> String {
    let flat = collapse_spaces(text);
    let flat = trim(&flat);
    if len16(flat) > max {
        format!("{}…", head(flat, max.saturating_sub(1)))
    } else {
        flat.to_owned()
    }
}

/// `text.length > max ? head(text, max) + note : text` as `cut` writes it.
pub fn cut(text: &str, max: usize) -> String {
    if len16(text) > max {
        format!("{}\n… (cut at {max} characters)", head(text, max))
    } else {
        text.to_owned()
    }
}

/// A number as JavaScript prints it in a template string: whole numbers without a fraction.
pub fn number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i128)
    } else {
        format!("{n}")
    }
}
