//! The host's side (was `link-events.ts`'s `createLinkEventEncoder` and `createLinkEventSender`): one encoder per tab
//! and connection, and the sender that holds a flush's subagent frames back so the encoder sees every item in wire
//! order.

use std::borrow::Cow;
use std::mem;
use std::time::Duration;

use serde_json::Value;

use super::delta::{ProgressEncoder, StatusEncoder};
use super::js;
use super::refs::{
    ArgsEncoder, EndsEncoder, OutputEncoder, ToolResultEncoder, UsageDropper, key_of,
};
use super::slim::{Slimmer, slimmed_subagent_frame};

/// How long the sender holds subagent frames for one tab event (`event-batcher.ts` `BATCH_INTERVAL_MS`).
pub const BATCH_INTERVAL: Duration = Duration::from_millis(32);

/// What the device reads beyond whole frames: its hello's `slim*` flags (`LinkSlim`, `protocol.ts`), as the encoder
/// tested each (truthy, or `=== true` for `readGroups` and `endFields`; the sender batches only on `progress === true`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    pub progress: bool,
    pub autopilot: bool,
    pub ends: bool,
    pub read_groups: bool,
    pub end_fields: bool,
    pub tool_results: bool,
    pub tool_outputs: bool,
    pub tool_args: bool,
    /// `progress === true`: frames leave in batches.
    pub batches: bool,
}

impl Options {
    pub fn from_value(slim: &Value) -> Options {
        let truthy = |key| js::truthy(slim.get(key));
        let exactly = |key| slim.get(key) == Some(&Value::Bool(true));
        Options {
            progress: truthy("progress"),
            autopilot: truthy("autopilot"),
            ends: truthy("ends"),
            read_groups: exactly("readGroups"),
            end_fields: exactly("endFields"),
            tool_results: truthy("toolResults"),
            tool_outputs: truthy("toolOutputs"),
            tool_args: truthy("toolArgs"),
            batches: exactly("progress"),
        }
    }
}

/// One per tab and connection: applies the windows' slimming and the capabilities the device asked for.
#[derive(Debug)]
pub struct Encoder {
    slim: Slimmer,
    usage: UsageDropper,
    progress: Option<ProgressEncoder>,
    status: Option<StatusEncoder>,
    ends: Option<EndsEncoder>,
    tools: Option<ToolResultEncoder>,
    outputs: Option<OutputEncoder>,
    args: Option<ArgsEncoder>,
}

/// `current` replaced by `f`'s result when it gave one.
fn then<'a>(current: Cow<'a, Value>, f: impl FnOnce(&Value) -> Option<Value>) -> Cow<'a, Value> {
    match f(&current) {
        Some(next) => Cow::Owned(next),
        None => current,
    }
}

impl Encoder {
    pub fn new(options: Options) -> Encoder {
        let ends = options
            .ends
            .then(|| EndsEncoder::new(options.read_groups, options.end_fields));
        Encoder {
            slim: Slimmer::new(),
            usage: UsageDropper::default(),
            progress: options.progress.then(ProgressEncoder::default),
            status: options.autopilot.then(StatusEncoder::default),
            tools: (ends.is_some() && options.tool_results).then(ToolResultEncoder::default),
            ends,
            outputs: options.tool_outputs.then(OutputEncoder::default),
            args: options.tool_args.then(ArgsEncoder::default),
        }
    }

    fn update(&mut self, scope: &str, event: &Value) -> Option<Value> {
        let mut current = Cow::Borrowed(event);
        if let Some(progress) = &mut self.progress {
            current = then(current, |event| progress.update(event));
        }
        if let Some(outputs) = &mut self.outputs {
            current = then(current, |event| outputs.update(scope, event));
        }
        if let Some(args) = &mut self.args {
            current = then(current, |event| args.encode(scope, event));
        }
        match current {
            Cow::Owned(next) => Some(next),
            Cow::Borrowed(_) => None,
        }
    }

    fn forget(&mut self, scope: &str, event: &Value) {
        if let Some(outputs) = &mut self.outputs {
            outputs.forget(scope, event);
        }
        if let Some(args) = &mut self.args {
            args.forget(scope, event);
        }
    }

    fn event(&mut self, event: &Value) -> Option<Value> {
        self.forget("", event);
        match js::type_of(event)? {
            "message_update" => self.usage.drop("", event),
            "message_start" | "message_end" | "agent_end" if self.ends.is_some() => {
                let ends = self.ends.as_mut()?;
                let current = then(Cow::Borrowed(event), |event| ends.encode(event));
                let current = match &mut self.tools {
                    Some(tools) => then(current, |event| tools.encode(event)),
                    None => current,
                };
                match current {
                    Cow::Owned(next) => Some(next),
                    Cow::Borrowed(_) => None,
                }
            }
            "tool_execution_end" => self.tools.as_mut()?.encode(event),
            "tool_execution_update" => self.update("", event),
            "tool_execution_start" => self.args.as_mut()?.encode("", event),
            "autopilot_update" => {
                let status = self.status.as_mut()?.encode(event.get("status"))?;
                event
                    .as_object()
                    .map(|event| Value::Object(js::with(event, "status", status)))
            }
            _ => None,
        }
    }

    /// An omp `events` batch as it crosses; borrowed when nothing changed.
    pub fn events<'a>(&mut self, batch: &'a [Value]) -> Cow<'a, [Value]> {
        let mut events = self.slim.slim(batch);
        for index in 0..events.len() {
            if let Some(next) = self.event(&events[index]) {
                events.to_mut()[index] = next;
            }
        }
        events
    }

    /// One subagent frame as it crosses.
    pub fn subagent_frame<'a>(&mut self, frame: &'a Value) -> Cow<'a, Value> {
        let slimmed = slimmed_subagent_frame(frame);
        match js::type_of(&slimmed) {
            Some("subagent_progress") => match &mut self.progress {
                Some(progress) => then(slimmed, |frame| progress.frame(frame)),
                None => slimmed,
            },
            Some("subagent_event") => {
                let Some(payload) = slimmed.get("payload").and_then(Value::as_object) else {
                    return slimmed;
                };
                let Some(event) = payload.get("event") else {
                    return slimmed;
                };
                let scope = key_of(payload.get("id"));
                self.forget(&scope, event);
                let next = match js::type_of(event) {
                    Some("message_update") => self.usage.drop(&scope, event),
                    Some("tool_execution_update") => self.update(&scope, event),
                    Some("tool_execution_start") => self
                        .args
                        .as_mut()
                        .and_then(|args| args.encode(&scope, event)),
                    _ => None,
                };
                let Some(next) = next else {
                    return slimmed;
                };
                let mut out = serde_json::Map::new();
                if let Some(kind) = slimmed.get("type") {
                    out.insert("type".into(), kind.clone());
                }
                out.insert(
                    "payload".into(),
                    Value::Object(js::with(payload, "event", next)),
                );
                Cow::Owned(Value::Object(out))
            }
            _ => slimmed,
        }
    }
}

/// The two tab events the sender sends.
pub const EVENTS: &str = "events";
pub const SUBAGENT_FRAME: &str = "subagentFrame";

/// What the host sends one device for one tab: [`Encoder`]'s output, and for a device that asked for `slimProgress`
/// the subagent frames of one [`BATCH_INTERVAL`] in one `subagentFrame` tab event (an array). Frames are encoded when
/// they leave, so the encoder sees them in wire order, and events and frames never swap places. `send` sends one tab
/// event and answers false when it did not go out (an event over the frame cap): the next snapshot of each subagent
/// then goes whole, since the device never got this one.
///
/// It owns no clock: [`Sender::subagent_frame`] answers the timer to start (its generation), and the owner calls
/// [`Sender::timer`] with it once [`BATCH_INTERVAL`] passed; a flush in between makes that call a no-op.
#[derive(Debug)]
pub struct Sender {
    options: Options,
    encoder: Encoder,
    held: Vec<Value>,
    timer: Option<u64>,
    generation: u64,
}

pub type Send<'a> = dyn FnMut(&'static str, Value) -> bool + 'a;

impl Sender {
    pub fn new(options: Options) -> Sender {
        Sender {
            options,
            encoder: Encoder::new(options),
            held: Vec::new(),
            timer: None,
            generation: 0,
        }
    }

    fn deliver(&mut self, name: &'static str, arg: Value, send: &mut Send) {
        if !send(name, arg) {
            self.encoder = Encoder::new(self.options);
        }
    }

    /// An omp `events` batch; the subagent frames held back go first, as they came.
    pub fn events(&mut self, batch: &[Value], send: &mut Send) {
        self.flush(send);
        let out = self.encoder.events(batch).into_owned();
        self.deliver(EVENTS, Value::Array(out), send);
    }

    /// A subagent frame: sent at once to a device that reads no batches, else held. `Some(generation)`: start the
    /// batch timer for it.
    pub fn subagent_frame(&mut self, frame: Value, send: &mut Send) -> Option<u64> {
        if !self.options.batches {
            let out = self.encoder.subagent_frame(&frame).into_owned();
            self.deliver(SUBAGENT_FRAME, out, send);
            return None;
        }
        self.held.push(frame);
        if self.timer.is_some() {
            return None;
        }
        self.generation += 1;
        self.timer = Some(self.generation);
        self.timer
    }

    /// Sends the frames held back now: before any other tab event, and before a response the omp is about to give.
    pub fn flush(&mut self, send: &mut Send) {
        self.timer = None;
        if self.held.is_empty() {
            return;
        }
        let frames = mem::take(&mut self.held);
        let out: Vec<Value> = frames
            .iter()
            .map(|frame| self.encoder.subagent_frame(frame).into_owned())
            .collect();
        self.deliver(SUBAGENT_FRAME, Value::Array(out), send);
    }

    /// The batch timer of `generation` ran out.
    pub fn timer(&mut self, generation: u64, send: &mut Send) {
        if self.timer == Some(generation) {
            self.flush(send);
        }
    }

    /// The connection is gone: what is held back is not sent.
    pub fn dispose(&mut self) {
        self.timer = None;
        self.held.clear();
    }
}
