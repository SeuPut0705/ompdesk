//! The human settings editor's raw models.yml contract. Text is never masked; authorization is
//! enforced by the native channel registry. This service has one mutation lane, validates through
//! stock, preserves the parsed document's comments, and atomically replaces a symlink's target.

use super::actions::{Models, ModelsText};
use super::deps::BoxFuture;
use crate::disk::tree;
use crate::fs::disk;
use crate::server::{Fault, Scope};
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use serde_saphyr::Commented;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const SKELETON: &str = "# Custom model providers.\nproviders: {}\n";

/// The existing stock ModelsConfigSchema, not an OMPdesk schema or provider roster copy.
trait Validator: Send + Sync {
    fn normalize(&self, config: Value) -> BoxFuture<'_, Result<Value, Fault>>;
}
impl Validator for crate::stock::native::Service {
    fn normalize(&self, config: Value) -> BoxFuture<'_, Result<Value, Fault>> {
        Box::pin(async move {
            let result = self
                .request(
                    "models.validate",
                    &serde_json::json!({"config":config}),
                    Duration::from_secs(30),
                    Scope::detached(),
                )
                .await?;
            if let Some(message) = result.get("error").and_then(Value::as_str) {
                return Err(invalid(message));
            }
            result.get("config").cloned().ok_or_else(|| {
                invalid("Stock omp did not return a normalized models.yml configuration")
            })
        })
    }
}
pub struct Service {
    agent_dir: PathBuf,
    stock: Arc<dyn Validator>,
    mutation: tokio::sync::Mutex<()>,
}
impl Service {
    pub fn new(agent_dir: PathBuf, stock: Arc<crate::stock::native::Service>) -> Self {
        Self::with_validator(agent_dir, stock)
    }
    fn with_validator(agent_dir: PathBuf, stock: Arc<dyn Validator>) -> Self {
        Self {
            agent_dir,
            stock,
            mutation: tokio::sync::Mutex::new(()),
        }
    }
    pub fn path(&self) -> PathBuf {
        models_path(&self.agent_dir)
    }
    pub async fn read_text(&self) -> Result<ModelsText, Fault> {
        let dir = self.agent_dir.clone();
        tokio::task::spawn_blocking(move || read(&dir))
            .await
            .map_err(join_error)?
    }
    pub async fn write_text(&self, text: &str, expected: &str) -> Result<String, Fault> {
        let _mutation = self.mutation.lock().await;
        let file = self.path();
        let before = stamp(&file)?;
        if token(before.as_ref()) != expected {
            return Err(invalid(format!(
                "{} changed on disk since it was opened. Nothing was written; reopen it.",
                file.display()
            )));
        }
        let mut doc: Commented<Node> = serde_saphyr::from_str_with_options(
            text,
            serde_saphyr::options! {strict_booleans: true},
        )
        .map_err(|error| {
            let at = error
                .location()
                .map(|at| format!(" at line {}, column {}", at.line(), at.column()))
                .unwrap_or_default();
            invalid(format!("models.yml: invalid YAML{at}"))
        })?;
        let raw = doc.0.json();
        let normalized = self
            .stock
            .normalize(if raw.is_null() {
                serde_json::json!({})
            } else {
                raw.clone()
            })
            .await?;
        let output = if raw == normalized {
            text.to_owned()
        } else {
            doc.0.apply(normalized);
            let mut output = serde_saphyr::to_string_with_options(
                &doc,
                serde_saphyr::ser_options! {
                    comment_position: serde_saphyr::CommentPosition::Above,
                },
            )
            .map_err(|_| invalid("models.yml could not be formatted"))?;
            let trailer = document_trailer(text)?;
            if !trailer.is_empty() {
                if !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push_str(&trailer);
            }
            output
        };
        let dir = self.agent_dir.clone();
        tokio::task::spawn_blocking(move || commit(&dir, &file, before.as_ref(), output.as_bytes()))
            .await
            .map_err(join_error)?
    }
}
impl Models for Service {
    fn read(&self) -> BoxFuture<'_, Result<ModelsText, Fault>> {
        Box::pin(self.read_text())
    }
    fn write<'a>(&'a self, text: &'a str, stamp: &'a str) -> BoxFuture<'a, Result<String, Fault>> {
        Box::pin(self.write_text(text, stamp))
    }
}

// Document-end comments are outside serde's node wrappers; the same parser owns their syntax.
fn document_trailer(text: &str) -> Result<String, Fault> {
    use serde_saphyr::granit_parser::{Event, Parser, Placement};
    let mut seen_node = false;
    let mut trailer = String::new();
    for event in Parser::new_from_str(text) {
        match event.map_err(|_| invalid("models.yml: invalid YAML"))?.0 {
            Event::Alias(_)
            | Event::Scalar(..)
            | Event::SequenceStart(..)
            | Event::MappingStart(..) => {
                seen_node = true;
                trailer.clear();
            }
            Event::Comment(comment, placement) if seen_node && placement != Placement::Right => {
                trailer.push('#');
                trailer.push_str(&comment);
                trailer.push('\n');
            }
            _ => {}
        }
    }
    Ok(trailer)
}
fn invalid(message: impl Into<String>) -> Fault {
    Fault::new("invalid_content", message)
}
fn join_error(error: tokio::task::JoinError) -> Fault {
    Fault::new("internal", error.to_string())
}
fn models_path(dir: &Path) -> PathBuf {
    let yml = dir.join("models.yml");
    if yml.exists() {
        return yml;
    }
    let yaml = dir.join("models.yaml");
    if yaml.exists() { yaml } else { yml }
}
#[derive(PartialEq)]
struct Stamp {
    mtime: f64,
    size: u64,
    ino: u64,
}
fn stamp(file: &Path) -> Result<Option<Stamp>, Fault> {
    let meta = match fs::metadata(file) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(tree::fault(&error, "stat", file)),
    };
    #[cfg(unix)]
    let ino = {
        use std::os::unix::fs::MetadataExt;
        meta.ino()
    };
    #[cfg(windows)]
    let ino = {
        let opened = fs::File::open(file).map_err(|e| tree::fault(&e, "open", file))?;
        crate::sys::file_identity(&opened)
            .map_err(|e| tree::fault(&e, "fstat", file))?
            .1
    };
    Ok(Some(Stamp {
        mtime: disk::mtime_ms(&meta),
        size: meta.len(),
        ino,
    }))
}
fn token(stamp: Option<&Stamp>) -> String {
    match stamp {
        None => "missing".into(),
        Some(stamp) => format!("{}:{}:{}", stamp.mtime, stamp.size, stamp.ino),
    }
}
fn read(dir: &Path) -> Result<ModelsText, Fault> {
    let file = models_path(dir);
    let stamp = stamp(&file)?;
    let text = if stamp.is_some() {
        String::from_utf8_lossy(&fs::read(&file).map_err(|e| tree::fault(&e, "open", &file))?)
            .into_owned()
    } else {
        SKELETON.into()
    };
    Ok(ModelsText {
        path: file.to_string_lossy().into_owned(),
        text,
        exists: stamp.is_some(),
        stamp: token(stamp.as_ref()),
    })
}
fn commit(dir: &Path, file: &Path, before: Option<&Stamp>, bytes: &[u8]) -> Result<String, Fault> {
    let conflict = || {
        invalid(format!(
            "{} changed on disk while it was being saved. Nothing was written; try again.",
            file.display()
        ))
    };
    if models_path(dir) != file || stamp(file)?.as_ref() != before {
        return Err(conflict());
    }
    if before.is_none() && fs::symlink_metadata(file).is_ok_and(|m| m.file_type().is_symlink()) {
        let link = fs::read_link(file).map_err(|e| tree::fault(&e, "readlink", file))?;
        let target = super::paths::resolve(&file.parent().unwrap_or(dir).join(link));
        return Err(invalid(format!(
            "{} links to {}, which does not exist. Nothing was written; fix or remove the link.",
            file.display(),
            target.display()
        )));
    }
    let (target, mode) = if before.is_some() {
        let target = fs::canonicalize(file).map_err(|e| tree::fault(&e, "realpath", file))?;
        let meta = fs::metadata(&target).map_err(|e| tree::fault(&e, "stat", &target))?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o7777
        };
        #[cfg(windows)]
        let mode = if meta.permissions().readonly() {
            0o444
        } else {
            0o666
        };
        (target, mode)
    } else {
        (file.to_path_buf(), 0o600)
    };
    let replaced = tree::write_atomic_if(&target, bytes, Some(mode), 0o777, &|| {
        models_path(dir) == file
            && stamp(file).is_ok_and(|now| now.as_ref() == before)
            && (before.is_some()
                || !fs::symlink_metadata(file).is_ok_and(|m| m.file_type().is_symlink()))
            && (before.is_none() || fs::canonicalize(file).is_ok_and(|now| now == target))
    })?;
    if !replaced {
        return Err(conflict());
    }
    Ok(token(stamp(&models_path(dir))?.as_ref()))
}

/// This is a document tree over serde-saphyr, not another YAML parser. The existing parser owns
/// scalar/alias/merge/comment syntax; existing nodes retain their comments when stock normalizes.
enum Node {
    Scalar(Value),
    Seq(Vec<Commented<Node>>),
    Map(Vec<(Commented<String>, Commented<Node>)>),
}
impl Node {
    fn json(&self) -> Value {
        match self {
            Self::Scalar(value) => value.clone(),
            Self::Seq(values) => Value::Array(values.iter().map(|v| v.0.json()).collect()),
            Self::Map(values) => Value::Object(
                values
                    .iter()
                    .map(|(k, v)| (k.0.clone(), v.0.json()))
                    .collect(),
            ),
        }
    }
    fn from_json(value: Value) -> Self {
        match value {
            Value::Array(values) => Self::Seq(
                values
                    .into_iter()
                    .map(|v| Commented(Self::from_json(v), String::new()))
                    .collect(),
            ),
            Value::Object(values) => Self::Map(
                values
                    .into_iter()
                    .map(|(k, v)| {
                        (
                            Commented(k, String::new()),
                            Commented(Self::from_json(v), String::new()),
                        )
                    })
                    .collect(),
            ),
            value => Self::Scalar(value),
        }
    }
    fn apply(&mut self, value: Value) {
        match (self, value) {
            (Self::Map(old), Value::Object(mut next)) => {
                old.retain(|(key, _)| next.contains_key(&key.0));
                for (key, value) in old.iter_mut() {
                    if let Some(next) = next.remove(&key.0) {
                        value.0.apply(next);
                    }
                }
                old.extend(next.into_iter().map(|(k, v)| {
                    (
                        Commented(k, String::new()),
                        Commented(Self::from_json(v), String::new()),
                    )
                }));
            }
            (Self::Seq(old), Value::Array(next)) if old.len() == next.len() => {
                for (old, next) in old.iter_mut().zip(next) {
                    old.0.apply(next);
                }
            }
            (node, next) => *node = Self::from_json(next),
        }
    }
}
impl Serialize for Node {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Scalar(value) => value.serialize(serializer),
            Self::Seq(values) => {
                let mut seq = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    seq.serialize_element(value)?;
                }
                seq.end()
            }
            Self::Map(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    if key.1.is_empty() {
                        map.serialize_entry(&key.0, value)?;
                    } else {
                        map.serialize_entry(key, value)?;
                    }
                }
                map.end()
            }
        }
    }
}
impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NodeVisitor;
        impl<'de> Visitor<'de> for NodeVisitor {
            type Value = Node;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a YAML configuration value")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Node, E> {
                Ok(Node::Scalar(Value::Null))
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<Node, E> {
                self.visit_unit()
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Node, E> {
                Ok(Node::Scalar(v.into()))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Node, E> {
                Ok(Node::Scalar(v.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Node, E> {
                Ok(Node::Scalar(v.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Node, E> {
                serde_json::Number::from_f64(v)
                    .map(|v| Node::Scalar(v.into()))
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Node, E> {
                Ok(Node::Scalar(v.into()))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Node, E> {
                Ok(Node::Scalar(v.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element()? {
                    values.push(value);
                }
                Ok(Node::Seq(values))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
                let mut values = Vec::new();
                while let Some(pair) = map.next_entry()? {
                    values.push(pair);
                }
                Ok(Node::Map(values))
            }
        }
        deserializer.deserialize_any(NodeVisitor)
    }
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;
