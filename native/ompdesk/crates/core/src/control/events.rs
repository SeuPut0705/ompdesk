//! The event stream behind `subscribe` (was `src/main/control-socket/events.ts`): a ring of the latest events, one
//! cursor per subscriber. A subscriber that cannot keep up (its connection is full) is told exactly how many events
//! it lost and its subscription ends: nothing is skipped silently. Sessions hidden from agents never appear (main's
//! views leave them out).
//!
//! The TypeScript read the sessions itself whenever something happened; here main sends them with each activity and
//! each poll answer (`super::link`), so this side only compares.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde::Serialize;

use super::{Activity, SessionState, View};

/// Where a subscriber's frames go: one connection's output.
pub trait Sink: Send + Sync {
    /// Takes one JSON line; false means the reader is behind, and `Hub::drained` says when it caught up.
    fn write(&self, line: String) -> bool;
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event<'a> {
    SessionState {
        session: &'a str,
        title: &'a str,
        state: SessionState,
        previous: Option<SessionState>,
    },
    Ask {
        session: &'a str,
        title: &'a str,
        #[serde(rename = "requestId")]
        request_id: &'a str,
        text: &'a str,
    },
    TurnFinished {
        session: &'a str,
        title: &'a str,
        #[serde(rename = "stopReason")]
        stop_reason: &'a str,
    },
    SessionClosed {
        session: &'a str,
    },
    Report {
        to: &'a str,
        text: &'a str,
    },
}

#[derive(Serialize)]
struct Lost<'a> {
    code: &'static str,
    message: &'a str,
    lost: u64,
}

struct Entry {
    seq: u64,
    /// The event as JSON.
    event: String,
    /// A report's addressee: only that caller hears it.
    to: Option<String>,
}

struct Subscription {
    /// The connection it belongs to.
    owner: u64,
    caller: String,
    /// The `subscribe` request's id as it is echoed in every frame.
    sub: String,
    sink: Arc<dyn Sink>,
    cursor: u64,
    paused: bool,
}

pub struct Hub {
    capacity: usize,
    ring: VecDeque<Entry>,
    next_seq: u64,
    subscriptions: Vec<Subscription>,
    /// Each visible session's state as last told, while somebody listens.
    known: HashMap<String, SessionState>,
    /// Whether `known` was read since the first subscriber came: until then nothing is compared.
    attached: bool,
}

impl Hub {
    pub fn new(capacity: usize) -> Hub {
        Hub {
            capacity,
            ring: VecDeque::new(),
            next_seq: 1,
            subscriptions: Vec::new(),
            known: HashMap::new(),
            attached: false,
        }
    }

    /// Whether anybody is subscribed: main is asked for activity and polled only while somebody is.
    pub fn listening(&self) -> bool {
        !self.subscriptions.is_empty()
    }

    /// Starts live: the subscriber sees events from now on, never earlier ones. The first subscriber's states are
    /// read from the next `views`.
    pub fn subscribe(&mut self, owner: u64, caller: &str, sub: &str, sink: Arc<dyn Sink>) {
        self.subscriptions.push(Subscription {
            owner,
            caller: caller.to_owned(),
            sub: sub.to_owned(),
            sink,
            cursor: self.next_seq,
            paused: false,
        });
    }

    /// The connection `owner` closed.
    pub fn release(&mut self, owner: u64) {
        self.subscriptions
            .retain(|subscription| subscription.owner != owner);
        self.detach_if_idle();
    }

    fn detach_if_idle(&mut self) {
        if self.subscriptions.is_empty() {
            self.attached = false;
            self.known.clear();
        }
    }

    /// The sessions now, with no activity (a poll's answer): the first after a subscriber came is where the states
    /// start, every later one is compared.
    pub fn views(&mut self, views: &[View]) {
        if !self.listening() {
            return;
        }
        if self.attached {
            self.sync(views);
        } else {
            self.known = views
                .iter()
                .map(|view| (view.session.clone(), view.state))
                .collect();
            self.attached = true;
        }
    }

    /// Something a tab did, with the sessions as they were at that moment.
    pub fn activity(&mut self, activity: &Activity, views: &[View]) {
        if !self.listening() || !self.attached {
            return;
        }
        let view = |views: &[View]| {
            views
                .iter()
                .find(|view| view.session == activity.tab_id)
                .cloned()
        };
        match activity.kind.as_str() {
            "released" => {
                if self.known.remove(&activity.tab_id).is_some() {
                    self.publish(
                        &Event::SessionClosed {
                            session: &activity.tab_id,
                        },
                        None,
                    );
                }
            }
            "ask" => {
                self.sync(views);
                if let Some(view) = view(views) {
                    self.publish(
                        &Event::Ask {
                            session: &activity.tab_id,
                            title: &view.title,
                            request_id: activity.request_id.as_deref().unwrap_or_default(),
                            text: activity.text.as_deref().unwrap_or_default(),
                        },
                        None,
                    );
                }
            }
            "idle" => {
                self.sync(views);
                if let Some(view) = view(views) {
                    self.publish(
                        &Event::TurnFinished {
                            session: &activity.tab_id,
                            title: &view.title,
                            stop_reason: activity.stop_reason.as_deref().unwrap_or("stop"),
                        },
                        None,
                    );
                }
            }
            _ => self.sync(views),
        }
    }

    /// A report addressed to the outside caller `to`.
    pub fn mail(&mut self, to: &str, text: &str) {
        if self.listening() {
            self.publish(&Event::Report { to, text }, Some(to));
        }
    }

    /// The connection `owner` took everything written to it: its paused subscriptions go on.
    pub fn drained(&mut self, owner: u64) {
        let mut index = 0;
        while index < self.subscriptions.len() {
            let subscription = &mut self.subscriptions[index];
            if subscription.owner == owner && subscription.paused {
                subscription.paused = false;
                if self.pump(index) {
                    continue;
                }
            }
            index += 1;
        }
        self.detach_if_idle();
    }

    fn sync(&mut self, views: &[View]) {
        for view in views {
            let previous = self.known.get(&view.session).copied();
            if previous == Some(view.state) {
                continue;
            }
            self.known.insert(view.session.clone(), view.state);
            self.publish(
                &Event::SessionState {
                    session: &view.session,
                    title: &view.title,
                    state: view.state,
                    previous,
                },
                None,
            );
        }
        // A session that left the views without a release was hidden: it vanishes without a word.
        self.known
            .retain(|session, _| views.iter().any(|view| &view.session == session));
    }

    fn publish(&mut self, event: &Event, to: Option<&str>) {
        // Strings, enums and options of them: serializing cannot fail.
        let event = serde_json::to_string(event).unwrap_or_default();
        self.ring.push_back(Entry {
            seq: self.next_seq,
            event,
            to: to.map(str::to_owned),
        });
        self.next_seq += 1;
        while self.ring.len() > self.capacity {
            self.ring.pop_front();
        }
        let mut index = 0;
        while index < self.subscriptions.len() {
            if !self.pump(index) {
                index += 1;
            }
        }
        self.detach_if_idle();
    }

    /// Writes the subscription at `index` what it has not seen; true when it was ended (it fell behind).
    fn pump(&mut self, index: usize) -> bool {
        loop {
            let subscription = &mut self.subscriptions[index];
            if subscription.paused {
                return false;
            }
            let oldest = self.ring.front().map_or(self.next_seq, |entry| entry.seq);
            if subscription.cursor < oldest {
                let lost = oldest - subscription.cursor;
                let message = format!(
                    "{lost} event{} dropped: the reader fell behind. Subscribe again and resync with `ompdesk sessions` (or `state` per session).",
                    if lost == 1 { "" } else { "s" }
                );
                let error = serde_json::to_string(&Lost {
                    code: "events_lost",
                    message: &message,
                    lost,
                })
                .unwrap_or_default();
                subscription.sink.write(format!(
                    "{{\"sub\":{},\"error\":{error}}}\n",
                    subscription.sub
                ));
                self.subscriptions.remove(index);
                return true;
            }
            if subscription.cursor >= self.next_seq {
                return false;
            }
            let Some(entry) = self.ring.get((subscription.cursor - oldest) as usize) else {
                return false;
            };
            subscription.cursor += 1;
            if entry
                .to
                .as_deref()
                .is_some_and(|to| to != subscription.caller)
            {
                continue;
            }
            let line = format!(
                "{{\"sub\":{},\"seq\":{},\"event\":{}}}\n",
                subscription.sub, entry.seq, entry.event
            );
            if !subscription.sink.write(line) {
                subscription.paused = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;

    use super::*;
    use crate::control::tests::{captured, state_of};

    #[derive(Default)]
    struct Recording {
        lines: Mutex<Vec<String>>,
        accepting: AtomicBool,
    }

    impl Sink for Recording {
        fn write(&self, line: String) -> bool {
            self.lines.lock().unwrap().push(line);
            self.accepting.load(Ordering::SeqCst)
        }
    }

    /// The sessions main would send, in the order a JavaScript `Map` keeps them.
    #[derive(Default)]
    struct Sessions(Vec<View>);

    impl Sessions {
        fn set(&mut self, session: &str, state: SessionState) {
            match self.0.iter_mut().find(|view| view.session == session) {
                Some(view) => view.state = state,
                None => self.0.push(View {
                    session: session.to_owned(),
                    title: format!("title of {session}"),
                    state,
                }),
            }
        }
    }

    /// `events.test.ts`'s cases and more, as scripts run through the TypeScript hub before it was deleted: what each
    /// subscriber was written, line for line.
    #[test]
    fn writes_each_subscriber_what_the_typescript_did() {
        let rows = captured("hub");
        assert_eq!(rows.len(), 16);
        for row in rows {
            let name = row["name"].as_str().unwrap();
            let mut hub = Hub::new(row["capacity"].as_u64().map_or(1024, |n| n as usize));
            let mut sessions = Sessions::default();
            for session in row["sessions"].as_array().unwrap() {
                sessions.set(session[0].as_str().unwrap(), state_of(&session[1]));
            }
            let mut sinks: Vec<(String, u64, Arc<Recording>)> = Vec::new();
            let find = |sinks: &[(String, u64, Arc<Recording>)], name: &Value| {
                let name = name.as_str().unwrap();
                sinks
                    .iter()
                    .find(|(sink, _, _)| sink == name)
                    .map(|(_, owner, sink)| (*owner, Arc::clone(sink)))
                    .unwrap()
            };
            for op in row["ops"].as_array().unwrap() {
                let (key, value) = op.as_object().unwrap().iter().next().unwrap();
                match key.as_str() {
                    "sub" => {
                        let owner = sinks.len() as u64 + 1;
                        let sink = Arc::new(Recording::default());
                        sink.accepting
                            .store(value[3].as_bool().unwrap(), Ordering::SeqCst);
                        sinks.push((
                            value[0].as_str().unwrap().to_owned(),
                            owner,
                            Arc::clone(&sink),
                        ));
                        let first = !hub.listening();
                        hub.subscribe(
                            owner,
                            value[1].as_str().unwrap(),
                            &value[2].to_string(),
                            sink,
                        );
                        // The TypeScript read the sessions as the first subscriber came.
                        if first {
                            hub.views(&sessions.0);
                        }
                    }
                    "unsub" => hub.release(find(&sinks, value).0),
                    "add" | "set" => sessions.set(value[0].as_str().unwrap(), state_of(&value[1])),
                    "del" => sessions
                        .0
                        .retain(|view| view.session != value.as_str().unwrap()),
                    "fire" => {
                        let kind = value["type"].as_str().unwrap();
                        let text = |key: &str, fallback: &str| {
                            Some(value[key].as_str().unwrap_or(fallback).to_owned())
                        };
                        let activity = Activity {
                            kind: kind.to_owned(),
                            tab_id: value["tab"].as_str().unwrap().to_owned(),
                            request_id: (kind == "ask").then(|| text("requestId", "q1")).flatten(),
                            text: (kind == "ask").then(|| text("text", "Proceed?")).flatten(),
                            stop_reason: value["stopReason"].as_str().map(str::to_owned),
                        };
                        hub.activity(&activity, &sessions.0);
                    }
                    "mail" => hub.mail(value[0].as_str().unwrap(), value[1].as_str().unwrap()),
                    "accept" => find(&sinks, &value[0])
                        .1
                        .accepting
                        .store(value[1].as_bool().unwrap(), Ordering::SeqCst),
                    "drain" => {
                        let (owner, sink) = find(&sinks, value);
                        sink.accepting.store(true, Ordering::SeqCst);
                        hub.drained(owner);
                    }
                    "poll" => hub.views(&sessions.0),
                    other => panic!("unknown op {other}"),
                }
            }
            for (sink, _, recording) in &sinks {
                let expected: Vec<String> =
                    serde_json::from_value(row["lines"][sink].clone()).unwrap();
                assert_eq!(*recording.lines.lock().unwrap(), expected, "{name}: {sink}");
            }
        }
    }
}
