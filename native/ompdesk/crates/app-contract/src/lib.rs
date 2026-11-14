//! Shared application boundary between the CEF shell and core domain implementations. This crate contains no
//! transport, executor or domain policy. In particular, page arguments cannot deserialize application authority.

use std::pin::Pin;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum NativeCaller {
    Desktop {
        win_id: u64,
        wc_id: u64,
    },
    Web {
        device_id: String,
        conn_id: String,
        window_id: i64,
    },
}

impl NativeCaller {
    pub fn desktop_window(&self) -> Option<u64> {
        match self {
            Self::Desktop { win_id, .. } => Some(*win_id),
            Self::Web { .. } => None,
        }
    }

    /// Retains the existing per-page ordered lane identity.
    pub fn lane_key(&self) -> String {
        match self {
            Self::Desktop { wc_id, .. } => format!("w{wc_id}"),
            Self::Web {
                device_id, conn_id, ..
            } => format!("d{device_id}:{conn_id}"),
        }
    }
}

/// A request identity never survives its originating core/connection generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RequestId {
    pub generation: u64,
    pub id: u64,
}

/// The admitted request. The transport authenticates caller and checks channel policy before constructing this.
/// Tab/cwd/device filesystem authority is resolved from application state, never additional fields in args.
pub struct AppRequest {
    pub id: RequestId,
    pub caller: NativeCaller,
    pub channel: String,
    pub args: Vec<Value>,
    pub bin: Option<Vec<u8>>,
}

#[derive(Debug, PartialEq)]
pub struct AppReply {
    pub value: Value,
    pub bin: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppFuture = Pin<Box<dyn Future<Output = Result<AppReply, AppError>> + Send>>;

/// One Base-owned dispatch implementation, shared by authenticated desktop and paired-page admission. Domain
/// implementations consume this boundary; they never register their own parallel page dispatcher. No default
/// methods: a runtime cannot silently omit cancellation, disconnect cleanup or page delivery.
pub trait NativeApp: Send + Sync {
    /// Starts in caller-lane order. Its returned future completes independently; callback replies must not queue
    /// behind the request awaiting them. Raw bytes are moved, never base64 encoded inside native application code.
    fn invoke(&self, request: AppRequest) -> AppFuture;

    /// A send finishes its synchronous handling before the caller's next request is admitted.
    fn send(&self, request: AppRequest) -> Result<(), AppError>;

    fn cancel(&self, request: RequestId);

    /// Closes only this authenticated endpoint's requests, media leases and views, not its execution host's run.
    fn close_caller(&self, caller: &NativeCaller);

    /// Goes through the same native desktop/web delivery router, preserving pushes-before-reply ordering.
    fn push(
        &self,
        caller: &NativeCaller,
        channel: &str,
        args: Vec<Value>,
        bin: Option<Vec<u8>>,
    ) -> Result<(), AppError>;
}
