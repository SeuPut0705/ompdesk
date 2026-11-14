//! A caller's native research job. The native machine app owns the caller association; this leaf owns no authority.
//! It reuses Research's stock RPC stream and child teardown, with the page request/plan contract applied here.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{Asked, Control, Ended, Research, RunParams, locked, plan, prompt};
use crate::json::utf16_prefix;
use crate::machine::Runtime;

#[derive(Clone, Default)]
pub struct SetupRunner {
    live: Arc<Mutex<Option<Live>>>,
}

struct Live {
    control: Arc<Control>,
    started_at: u64,
    activity: Option<super::stream::Activity>,
}

fn failure(message: String, code: Option<&str>) -> Value {
    let mut result = json!({"success":false,"error":message});
    if let Some(code) = code {
        result["code"] = Value::String(code.to_owned());
    }
    result
}

impl SetupRunner {
    pub fn status(&self) -> Value {
        match locked(&self.live).as_ref() {
            None => json!({"running":false}),
            Some(live) => {
                let mut result = json!({"running":true,"startedAt":live.started_at});
                if let Some(activity) = &live.activity {
                    result["activity"] = serde_json::to_value(activity).unwrap_or(Value::Null);
                }
                result
            }
        }
    }

    pub fn running(&self) -> bool {
        locked(&self.live).is_some()
    }

    pub fn abort(&self) -> bool {
        let state = locked(&self.live);
        let Some(live) = state.as_ref() else {
            return false;
        };
        *locked(&live.control.asked) = Some(Asked::Cancelled);
        live.control.stop.notify_one();
        true
    }

    pub async fn run(&self, runtime: Runtime, input: Value, cwd: String) -> Value {
        self.run_with_budget(runtime, input, cwd, Duration::from_millis(plan::TIMEOUT_MS))
            .await
    }

    async fn run_with_budget(
        &self,
        mut runtime: Runtime,
        input: Value,
        cwd: String,
        budget: Duration,
    ) -> Value {
        let (request, control) = {
            let mut state = locked(&self.live);
            if state.is_some() {
                return failure(
                    "Model research is already running".into(),
                    Some("model_setup_running"),
                );
            }
            let request = match plan::Request::parse(&input) {
                Ok(request) => request,
                Err(error) => return failure(error.message, Some(&error.code)),
            };
            let control = Arc::new(Control::default());
            *state = Some(Live {
                control: Arc::clone(&control),
                started_at: crate::clock::now_ms(),
                activity: None,
            });
            (request, control)
        };
        runtime.env.insert("PI_NOTIFICATIONS".into(), "off".into());
        runtime
            .env
            .insert("OTEL_SDK_DISABLED".into(), "true".into());
        let research = Research::start(RunParams {
            run: String::new(),
            bin: runtime.bin.to_string_lossy().into_owned(),
            env: runtime.env,
            cwd,
            research_model: request.research_model.clone(),
            prompt: prompt::build(&request),
            timeout_ms: budget.as_millis().min(u128::from(u64::MAX)) as u64,
        });
        let mut research = match research {
            Ok(research) => research,
            Err(error) => {
                locked(&self.live).take();
                return failure(error.message, None);
            }
        };
        let (send, receive) = oneshot::channel();
        let live = Arc::clone(&self.live);
        let task_control = Arc::clone(&control);
        tokio::spawn(async move {
            let ended = research
                .until_ended(&task_control, budget, |activity| {
                    if let Some(live) = locked(&live).as_mut() {
                        live.activity = Some(activity.clone());
                    }
                })
                .await;
            // Keep the caller's reservation until the real child has exited; cancellation never starts a second one beside it.
            research.leave().await;
            locked(&live).take();
            let _ = send.send(ended);
        });
        let guard = CancelOnDrop(control);
        let result = match receive.await {
            Err(_) => failure(
                "The model research task exited before the research finished".into(),
                None,
            ),
            Ok(Ended::Failed {
                error,
                stderr,
                cancelled,
            }) => {
                let mut result = failure(error, None);
                if let Some(stderr) = stderr {
                    result["stderr"] = Value::String(stderr);
                }
                if cancelled {
                    result["cancelled"] = Value::Bool(true);
                }
                result
            }
            Ok(Ended::Reply { reply }) => match plan::parse_plan(&reply, &request) {
                Ok(mut result) => {
                    result["success"] = Value::Bool(true);
                    result
                }
                Err(error) => {
                    let mut result = failure(error.message, Some(&error.code));
                    result["reply"] = Value::String(utf16_prefix(&reply, 4_000));
                    result
                }
            },
        };
        drop(guard);
        result
    }
}

struct CancelOnDrop(Arc<Control>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        *locked(&self.0.asked) = Some(Asked::Cancelled);
        self.0.stop.notify_one();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::models::test_rig::{Fixture, start_then};

    fn request() -> Value {
        json!({"researchModel":"p/research","models":[{"selector":"p/m","provider":"p"}],"roles":[{"id":"default","name":"Default"}]})
    }

    #[tokio::test]
    async fn parses_a_real_rpc_child_reply_and_waits_for_its_exit() {
        let fixture = Fixture::new("research-reply");
        let runtime = fixture.runtime(concat!(
            "IFS= read -r filter; IFS= read -r prompt\n",
            "printf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":\"{\\\"assignments\\\":[{\\\"role\\\":\\\"Default\\\",\\\"model\\\":\\\"p/m:high\\\",\\\"reason\\\":\\\" Good. \\\"}]}\"}}'\n",
            "printf '%s\\n' '{\"type\":\"prompt_result\",\"id\":\"model-setup\",\"status\":\"completed\"}'\n",
            "cat >/dev/null\n",
            "printf closed > closed\n",
        ));
        let runner = SetupRunner::default();
        let result = runner
            .run(
                runtime,
                request(),
                fixture.dir.to_string_lossy().into_owned(),
            )
            .await;
        assert_eq!(result["success"], true);
        assert_eq!(
            result["plan"]["assignments"],
            json!([{"role":"default","model":"p/m","reason":"Good."}])
        );
        assert_eq!(
            result["plan"]["advisor"],
            json!({"enable":false,"reason":""})
        );
        assert!(
            fixture.dir.join("closed").exists(),
            "child did not exit before the result"
        );
        assert_eq!(runner.status(), json!({"running":false}));
    }

    #[tokio::test]
    async fn cancels_an_immediate_stop_and_refuses_an_overlapping_run() {
        let fixture = Fixture::new("research-cancel");
        let runtime = fixture.runtime("IFS= read -r filter; IFS= read -r prompt; cat >/dev/null");
        let runner = SetupRunner::default();
        let future = runner.run(
            runtime,
            request(),
            fixture.dir.to_string_lossy().into_owned(),
        );
        let result = start_then(future, || {
            assert!(runner.running());
            assert!(runner.abort());
        })
        .await;
        assert_eq!(result["cancelled"], true);
        assert!(!runner.running());
        assert!(!runner.abort());
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_and_reaps_a_real_research_child() {
        let fixture = Fixture::new("research-timeout");
        let runtime = fixture.runtime("exec sleep 300");
        let runner = SetupRunner::default();
        let result = runner
            .run_with_budget(
                runtime,
                request(),
                fixture.dir.to_string_lossy().into_owned(),
                Duration::from_secs(60),
            )
            .await;
        assert_eq!(result["error"], "Model research timed out after 1 minutes");
        assert!(!runner.running());
    }
}
