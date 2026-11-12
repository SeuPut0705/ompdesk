//! Turn resume and the connectivity monitor (were `src/main/turn-resume.ts`, `turn-resume-ends.ts` and
//! `connectivity.ts`; unit 9f): hub instances of kinds `resume` and `connectivity`. Main's classes of the same names
//! stay as their clients (`src/main/turn-resume.ts`, `src/main/connectivity.ts`); every collaborator they were given is
//! asked from here, and the rules and their state live only here.

use std::rc::Rc;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::hub::{self, Kind, Out, Outcome};
use crate::server::Fault;

mod connectivity;
mod ends;
mod facts;
mod jsre;
mod machine;
mod text;
mod util;

use facts::{Fact, MarkerData};
use machine::{Env, Inst};

pub const RESUME_KIND: Kind = Kind {
    name: "resume",
    open: open_resume,
    call: call_resume,
    close: machine::close,
};

pub const CONNECTIVITY_KIND: Kind = Kind {
    name: "connectivity",
    open: connectivity::open,
    call: connectivity::call,
    close: connectivity::close,
};

fn open_resume(id: u64, opts: &RawValue, out: Out) -> Result<(), Fault> {
    machine::open(id, opts, out)
}

#[derive(Deserialize)]
struct SyncParams {
    env: Env,
}

#[derive(Deserialize)]
struct FlushParams {
    env: Env,
}

#[derive(Deserialize)]
struct TabParams {
    tab: String,
    #[serde(default)]
    enabled: bool,
}

#[derive(Deserialize)]
struct TimerParams {
    timer: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusParams {
    listener: u64,
    status: String,
    #[serde(default)]
    session_held: bool,
}

#[derive(Deserialize)]
struct MessageParams {
    message: Option<String>,
}

#[derive(Deserialize)]
struct DeriveParams {
    facts: Vec<Fact>,
    previous: Vec<MarkerData>,
    now: f64,
    limited: Vec<String>,
}

#[derive(Deserialize)]
struct MarkerParams {
    marker: MarkerData,
}

/// The pure rules, answered without an instance's state (main calls them from tests and from code that cannot wait for a
/// continuation): `deriveMarkers`, `launchAction`, the text classifiers.
fn pure(method: &str, params: &RawValue) -> Option<Outcome> {
    Some(match method {
        "deriveMarkers" => match hub::params::<DeriveParams>(params) {
            Ok(p) => Outcome::ok(&facts::derive_markers(
                &p.facts,
                &p.previous,
                p.now,
                &p.limited.into_iter().collect(),
            )),
            Err(fault) => Outcome::Now(Err(fault)),
        },
        "launchAction" => match hub::params::<MarkerParams>(params) {
            Ok(p) => Outcome::ok(&facts::launch_action(&p.marker)),
            Err(fault) => Outcome::Now(Err(fault)),
        },
        "isNetworkError" => message(params, |m| json!(text::is_network_error(m))),
        "isTransientError" => message(params, |m| json!(text::is_transient_error(m))),
        "connectFailureHost" => message(params, |m| json!(text::connect_failure_host(m))),
        _ => return None,
    })
}

fn message(params: &RawValue, answer: impl Fn(Option<&str>) -> Value) -> Outcome {
    match hub::params::<MessageParams>(params) {
        Ok(p) => Outcome::ok(&answer(p.message.as_deref())),
        Err(fault) => Outcome::Now(Err(fault)),
    }
}

fn call_resume(id: u64, method: &str, params: &RawValue) -> Outcome {
    if let Some(answer) = pure(method, params) {
        return answer;
    }
    let Some(inst) = machine::instance(id) else {
        return Outcome::fault("no_instance", format!("No turn resume {id}"));
    };
    macro_rules! parsed {
        ($ty:ty) => {
            match hub::params::<$ty>(params) {
                Ok(p) => p,
                Err(fault) => return Outcome::Now(Err(fault)),
            }
        };
    }
    match method {
        "sync" => {
            inst.sync(parsed!(SyncParams).env);
            Outcome::done()
        }
        "flush" => Outcome::ok(&inst.flush(parsed!(FlushParams).env)),
        "timer" => {
            inst.on_timer(parsed!(TimerParams).timer);
            Outcome::done()
        }
        "relaunchContinuation" => {
            let p = parsed!(TabParams);
            Outcome::ok(&inst.relaunch_continuation(&p.tab, p.enabled))
        }
        "status" => {
            let p = parsed!(StatusParams);
            later(inst, move |inst| async move {
                inst.on_status(p.listener, &p.status, p.session_held)
                    .await?;
                Ok(Value::Null)
            })
        }
        "launch" => later(inst, |inst| async move {
            inst.launch().await?;
            Ok(Value::Null)
        }),
        "cancelWait" => {
            let p = parsed!(TabParams);
            later(inst, move |inst| async move {
                inst.cancel_wait(&p.tab).await?;
                Ok(Value::Null)
            })
        }
        "stopResumed" => {
            let p = parsed!(TabParams);
            later(inst, move |inst| async move {
                let token = inst.stop_resumed(&p.tab).await?;
                Ok(json!(token))
            })
        }
        other => Outcome::fault("no_method", other.to_owned()),
    }
}

fn later<F, Fut>(inst: Rc<Inst>, work: F) -> Outcome
where
    F: FnOnce(Rc<Inst>) -> Fut,
    Fut: Future<Output = Result<Value, Fault>> + 'static,
{
    Outcome::Later(Box::pin(work(inst)))
}
