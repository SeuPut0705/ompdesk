//! The sidecar pool (was `src/main/sidecar-pool.ts`'s rules and state; units 9d and 9e): a hub instance of kind `pool`.

use serde_json::value::RawValue;

use crate::hub::{Kind, Out, Outcome};
use crate::server::Fault;

pub const KIND: Kind = Kind {
    name: "pool",
    open,
    call,
    close,
};

fn open(_id: u64, _opts: &RawValue, _out: Out) -> Result<(), Fault> {
    Err(Fault::new("not_built", "The pool is not in the core yet"))
}

fn call(_id: u64, method: &str, _params: &RawValue) -> Outcome {
    Outcome::fault("no_method", method.to_string())
}

fn close(_id: u64) {}
