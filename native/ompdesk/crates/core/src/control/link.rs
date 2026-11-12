//! The control socket's way to main, where the agent-control service still lives. The TypeScript server called its
//! backend directly: run a tool, resolve a session's name, read the sessions now, hear what tabs do. Here:
//!
//! - The core asks through the event `control` (`Ask`): `run` and `resolve` carry a call number main answers,
//!   `release` says a caller's connection closed, `watch` turns main's forwarding of tab activity and reports on and
//!   off (on only while a wait runs or somebody is subscribed; main tells the sessions as it turns it on), `poll`
//!   asks for the sessions now.
//! - Main answers and tells through the request `control.push` (`Push`), each with a sequence number. The core runs
//!   every request as its own task, so the number is what keeps main's order: a push is applied only once the one
//!   before it was. The numbers also date things: a tab's step is "after" a send when its push came after the one
//!   main had sent last as it started the send tool (`began`).
//! - Every push main sends while it is watched carries the sessions agents may see, as they were at that moment
//!   (`views`). The TypeScript read them synchronously at each step; here each waiting request is handed what main
//!   saw at each step, in order (`Glance`), so a state that held only between two steps is still seen.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde_json::value::RawValue;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use super::events::{Hub, Sink};
use super::{Activity, Caller, Tuning, View};
use crate::server::Fault;

/// What the core asks of main.
#[derive(Debug)]
pub enum Ask {
    /// One control tool call as the caller, exactly as an agent in a session makes it.
    Run {
        call: u64,
        caller: Arc<Caller>,
        tool: Box<RawValue>,
        args: Option<Box<RawValue>>,
    },
    /// The open session `name` names, by the tools' own rules.
    Resolve {
        call: u64,
        caller: Arc<Caller>,
        name: Box<RawValue>,
    },
    /// The caller's connection closed.
    Release { caller: Arc<Caller> },
    /// Forward tab activity and reports from now on (and tell the sessions now), or stop.
    Watch { on: bool },
    /// Tell the sessions now.
    Poll,
}

/// What main tells the core.
pub enum Push {
    /// The answer to a `run` or a `resolve`: its value, or the message it failed with. `began`: the number of the
    /// last push main had sent when it started on the call.
    Reply {
        call: u64,
        result: Result<Box<RawValue>, String>,
        began: Option<u64>,
    },
    Activity(Activity),
    /// The sessions alone: a poll's answer, and what main says as it starts to watch.
    Views,
    /// A report addressed to an outside caller.
    Mail {
        to: String,
        text: String,
    },
}

/// Main's answer to a call.
pub struct Answer {
    pub result: Result<Box<RawValue>, String>,
    /// The answer's own push number.
    pub at: u64,
    pub began: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StepKind {
    Working,
    Blocked,
    Ended,
    Released,
}

/// One lifecycle step of a tab, dated by the push that told it.
#[derive(Debug)]
pub struct Step {
    pub seq: u64,
    tab: String,
    pub kind: StepKind,
    pub stop_reason: Option<String>,
}

/// What main saw at one moment, for one waiting request: its session then, and how far its steps went.
struct Glance {
    view: Option<View>,
    upto: u64,
    at: Instant,
}

/// The steps one request heard since it began: every tab's until it knows its tab, then only that tab's.
#[derive(Default)]
struct Watch {
    tab: Option<String>,
    log: Vec<Step>,
    /// What came since the request last looked, oldest first; kept only once the tab is known.
    glances: VecDeque<Glance>,
}

/// What a waiting request looks at: its session at one moment and its tab's steps up to then.
pub struct Look<'a> {
    view: Option<&'a View>,
    steps: &'a [Step],
    upto: u64,
    /// When main said it.
    pub at: Instant,
}

impl Look<'_> {
    /// The session then; none once its tab is gone or it was hidden from agents.
    pub fn view(&self) -> Option<&View> {
        self.view
    }

    /// The tab's steps after the push `mark`, oldest first.
    pub fn since(&self, mark: u64) -> impl DoubleEndedIterator<Item = &Step> {
        self.steps
            .iter()
            .filter(move |step| step.seq > mark && step.seq <= self.upto)
    }
}

struct State {
    views: Vec<View>,
    calls: HashMap<u64, oneshot::Sender<Answer>>,
    last_call: u64,
    watches: HashMap<u64, Watch>,
    last_watch: u64,
    /// The number of the last push applied.
    applied: u64,
    hub: Hub,
    /// Asks main for the sessions on a beat while somebody is subscribed.
    hub_poll: Option<JoinHandle<()>>,
    /// Whether main was last told to watch.
    watching: bool,
}

pub struct Link {
    state: Mutex<State>,
    /// Counts the pushes applied: a waiting request takes its glances at each.
    changed: watch::Sender<u64>,
    /// The sequence number of the push whose turn it is.
    turn: watch::Sender<u64>,
    ask: Box<dyn Fn(Ask) + Send + Sync>,
    pub tuning: Tuning,
}

/// A push whose turn never comes (main skipped a number) fails after this, instead of holding its request for ever.
const TURN_WAIT: Duration = Duration::from_secs(10);
/// What `turn` holds once the link is closed.
const CLOSED: u64 = u64::MAX;

fn view_of<'a>(views: &'a [View], tab: Option<&str>) -> Option<&'a View> {
    let tab = tab?;
    views.iter().find(|view| view.session == tab)
}

impl Link {
    pub fn new(tuning: Tuning, ask: impl Fn(Ask) + Send + Sync + 'static) -> Arc<Link> {
        Arc::new(Link {
            state: Mutex::new(State {
                views: Vec::new(),
                calls: HashMap::new(),
                last_call: 0,
                watches: HashMap::new(),
                last_watch: 0,
                applied: 0,
                hub: Hub::new(tuning.event_capacity),
                hub_poll: None,
                watching: false,
            }),
            changed: watch::channel(0).0,
            turn: watch::channel(1).0,
            ask: Box::new(ask),
            tuning,
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Tells main to watch or to stop when the need changed, and keeps the subscribers' poll going. Called with the
    /// state held after anything that adds or drops a wait or a subscriber, so main hears the asks in that order.
    fn settle(self: &Arc<Self>, state: &mut State) {
        let listening = state.hub.listening();
        let wanted = listening || !state.watches.is_empty();
        if wanted != state.watching {
            state.watching = wanted;
            (self.ask)(Ask::Watch { on: wanted });
        }
        if listening && state.hub_poll.is_none() {
            let link = Arc::downgrade(self);
            let beat = Duration::from_millis(self.tuning.event_poll_ms);
            state.hub_poll = Some(tokio::spawn(poll_on_a_beat(link, beat)));
        } else if !listening && let Some(poll) = state.hub_poll.take() {
            poll.abort();
        }
    }

    /// Applies main's push `seq` once every push before it was applied.
    pub async fn push(
        self: &Arc<Self>,
        seq: u64,
        push: Push,
        views: Option<Vec<View>>,
    ) -> Result<(), Fault> {
        let mut turn = self.turn.subscribe();
        let reached = tokio::time::timeout(TURN_WAIT, turn.wait_for(|next| *next >= seq))
            .await
            .ok()
            .and_then(Result::ok)
            .map(|next| *next);
        if reached != Some(seq) {
            return Err(Fault::new(
                "out_of_order",
                format!("control push {seq} came out of its turn"),
            ));
        }
        self.apply(seq, push, views);
        self.turn.send_if_modified(|next| {
            let ours = *next == seq;
            if ours {
                *next = seq + 1;
            }
            ours
        });
        Ok(())
    }

    /// What `push` does once it is the push's turn.
    pub fn apply(self: &Arc<Self>, seq: u64, push: Push, views: Option<Vec<View>>) {
        {
            let mut state = self.state();
            let state = &mut *state;
            state.applied = seq;
            if let Some(views) = views {
                state.views = views;
            }
            let at = Instant::now();
            match push {
                Push::Reply {
                    call,
                    result,
                    began,
                } => {
                    if let Some(waiting) = state.calls.remove(&call) {
                        let _ = waiting.send(Answer {
                            result,
                            at: seq,
                            began,
                        });
                    }
                }
                Push::Activity(activity) => {
                    let kind = match activity.kind.as_str() {
                        "busy" => Some(StepKind::Working),
                        "ask" => Some(StepKind::Blocked),
                        "idle" => Some(StepKind::Ended),
                        "released" => Some(StepKind::Released),
                        _ => None,
                    };
                    if let Some(kind) = kind {
                        let stop_reason = (kind == StepKind::Ended)
                            .then(|| activity.stop_reason.as_deref().unwrap_or("stop"))
                            .filter(|reason| !reason.is_empty());
                        for watch in state.watches.values_mut() {
                            if watch
                                .tab
                                .as_ref()
                                .is_some_and(|tab| *tab != activity.tab_id)
                            {
                                continue;
                            }
                            watch.log.push(Step {
                                seq,
                                tab: activity.tab_id.clone(),
                                kind,
                                stop_reason: stop_reason.map(str::to_owned),
                            });
                            // A step of its tab makes a waiting request look at the session as it is now.
                            if watch.tab.is_some() {
                                watch.glances.push_back(Glance {
                                    view: view_of(&state.views, watch.tab.as_deref()).cloned(),
                                    upto: seq,
                                    at,
                                });
                            }
                        }
                    }
                    state.hub.activity(&activity, &state.views);
                }
                Push::Views => {
                    for watch in state.watches.values_mut() {
                        if watch.tab.is_some() {
                            watch.glances.push_back(Glance {
                                view: view_of(&state.views, watch.tab.as_deref()).cloned(),
                                upto: seq,
                                at,
                            });
                        }
                    }
                    state.hub.views(&state.views);
                }
                Push::Mail { to, text } => state.hub.mail(&to, &text),
            }
            // A subscriber that fell behind was ended: the last one leaving stops the watch.
            self.settle(state);
        }
        self.changed.send_modify(|count| *count += 1);
    }

    async fn call(&self, ask: impl FnOnce(u64) -> Ask) -> Answer {
        let (waiting, answered) = oneshot::channel();
        let call = {
            let mut state = self.state();
            state.last_call += 1;
            let call = state.last_call;
            state.calls.insert(call, waiting);
            (self.ask)(ask(call));
            call
        };
        // A request that stops waiting (its connection closed, its timeout passed) leaves nothing behind.
        let _forget = Forget { link: self, call };
        answered.await.unwrap_or_else(|_| Answer {
            result: Err("OMPdesk closed the control socket".into()),
            at: 0,
            began: None,
        })
    }

    pub async fn run(
        &self,
        caller: &Arc<Caller>,
        tool: Box<RawValue>,
        args: Option<Box<RawValue>>,
    ) -> Answer {
        self.call(|call| Ask::Run {
            call,
            caller: Arc::clone(caller),
            tool,
            args,
        })
        .await
    }

    pub async fn resolve(&self, caller: &Arc<Caller>, name: Box<RawValue>) -> Answer {
        self.call(|call| Ask::Resolve {
            call,
            caller: Arc::clone(caller),
            name,
        })
        .await
    }

    /// The caller's connection closed.
    pub fn release(&self, caller: Arc<Caller>) {
        (self.ask)(Ask::Release { caller });
    }

    /// Hears every tab's lifecycle steps from now on, for one request. Main is told to watch before the request's
    /// first call goes out, so a turn that ends while a name is resolved is never missed.
    pub fn watch(self: &Arc<Self>) -> Watching {
        let mut state = self.state();
        state.last_watch += 1;
        let id = state.last_watch;
        state.watches.insert(id, Watch::default());
        let born = state.applied;
        self.settle(&mut state);
        Watching {
            link: Arc::clone(self),
            id,
            born,
        }
    }

    /// `check` on the request's session as main last told it and all its steps so far.
    pub fn look<T>(&self, watching: &Watching, check: impl FnOnce(&Look) -> T) -> T {
        let state = self.state();
        let watch = state.watches.get(&watching.id);
        check(&Look {
            view: view_of(&state.views, watch.and_then(|watch| watch.tab.as_deref())),
            steps: watch.map_or(&[][..], |watch| &watch.log),
            upto: state.applied,
            at: Instant::now(),
        })
    }

    /// Resolves with the first `check` that answers: tried now, then on what main saw at every step of the request's
    /// tab and at every answer to a poll, in order. The sessions are asked for on every poll beat, since a state can
    /// change with no activity (a plan up for review).
    pub async fn until<T, E>(
        &self,
        watching: &Watching,
        mut check: impl FnMut(&Look) -> Result<Option<T>, E>,
    ) -> Result<T, E> {
        let mut changed = self.changed.subscribe();
        {
            let mut state = self.state();
            let State {
                views,
                watches,
                applied,
                ..
            } = &mut *state;
            let watch = watches.get_mut(&watching.id);
            let (tab, steps) = match watch {
                Some(watch) => {
                    // What came before this wait began is not its to judge: it starts from the session now.
                    watch.glances.clear();
                    (watch.tab.as_deref(), &watch.log[..])
                }
                None => (None, &[][..]),
            };
            let now = Look {
                view: view_of(views, tab),
                steps,
                upto: *applied,
                at: Instant::now(),
            };
            if let Some(value) = check(&now)? {
                return Ok(value);
            }
        }
        let beat = Duration::from_millis(self.tuning.poll_ms);
        let mut poll = tokio::time::interval_at(Instant::now() + beat, beat);
        poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                // The sender lives in this link, which the caller holds.
                _ = changed.changed() => {}
                _ = poll.tick() => {
                    (self.ask)(Ask::Poll);
                    continue;
                }
            }
            let mut state = self.state();
            let Some(watch) = state.watches.get_mut(&watching.id) else {
                continue;
            };
            while let Some(glance) = watch.glances.pop_front() {
                let then = Look {
                    view: glance.view.as_ref(),
                    steps: &watch.log,
                    upto: glance.upto,
                    at: glance.at,
                };
                if let Some(value) = check(&then)? {
                    return Ok(value);
                }
            }
        }
    }

    /// Subscribes a connection's output to the event stream.
    pub fn subscribe(self: &Arc<Self>, owner: u64, caller: &str, sub: &str, sink: Arc<dyn Sink>) {
        let mut state = self.state();
        let state = &mut *state;
        let first = !state.hub.listening();
        state.hub.subscribe(owner, caller, sub, sink);
        // Main already watches for a wait: the sessions it last told are where the states start. Otherwise it tells
        // them as it starts to watch.
        if first && state.watching {
            state.hub.views(&state.views);
        }
        self.settle(state);
    }

    /// The connection `owner` closed: its subscriptions end.
    pub fn unsubscribe(self: &Arc<Self>, owner: u64) {
        let mut state = self.state();
        state.hub.release(owner);
        self.settle(&mut state);
    }

    /// The connection `owner` took everything written to it.
    pub fn drained(self: &Arc<Self>, owner: u64) {
        let mut state = self.state();
        state.hub.drained(owner);
        self.settle(&mut state);
    }

    /// The listener closed: nothing waits on main any more.
    pub fn close(&self) {
        let mut state = self.state();
        if let Some(poll) = state.hub_poll.take() {
            poll.abort();
        }
        state.calls.clear();
        self.turn.send_replace(CLOSED);
    }
}

async fn poll_on_a_beat(link: Weak<Link>, beat: Duration) {
    let mut poll = tokio::time::interval_at(Instant::now() + beat, beat);
    poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        poll.tick().await;
        match link.upgrade() {
            Some(link) => (link.ask)(Ask::Poll),
            None => return,
        }
    }
}

struct Forget<'a> {
    link: &'a Link,
    call: u64,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        self.link.state().calls.remove(&self.call);
    }
}

/// One request's hearing of the lifecycle steps; it ends when this is dropped, however the request ends.
pub struct Watching {
    link: Arc<Link>,
    id: u64,
    /// The number of the last push applied before it began.
    pub born: u64,
}

impl Watching {
    /// From now on only `tab`'s steps are kept.
    pub fn bind(&self, tab: &str) {
        if let Some(watch) = self.link.state().watches.get_mut(&self.id) {
            watch.log.retain(|step| step.tab == tab);
            watch.tab = Some(tab.to_owned());
        }
    }
}

impl Drop for Watching {
    fn drop(&mut self) {
        let mut state = self.link.state();
        state.watches.remove(&self.id);
        self.link.settle(&mut state);
    }
}
