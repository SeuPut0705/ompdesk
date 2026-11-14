//! JSON.parse and stringify need UTF-16 strings, overflow-to-null numbers, and nesting beyond serde's limit.
//! The flat arena preserves lone surrogates and processes deeply nested documents without recursive traversal.

use super::redactor::{inert, redact_units, secret_field};
use crate::control::js::json_number;

#[derive(Debug)]
enum Node {
    Atom(String),
    Text(Vec<u16>),
    Array(Vec<usize>),
    Object(Vec<(Vec<u16>, usize)>),
}

struct Frame {
    node: usize,
    state: u8,
    key: Vec<u16>,
}

struct Parser<'a> {
    input: &'a str,
    at: usize,
    nodes: Vec<Node>,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.input.as_bytes().get(self.at).is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r')) { self.at += 1; }
    }

    fn take(&mut self, byte: u8) -> bool {
        if self.input.as_bytes().get(self.at) == Some(&byte) { self.at += 1; true } else { false }
    }

    fn string(&mut self) -> Option<Vec<u16>> {
        if !self.take(b'"') { return None; }
        let mut out = Vec::new();
        loop {
            let b = *self.input.as_bytes().get(self.at)?;
            self.at += 1;
            match b {
                b'"' => return Some(out),
                0..=31 => return None,
                b'\\' => {
                    let esc = *self.input.as_bytes().get(self.at)?;
                    self.at += 1;
                    let c = match esc {
                        b'"' | b'\\' | b'/' => u16::from(esc),
                        b'b' => 8, b'f' => 12, b'n' => 10, b'r' => 13, b't' => 9,
                        b'u' => {
                            let digits = self.input.get(self.at..self.at + 4)?;
                            if !digits.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
                            self.at += 4;
                            u16::from_str_radix(digits, 16).ok()?
                        }
                        _ => return None,
                    };
                    out.push(c);
                }
                32..=127 => out.push(u16::from(b)),
                _ => {
                    self.at -= 1;
                    let c = self.input[self.at..].chars().next()?;
                    self.at += c.len_utf8();
                    let mut units = [0; 2];
                    out.extend_from_slice(c.encode_utf16(&mut units));
                }
            }
        }
    }

    fn value(&mut self) -> Option<(usize, bool)> {
        self.ws();
        let b = *self.input.as_bytes().get(self.at)?;
        let (node, container) = match b {
            b'[' => { self.at += 1; (Node::Array(Vec::new()), true) }
            b'{' => { self.at += 1; (Node::Object(Vec::new()), true) }
            b'"' => (Node::Text(self.string()?), false),
            b't' | b'f' | b'n' => {
                let word = match b { b't' => "true", b'f' => "false", _ => "null" };
                if !self.input[self.at..].starts_with(word) { return None; }
                self.at += word.len();
                (Node::Atom(word.into()), false)
            }
            b'-' | b'0'..=b'9' => {
                let start = self.at;
                self.take(b'-');
                if !self.take(b'0') {
                    if !matches!(self.input.as_bytes().get(self.at), Some(b'1'..=b'9')) { return None; }
                    self.at += 1;
                    while matches!(self.input.as_bytes().get(self.at), Some(b'0'..=b'9')) { self.at += 1; }
                }
                if self.take(b'.') {
                    let begin = self.at;
                    while matches!(self.input.as_bytes().get(self.at), Some(b'0'..=b'9')) { self.at += 1; }
                    if self.at == begin { return None; }
                }
                if self.take(b'e') || self.take(b'E') {
                    if !self.take(b'+') { self.take(b'-'); }
                    let begin = self.at;
                    while matches!(self.input.as_bytes().get(self.at), Some(b'0'..=b'9')) { self.at += 1; }
                    if self.at == begin { return None; }
                }
                let n = self.input[start..self.at].parse::<f64>().ok()?;
                (Node::Atom(json_number(n)), false)
            }
            _ => return None,
        };
        let id = self.nodes.len();
        self.nodes.push(node);
        Some((id, container))
    }
}

fn set(items: &mut Vec<(Vec<u16>, usize)>, key: Vec<u16>, id: usize) {
    if let Some((_, existing)) = items.iter_mut().find(|(k, _)| *k == key) { *existing = id; }
    else { items.push((key, id)); }
}

fn index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key[0] == 48) { return None; }
    let mut n = 0u32;
    for c in key {
        if !(48..=57).contains(c) { return None; }
        n = n.checked_mul(10)?.checked_add(u32::from(*c - 48))?;
    }
    (n != u32::MAX).then_some(n)
}

fn order(items: &mut [(Vec<u16>, usize)]) {
    items.sort_by_key(|(key, _)| index(key).map_or((1, 0), |n| (0, n)));
}

fn parse(text: &str) -> Option<Vec<Node>> {
    let mut p = Parser { input: text, at: 0, nodes: Vec::new() };
    let (root, container) = p.value()?;
    let mut stack = Vec::new();
    if container { stack.push(Frame { node: root, state: 0, key: Vec::new() }); }
    while !stack.is_empty() {
        p.ws();
        let frame = stack.last_mut()?;
        let array = matches!(p.nodes[frame.node], Node::Array(_));
        if array {
            match frame.state {
                0 if p.take(b']') => { stack.pop(); continue; }
                1 => {
                    if p.take(b']') { stack.pop(); continue; }
                    if !p.take(b',') { return None; }
                    frame.state = 2;
                    continue;
                }
                _ => {}
            }
        } else {
            match frame.state {
                0 | 4 => {
                    if frame.state == 0 && p.take(b'}') { stack.pop(); continue; }
                    frame.key = p.string()?;
                    frame.state = 1;
                    continue;
                }
                1 => { if !p.take(b':') { return None; } frame.state = 2; continue; }
                3 => {
                    if p.take(b'}') { stack.pop(); continue; }
                    if !p.take(b',') { return None; }
                    frame.state = 4;
                    continue;
                }
                _ => {}
            }
        }
        let (id, container) = p.value()?;
        let frame = stack.last_mut()?;
        match &mut p.nodes[frame.node] {
            Node::Array(items) => { items.push(id); frame.state = 1; }
            Node::Object(items) => { set(items, std::mem::take(&mut frame.key), id); frame.state = 3; }
            _ => return None,
        }
        if container { stack.push(Frame { node: id, state: 0, key: Vec::new() }); }
    }
    p.ws();
    (p.at == text.len()).then_some(p.nodes)
}

fn quoted(text: &[u16], out: &mut String) {
    use std::fmt::Write;
    out.push('"');
    for decoded in char::decode_utf16(text.iter().copied()) {
        match decoded {
            Err(e) => { let _ = write!(out, "\\u{:04x}", e.unpaired_surrogate()); }
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if c < ' ' => { let _ = write!(out, "\\u{:04x}", c as u32); }
            Ok(c) => out.push(c),
        }
    }
    out.push('"');
}

enum Task { Value(usize, usize), Text(String) }

pub(super) fn redact(text: &str, indent: bool) -> Option<String> {
    let mut nodes = parse(text)?;
    let mut pending = vec![(0, false)];
    while let Some((id, secret)) = pending.pop() {
        match &mut nodes[id] {
            Node::Text(value) => {
                *value = if secret && !inert(value) { "<secret>".encode_utf16().collect() }
                    else { redact_units(std::mem::take(value)) };
            }
            Node::Array(items) => pending.extend(items.iter().map(|id| (*id, secret))),
            Node::Object(items) => {
                order(items);
                let mut redacted = Vec::new();
                for (key, child) in std::mem::take(items) {
                    let field = secret_field(&key);
                    pending.push((child, field));
                    set(&mut redacted, redact_units(key), child);
                }
                order(&mut redacted);
                *items = redacted;
            }
            Node::Atom(_) => {}
        }
    }
    let mut out = String::new();
    let mut tasks = vec![Task::Value(0, 0)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Text(s) => out.push_str(&s),
            Task::Value(id, depth) => match &nodes[id] {
                Node::Atom(s) => out.push_str(s),
                Node::Text(s) => quoted(s, &mut out),
                Node::Array(items) => {
                    out.push('[');
                    if items.is_empty() { out.push(']'); continue; }
                    tasks.push(Task::Text(if indent { format!("\n{}]", "  ".repeat(depth)) } else { "]".into() }));
                    for (i, child) in items.iter().enumerate().rev() {
                        tasks.push(Task::Value(*child, depth + 1));
                        tasks.push(Task::Text(if indent { format!("{}\n{}", if i > 0 { "," } else { "" }, "  ".repeat(depth + 1)) } else if i > 0 { ",".into() } else { String::new() }));
                    }
                }
                Node::Object(items) => {
                    out.push('{');
                    if items.is_empty() { out.push('}'); continue; }
                    tasks.push(Task::Text(if indent { format!("\n{}}}", "  ".repeat(depth)) } else { "}".into() }));
                    for (i, (key, child)) in items.iter().enumerate().rev() {
                        tasks.push(Task::Value(*child, depth + 1));
                        let mut prefix = if indent { format!("{}\n{}", if i > 0 { "," } else { "" }, "  ".repeat(depth + 1)) } else if i > 0 { ",".into() } else { String::new() };
                        quoted(key, &mut prefix);
                        prefix.push_str(if indent { ": " } else { ":" });
                        tasks.push(Task::Text(prefix));
                    }
                }
            },
        }
    }
    Some(out)
}
