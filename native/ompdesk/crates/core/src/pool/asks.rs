//! Native answers to the existing pool engine's collaborator asks, not a page/IPC dispatch endpoint.

use super::{
    Application, Decision, EffectFuture, Host, Owner, Sidecar, Spawn, merge_plans, restart_decision,
};
use serde_json::{Value, json};
use std::sync::Arc;

pub type ErrorOf<H> = <<H as Host>::Sidecar as Sidecar>::Error;

/// `spawn_owner` resolves the pool's tab reservation in Base's authenticated authority registry.
/// Neither this executor nor a field of an ask can construct an Owner.
pub trait Collaborators: Host {
    fn error(&self, message: String) -> ErrorOf<Self>;
    fn spawn_owner(&self, tab: &str) -> Result<Owner, ErrorOf<Self>>;
    fn blocked(&self, session: Option<&str>, device: Option<&str>, cwd: &str, hosted: bool)
    -> bool;
    fn acquired(&self, tab: &str, sidecar: Arc<Self::Sidecar>);
    fn end_views(&self, tab: &str, views: &[i64]);
    fn deleted_add(&self, session: &str, device: Option<&str>);
    fn self_device(&self) -> Option<String>;
    fn snowflake(&self) -> String;
    fn running_changed(&self);
    fn session_files_changed(&self);
    fn window_tabs_changed(&self, window: i64, layout: Value);
    fn exiting(&self, key: String) -> EffectFuture<'_, ()>;
    fn command(
        &self,
        sidecar: Arc<Self::Sidecar>,
        command: Value,
    ) -> EffectFuture<'static, Result<Value, ErrorOf<Self>>>;
}

impl<H: Collaborators> Application<H> {
    pub async fn ask(&self, question: &str, item: &Value) -> Result<Value, ErrorOf<H>> {
        let tab = item["tab"].as_str().unwrap_or_default();
        match question {
            "blocked" => Ok(Value::Bool(self.host.blocked(
                item["sessionPath"].as_str(),
                item["device"].as_str(),
                item["cwd"].as_str().unwrap_or_default(),
                item["hosted"] == true,
            ))),
            "spawn" => self.spawn(Spawn {
                owner: self.host.spawn_owner(tab)?,
                tab: tab.into(),
                window: item["win"].as_i64().unwrap_or_default(),
                cwd: item["cwd"].as_str().unwrap_or_default().into(),
                kind: item["kind"].as_str().unwrap_or("agent").into(),
                fresh: item["fresh"] == true,
                device: item["device"].as_str().map(str::to_owned),
                session_path: item["sessionPath"].as_str().map(str::to_owned),
                worktree: item
                    .get("worktree")
                    .filter(|value| !value.is_null())
                    .cloned(),
                placeholder: item["placeholder"] == true,
                defer_start: item["deferStart"] == true,
            }),
            "wire" => {
                if let Some(sidecar) = self.sidecar(tab) {
                    self.host.wire_light(tab, &sidecar);
                }
                Ok(Value::Null)
            }
            "acquired" => {
                if let Some(sidecar) = self.sidecar(tab) {
                    self.host.acquired(tab, sidecar);
                }
                Ok(Value::Null)
            }
            "facts" => {
                let tabs = item["tabs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                Ok(self.facts(&tabs))
            }
            "window" => {
                let (destroyed, web) = self.host.window(item["win"].as_i64().unwrap_or_default());
                Ok(json!({"destroyed": destroyed, "web": web}))
            }
            "start" => {
                self.start(tab, item["sessionFile"].as_str());
                Ok(Value::Null)
            }
            "restart" => {
                self.restart(tab, item["sessionFile"].as_str());
                Ok(Value::Null)
            }
            "sleep" => {
                self.sleep(tab);
                Ok(Value::Null)
            }
            "adoptCwd" => Ok(Value::Bool(
                self.adopt_cwd(tab, item["cwd"].as_str().unwrap_or_default()),
            )),
            "sideChannel" => {
                if let Some(sidecar) = self.sidecar(tab) {
                    let _ = sidecar.send_now(item["frame"].clone());
                }
                Ok(Value::Null)
            }
            "sideChannelLater" => {
                self.send(tab, item["frame"].clone()).await?;
                Ok(Value::Null)
            }
            "rpc" => match self.sidecar(tab) {
                Some(sidecar) => self.host.command(sidecar, item["command"].clone()).await,
                None => Ok(Value::Null),
            },
            "endViews" => {
                let views = item["views"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_i64)
                    .collect::<Vec<_>>();
                self.host.end_views(tab, &views);
                Ok(Value::Null)
            }
            "dispose" => {
                self.dispose(
                    tab,
                    item["ownerKey"].as_str().map(str::to_owned),
                    item["hosted"] == true,
                );
                Ok(Value::Null)
            }
            "disposeSidecars" => {
                let tabs = item["tabs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                for tab in tabs {
                    let handle = self.handles().remove(tab);
                    if let Some(handle) = handle {
                        handle.sidecar.remove_listeners();
                        handle.sidecar.dispose();
                    }
                }
                Ok(Value::Null)
            }
            "decide" => {
                let facts = self.sidecar(tab).map(|sidecar| sidecar.facts());
                let status = facts.as_ref().and_then(|facts| facts["status"].as_str());
                let decision =
                    restart_decision(status, item["busy"] == true, item["kind"] != "omp");
                Ok(Value::from(match decision {
                    Decision::Restart => "restart",
                    Decision::Now => "now",
                    Decision::Wait => "wait",
                    Decision::Skip => "skip",
                }))
            }
            "mergePlans" => Ok(merge_plans(&item["a"], &item["b"])),
            "deletedAdd" => {
                self.host.deleted_add(
                    item["sessionPath"].as_str().unwrap_or_default(),
                    item["device"].as_str(),
                );
                Ok(Value::Null)
            }
            "selfDevice" => Ok(self.host.self_device().map_or(Value::Null, Value::from)),
            "snowflake" => Ok(Value::from(self.host.snowflake())),
            "onRunningChange" => {
                self.host.running_changed();
                Ok(Value::Null)
            }
            "onSessionFilesChanged" => {
                self.host.session_files_changed();
                Ok(Value::Null)
            }
            "onWindowTabsChanged" => {
                self.host.window_tabs_changed(
                    item["win"].as_i64().unwrap_or_default(),
                    item["layout"].clone(),
                );
                Ok(Value::Null)
            }
            "exiting" => {
                self.host
                    .exiting(item["key"].as_str().unwrap_or_default().into())
                    .await;
                Ok(Value::Null)
            }
            other => Err(self.host.error(format!(
                "The pool's core asked an unknown question: {other}"
            ))),
        }
    }

    pub fn reload_extensions(
        &self,
        tab: &str,
        plan: &Value,
    ) -> EffectFuture<'static, Result<(), ErrorOf<H>>> {
        let Some(sidecar) = self.sidecar(tab) else {
            return Box::pin(std::future::ready(Ok(())));
        };
        let reload = (plan["reload"] == true).then_some(("extension_update.reload", None));
        let reconnect = plan["reconnect"]
            .as_array()
            .filter(|names| !names.is_empty())
            .map(|names| ("extension_update.reconnect", Some(json!({"names": names}))));
        let mcp = plan.get("mcp").filter(|value| !value.is_null()).map(|mcp| {
            let params = if mcp["all"] == true {
                json!({})
            } else {
                json!({"names": mcp["names"]})
            };
            ("mcp_sync", Some(params))
        });
        let mut steps = [reload, reconnect, mcp].into_iter().flatten();
        let first = steps
            .next()
            .map(|(method, params)| sidecar.bridge(method.into(), params, None));
        Box::pin(async move {
            if let Some(first) = first {
                first.await?;
            }
            for (method, params) in steps {
                sidecar.bridge(method.into(), params, None).await?;
            }
            Ok(())
        })
    }
}

pub fn describe_answer(frame: &Value) -> String {
    if frame["cancelled"] == true {
        return "dismissed".into();
    }
    if let Some(value) = frame["value"].as_str() {
        return value.into();
    }
    if let Some(confirmed) = frame["confirmed"].as_bool() {
        return if confirmed { "yes" } else { "no" }.into();
    }
    let Some(answers) = frame["answers"].as_array() else {
        return String::new();
    };
    let mut words = Vec::new();
    for answer in answers.iter().filter(|answer| answer.is_object()) {
        if let Some(picked) = answer["selectedOptions"].as_array() {
            words.extend(picked.iter().map(crate::control::js::string_of_value));
        }
        if let Some(custom) = answer["customInput"].as_str() {
            words.push(custom.into());
        }
    }
    words.join(", ")
}
