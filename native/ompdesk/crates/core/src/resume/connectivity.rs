//! Whether this computer can reach the internet right now, as far as a waiting turn is concerned (was
//! `ConnectivityMonitor` in `src/main/connectivity.ts`): a hub instance of kind `connectivity`. Main wires
//! `net.isOnline()`, the renderer's `online`/`offline` events and `powerMonitor` `suspend`/`resume` into it.
//!
//! Three things make a turn wait instead of failing: the network is down, the computer just woke from sleep, or a turn
//! failed to connect while the link looked up and a probe found nothing reachable (a dead DNS or route). Right after a
//! wake `net.isOnline()` can say yes while the Wi-Fi has not rejoined, so a `resume` holds the state at offline until a
//! probe confirms the way out, and a network-class error in the minutes after it is still treated as the wake's doing.
//!
//! A held continuation has no timer of its own: it waits while this says offline. So the offline state must never
//! outlive the outage: besides the events and the wake's probe loop, an offline state that nothing is recovering asks
//! again every `REPROBE_INTERVAL_MS` and goes online the moment it answers, whatever the link flag says.
//!
//! What main reads (`net.isOnline()`, the clock) comes with the call that needs it; the probe, the timers and the
//! `changed` hook are main's: the probe is a question main answers later, a timer is one main runs and calls back.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;

use crate::hub::{self, Out, Outcome};
use crate::server::Fault;

use super::util::start;

/// A network-class error within this long of a wake still counts as caused by it.
const RESUME_WINDOW_MS: f64 = 60_000.0;
/// How often the post-wake probe retries until the network answers.
const PROBE_INTERVAL_MS: f64 = 2_000.0;
/// How often an offline state no probe loop is recovering asks again: a held continuation is released within this
/// plus the probe's timeout of the network answering.
const REPROBE_INTERVAL_MS: f64 = 15_000.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Timer {
    Attempt,
    Reprobe,
}

#[derive(Default)]
struct State {
    online: bool,
    polled: bool,
    resumed_at: Option<f64>,
    recovering: bool,
    cancel_probe: Option<u64>,
    probing: bool,
    /// Cancels the next re-probe of an offline state nothing is recovering (a missed `online`, a `resume` that never came).
    cancel_reprobe: Option<u64>,
    reprobing: bool,
    /// The tokens waiting on the one probe per host: it answers every concurrent ask.
    verifying: HashMap<String, Vec<u64>>,
    /// The host whose failed lookup took the state offline: the recovery probe asks it beside the default.
    probe_host: Option<String>,
    timers: HashMap<u64, Timer>,
    next: u64,
}

pub struct Monitor {
    out: Out,
    st: RefCell<State>,
}

thread_local! {
    static MONITORS: RefCell<HashMap<u64, Rc<Monitor>>> = RefCell::default();
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Opts {
    online: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { online: true }
    }
}

/// What main read for the call: `net.isOnline()` and the clock.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Reads {
    is_online: bool,
    now: f64,
    online: bool,
    host: Option<String>,
    timer: u64,
}

pub fn open(id: u64, opts: &RawValue, out: Out) -> Result<(), Fault> {
    let opts: Opts = hub::params(opts)?;
    let monitor = Monitor {
        out,
        st: RefCell::new(State {
            online: opts.online,
            polled: opts.online,
            ..State::default()
        }),
    };
    MONITORS.with(|all| all.borrow_mut().insert(id, Rc::new(monitor)));
    Ok(())
}

pub fn close(id: u64) {
    MONITORS.with(|all| all.borrow_mut().remove(&id));
}

pub fn call(id: u64, method: &str, params: &RawValue) -> Outcome {
    let Some(monitor) = MONITORS.with(|all| all.borrow().get(&id).cloned()) else {
        return Outcome::fault("no_instance", format!("No monitor {id}"));
    };
    let reads: Reads = match hub::params(params) {
        Ok(reads) => reads,
        Err(fault) => return Outcome::Now(Err(fault)),
    };
    match method {
        "online" => Outcome::ok(&monitor.st.borrow().online),
        "shouldWait" => Outcome::ok(&monitor.should_wait(reads.now)),
        "report" => {
            monitor.report(reads.online, reads.is_online);
            Outcome::done()
        }
        "poll" => {
            monitor.poll(reads.is_online);
            Outcome::done()
        }
        "suspend" => {
            monitor.suspend();
            Outcome::done()
        }
        "resume" => {
            monitor.resume(reads.now, reads.is_online);
            Outcome::done()
        }
        "verify" => Outcome::ok(&monitor.verify(reads.host, reads.is_online)),
        "timer" => {
            monitor.on_timer(reads.timer, reads.is_online);
            Outcome::done()
        }
        other => Outcome::fault("no_method", other.to_owned()),
    }
}

impl Monitor {
    fn push(&self, item: serde_json::Value) {
        self.out.push(&item);
    }

    fn token(&self) -> u64 {
        let mut st = self.st.borrow_mut();
        st.next += 1;
        st.next
    }

    /// Settles main's promise for `token` after the call that made it has answered.
    fn done(&self, token: u64, value: bool) {
        let out = self.out;
        hub::spawn(async move { out.push(&json!({"k": "done", "token": token, "value": value})) });
    }

    fn schedule(&self, ms: f64, kind: Timer) -> u64 {
        let timer = self.token();
        self.st.borrow_mut().timers.insert(timer, kind);
        self.push(json!({"k": "schedule", "timer": timer, "ms": ms}));
        timer
    }

    fn cancel(&self, timer: u64) {
        self.st.borrow_mut().timers.remove(&timer);
        self.push(json!({"k": "cancelTimer", "timer": timer}));
    }

    /// Offline, or inside the window after a wake: a network-class turn error means "wait", not "failed".
    fn should_wait(&self, now: f64) -> bool {
        let st = self.st.borrow();
        if !st.online {
            return true;
        }
        st.resumed_at.is_some_and(|at| now - at < RESUME_WINDOW_MS)
    }

    /// An `online`/`offline` event from a window.
    fn report(self: &Rc<Self>, online: bool, is_online: bool) {
        if !online {
            self.set(false);
            return;
        }
        // While recovering from sleep the probe decides, not the first optimistic event.
        if self.st.borrow().recovering {
            self.start_attempt(is_online);
        } else {
            self.set(true);
        }
    }

    /// Edge-triggered `net.isOnline()` sampling: only a real change reports, so a window's event is not overruled.
    fn poll(self: &Rc<Self>, is_online: bool) {
        {
            let mut st = self.st.borrow_mut();
            if is_online == st.polled {
                return;
            }
            st.polled = is_online;
        }
        self.report(is_online, is_online);
    }

    /// `powerMonitor` `suspend`: nothing is reachable until the wake is confirmed.
    fn suspend(&self) {
        {
            let mut st = self.st.borrow_mut();
            st.recovering = false;
            st.probe_host = None;
        }
        self.stop_probe();
        self.set(false);
        // A `resume` that never comes must not leave the state offline for good.
        self.arm_reprobe();
    }

    /// `powerMonitor` `resume`: offline until the probe answers.
    fn resume(self: &Rc<Self>, now: f64, is_online: bool) {
        {
            let mut st = self.st.borrow_mut();
            st.resumed_at = Some(now);
            st.probe_host = None;
            st.recovering = true;
        }
        self.stop_reprobe();
        self.set(false);
        self.start_attempt(is_online);
    }

    /// A turn failed to resolve `host` while the link says it is up: a dead DNS or route that `net.isOnline()` never
    /// sees. Unreachable only when neither the default way out nor `host` answers; then the state goes offline and the
    /// probe loop brings it back as soon as either answers. One probe per host answers every concurrent ask. Answers
    /// the token of the caller's promise.
    fn verify(self: &Rc<Self>, host: Option<String>, is_online: bool) -> u64 {
        let token = self.token();
        if !self.st.borrow().online {
            self.done(token, false);
            return token;
        }
        let key = host.clone().unwrap_or_default();
        let first = {
            let mut st = self.st.borrow_mut();
            match st.verifying.get_mut(&key) {
                Some(waiting) => {
                    waiting.push(token);
                    false
                }
                None => {
                    st.verifying.insert(key.clone(), vec![token]);
                    true
                }
            }
        };
        if first {
            let me = Rc::clone(self);
            start(async move {
                let reachable = me.check(host, is_online).await;
                let waiting = me
                    .st
                    .borrow_mut()
                    .verifying
                    .remove(&key)
                    .unwrap_or_default();
                for token in waiting {
                    me.done(token, reachable);
                }
            });
        }
        token
    }

    async fn check(self: &Rc<Self>, host: Option<String>, is_online: bool) -> bool {
        let reachable = self.reachable(host.as_deref(), is_online).await;
        if !self.st.borrow().online {
            return false;
        }
        if reachable {
            return true;
        }
        let begin = {
            let mut st = self.st.borrow_mut();
            if st.recovering {
                false
            } else {
                st.recovering = true;
                st.probe_host = host;
                true
            }
        };
        if begin {
            self.stop_reprobe();
            self.set(false);
            if !self.st.borrow().probing {
                self.set_probe_timer();
            }
        }
        false
    }

    /// The link is up and the default way out or `host` answers; a throwing probe is no answer.
    async fn reachable(&self, host: Option<&str>, is_online: bool) -> bool {
        is_online && self.answers(host).await
    }

    /// The resolver answers for the default way out or `host`, whatever the link flag says.
    async fn answers(&self, host: Option<&str>) -> bool {
        let host = host.filter(|host| !host.is_empty());
        let default = self.probe(None);
        match host {
            Some(host) => {
                let named = self.probe(Some(host));
                let (left, right) = tokio::join!(default, named);
                left || right
            }
            None => default.await,
        }
    }

    fn probe(&self, host: Option<&str>) -> hub::LocalFuture<bool> {
        let asked = self.out.ask_later("probe", &json!({"host": host}));
        Box::pin(async move {
            asked
                .await
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        })
    }

    fn set(&self, online: bool) {
        {
            let mut st = self.st.borrow_mut();
            if online == st.online {
                return;
            }
            st.online = online;
        }
        if online {
            self.stop_reprobe();
        } else {
            self.arm_reprobe();
        }
        self.push(json!({"k": "changed", "online": online}));
    }

    /// Ask the resolver again in `REPROBE_INTERVAL_MS` while the state is offline and no probe loop is recovering it.
    fn arm_reprobe(&self) {
        {
            let st = self.st.borrow();
            if st.online || st.recovering || st.cancel_reprobe.is_some() {
                return;
            }
        }
        let timer = self.schedule(REPROBE_INTERVAL_MS, Timer::Reprobe);
        self.st.borrow_mut().cancel_reprobe = Some(timer);
    }

    fn stop_reprobe(&self) {
        let timer = self.st.borrow_mut().cancel_reprobe.take();
        if let Some(timer) = timer {
            self.cancel(timer);
        }
    }

    /// Books the next recovery probe; a handle it replaces is dropped, not cancelled (as the TypeScript overwrote it).
    fn set_probe_timer(&self) {
        let timer = self.schedule(PROBE_INTERVAL_MS, Timer::Attempt);
        let before = self.st.borrow_mut().cancel_probe.replace(timer);
        if let Some(before) = before {
            self.push(json!({"k": "forgetTimer", "timer": before}));
        }
    }

    fn stop_probe(&self) {
        let timer = self.st.borrow_mut().cancel_probe.take();
        if let Some(timer) = timer {
            self.cancel(timer);
        }
    }

    async fn reprobe(self: Rc<Self>) {
        self.stop_reprobe();
        {
            let mut st = self.st.borrow_mut();
            if st.online || st.recovering || st.reprobing {
                return;
            }
            st.reprobing = true;
        }
        let reachable = self.answers(None).await;
        self.st.borrow_mut().reprobing = false;
        {
            let st = self.st.borrow();
            if st.online || st.recovering {
                return;
            }
        }
        if reachable {
            self.set(true);
        } else {
            self.arm_reprobe();
        }
    }

    fn start_attempt(self: &Rc<Self>, is_online: bool) {
        let me = Rc::clone(self);
        start(async move { me.attempt(is_online).await });
    }

    async fn attempt(self: Rc<Self>, is_online: bool) {
        {
            let mut st = self.st.borrow_mut();
            if st.probing {
                return;
            }
            st.probing = true;
        }
        self.stop_probe();
        let host = self.st.borrow().probe_host.clone();
        let reachable = self.reachable(host.as_deref(), is_online).await;
        self.st.borrow_mut().probing = false;
        if !self.st.borrow().recovering {
            return;
        }
        if reachable {
            self.st.borrow_mut().recovering = false;
            self.set(true);
            return;
        }
        self.set_probe_timer();
    }

    fn on_timer(self: &Rc<Self>, timer: u64, is_online: bool) {
        let kind = self.st.borrow_mut().timers.remove(&timer);
        match kind {
            Some(Timer::Attempt) => self.start_attempt(is_online),
            Some(Timer::Reprobe) => {
                let me = Rc::clone(self);
                start(async move { me.reprobe().await });
            }
            None => {}
        }
    }
}
