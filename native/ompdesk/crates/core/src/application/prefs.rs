//! The shared `prefs.json` used by SafeStore. Construct one instance at boot and share its Arc.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Map, Value};

use crate::disk::saves::{disk_full, write_kept};
use crate::remote::events::js;
use crate::server::Fault;

pub struct Prefs {
    file: PathBuf,
    values: Mutex<Value>,
}

#[derive(Debug)]
enum Segment {
    Key(String),
    Index(usize),
}

impl Prefs {
    /// `user_data` is supplied by the native application, never by a page.
    pub fn open(user_data: &Path) -> Result<Arc<Self>, Fault> {
        let file = user_data.join("prefs.json");
        let values = match std::fs::read(&file) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|error| Fault::new("prefs_json", error.to_string()))?;
                match value {
                    Value::Object(_) => normalize(value),
                    Value::Null | Value::Bool(_) | Value::Number(_) => Value::Object(Map::new()),
                    Value::String(text) => Value::Object(
                        text.chars()
                            .enumerate()
                            .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
                            .collect(),
                    ),
                    Value::Array(items) => Value::Object(
                        items
                            .into_iter()
                            .enumerate()
                            .map(|(i, v)| (i.to_string(), normalize(v)))
                            .collect(),
                    ),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Object(Map::new()),
            Err(error) => {
                return Err(crate::fs::error::NodeError::new(
                    &error,
                    "open",
                    Some(&file.to_string_lossy()),
                )
                .fault(crate::fs::error::Codes::None));
            }
        };
        Ok(Arc::new(Self {
            file,
            values: Mutex::new(values),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, Value> {
        self.values
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn snapshot(&self) -> Value {
        self.lock().clone()
    }

    pub fn get(&self, path: &str) -> Result<Option<Value>, Fault> {
        let segments = segments(path)?;
        let values = self.lock();
        Ok(lookup(&values, &segments).cloned())
    }

    pub fn has(&self, path: &str) -> Result<bool, Fault> {
        Ok(self.get(path)?.is_some())
    }

    pub fn set(&self, path: &str, value: Value) -> Result<(), Fault> {
        if path.starts_with("__internal__.") {
            return Err(Fault::new(
                "prefs_key",
                "Please don't use the __internal__ key, as it's used to manage this module internal operations.",
            ));
        }
        let segments = segments(path)?;
        let mut values = self.lock();
        let mut next = values.clone();
        assign(&mut next, &segments, normalize(value))?;
        self.save(&next)?;
        *values = next;
        Ok(())
    }

    pub fn delete(&self, path: &str) -> Result<(), Fault> {
        let segments = segments(path)?;
        let mut values = self.lock();
        let mut next = values.clone();
        remove(&mut next, &segments)?;
        self.save(&next)?;
        *values = next;
        Ok(())
    }

    fn save(&self, values: &Value) -> Result<(), Fault> {
        let bytes = pretty(values);
        match write_kept(&self.file, bytes.as_bytes(), None, 0o777) {
            Ok(_) => Ok(()),
            Err(error) if disk_full(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

fn normalize(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut result = Map::new();
            for (key, value) in map {
                js::set(&mut result, key, normalize(value));
            }
            Value::Object(result)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        other => other,
    }
}

fn segments(path: &str) -> Result<Vec<Segment>, Fault> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut state = 0; // start, property, index, index end
    let mut escaped = false;
    for c in path.chars() {
        match c {
            '\\' if state == 2 => {
                return Err(Fault::new("prefs_key", "Invalid character in an index"));
            }
            '\\' if state == 3 => {
                return Err(Fault::new("prefs_key", "Invalid character after an index"));
            }
            '\\' => {
                if escaped {
                    current.push('\\');
                }
                escaped = !escaped;
                state = 1;
            }
            '.' if state == 2 => {
                return Err(Fault::new("prefs_key", "Invalid character in an index"));
            }
            '.' if state == 3 => state = 1,
            '.' if escaped => {
                escaped = false;
                current.push('.');
            }
            '.' => {
                if forbidden(&current) {
                    return Ok(Vec::new());
                }
                parts.push(Segment::Key(std::mem::take(&mut current)));
                state = 1;
            }
            '[' if state == 2 => {
                return Err(Fault::new("prefs_key", "Invalid character in an index"));
            }
            '[' if state == 3 => state = 2,
            '[' if escaped => {
                escaped = false;
                current.push('[');
            }
            '[' => {
                if state == 1 {
                    if forbidden(&current) {
                        return Ok(Vec::new());
                    }
                    parts.push(Segment::Key(std::mem::take(&mut current)));
                }
                state = 2;
            }
            ']' if state == 2 => {
                let index = current
                    .parse()
                    .map_err(|_| Fault::new("prefs_key", "Invalid array index"))?;
                parts.push(Segment::Index(index));
                current.clear();
                state = 3;
            }
            _ if state == 3 => {
                return Err(Fault::new("prefs_key", "Invalid character after an index"));
            }
            _ if state == 2 && !c.is_ascii_digit() => {
                return Err(Fault::new("prefs_key", "Invalid character in an index"));
            }
            _ => {
                if state == 0 {
                    state = 1;
                }
                if escaped {
                    current.push('\\');
                    escaped = false;
                }
                current.push(c);
            }
        }
    }
    if escaped {
        current.push('\\');
    }
    match state {
        2 => return Err(Fault::new("prefs_key", "Index was not closed")),
        0 | 1 => {
            if forbidden(&current) {
                return Ok(Vec::new());
            }
            parts.push(Segment::Key(current));
        }
        _ => {}
    }
    Ok(parts)
}

fn forbidden(key: &str) -> bool {
    matches!(key, "__proto__" | "prototype" | "constructor")
}

fn lookup<'a>(mut value: &'a Value, path: &[Segment]) -> Option<&'a Value> {
    if path.is_empty() {
        return None;
    }
    for part in path {
        value = match (value, part) {
            (Value::Object(map), Segment::Key(key)) => map.get(key)?,
            (Value::Object(map), Segment::Index(index)) => map.get(&index.to_string())?,
            (Value::Array(array), Segment::Index(index)) => array.get(*index)?,
            _ => return None,
        };
    }
    Some(value)
}

fn assign(value: &mut Value, path: &[Segment], new: Value) -> Result<(), Fault> {
    let Some((first, rest)) = path.split_first() else {
        return Ok(());
    };
    match value {
        Value::Object(map) => {
            let key = match first {
                Segment::Key(key) => key.clone(),
                Segment::Index(index) => index.to_string(),
            };
            if rest.is_empty() {
                js::set(map, key, new);
            } else {
                if !matches!(map.get(&key), Some(Value::Object(_) | Value::Array(_))) {
                    js::set(
                        map,
                        key.clone(),
                        if matches!(rest[0], Segment::Index(_)) {
                            Value::Array(Vec::new())
                        } else {
                            Value::Object(Map::new())
                        },
                    );
                }
                assign(map.get_mut(&key).expect("inserted key"), rest, new)?;
            }
        }
        Value::Array(array) => {
            let Segment::Index(index) = first else {
                return Err(Fault::new("prefs_key", "Cannot use string index"));
            };
            if *index >= array.len() {
                array.resize(index + 1, Value::Null);
            }
            if rest.is_empty() {
                array[*index] = new;
            } else {
                if !matches!(array[*index], Value::Object(_) | Value::Array(_)) {
                    array[*index] = if matches!(rest[0], Segment::Index(_)) {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(Map::new())
                    };
                }
                assign(&mut array[*index], rest, new)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn remove(value: &mut Value, path: &[Segment]) -> Result<(), Fault> {
    let Some((first, rest)) = path.split_first() else {
        return Ok(());
    };
    match value {
        Value::Object(map) => {
            let key = match first {
                Segment::Key(key) => key.clone(),
                Segment::Index(index) => index.to_string(),
            };
            if rest.is_empty() {
                map.shift_remove(&key);
            } else if let Some(child) = map.get_mut(&key) {
                remove(child, rest)?;
            }
        }
        Value::Array(array) => {
            let Segment::Index(index) = first else {
                return Err(Fault::new("prefs_key", "Cannot use string index"));
            };
            if let Some(child) = array.get_mut(*index) {
                if rest.is_empty() {
                    *child = Value::Null;
                } else {
                    remove(child, rest)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn pretty(value: &Value) -> String {
    let compact = js::stringify(value);
    let mut out = String::new();
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escape = false;
    let mut chars = compact.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                quoted = false;
            }
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                out.push(c);
            }
            '{' | '[' => {
                out.push(c);
                depth += 1;
                if !matches!(chars.peek(), Some('}' | ']')) {
                    out.push('\n');
                    out.push_str(&"\t".repeat(depth));
                }
            }
            '}' | ']' => {
                depth -= 1;
                if !matches!(out.chars().last(), Some('{' | '[')) {
                    out.push('\n');
                    out.push_str(&"\t".repeat(depth));
                }
                out.push(c);
            }
            ',' => {
                out.push(c);
                out.push('\n');
                out.push_str(&"\t".repeat(depth));
            }
            ':' => out.push_str(": "),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
#[path = "prefs_tests.rs"]
mod tests;
