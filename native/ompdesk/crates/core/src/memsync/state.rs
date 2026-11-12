//! `<userData>/ai-memory/sync.json`: per host, the cursors and agreement pairs a device keeps. Older OMPdesks read and
//! write the same file, so it is read as zod's `SyncFile` read it (anything else starts the file over) and written as
//! `JSON.stringify` wrote the parsed object: the schema's key order, the agreement pairs in the order they were made.

use serde::Serialize;
use serde_json::{Map, Number, Value};

use super::wire::{ConclusionCursor, Cursor};

/// One host's state.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostState {
    /// Where the next pull of this host's pages goes on.
    pub pull: Option<Cursor>,
    /// This computer's newest `updated_at` already offered to the host.
    pub push: String,
    /// Key → [this computer's hash, the host's hash] when the two last agreed, oldest first.
    pub base: Map<String, Value>,
    /// Key → the host's hash as last seen.
    pub remote: Map<String, Value>,
    /// Keys to offer again whatever their time: a push that failed or lost a conflict it then won.
    pub pending: Vec<String>,
    /// Where the next pull of this host's conclusions goes on, per stream, and the host's database they belong to.
    pub conclusions: ConclusionCursor,
    /// The last row of each of this computer's streams the host has answered for, and this computer's database.
    pub conclusions_sent: ConclusionCursor,
    /// One whole pass over both computers' memory once repository identities cross.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_pass: Option<IdentityPass>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IdentityPass {
    /// When it started, ms since 1970 as main's clock said.
    pub at: Number,
    pub done: bool,
    pub running: bool,
    pub seen: bool,
    pub pages: bool,
    pub conclusions: bool,
}

impl HostState {
    /// The agreement pair kept for `key`: (this computer's hash, the host's).
    pub fn base(&self, key: &str) -> Option<(&str, &str)> {
        let pair = self.base.get(key)?.as_array()?;
        Some((pair.first()?.as_str()?, pair.get(1)?.as_str()?))
    }

    pub fn agree(&mut self, key: &str, mine: &str, theirs: &str) {
        self.base
            .insert(key.to_owned(), Value::from(vec![mine, theirs]));
    }

    pub fn remote(&self, key: &str) -> Option<&str> {
        self.remote.get(key)?.as_str()
    }

    pub fn saw(&mut self, key: &str, hash: &str) {
        self.remote.insert(key.to_owned(), Value::from(hash));
    }

    pub fn pend(&mut self, key: &str) {
        if !self.pending.iter().any(|pending| pending == key) {
            self.pending.push(key.to_owned());
        }
    }

    pub fn unpend(&mut self, key: &str) {
        if let Some(at) = self.pending.iter().position(|pending| pending == key) {
            self.pending.remove(at);
        }
    }

    /// Keep the newest `limit` agreement pairs only (insertion order is the order they were made in).
    pub fn trim(&mut self, limit: usize) {
        let drop = self.base.len().saturating_sub(limit);
        if drop == 0 {
            return;
        }
        let dropped: Vec<String> = self.base.keys().take(drop).cloned().collect();
        self.base = std::mem::take(&mut self.base)
            .into_iter()
            .skip(drop)
            .collect();
        let remote = std::mem::take(&mut self.remote);
        self.remote = remote
            .into_iter()
            .filter(|(key, _)| !dropped.contains(key))
            .collect();
    }

    fn parse(value: &Value) -> Option<HostState> {
        let object = value.as_object()?;
        let cursor = |name: &str| match object.get(name) {
            None => Some(ConclusionCursor::default()),
            Some(value) => ConclusionCursor::parse(value).ok(),
        };
        let base = object.get("base")?.as_object()?;
        let pairs = base.values().all(|pair| {
            pair.as_array()
                .is_some_and(|pair| pair.len() == 2 && pair.iter().all(Value::is_string))
        });
        let remote = object.get("remote")?.as_object()?;
        let pending = object.get("pending")?.as_array()?;
        Some(HostState {
            pull: Cursor::parse(object.get("pull")?).ok()?,
            push: object.get("push")?.as_str()?.to_owned(),
            base: pairs.then(|| base.clone())?,
            remote: remote
                .values()
                .all(Value::is_string)
                .then(|| remote.clone())?,
            pending: pending
                .iter()
                .map(|key| key.as_str().map(str::to_owned))
                .collect::<Option<_>>()?,
            conclusions: cursor("conclusions")?,
            conclusions_sent: cursor("conclusionsSent")?,
            identity_pass: match object.get("identityPass") {
                None => None,
                Some(pass) => Some(IdentityPass::parse(pass)?),
            },
        })
    }
}

impl IdentityPass {
    fn parse(value: &Value) -> Option<IdentityPass> {
        let object = value.as_object()?;
        let flag = |name: &str| object.get(name)?.as_bool();
        Some(IdentityPass {
            at: object.get("at")?.as_number()?.clone(),
            done: flag("done")?,
            running: flag("running")?,
            seen: flag("seen")?,
            pages: flag("pages")?,
            conclusions: flag("conclusions")?,
        })
    }
}

/// The whole file: `{v: 1, hosts}`, hosts in the order first synced with.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SyncFile {
    pub hosts: Vec<(String, HostState)>,
}

impl Serialize for SyncFile {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        struct Hosts<'a>(&'a [(String, HostState)]);
        impl Serialize for Hosts<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (host, state) in self.0 {
                    map.serialize_entry(host, state)?;
                }
                map.end()
            }
        }
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("v", &1)?;
        map.serialize_entry("hosts", &Hosts(&self.hosts))?;
        map.end()
    }
}

impl SyncFile {
    /// The file as `SyncFile.parse(JSON.parse(text))` read it; none when it does not hold one.
    pub fn parse(text: &str) -> Option<SyncFile> {
        let value: Value = serde_json::from_str(&crate::json::whole_surrogates(text)).ok()?;
        let object = value.as_object()?;
        if object.get("v")?.as_f64()? != 1.0 {
            return None;
        }
        let hosts = object
            .get("hosts")?
            .as_object()?
            .iter()
            .map(|(host, state)| Some((host.clone(), HostState::parse(state)?)))
            .collect::<Option<_>>()?;
        Some(SyncFile { hosts })
    }

    /// The host's state, made fresh the first time.
    pub fn host(&mut self, host: &str) -> &mut HostState {
        let at = match self.hosts.iter().position(|(name, _)| name == host) {
            Some(at) => at,
            None => {
                self.hosts.push((host.to_owned(), HostState::default()));
                self.hosts.len() - 1
            }
        };
        &mut self.hosts[at].1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_the_typescript_wrote_reads_and_writes_back_byte_for_byte() {
        let written = concat!(
            r#"{"v":1,"hosts":{"win":{"pull":{"at":"2026-10-19T00:00:03.000Z","key":"default\u0000app\u0000decisions/a.md"},"#,
            r#""push":"2026-10-19T00:00:04.000Z","base":{"z\u0000k":["a","b"],"a\u0000k":["c","d"]},"#,
            r#""remote":{"z\u0000k":"b","a\u0000k":"d"},"pending":["a\u0000k"],"#,
            r#""conclusions":{"native":3,"synced":1,"store":"db-1"},"conclusionsSent":{"native":2,"synced":0},"#,
            r#""identityPass":{"at":1760918400000,"done":true,"running":false,"seen":true,"pages":true,"conclusions":true}},"#,
            r#""tab":{"pull":null,"push":"","base":{},"remote":{},"pending":[],"conclusions":{"native":0,"synced":0},"#,
            r#""conclusionsSent":{"native":0,"synced":0}}}}"#
        );
        let file = SyncFile::parse(written).unwrap();
        assert_eq!(serde_json::to_string(&file).unwrap(), written);
    }

    #[test]
    fn a_file_written_before_conclusions_gets_both_cursors_at_zero() {
        let old =
            r#"{"v":1,"hosts":{"win":{"pull":null,"push":"","base":{},"remote":{},"pending":[]}}}"#;
        let file = SyncFile::parse(old).unwrap();
        assert_eq!(
            serde_json::to_string(&file).unwrap(),
            r#"{"v":1,"hosts":{"win":{"pull":null,"push":"","base":{},"remote":{},"pending":[],"conclusions":{"native":0,"synced":0},"conclusionsSent":{"native":0,"synced":0}}}}"#
        );
    }

    #[test]
    fn a_file_zod_refused_starts_over() {
        for text in [
            "",
            "{not json",
            r#"{"v":2,"hosts":{}}"#,
            r#"{"v":1,"hosts":{"win":{"pull":null,"push":"","base":{"k":["a"]},"remote":{},"pending":[]}}}"#,
            r#"{"v":1,"hosts":{"win":{"pull":null,"push":"","base":{},"remote":{},"pending":[],"conclusions":null}}}"#,
            r#"{"v":1,"hosts":{"win":{"push":"","base":{},"remote":{},"pending":[]}}}"#,
        ] {
            assert!(SyncFile::parse(text).is_none(), "{text}");
        }
    }

    #[test]
    fn trimming_keeps_the_newest_pairs() {
        let mut state = HostState::default();
        for key in ["a", "b", "c"] {
            state.agree(key, "m", "t");
            state.saw(key, "t");
        }
        state.agree("a", "m2", "t2");
        state.trim(2);
        assert_eq!(state.base.keys().collect::<Vec<_>>(), ["b", "c"]);
        assert_eq!(state.remote.keys().collect::<Vec<_>>(), ["b", "c"]);
    }
}
