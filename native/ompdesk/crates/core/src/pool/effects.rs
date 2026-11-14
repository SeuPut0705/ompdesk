//! Effects emitted by the existing pool engine. Native window/view delivery and observer/timer wiring belong
//! to Base's instance graph; sidecar operations run directly against the owned native handles here.

use super::{Application, EffectFuture, asks::Collaborators};
use serde_json::Value;

pub enum Notification {
    Send {
        windows: Vec<i64>,
        channel: String,
        data: Value,
    },
    WireFull {
        tab: String,
        window: i64,
    },
    UnwireFull {
        tab: String,
        window: i64,
        last: bool,
    },
    SessionFile {
        tab: String,
        file: Option<String>,
    },
    Gone {
        tab: String,
    },
    ListenClosed {
        window: i64,
    },
    EmitView {
        tab: String,
        view: i64,
        event: String,
        arg: Value,
    },
    SettleWatch {
        tab: String,
        operation: String,
        frame: Option<String>,
        settled: bool,
        settling: bool,
    },
    ModelWaitForget {
        tab: String,
    },
    TurnStop {
        tab: String,
        command: String,
        by: Value,
    },
    Immediate {
        tab: String,
        kind: String,
    },
    StopTimer {
        token: u64,
        ms: u64,
    },
    Settle {
        token: u64,
        ok: bool,
        value: Value,
        code: Option<String>,
        message: Option<String>,
    },
}

pub trait Host: Collaborators {
    fn notify(&self, notification: Notification);
}

impl<H: Host> Application<H> {
    /// The native hub schedules this continuation without holding a page request or another pool job behind it.
    pub fn effect(self: &std::sync::Arc<Self>, item: &Value) -> Option<EffectFuture<'static, ()>> {
        let text = |key: &str| item[key].as_str().unwrap_or_default().to_owned();
        let tab = || text("tab");
        let notification = match item["k"].as_str().unwrap_or_default() {
            "send" => Notification::Send {
                windows: item["wins"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_i64)
                    .collect(),
                channel: text("channel"),
                data: item["data"].clone(),
            },
            "wireFull" => Notification::WireFull {
                tab: tab(),
                window: item["win"].as_i64().unwrap_or_default(),
            },
            "unwireFull" => Notification::UnwireFull {
                tab: tab(),
                window: item["win"].as_i64().unwrap_or_default(),
                last: item["last"] == true,
            },
            "sessionFile" => Notification::SessionFile {
                tab: tab(),
                file: item["file"].as_str().map(str::to_owned),
            },
            "gone" => Notification::Gone { tab: tab() },
            "listenClosed" => Notification::ListenClosed {
                window: item["win"].as_i64().unwrap_or_default(),
            },
            "command" => {
                let sidecar = self.sidecar(&tab())?;
                let call = self.host.command(sidecar, item["command"].clone());
                return Some(Box::pin(async move {
                    let _ = call.await;
                }));
            }
            "emitView" => Notification::EmitView {
                tab: tab(),
                view: item["view"].as_i64().unwrap_or_default(),
                event: text("event"),
                arg: item["arg"].clone(),
            },
            "settleWatch" => Notification::SettleWatch {
                tab: tab(),
                operation: text("op"),
                frame: item["frame"].as_str().map(str::to_owned),
                settled: item["settled"] == true,
                settling: item["settling"] == true,
            },
            "modelWaitForget" => Notification::ModelWaitForget { tab: tab() },
            "turnStop" => Notification::TurnStop {
                tab: tab(),
                command: text("command"),
                by: item["by"].clone(),
            },
            "reloadExtensions" => {
                let reload = self.reload_extensions(&tab(), &item["plan"]);
                return Some(Box::pin(async move {
                    let _ = reload.await;
                }));
            }
            "immediate" => Notification::Immediate {
                tab: tab(),
                kind: text("kind"),
            },
            "stopTimer" => Notification::StopTimer {
                token: item["token"].as_u64().unwrap_or_default(),
                ms: item["ms"].as_u64().unwrap_or_default(),
            },
            "settle" => Notification::Settle {
                token: item["token"].as_u64().unwrap_or_default(),
                ok: item["ok"] == true,
                value: item["value"].clone(),
                code: item["code"].as_str().map(str::to_owned),
                message: item["message"].as_str().map(str::to_owned),
            },
            _ => return None,
        };
        self.host.notify(notification);
        None
    }
}
