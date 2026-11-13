//! The updater's state as Node mirrors it (PROTOCOL.md §15.8 `State`, `RawStatus`): `UpdateStatus` of
//! `src/shared/ipc-types.ts` with an error spelled as a `MAIN_TEXT` key Node translates.

use serde_json::{Map, Value, json};

/// How this copy installs (`UpdateInstallMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Windows: the downloaded installer runs on restart or quit.
    Automatic,
    /// macOS, a bundle the app may replace: the detached swap helper.
    Relaunch,
    /// macOS, a read-only bundle: the verified DMG opened in Finder.
    Manual,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Automatic => "automatic",
            Mode::Relaunch => "relaunch",
            Mode::Manual => "manual",
        }
    }
}

/// The release repository's answer to a probe (`UpdateAccess`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Ok,
    Missing,
    Invalid,
    Denied,
    Network,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Ok => "ok",
            Access::Missing => "missing",
            Access::Invalid => "invalid",
            Access::Denied => "denied",
            Access::Network => "network",
        }
    }

    pub fn parse(text: &str) -> Option<Access> {
        Some(match text {
            "ok" => Access::Ok,
            "missing" => Access::Missing,
            "invalid" => Access::Invalid,
            "denied" => Access::Denied,
            "network" => Access::Network,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Idle,
    Checking,
    Available {
        version: String,
        notes: Option<String>,
        mode: Mode,
    },
    Downloading {
        version: String,
        mode: Mode,
        percent: u32,
    },
    Downloaded {
        version: String,
        mode: Mode,
    },
    NotAvailable {
        version: String,
    },
    /// `key` is a `MAIN_TEXT` key; Node shows `mainT(key)` and ` (suffix)` after it when there is one.
    Error {
        key: String,
        suffix: Option<String>,
        detail: Option<String>,
        show_in_banner: Option<bool>,
    },
    AuthRequired {
        reason: Access,
    },
}

impl Status {
    pub fn to_json(&self) -> Value {
        match self {
            Status::Idle => json!({ "state": "idle" }),
            Status::Checking => json!({ "state": "checking" }),
            Status::Available {
                version,
                notes,
                mode,
            } => {
                let mut out =
                    json!({ "state": "available", "version": version, "mode": mode.as_str() });
                if let Some(notes) = notes {
                    out["notes"] = json!(notes);
                }
                out
            }
            Status::Downloading {
                version,
                mode,
                percent,
            } => {
                json!({ "state": "downloading", "version": version, "mode": mode.as_str(), "percent": percent })
            }
            Status::Downloaded { version, mode } => {
                json!({ "state": "downloaded", "version": version, "mode": mode.as_str() })
            }
            Status::NotAvailable { version } => {
                json!({ "state": "not-available", "version": version })
            }
            Status::Error {
                key,
                suffix,
                detail,
                show_in_banner,
            } => {
                let mut out = Map::new();
                out.insert("state".into(), json!("error"));
                out.insert("key".into(), json!(key));
                if let Some(suffix) = suffix {
                    out.insert("suffix".into(), json!(suffix));
                }
                if let Some(detail) = detail {
                    out.insert("detail".into(), json!(detail));
                }
                if let Some(banner) = show_in_banner {
                    out.insert("showInBanner".into(), json!(banner));
                }
                Value::Object(out)
            }
            Status::AuthRequired { reason } => {
                json!({ "state": "auth-required", "reason": reason.as_str() })
            }
        }
    }

    /// `UpdateStatus` with the error's text in `message`, as the TypeScript's `settleFailedUpdateCheck` returned it
    /// (the captured tables pass the text as the key).
    pub fn to_ts_json(&self) -> Value {
        let mut out = self.to_json();
        if let Some(object) = out.as_object_mut()
            && let Some(key) = object.remove("key")
        {
            let suffix = object.remove("suffix");
            let text = match suffix.as_ref().and_then(Value::as_str) {
                Some(suffix) => format!("{} ({suffix})", key.as_str().unwrap_or_default()),
                None => key.as_str().unwrap_or_default().to_string(),
            };
            let detail = object.remove("detail");
            let banner = object.remove("showInBanner");
            object.insert("message".into(), json!(text));
            if let Some(detail) = detail {
                object.insert("detail".into(), detail);
            }
            if let Some(banner) = banner {
                object.insert("showInBanner".into(), banner);
            }
        }
        out
    }
}
