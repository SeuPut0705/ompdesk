use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::pool::application::Sidecar;
use crate::server::Fault;

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "get_queue", "queue_remove", "queue_clear", "queue_edit", "queue_move", "dequeue",
];

static NEXT_CHIP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq)]
enum Lane { Steering, FollowUp }

impl Lane {
    fn name(self) -> &'static str {
        match self { Self::Steering => "steering", Self::FollowUp => "followUp" }
    }
    fn other(self) -> Self {
        match self { Self::Steering => Self::FollowUp, Self::FollowUp => Self::Steering }
    }
    fn parse(value: &Value) -> Option<Self> {
        match value.as_str() { Some("steering") => Some(Self::Steering), Some("followUp") => Some(Self::FollowUp), _ => None }
    }
}

#[derive(Clone)]
struct Chip { id: String, text: String, timestamp: u64 }
struct Expectation { lane: Lane, chip: Chip, at: u64 }

#[derive(Default)]
struct State {
    steering: Vec<Chip>,
    follow_up: Vec<Chip>,
    expected: Vec<Expectation>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

impl State {
    fn lane(&self, lane: Lane) -> &[Chip] {
        match lane { Lane::Steering => &self.steering, Lane::FollowUp => &self.follow_up }
    }
    fn find(&self, id: &str) -> Option<(Lane, Chip, usize)> {
        [Lane::Steering, Lane::FollowUp].into_iter().find_map(|lane| {
            self.lane(lane).iter().position(|chip| chip.id == id).map(|index| (lane, self.lane(lane)[index].clone(), index))
        })
    }
    fn expect(&mut self, lane: Lane, text: &str, mut chip: Chip) {
        chip.text = text.to_owned();
        self.expected.push(Expectation { lane, chip, at: now() });
    }
    fn reconcile(&mut self, steering: &[String], follow_up: &[String]) -> Value {
        let at = now();
        self.expected.retain(|entry| at.saturating_sub(entry.at) < 10_000);
        let match_lane = |previous: &[Chip], texts: &[String]| {
            let mut cursor = 0;
            texts.iter().map(|text| {
                let index = previous.iter().enumerate().skip(cursor).find(|(_, chip)| chip.text == *text).map(|(index, _)| index);
                index.map(|index| { cursor = index + 1; previous[index].clone() })
            }).collect::<Vec<_>>()
        };
        let matched = [match_lane(&self.steering, steering), match_lane(&self.follow_up, follow_up)];
        let mut used: HashSet<String> = matched.iter().flatten().flatten().map(|chip| chip.id.clone()).collect();
        let mut next = [Vec::new(), Vec::new()];
        for (slot, (lane, texts)) in [(Lane::Steering, steering), (Lane::FollowUp, follow_up)].into_iter().enumerate() {
            for (index, text) in texts.iter().enumerate() {
                let chip = if let Some(chip) = &matched[slot][index] {
                    chip.clone()
                } else if let Some(index) = self.expected.iter().position(|entry| entry.lane == lane && entry.chip.text == *text && !used.contains(&entry.chip.id)) {
                    self.expected.remove(index).chip
                } else if let Some(chip) = self.lane(lane.other()).iter().find(|chip| chip.text == *text && !used.contains(&chip.id)) {
                    chip.clone()
                } else {
                    let id = NEXT_CHIP_ID.fetch_add(1, Ordering::Relaxed) + 1;
                    Chip { id: format!("q{id}"), text: text.clone(), timestamp: at }
                };
                used.insert(chip.id.clone());
                next[slot].push(chip);
            }
        }
        [self.steering, self.follow_up] = next;
        self.view()
    }
    fn view(&self) -> Value {
        let wire = |lane: &[Chip]| lane.iter().map(|chip| json!({"id":chip.id,"text":chip.text,"timestamp":chip.timestamp,"editable":chip.text != "[Image]"})).collect::<Vec<_>>();
        json!({"steering":wire(&self.steering),"followUp":wire(&self.follow_up)})
    }
}

/// One instance belongs to one canonical sidecar generation, shared with its event projector.
#[derive(Default)]
pub struct Queue { state: Mutex<State> }

fn strings(value: &Value) -> Option<Vec<String>> {
    value.as_array()?.iter().map(|item| item.as_str().map(str::to_owned)).collect()
}

fn other(message: impl Into<String>) -> CommandError { CommandError::Other(message.into()) }

impl Queue {
    pub fn new() -> Self { Self::default() }

    pub fn project_queue_update(&self, mut frame: Value) -> Value {
        let (Some(steering), Some(follow_up)) = (strings(&frame["steering"]), strings(&frame["followUp"])) else { return frame; };
        let view = self.state.lock().unwrap_or_else(|e| e.into_inner()).reconcile(&steering, &follow_up);
        if let (Some(frame), Some(view)) = (frame.as_object_mut(), view.as_object()) {
            frame.extend(view.clone());
        }
        frame
    }

    async fn refresh<S: Sidecar<Error = Fault> + ?Sized + 'static>(&self, session: &Session<S>) -> Result<Value, CommandError> {
        let state = session.stock(json!({"type":"get_state"})).await?;
        let queued = &state["queuedMessages"];
        let steering = strings(&queued["steering"]).unwrap_or_default();
        let follow_up = strings(&queued["followUp"]).unwrap_or_default();
        Ok(self.state.lock().unwrap_or_else(|e| e.into_inner()).reconcile(&steering, &follow_up))
    }

    async fn locate<S: Sidecar<Error = Fault> + ?Sized + 'static>(&self, session: &Session<S>, command: &RpcCommand) -> Result<(Lane, Chip, usize), CommandError> {
        let id = command.string("queueId").filter(|id| !id.is_empty()).ok_or_else(|| other("queueId must be a non-empty string"))?;
        let found = self.state.lock().unwrap_or_else(|e| e.into_inner()).find(id);
        if let Some(found) = found { return Ok(found); }
        self.refresh(session).await?;
        self.state.lock().unwrap_or_else(|e| e.into_inner()).find(id).ok_or_else(|| other(format!("Unknown queued message id: {id}")))
    }

    async fn remove<S: Sidecar<Error = Fault> + ?Sized + 'static>(session: &Session<S>, lane: Lane, chip: &Chip) -> Result<bool, CommandError> {
        let result = session.stock(json!({"type":"remove_queued_message","message":chip.text,"queue":lane.name()})).await?;
        Ok(result["removed"] == true)
    }

    pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(&self, command: &RpcCommand, session: &Session<S>) -> CommandResult {
        let result = match command.kind.as_str() {
            "get_queue" => self.refresh(session).await?,
            "queue_remove" => {
                let (lane, chip, _) = self.locate(session, command).await?;
                if !Self::remove(session, lane, &chip).await? { return Err(other(format!("Unknown queued message id: {}", chip.id))); }
                json!({"removed":true})
            }
            "queue_clear" => {
                let lanes = match command.params.get("lane") {
                    None => vec![Lane::Steering, Lane::FollowUp],
                    Some(value) => vec![Lane::parse(value).ok_or_else(|| other("lane must be \"steering\" or \"followUp\""))?],
                };
                self.refresh(session).await?;
                let chips: Vec<_> = {
                    let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    lanes.into_iter().flat_map(|lane| state.lane(lane).iter().cloned().map(move |chip| (lane, chip))).collect()
                };
                let mut removed = 0;
                for (lane, chip) in chips { if Self::remove(session, lane, &chip).await? { removed += 1; } }
                json!({"removed":removed})
            }
            "queue_edit" => {
                let text = command.string("text").ok_or_else(|| other("text must be a string"))?;
                let (lane, chip, _) = self.locate(session, command).await?;
                if text != chip.text {
                    editable(&chip)?;
                    if !Self::remove(session, lane, &chip).await? { return Err(other(format!("Unknown queued message id: {}", chip.id))); }
                    self.state.lock().unwrap_or_else(|e| e.into_inner()).expect(lane, text, chip);
                    session.stock(json!({"type":if lane == Lane::Steering { "steer" } else { "follow_up" },"message":text})).await?;
                }
                json!({"updated":true})
            }
            "queue_move" => {
                let to_lane = match command.params.get("toLane") {
                    None => None,
                    Some(value) => Some(Lane::parse(value).ok_or_else(|| other("toLane must be \"steering\" or \"followUp\""))?),
                };
                let to_index = command.params.get("toIndex").and_then(Value::as_f64).filter(|n| n.is_finite()).ok_or_else(|| other("toIndex must be a finite number"))?;
                let (lane, chip, index) = self.locate(session, command).await?;
                let (len, landed) = {
                    let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    (state.lane(lane).len(), to_lane.map(|target| state.lane(target).len()).unwrap_or(0))
                };
                if to_lane.is_none() || to_lane == Some(lane) {
                    let target = to_index.floor().max(0.0).min(len.saturating_sub(1) as f64) as usize;
                    if target != index { return Err(CommandError::local("unsupported", "omp cannot reorder queued messages within a lane")); }
                    json!({"lane":lane.name(),"index":index})
                } else {
                    let target = to_lane.expect("target checked");
                    if target == Lane::Steering {
                        self.state.lock().unwrap_or_else(|e| e.into_inner()).expect(target, &chip.text, chip.clone());
                        let result = session.stock(json!({"type":"promote_queued_message","message":chip.text})).await?;
                        if result["promoted"] != true { return Err(other(format!("Unknown queued message id: {}", chip.id))); }
                    } else {
                        editable(&chip)?;
                        if !Self::remove(session, lane, &chip).await? { return Err(other(format!("Unknown queued message id: {}", chip.id))); }
                        self.state.lock().unwrap_or_else(|e| e.into_inner()).expect(target, &chip.text, chip.clone());
                        session.stock(json!({"type":"follow_up","message":chip.text})).await?;
                    }
                    json!({"lane":target.name(),"index":landed})
                }
            }
            "dequeue" => {
                if session.bridge_connected() {
                    let popped = session.bridge("composer.dequeue", json!({})).await?;
                    json!({"messages":if popped.is_null() { vec![] } else { vec![popped] }})
                } else {
                    self.refresh(session).await?;
                    let last = {
                        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        let lane = if state.steering.is_empty() { Lane::FollowUp } else { Lane::Steering };
                        state.lane(lane).last().cloned().map(|chip| (lane, chip))
                    };
                    match last {
                        Some((lane, chip)) if Self::remove(session, lane, &chip).await? => json!({"messages":[{"text":chip.text}]}),
                        _ => json!({"messages":[]}),
                    }
                }
            }
            _ => return Ok(None),
        };
        Ok(Some(result))
    }
}

fn editable(chip: &Chip) -> Result<(), CommandError> {
    if chip.text == "[Image]" { Err(CommandError::local("not_editable", "An image-only queued message cannot be re-queued")) } else { Ok(()) }
}
