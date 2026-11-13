//! Small shared pieces: the error a step ends with, JSON reads, and timers.

use serde_json::Value;
use tokio::task::AbortHandle;

use crate::ports::PortError;
use crate::server::Fault;

/// What a command or step fails with: a message that reads as it is (a toast shows it), and the code an `AutopilotError`
/// carries (`autopilot_*`); plain errors carry none.
#[derive(Debug, Clone, PartialEq)]
pub struct Oops {
    pub message: String,
    pub code: Option<&'static str>,
}

pub type R<T> = Result<T, Oops>;

pub fn oops(code: &'static str, message: impl Into<String>) -> Oops {
    Oops {
        message: message.into(),
        code: Some(code),
    }
}

impl From<String> for Oops {
    fn from(message: String) -> Oops {
        Oops {
            message,
            code: None,
        }
    }
}

impl From<&str> for Oops {
    fn from(message: &str) -> Oops {
        Oops::from(message.to_owned())
    }
}

impl From<PortError> for Oops {
    fn from(error: PortError) -> Oops {
        Oops::from(error.message)
    }
}

impl From<Fault> for Oops {
    fn from(fault: Fault) -> Oops {
        Oops::from(fault.message)
    }
}

impl std::fmt::Display for Oops {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|number| {
        number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64))
    })
}

pub fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// What a timer that can be called off holds.
pub struct Cancel(AbortHandle);

impl Cancel {
    pub fn cancel(self) {
        self.0.abort();
    }
}

/// Runs `work` once after `ms`; the handle calls it off.
pub fn after(ms: u64, work: impl FnOnce() + Send + 'static) -> Cancel {
    let task = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        work();
    });
    Cancel(task.abort_handle())
}

/// Runs `work` every `ms` until the handle calls it off.
pub fn every(ms: u64, mut work: impl FnMut() + Send + 'static) -> Cancel {
    let task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(ms.max(1)));
        tick.tick().await;
        loop {
            tick.tick().await;
            work();
        }
    });
    Cancel(task.abort_handle())
}

/// `string.slice(0, 9)` of a hash.
pub fn short(sha: &str) -> &str {
    &sha[..sha.len().min(9)]
}
