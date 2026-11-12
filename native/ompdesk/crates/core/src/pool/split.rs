//! The split geometry of a window's tabs (a Rust copy of the functions of `src/shared/split-layout.ts` the pool and the
//! layout rules read; the page runs the TypeScript, which also holds the helpers only the page uses). The two are
//! pinned to one table captured from the TypeScript (`split-captured.json`, the `captured` test below): every
//! function here gives the answer the TypeScript gave for the same input.
//!
//! A split is a tree of at most four leaves (tab ids), `{axis, ratio, first, second}`; a leaf is `{tabId}`.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Axis {
    Columns,
    Rows,
}

impl Axis {
    fn name(self) -> &'static str {
        match self {
            Axis::Columns => "columns",
            Axis::Rows => "rows",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum SplitNode {
    Leaf(String),
    Split(Box<SplitLayout>),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SplitLayout {
    pub axis: Axis,
    pub ratio: f64,
    pub first: SplitNode,
    pub second: SplitNode,
}

impl SplitNode {
    pub(crate) fn to_value(&self) -> Value {
        match self {
            SplitNode::Leaf(tab_id) => json!({ "tabId": tab_id }),
            SplitNode::Split(split) => split.to_value(),
        }
    }
}

impl SplitLayout {
    pub(crate) fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("axis".into(), Value::from(self.axis.name()));
        map.insert("ratio".into(), Value::from(self.ratio));
        map.insert("first".into(), self.first.to_value());
        map.insert("second".into(), self.second.to_value());
        Value::Object(map)
    }

    pub(crate) fn tab_ids(&self) -> Vec<String> {
        let mut ids = split_tab_ids(&self.first);
        ids.extend(split_tab_ids(&self.second));
        ids
    }

    pub(crate) fn contains(&self, tab_id: &str) -> bool {
        self.first_has(tab_id) || self.second_has(tab_id)
    }

    fn first_has(&self, tab_id: &str) -> bool {
        node_has(&self.first, tab_id)
    }

    fn second_has(&self, tab_id: &str) -> bool {
        node_has(&self.second, tab_id)
    }
}

fn node_has(node: &SplitNode, tab_id: &str) -> bool {
    match node {
        SplitNode::Leaf(id) => id == tab_id,
        SplitNode::Split(split) => split.contains(tab_id),
    }
}

pub(crate) fn split_tab_ids(node: &SplitNode) -> Vec<String> {
    match node {
        SplitNode::Leaf(id) => vec![id.clone()],
        SplitNode::Split(split) => split.tab_ids(),
    }
}

/// `mapSplitLeaves`: each leaf becomes what `map` says (`None` drops it); a split that loses one side is the other.
pub(crate) fn map_split_leaves(
    node: &SplitNode,
    map: &mut dyn FnMut(&str) -> Option<SplitNode>,
) -> Option<SplitNode> {
    match node {
        SplitNode::Leaf(id) => map(id),
        SplitNode::Split(split) => {
            let first = map_split_leaves(&split.first, map);
            let second = map_split_leaves(&split.second, map);
            match (first, second) {
                (Some(first), Some(second)) => Some(SplitNode::Split(Box::new(SplitLayout {
                    axis: split.axis,
                    ratio: split.ratio,
                    first,
                    second,
                }))),
                (first, second) => first.or(second),
            }
        }
    }
}

/// `asSplitLayout`: a node that is a split, else nothing.
pub(crate) fn as_split_layout(node: Option<SplitNode>) -> Option<SplitLayout> {
    match node {
        Some(SplitNode::Split(split)) => Some(*split),
        _ => None,
    }
}

/// `withoutSplitTab`: the split with `tab_id` taken out, or nothing once it holds fewer than two tabs.
pub(crate) fn without_split_tab(split: &SplitLayout, tab_id: &str) -> Option<SplitLayout> {
    let node = SplitNode::Split(Box::new(split.clone()));
    as_split_layout(map_split_leaves(&node, &mut |id| {
        (id != tab_id).then(|| SplitNode::Leaf(id.to_string()))
    }))
}

fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// `readSplitNode`: boundary validation; legacy two-pane records (`firstTabId`, `secondTabId`) migrate here.
pub(crate) fn read_split_node(value: &Value, depth: u32) -> Option<SplitNode> {
    // `!value || typeof value !== "object"`: an array is an object to JavaScript, and has none of the keys below.
    let object = value.as_object()?;
    if depth > 3 {
        return None;
    }
    if let Some(tab_id) = string_field(object, "tabId") {
        return Some(SplitNode::Leaf(tab_id.to_string()));
    }
    let axis = match string_field(object, "axis")? {
        "columns" => Axis::Columns,
        "rows" => Axis::Rows,
        _ => return None,
    };
    let ratio = object
        .get("ratio")?
        .as_f64()
        .filter(|ratio| ratio.is_finite())?;
    let side = |tab_key: &str, key: &str| -> Option<SplitNode> {
        if let Some(tab_id) = string_field(object, tab_key) {
            return Some(SplitNode::Leaf(tab_id.to_string()));
        }
        read_split_node(object.get(key)?, depth + 1)
    };
    let first = side("firstTabId", "first")?;
    let second = side("secondTabId", "second")?;
    let layout = SplitLayout {
        axis,
        ratio: ratio.clamp(0.2, 0.8),
        first,
        second,
    };
    let ids = layout.tab_ids();
    let unique: HashSet<&String> = ids.iter().collect();
    (ids.len() <= 4 && unique.len() == ids.len()).then(|| SplitNode::Split(Box::new(layout)))
}

/// `rememberedSplitOf`: the remembered split `tab_id` belongs to (a session is in at most one).
pub(crate) fn remembered_split_of<'a>(
    splits: &'a [SplitLayout],
    tab_id: &str,
) -> Option<&'a SplitLayout> {
    splits.iter().find(|split| split.contains(tab_id))
}

/// `forgetSplitTab`: `tab_id` leaves its remembered split; a split left with one session dissolves.
pub(crate) fn forget_split_tab(splits: &[SplitLayout], tab_id: &str) -> Vec<SplitLayout> {
    let Some(owner) = splits.iter().position(|split| split.contains(tab_id)) else {
        return splits.to_vec();
    };
    let rest = without_split_tab(&splits[owner], tab_id);
    splits
        .iter()
        .enumerate()
        .flat_map(|(index, split)| {
            if index != owner {
                vec![split.clone()]
            } else {
                rest.iter().cloned().collect()
            }
        })
        .collect()
}

/// Cap on remembered splits per window (a split holds at least two of the window's tabs).
const MAX_REMEMBERED_SPLITS: usize = 16;

/// `readRememberedSplits`: boundary validation of remembered splits. `resolve` maps a stored leaf to the tab id it
/// stands for (`None`: the tab is gone); `claimed` holds the sessions already placed and grows with every kept split,
/// so a session ends up in at most one.
pub(crate) fn read_remembered_splits(
    value: &Value,
    resolve: &mut dyn FnMut(&str) -> Option<String>,
    claimed: &mut HashSet<String>,
) -> Vec<SplitLayout> {
    let Some(candidates) = value.as_array() else {
        return Vec::new();
    };
    let mut kept: Vec<SplitLayout> = Vec::new();
    for candidate in candidates {
        if kept.len() >= MAX_REMEMBERED_SPLITS {
            break;
        }
        let Some(parsed) = read_split_node(candidate, 0) else {
            continue;
        };
        let mapped = map_split_leaves(&parsed, &mut |source| {
            let id = resolve(source)?;
            (!claimed.contains(&id)).then_some(SplitNode::Leaf(id))
        });
        let Some(split) = as_split_layout(mapped) else {
            continue;
        };
        let ids = split.tab_ids();
        let unique: HashSet<&String> = ids.iter().collect();
        if unique.len() != ids.len() {
            continue;
        }
        claimed.extend(ids);
        kept.push(split);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows captured from `src/shared/split-layout.ts` (`scripts` of the batch: every case ran through the
    /// TypeScript functions, and its answer is stored beside its input).
    const CAPTURED: &str = include_str!("split-captured.json");

    fn layouts(value: &Value) -> Vec<Value> {
        value
            .as_array()
            .map(|splits| splits.iter().map(Value::clone).collect())
            .unwrap_or_default()
    }

    /// The captured layouts as the TypeScript held them, ratios as written (`readSplitNode` would clamp them).
    fn raw_node(value: &Value) -> SplitNode {
        if let Some(tab_id) = value["tabId"].as_str() {
            return SplitNode::Leaf(tab_id.to_string());
        }
        SplitNode::Split(Box::new(SplitLayout {
            axis: if value["axis"] == "columns" {
                Axis::Columns
            } else {
                Axis::Rows
            },
            ratio: value["ratio"].as_f64().expect("ratio"),
            first: raw_node(&value["first"]),
            second: raw_node(&value["second"]),
        }))
    }

    fn parse_layouts(value: &Value) -> Vec<SplitLayout> {
        layouts(value)
            .iter()
            .map(|split| as_split_layout(Some(raw_node(split))).expect("a captured split is valid"))
            .collect()
    }

    fn values(splits: &[SplitLayout]) -> Value {
        Value::Array(splits.iter().map(SplitLayout::to_value).collect())
    }

    #[test]
    fn captured() {
        let table: Value = serde_json::from_str(CAPTURED).expect("captured rows");
        let mut count = 0;
        for row in table["readNode"].as_array().expect("readNode rows") {
            let got = read_split_node(&row["input"], 0).map(|node| node.to_value());
            assert_eq!(
                got.unwrap_or(Value::Null),
                row["output"],
                "readSplitNode {}",
                row["input"]
            );
            count += 1;
        }
        for row in table["remembered"].as_array().expect("remembered rows") {
            let mapping = row["resolve"].as_object().expect("resolve map");
            let mut claimed: HashSet<String> = row["claimed"]
                .as_array()
                .expect("claimed")
                .iter()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect();
            let got = read_remembered_splits(
                &row["input"],
                &mut |id| match mapping.get(id) {
                    Some(Value::String(mapped)) => Some(mapped.clone()),
                    _ => None,
                },
                &mut claimed,
            );
            let mut claimed_sorted: Vec<String> = claimed.into_iter().collect();
            claimed_sorted.sort();
            assert_eq!(
                json!({"kept": values(&got), "claimed": claimed_sorted}),
                row["output"],
                "readRememberedSplits {}",
                row["input"]
            );
            count += 1;
        }
        for row in table["forget"].as_array().expect("forget rows") {
            let splits = parse_layouts(&row["splits"]);
            let tab = row["tab"].as_str().expect("tab");
            assert_eq!(
                values(&forget_split_tab(&splits, tab)),
                row["output"],
                "forgetSplitTab {}",
                row["splits"]
            );
            let home = remembered_split_of(&splits, tab).map(SplitLayout::to_value);
            assert_eq!(
                home.unwrap_or(Value::Null),
                row["home"],
                "rememberedSplitOf {}",
                row["splits"]
            );
            count += 1;
        }
        for row in table["map"].as_array().expect("map rows") {
            let split = as_split_layout(Some(raw_node(&row["split"]))).expect("split");
            let mapping = row["mapping"].as_object().expect("mapping");
            let node = SplitNode::Split(Box::new(split));
            let mapped = map_split_leaves(&node, &mut |id| match mapping.get(id) {
                Some(Value::String(to)) => Some(SplitNode::Leaf(to.clone())),
                _ => None,
            });
            let ids = split_tab_ids(&node);
            assert_eq!(json!(ids), row["ids"]);
            let as_layout = as_split_layout(mapped.clone()).map(|layout| layout.to_value());
            assert_eq!(
                as_layout.unwrap_or(Value::Null),
                row["layout"],
                "asSplitLayout(mapSplitLeaves) {}",
                row["split"]
            );
            let whole = mapped.map(|node| node.to_value()).unwrap_or(Value::Null);
            assert_eq!(whole, row["node"], "mapSplitLeaves {}", row["split"]);
            count += 1;
        }
        assert!(count > 150, "only {count} captured rows");
    }
}
