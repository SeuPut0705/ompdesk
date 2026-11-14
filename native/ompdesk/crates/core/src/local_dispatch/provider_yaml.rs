use std::str::FromStr;

use serde_json::{Map, Value};
use yaml_edit::{AnchorRegistry, Document, Mapping, Scalar, ScalarType, ScalarValue, Sequence, YamlNode};

use super::protocol::CommandError;

type R<T> = Result<T, CommandError>;

pub struct ModelsDocument {
    doc: Document,
    pub raw: Value,
}

impl ModelsDocument {
    pub fn parse(text: &str) -> R<Self> {
        let mut doc = Document::from_str(text).map_err(|_| invalid_yaml())?;
        if doc.as_mapping().is_none() && doc.as_scalar().is_none() && doc.as_sequence().is_none() && doc.as_tagged().is_none() {
            doc = Document::from_str(&format!("{text}\n{{}}\n")).map_err(|_| invalid_yaml())?;
        }
        let anchors = AnchorRegistry::from_document(&doc);
        let raw = if let Some(mapping) = doc.as_mapping() {
            mapping_value(&mapping, &anchors, &mut 0)?
        } else if let Some(scalar) = doc.as_scalar() {
            scalar_value(&scalar)?
        } else if let Some(sequence) = doc.as_sequence() {
            sequence_value(&sequence, &anchors, &mut 0)?
        } else { return Err(invalid_yaml()); };
        let raw = if raw.is_null() { Value::Object(Map::new()) } else { raw };
        Ok(Self { doc, raw })
    }

    /// Stock normalizes legacy representations before a save. Apply its changes recursively so comments on
    /// unchanged fields and on the scalar being edited remain attached to the original CST nodes.
    pub fn render(self, normalized: &Value) -> R<String> {
        let root = self.doc.as_mapping().ok_or_else(invalid_yaml)?;
        let after = normalized.as_object().ok_or_else(invalid_yaml)?;
        patch_mapping(&root, self.raw.as_object(), after)?;
        Ok(self.doc.to_string())
    }
}

fn invalid_yaml() -> CommandError {
    CommandError::Other("models.yml: invalid YAML".into())
}

fn scalar_value(scalar: &Scalar) -> R<Value> {
    let value = ScalarValue::from_scalar(scalar);
    Ok(match value.scalar_type() {
        ScalarType::Null => Value::Null,
        ScalarType::Boolean => Value::Bool(value.to_bool().ok_or_else(invalid_yaml)?),
        ScalarType::Integer => {
            if let Some(integer) = value.to_i64() { Value::from(integer) }
            else { number(value.to_f64())? }
        }
        ScalarType::Float => number(value.to_f64())?,
        ScalarType::String | ScalarType::Timestamp | ScalarType::Regex => Value::String(scalar.as_string()),
        ScalarType::Binary => return Err(invalid_yaml()),
    })
}

fn number(value: Option<f64>) -> R<Value> {
    // JSON.stringify, the installed-stock boundary, writes non-finite YAML numbers as null.
    value.map(|value| serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)).ok_or_else(invalid_yaml)
}

fn node_value(node: &YamlNode, anchors: &AnchorRegistry, aliases: &mut usize) -> R<Value> {
    match node {
        YamlNode::Scalar(scalar) => scalar_value(scalar),
        YamlNode::Mapping(mapping) => mapping_value(mapping, anchors, aliases),
        YamlNode::Sequence(sequence) => sequence_value(sequence, anchors, aliases),
        YamlNode::Alias(alias) => {
            *aliases += 1;
            if *aliases > 100 { return Err(invalid_yaml()); }
            let resolved = anchors.resolve_alias(alias).map_err(|_| invalid_yaml())?;
            node_value(&resolved, anchors, aliases)
        }
        YamlNode::TaggedNode(tagged) => {
            if let Some(mapping) = tagged.as_mapping() { return mapping_value(&mapping, anchors, aliases); }
            if let Some(sequence) = tagged.as_sequence() { return sequence_value(&sequence, anchors, aliases); }
            let scalar = tagged.value().ok_or_else(invalid_yaml)?;
            if matches!(tagged.resolved_tag().as_deref(), Some("tag:yaml.org,2002:str" | "!!str")) {
                Ok(Value::String(scalar.as_string()))
            } else { scalar_value(&scalar) }
        }
    }
}

fn mapping_value(mapping: &Mapping, anchors: &AnchorRegistry, aliases: &mut usize) -> R<Value> {
    let mut out = Map::new();
    for (key, value) in mapping.iter() {
        let key = key.as_scalar().ok_or_else(invalid_yaml)?.as_string();
        if out.contains_key(&key) { return Err(invalid_yaml()); }
        out.insert(key, node_value(&value, anchors, aliases)?);
    }
    Ok(Value::Object(out))
}

fn sequence_value(sequence: &Sequence, anchors: &AnchorRegistry, aliases: &mut usize) -> R<Value> {
    sequence.values().map(|value| node_value(&value, anchors, aliases)).collect::<R<Vec<_>>>().map(Value::Array)
}

fn json_node(value: &Value) -> R<YamlNode> {
    let doc = Document::from_str(&format!("value: {}\n", value)).map_err(|_| invalid_yaml())?;
    doc.get("value").ok_or_else(invalid_yaml)
}

fn patch_mapping(mapping: &Mapping, before: Option<&Map<String, Value>>, after: &Map<String, Value>) -> R<()> {
    if let Some(before) = before {
        for key in before.keys().filter(|key| !after.contains_key(*key)) { mapping.remove(key.as_str()); }
    }
    for (key, value) in after {
        let old = before.and_then(|before| before.get(key));
        if old == Some(value) { continue; }
        let existing = mapping.get(key.as_str());
        if let (Some(old), Some(existing)) = (old, existing.as_ref()) {
            if patch_node(existing, old, value)? { continue; }
        }
        mapping.set(key.as_str(), json_node(value)?);
    }
    Ok(())
}

fn patch_node(node: &YamlNode, before: &Value, after: &Value) -> R<bool> {
    if let (Some(mapping), Some(before), Some(after)) = (node.as_mapping(), before.as_object(), after.as_object()) {
        patch_mapping(mapping, Some(before), after)?;
        return Ok(true);
    }
    if let (Some(sequence), Some(before), Some(after)) = (node.as_sequence(), before.as_array(), after.as_array()) {
        if before.len() == after.len() {
            for (index, (old, new)) in before.iter().zip(after).enumerate() {
                if old == new { continue; }
                if let Some(node) = sequence.get(index) {
                    if patch_node(&node, old, new)? { continue; }
                }
                sequence.set(index, json_node(new)?);
            }
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn editing_a_nested_scalar_keeps_comments_and_untouched_provider_bytes() {
        let original = "# Company gateway\nproviders:\n  untouched: # Leave this provider alone\n    api: openai-completions\n    baseUrl: https://legacy.invalid/v1\n  custom:\n    api: openai-completions\n    baseUrl: https://api.invalid/v1 # Keep this endpoint comment\n    compat: {supportsStore: true, extraBody: {seed: 42}}\n    models:\n      - id: model-a\n        compactionModel: compact\n";
        let document = ModelsDocument::parse(original).unwrap();
        let mut updated = document.raw.clone();
        updated["providers"]["custom"]["baseUrl"] = json!("https://api.invalid/v2");
        updated["providers"]["custom"]["compat"]["extraBody"] = json!({"temperature":0.5});
        let rendered = document.render(&updated).unwrap();
        assert!(rendered.contains("# Company gateway"));
        assert!(rendered.contains("untouched: # Leave this provider alone\n    api: openai-completions\n    baseUrl: https://legacy.invalid/v1"));
        assert!(rendered.contains("# Keep this endpoint comment"));
        assert_eq!(ModelsDocument::parse(&rendered).unwrap().raw, updated);
    }

    #[test]
    fn quoted_numbers_and_aliases_keep_their_types_and_duplicate_keys_are_refused() {
        let parsed = ModelsDocument::parse("defaults: &config {api: openai-completions}\nproviders:\n  custom: *config\ntext: '10'\nnumber: 10\n").unwrap();
        assert_eq!(parsed.raw["providers"]["custom"]["api"], "openai-completions");
        assert_eq!(parsed.raw["text"], "10");
        assert_eq!(parsed.raw["number"], 10);
        assert!(ModelsDocument::parse("providers: {}\nproviders: {}\n").is_err());
    }
}
