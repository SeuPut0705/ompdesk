//! A kind for main's tests of the hub connection (`src/main/core/hub.test.ts`), as `core.echo` is the wire's: it
//! pushes, waits, asks and answers on command, and holds nothing else.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{Kind, Out, Outcome};

thread_local! {
    static PROBES: RefCell<HashMap<u64, Probe>> = RefCell::default();
}

struct Probe {
    out: Out,
    waiting: Option<oneshot::Sender<()>>,
}

pub const KIND: Kind = Kind {
    name: "test:probe",
    open: |id, _, out| {
        PROBES.with(|probes| probes.borrow_mut().insert(id, Probe { out, waiting: None }));
        Ok(())
    },
    call: probe_call,
    close: |id| {
        PROBES.with(|probes| probes.borrow_mut().remove(&id));
    },
};

fn out_of(id: u64) -> Out {
    PROBES.with(|probes| probes.borrow()[&id].out)
}

fn probe_call(id: u64, method: &str, params: &RawValue) -> Outcome {
    let params: Value = serde_json::from_str(params.get()).unwrap_or(Value::Null);
    let out = out_of(id);
    match method {
        // Pushes its items, then answers.
        "push" => {
            out.push(&json!({"k": "n", "n": params["n"]}));
            Outcome::ok(&params["n"])
        }
        // Answers once `fire` came; its continuation tells main first.
        "wait" => {
            let (fire, fired) = oneshot::channel();
            PROBES.with(|probes| probes.borrow_mut().get_mut(&id).unwrap().waiting = Some(fire));
            Outcome::Later(Box::pin(async move {
                let _ = fired.await;
                out.push(&json!({"k": "woke"}));
                Ok(json!("woke"))
            }))
        }
        "fire" => {
            let waiting =
                PROBES.with(|probes| probes.borrow_mut().get_mut(&id).unwrap().waiting.take());
            if let Some(waiting) = waiting {
                let _ = waiting.send(());
            }
            Outcome::done()
        }
        "mark" => {
            out.push(&json!({"k": "mark"}));
            Outcome::done()
        }
        // Asks main and answers what main said; then pushes `after`.
        "ask" => Outcome::Later(Box::pin(async move {
            let answer = out.ask("probe", &json!({"x": 1})).await?;
            out.push(&json!({"k": "after"}));
            Ok(answer)
        })),
        // Asks main for a promise's value: a call that awaits it is a call main must not wait for.
        "askLater" => Outcome::Later(Box::pin(async move {
            out.ask_later("probe", &json!({"x": 2})).await
        })),
        _ => Outcome::fault("no_method", method.to_string()),
    }
}
