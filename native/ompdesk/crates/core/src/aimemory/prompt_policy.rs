//! The one prompt-classification policy, compiled into native upkeep and the terminal extension's embedded WASM.

pub struct Facts<'a> {
    pub agent: bool,
    pub agent_message: bool,
    pub subagent_assignment: bool,
    pub junk: bool,
    pub title: Option<Text>,
    pub explicit: Option<String>,
    pub body: &'a str,
    pub first_line: Option<Text>,
}

fn is_js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// JavaScript title clipping is in UTF-16 units and may end on half a pair. Preserve it on the WASM JSON wire;
/// native String consumers use the same U+FFFD decoding as the core's JSON transport.
#[derive(Clone)]
pub struct Text(Vec<u16>);

impl Text {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn into_string(self) -> String {
        String::from_utf16_lossy(&self.0)
    }

    fn json(&self) -> String {
        use std::fmt::Write;
        let mut out = String::from("\"");
        for ch in char::decode_utf16(self.0.iter().copied()) {
            match ch {
                Ok('"') => out.push_str("\\\""),
                Ok('\\') => out.push_str("\\\\"),
                Ok(ch) if ch < ' ' => {
                    let _ = write!(out, "\\u{:04x}", ch as u32);
                }
                Ok(ch) => out.push(ch),
                Err(error) => {
                    let _ = write!(out, "\\u{:04x}", error.unpaired_surrogate());
                }
            }
        }
        out.push('"');
        out
    }
}

fn json_text(text: &str) -> String {
    Text(text.encode_utf16().collect()).json()
}

impl Facts<'_> {
    pub fn json(&self) -> String {
        let title = self
            .title
            .as_ref()
            .map_or_else(|| "null".into(), Text::json);
        let first_line = self
            .first_line
            .as_ref()
            .map_or_else(|| "null".into(), Text::json);
        let explicit = self
            .explicit
            .as_deref()
            .map_or_else(|| "null".into(), json_text);
        format!(
            "{{\"agent\":{},\"junk\":{},\"title\":{title},\"explicit\":{explicit},\"body\":{},\"firstLine\":{first_line},\"agentMessage\":{},\"subagentAssignment\":{}}}",
            self.agent,
            self.junk,
            json_text(self.body),
            self.agent_message,
            self.subagent_assignment
        )
    }
}

const TITLE_MAX: usize = 120;
const WRAPPER: &str = "ompdesk-agent-message";

fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

fn horizontal(text: &str) -> &str {
    text.trim_start_matches([' ', '\t'])
}

fn ignore_case_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &text[prefix.len()..])
}

fn line_end(text: &str) -> Option<&str> {
    let text = horizontal(text);
    if text.is_empty() {
        Some(text)
    } else {
        text.strip_prefix("\r\n")
            .or_else(|| text.strip_prefix('\n'))
    }
}

fn quoted(text: &str) -> Option<&str> {
    let text = text.strip_prefix('"')?;
    Some(&text[text.find('"')? + 1..])
}

fn wrapped_start(text: &str) -> Option<&str> {
    let text = text.strip_prefix("<ompdesk-agent-message from=")?;
    let text = quoted(text)?;
    let text = match text.strip_prefix(" session=") {
        Some(text) => quoted(text)?,
        None => text,
    };
    line_end(text.strip_prefix('>')?)
}

fn wrapped_end(text: &str) -> &str {
    let suffix = text.trim_end_matches([' ', '\t']);
    let Some(prefix) = suffix.strip_suffix("</ompdesk-agent-message>") else {
        return text;
    };
    let prefix = prefix.trim_end_matches([' ', '\t']);
    if prefix.is_empty() {
        ""
    } else {
        prefix
            .strip_suffix("\r\n")
            .or_else(|| prefix.strip_suffix('\n'))
            .unwrap_or(text)
    }
}

fn unwrap(prompt: &str) -> (&str, bool, bool) {
    let mut body = trim(prompt);
    let (mut agent_message, mut subagent_assignment) = (false, false);
    for _ in 0..4 {
        if let Some(rest) = wrapped_start(body) {
            agent_message = true;
            body = trim(wrapped_end(rest));
        } else if let Some(rest) = [
            "Complete assignment thoroughly:",
            "You are a subagent spawned by another session.",
        ]
        .into_iter()
        .find_map(|prefix| ignore_case_prefix(body, prefix).and_then(line_end))
        {
            subagent_assignment = true;
            body = trim(rest);
        } else {
            break;
        }
    }
    (body, agent_message, subagent_assignment)
}

fn clip(text: &str) -> Text {
    let flat = text
        .split(is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut units: Vec<u16> = flat.encode_utf16().collect();
    if units.len() > TITLE_MAX {
        units.truncate(TITLE_MAX - 1);
        while units
            .last()
            .is_some_and(|unit| char::from_u32(u32::from(*unit)).is_some_and(is_js_space))
        {
            units.pop();
        }
        units.push('…' as u16);
    }
    Text(units)
}

fn bare_line(line: &str) -> &str {
    let line = horizontal(line);
    let line = ignore_case_prefix(line, "Title:").map_or(line, horizontal);
    let head = line.bytes().take_while(|byte| *byte == b'#').count();
    let line = if (1..=6).contains(&head) && line[head..].starts_with([' ', '\t']) {
        horizontal(&line[head..])
    } else if let Some(rest) = line.strip_prefix('>') {
        rest.strip_prefix([' ', '\t']).unwrap_or(rest)
    } else if line.starts_with(['-', '*', '+']) && line[1..].starts_with([' ', '\t']) {
        horizontal(&line[1..])
    } else {
        line
    };
    trim(line)
}

fn noise(line: &str) -> bool {
    if line.starts_with("```")
        || (line.len() >= 3 && line.bytes().all(|byte| b"-*_~=\x3d".contains(&byte)))
    {
        return true;
    }
    let Some(tag) = line.strip_prefix('<').and_then(|tag| tag.strip_suffix('>')) else {
        return false;
    };
    let tag = tag.strip_prefix('/').unwrap_or(tag);
    let mut chars = tag.chars();
    if !chars.next().is_some_and(|ch| ch.is_ascii_alphabetic()) {
        return false;
    }
    let rest = chars.as_str();
    let after_name = rest
        .trim_start_matches(|ch: char| ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '-'));
    after_name.is_empty() || (after_name.starts_with(is_js_space) && !after_name.contains('>'))
}

fn section_label(line: &str) -> bool {
    let line = horizontal(line);
    let head = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&head) || !line[head..].starts_with([' ', '\t']) {
        return false;
    }
    let word = horizontal(&line[head..]);
    let end = word.find(is_js_space).unwrap_or(word.len());
    !word[..end].contains('#')
        && end > 0
        && matches!(word[end..].trim_matches([' ', '\t']), "" | ":")
}

fn first_line(text: &str) -> Option<Text> {
    let mut label = None;
    for raw in text.split('\n') {
        let line = trim(raw);
        if line.is_empty() || noise(line) {
            continue;
        }
        let bare = bare_line(line);
        if bare.is_empty() || noise(bare) {
            continue;
        }
        if section_label(line) {
            label.get_or_insert_with(|| clip(bare.strip_suffix(':').unwrap_or(bare)));
        } else {
            return Some(clip(bare));
        }
    }
    label
}

fn junk(title: &str) -> bool {
    let text = trim(title);
    if text.is_empty()
        || text.starts_with(&format!("<{WRAPPER}"))
        || text.starts_with(&format!("</{WRAPPER}"))
    {
        return true;
    }
    if text
        .strip_suffix(':')
        .unwrap_or(text)
        .eq_ignore_ascii_case("Complete assignment thoroughly")
        || text
            .strip_suffix('.')
            .unwrap_or(text)
            .eq_ignore_ascii_case("You are a subagent spawned by another session")
        || text == "session"
    {
        return true;
    }
    ignore_case_prefix(text, "Session ").is_some_and(|id| {
        let bytes = id.as_bytes();
        bytes.len() >= 14
            && bytes[8] == b'-'
            && bytes[13] == b'-'
            && bytes[..8]
                .iter()
                .chain(&bytes[9..13])
                .all(u8::is_ascii_hexdigit)
    })
}

fn explicit(body: &str) -> Option<String> {
    let rest = horizontal(body).strip_prefix("Title:").map(horizontal)?;
    let line = rest
        .split('\n')
        .next()
        .unwrap_or_default()
        .strip_suffix('\r')
        .unwrap_or_else(|| rest.split('\n').next().unwrap_or_default());
    if line.contains('\r') {
        return None;
    }
    let line = line.trim_end_matches([' ', '\t']);
    (!line.is_empty() && !line.starts_with(is_js_space) && line.encode_utf16().count() <= TITLE_MAX)
        .then(|| line.to_owned())
}

pub fn facts<'a>(text: &'a str, session_name: Option<&str>) -> Facts<'a> {
    let (body, agent_message, subagent_assignment) = unwrap(text);
    let explicit = explicit(body);
    let title = explicit
        .as_deref()
        .map(|text| Text(text.encode_utf16().collect()))
        .or_else(|| {
            session_name
                .map(trim)
                .filter(|name| !name.is_empty() && !junk(name))
                .map(clip)
        })
        .or_else(|| first_line(body));
    Facts {
        agent: agent_message || subagent_assignment,
        agent_message,
        subagent_assignment,
        junk: junk(text),
        title,
        explicit,
        body,
        first_line: first_line(text),
    }
}
