//! Private inbox wire data. Native receipt of responsibility is not a bridge/model-context receipt.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::journal::Persistence;
use super::journal::attachments::{Attached, AttachedSet, read_attached};

/// Supplied only by the app's trusted native-service constructor, never by a delivery/tool payload.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFiles {
    pub ledger: PathBuf,
    pub upload_user_data: PathBuf,
}

pub(crate) fn new_delivery_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    crate::sys::random(&mut bytes)
        .map_err(|error| format!("Cannot create native inbox identity: {error}"))?;
    Ok(crate::hex(&bytes))
}

/// Canonical persistent host and saved session identity, bound by the authenticated native route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxAddress {
    pub device_id: String,
    pub session_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum InboxLogicalPayload {
    Prompt {
        text: String,
    },
    Report {
        text: String,
        details: Map<String, Value>,
        instruction: Option<String>,
        card: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxLogicalMessage {
    pub producer: InboxAddress,
    pub target: InboxAddress,
    pub request_id: Option<String>,
    pub intent: InboxIntent,
    pub trigger_turn: bool,
    pub payload: InboxLogicalPayload,
}

impl InboxLogicalMessage {
    /// No-ID calls receive a random identity before producer persistence, never a transcript-derived ID.
    pub fn delivery_id(&self) -> Result<String, String> {
        if let Some(request_id) = &self.request_id {
            if request_id.is_empty() {
                return Err("An explicit native inbox request identity cannot be empty".into());
            }
            serde_json::to_string(&(&self.producer, &self.target, request_id))
                .map_err(|error| error.to_string())
        } else {
            new_delivery_id()
        }
    }

    pub fn validate(&self, entry: &NativeInboxEntry) -> Result<(), String> {
        let kind = match &self.payload {
            InboxLogicalPayload::Prompt { .. } => InboxKind::Prompt,
            InboxLogicalPayload::Report { .. } => InboxKind::Report,
        };
        if self.producer.device_id.is_empty()
            || self.producer.session_path.is_empty()
            || self.target.device_id.is_empty()
            || self.target.session_path.is_empty()
            || self.request_id.as_ref().is_some_and(String::is_empty)
            || kind != entry.payload.kind()
            || self.intent != entry.intent
            || self.trigger_turn != entry.trigger_turn
            || entry.legacy
        {
            return Err("Native logical identity or delivery semantics are invalid".into());
        }
        if self.request_id.is_some() && self.delivery_id()? != entry.delivery_id {
            return Err("Native request identity is not bound to its producer and target".into());
        }
        Ok(())
    }
}

/// Initial admission only. Never part of the stable key, forwarded authority, or durable replay requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InboxSourceExecution {
    pub tab_id: String,
    pub runtime_instance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InboxAdmission {
    pub logical: InboxLogicalMessage,
    pub execution: InboxSourceExecution,
}

/// Preserve damaged native metadata as data; never drop an old outbox row or promote it from text.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum InboxLogicalSource {
    Legacy,
    Bound(InboxLogicalMessage),
    Damaged(Value),
}

impl InboxLogicalSource {
    pub fn read(value: Option<&Value>) -> Self {
        match value {
            None => Self::Legacy,
            Some(value) => match serde_json::from_value(value.clone()) {
                Ok(source) => Self::Bound(source),
                Err(_) => Self::Damaged(value.clone()),
            },
        }
    }

    pub fn json(&self) -> Option<Value> {
        match self {
            Self::Legacy => None,
            Self::Bound(source) => {
                Some(serde_json::to_value(source).expect("logical inbox data serializes"))
            }
            Self::Damaged(value) => Some(value.clone()),
        }
    }

    pub fn bound(&self) -> Result<Option<&InboxLogicalMessage>, String> {
        match self {
            Self::Legacy => Ok(None),
            Self::Bound(source) => Ok(Some(source)),
            Self::Damaged(_) => {
                Err("Native source metadata is damaged; original remains pending".into())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InboxKind {
    Prompt,
    Report,
}

impl InboxKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Report => "report",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeInboxKey {
    pub kind: InboxKind,
    pub delivery_id: String,
}

impl NativeInboxKey {
    pub fn provider_id(&self) -> String {
        serde_json::to_string(&(self.kind.as_str(), self.delivery_id.as_str()))
            .expect("a tuple of strings always serializes")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxReceiver {
    pub session_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    pub instance: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct InboxSender {
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InboxIntent {
    Immediate,
    FollowUp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum InboxBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum InboxContent {
    Text(String),
    Blocks(Vec<InboxBlock>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum InboxPayload {
    Prompt {
        content: InboxContent,
    },
    Report {
        content: InboxContent,
        details: Map<String, Value>,
    },
}

impl InboxPayload {
    pub fn kind(&self) -> InboxKind {
        match self {
            Self::Prompt { .. } => InboxKind::Prompt,
            Self::Report { .. } => InboxKind::Report,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeInboxEntry {
    pub delivery_id: String,
    pub sender: InboxSender,
    pub intent: InboxIntent,
    pub trigger_turn: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub legacy: bool,
    #[serde(flatten)]
    pub payload: InboxPayload,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl NativeInboxEntry {
    pub fn key(&self) -> NativeInboxKey {
        NativeInboxKey {
            kind: self.payload.kind(),
            delivery_id: self.delivery_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct NativeInboxRequest {
    pub receiver: InboxReceiver,
    pub entries: Vec<NativeInboxEntry>,
}

/// Exact logical request and its first derived stock presentation. Paths are transport materialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct NativeInboxTransferEntry {
    pub entry: NativeInboxEntry,
    pub logical: InboxLogicalMessage,
    pub dispatch: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_attachments",
        deserialize_with = "deserialize_attachments"
    )]
    pub attachments: Option<AttachedSet>,
}

impl NativeInboxTransferEntry {
    /// Landing paths/times are transport materialization, not logical delivery identity.
    pub fn logical_payload(&self) -> Result<Value, serde_json::Error> {
        let mut value = serde_json::to_value(&self.logical)?;
        if let Some(set) = &self.attachments {
            value["attachments"] = serde_json::json!({
                "images": set.images.iter().map(|file| file.to_json()).collect::<Vec<_>>(),
                "files": set.files.iter().map(|landed| landed.file.to_json()).collect::<Vec<_>>(),
            });
        }
        Ok(value)
    }
}

pub(crate) fn same_native_source(
    previous: Option<NativeInboxTransferEntry>,
    incoming: Option<NativeInboxTransferEntry>,
) -> Result<(), String> {
    let (Some(previous), Some(incoming)) = (previous, incoming) else {
        return Err(
            "Native source identity conflicts with an ambiguous legacy record; original retained"
                .into(),
        );
    };
    if previous
        .logical_payload()
        .map_err(|error| error.to_string())?
        != incoming
            .logical_payload()
            .map_err(|error| error.to_string())?
    {
        return Err(
            "Native source identity conflicts with an existing payload; original retained".into(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct NativeInboxTransfer {
    pub receiver: InboxReceiver,
    pub entries: Vec<NativeInboxTransferEntry>,
    pub uploads: Vec<NativeInboxUpload>,
}

/// A landing issued by the existing upload service, read only in the authenticated transport peer's namespace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct NativeInboxUpload {
    pub sha256: String,
    pub path: String,
}

fn serialize_attachments<S: serde::Serializer>(
    set: &Option<AttachedSet>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    set.as_ref().map(AttachedSet::to_json).serialize(serializer)
}

fn deserialize_attachments<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AttachedSet>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    match read_attached(Some(&value)) {
        Attached::None => Ok(None),
        Attached::Set(set) => Ok(Some(set)),
        Attached::Corrupt => Err(serde::de::Error::custom(
            "Invalid native inbox attachment references",
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum InboxEvidence {
    #[serde(rename = "context-id-and-provider-output")]
    ContextIdAndProviderOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxContextReceipt {
    pub request_id: String,
    pub session_path: String,
    pub instance: String,
    pub ids: Vec<String>,
    pub evidence: InboxEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InboxEntryState {
    Accepted,
    Journaled,
    ContextObserved,
    LegacyAmbiguous,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxEntryReply {
    #[serde(flatten)]
    pub key: NativeInboxKey,
    pub state: InboxEntryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct InboxAcceptedDelivery {
    pub key: NativeInboxKey,
    /// The first accepted presentation's dispatch, unchanged by lost ACKs, rebinds or title changes.
    pub dispatch: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct NativeInboxReply {
    pub receiver: InboxReceiver,
    pub entries: Vec<InboxEntryReply>,
    pub receipts: Vec<InboxContextReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeInboxAcceptance {
    pub persistence: Persistence,
    pub receiver: InboxReceiver,
    pub deliveries: Vec<InboxAcceptedDelivery>,
}
