//! Threaded, transport-independent owner of the lid policy.

use std::io;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::Duration;

use serde_json::Value;

use super::lid::{Backend, Input, Policy};

pub type Logger = Box<dyn FnMut(&'static str, Value) + Send + 'static>;
struct Answer(Option<Box<dyn FnOnce(bool) + Send>>);

impl Answer {
    fn send(mut self, held: bool) {
        if let Some(answer) = self.0.take() {
            answer(held);
        }
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        if let Some(answer) = self.0.take() {
            answer(false);
        }
    }
}

enum Msg {
    Input(Input),
    Query(Answer),
    Quit,
}

pub struct LidRuntime {
    tx: Option<Sender<Msg>>,
    done: Receiver<()>,
    settled: bool,
}

impl LidRuntime {
    pub fn start(backend: Box<dyn Backend + Send>, on_ac: bool, log: Logger) -> io::Result<Self> {
        let (tx, rx) = mpsc::channel();
        let (done_tx, done) = mpsc::channel();
        std::thread::Builder::new()
            .name("boot-lid".into())
            .spawn(move || {
                run(backend, on_ac, log, rx);
                let _ = done_tx.send(());
            })?;
        Ok(Self {
            tx: Some(tx),
            done,
            settled: false,
        })
    }

    pub fn input(&self, input: Input) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Input(input));
        }
    }

    pub fn query(&self, answer: impl FnOnce(bool) + Send + 'static) {
        let msg = Msg::Query(Answer(Some(Box::new(answer))));
        let result = match &self.tx {
            Some(tx) => tx.send(msg).err().map(|error| error.0),
            None => Some(msg),
        };
        drop(result);
    }

    pub fn shutdown(&mut self, timeout: Duration) -> bool {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Msg::Quit);
        }
        if !self.settled {
            self.settled = self.done.recv_timeout(timeout).is_ok();
        }
        self.settled
    }
}

impl Drop for LidRuntime {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Msg::Quit);
        }
    }
}

fn take(policy: &mut Policy, msg: Msg, queries: &mut Vec<Answer>) -> bool {
    match msg {
        Msg::Input(input) => policy.apply(input),
        Msg::Query(answer) => {
            queries.push(answer);
            false
        }
        Msg::Quit => policy.apply(Input::Dispose),
    }
}

fn run(mut backend: Box<dyn Backend + Send>, on_ac: bool, mut log: Logger, rx: Receiver<Msg>) {
    let mut policy = Policy::new(on_ac);
    policy.start(backend.as_mut(), &mut log);
    let mut queries = Vec::new();
    while let Ok(msg) = rx.recv() {
        if take(&mut policy, msg, &mut queries) {
            policy.converge(backend.as_mut(), &mut log, &mut |policy| loop {
                match rx.try_recv() {
                    Ok(msg) => {
                        take(policy, msg, &mut queries);
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        policy.apply(Input::Dispose);
                        break;
                    }
                }
            });
        }
        if policy.disposed() {
            break;
        }
        for answer in queries.drain(..) {
            answer.send(policy.held());
        }
    }
    policy.dispose(backend.as_mut(), &mut log);
    for answer in queries {
        answer.send(false);
    }
    for msg in rx.try_iter() {
        if let Msg::Query(answer) = msg {
            answer.send(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot_core::lid::Outcome;
    use serde_json::Map;
    use std::sync::mpsc::{Receiver, Sender, channel};
    use std::thread;

    struct Fake {
        events: Sender<&'static str>,
        hold_gate: Option<Receiver<()>>,
    }

    impl Backend for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn is_laptop(&mut self) -> Result<bool, String> {
            Ok(true)
        }
        fn recover(&mut self) -> Result<Option<Map<String, Value>>, String> {
            Ok(None)
        }
        fn hold(&mut self) -> Result<Outcome, String> {
            self.events.send("hold").unwrap();
            if let Some(gate) = self.hold_gate.take() {
                gate.recv().unwrap();
            }
            Ok(Outcome {
                changed: true,
                details: Map::new(),
            })
        }
        fn release(&mut self) -> Result<(), String> {
            self.events.send("release").unwrap();
            Ok(())
        }
        fn release_now(&mut self) -> Result<(), String> {
            self.events.send("release_now").unwrap();
            Ok(())
        }
    }

    fn blocker() -> Input {
        Input::Blocker {
            key: "work".into(),
            held: true,
        }
    }
    fn logger() -> Logger {
        Box::new(|_, _| {})
    }

    #[test]
    fn shutdown_during_hold_releases_and_never_holds_again() {
        let (events, observed) = channel();
        let (gate, waiting) = channel();
        let mut runtime = LidRuntime::start(
            Box::new(Fake {
                events,
                hold_gate: Some(waiting),
            }),
            true,
            logger(),
        )
        .unwrap();
        runtime.input(blocker());
        assert_eq!(observed.recv().unwrap(), "hold");
        assert!(!runtime.shutdown(Duration::ZERO));
        runtime.input(blocker());
        gate.send(()).unwrap();
        assert!(runtime.shutdown(Duration::from_secs(5)));
        assert_eq!(observed.recv().unwrap(), "release_now");
        assert!(observed.recv().is_err());
    }

    #[test]
    fn explicit_dispose_is_terminal() {
        let (events, observed) = channel();
        let mut runtime = LidRuntime::start(
            Box::new(Fake {
                events,
                hold_gate: None,
            }),
            true,
            logger(),
        )
        .unwrap();
        runtime.input(Input::Dispose);
        runtime.input(blocker());
        assert!(runtime.shutdown(Duration::from_secs(5)));
        assert_eq!(observed.recv().unwrap(), "release_now");
        assert!(observed.recv().is_err());
    }

    #[test]
    fn disconnected_sender_releases_held_backend() {
        let (events, observed) = channel();
        let (tx, rx) = channel();
        let worker = thread::spawn(move || {
            run(
                Box::new(Fake {
                    events,
                    hold_gate: None,
                }),
                true,
                logger(),
                rx,
            )
        });
        tx.send(Msg::Input(blocker())).unwrap();
        assert_eq!(observed.recv().unwrap(), "hold");
        drop(tx);
        worker.join().unwrap();
        assert_eq!(observed.recv().unwrap(), "release_now");
        assert!(observed.recv().is_err());
    }
}
