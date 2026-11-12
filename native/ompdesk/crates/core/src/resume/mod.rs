//! Turn resume and the connectivity monitor (were `src/main/turn-resume.ts`, `turn-resume-ends.ts` and
//! `connectivity.ts`; unit 9f): hub instances of kinds `resume` and `connectivity`.

use serde_json::value::RawValue;

use crate::hub::{Kind, Out, Outcome};
use crate::server::Fault;

pub const RESUME_KIND: Kind = Kind {
    name: "resume",
    open,
    call,
    close,
};

pub const CONNECTIVITY_KIND: Kind = Kind {
    name: "connectivity",
    open,
    call,
    close,
};

fn open(_id: u64, _opts: &RawValue, _out: Out) -> Result<(), Fault> {
    Err(Fault::new("not_built", "Turn resume is not in the core yet"))
}

fn call(_id: u64, method: &str, _params: &RawValue) -> Outcome {
    Outcome::fault("no_method", method.to_string())
}

fn close(_id: u64) {}
