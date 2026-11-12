//! One-at-a-time work whose every step has a bound (was `SerialChain`, `src/main/serial-chain.ts`, as Autopilot used it:
//! the run's pipeline and the ship queue's drain). A plain chain of futures stops for good when one step never settles:
//! each later call waits behind it and nothing says so. Here a step that runs past its bound is stopped (its task is
//! aborted, so it ends at its next await and acts on nothing after it: the fence the TypeScript spelled
//! `throwIfStepStalled`), fails its own caller with `Stalled`, `on_stall` hears of it, and the next step starts.
//!
//! What this leaves out of the TypeScript chain: a stopped step's child processes (`trackEffect`) are not waited for
//! before the next step starts. A git of a stopped step ends by its own timeout; the land check's folder is removed by
//! the guard that owns it.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};

/// A step ran past its bound and was stopped; the chain went on without it.
#[derive(Debug, Clone, PartialEq)]
pub struct Stalled {
    pub chain: String,
    pub step: String,
    pub ms: u64,
}

fn span(ms: u64) -> String {
    if ms >= 60_000 {
        format!("{} min", (ms as f64 / 60_000.0).round() as u64)
    } else {
        format!("{} s", (ms as f64 / 1000.0).round() as u64)
    }
}

impl Stalled {
    /// `StepStalledError`'s message.
    pub fn message(&self) -> String {
        format!(
            "{} did not finish in {} and was stopped so the next one can run ({}).",
            self.step,
            span(self.ms),
            self.chain
        )
    }
}

/// What a step ends with: its value, or why it did not give one.
#[derive(Debug)]
pub enum Ended<T> {
    Done(T),
    Stalled(Stalled),
    /// The step's task panicked.
    Failed(String),
}

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;
type OnStall = Arc<dyn Fn(&Stalled) + Send + Sync>;

pub struct Steps {
    name: String,
    max: Duration,
    jobs: mpsc::UnboundedSender<Job>,
    on_stall: Option<OnStall>,
    pending: Arc<watch::Sender<usize>>,
}

impl Steps {
    /// A chain named `name` whose steps may each run `max` (a step's own bound replaces it).
    pub fn new(name: impl Into<String>, max: Duration, on_stall: Option<OnStall>) -> Steps {
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        tokio::spawn(async move {
            while let Some(job) = queue.recv().await {
                job.await;
            }
        });
        Steps {
            name: name.into(),
            max,
            jobs,
            on_stall,
            pending: Arc::new(watch::channel(0).0),
        }
    }

    /// Steps queued or running.
    pub fn pending(&self) -> usize {
        *self.pending.borrow()
    }

    /// Resolves once every step queued so far (and any queued meanwhile) ended.
    pub async fn idle(&self) {
        let mut pending = self.pending.subscribe();
        let _ = pending.wait_for(|count| *count == 0).await;
    }

    /// Runs `work` after every step queued before it ended. The bound counts from when the step starts, not from when it
    /// was queued. The step is fenced to its caller: when the returned future is dropped (the caller's own step was
    /// stopped) the step ends with it, or never starts if its turn has not come.
    pub fn run<T: Send + 'static>(
        &self,
        step: &str,
        max: Option<Duration>,
        work: impl Future<Output = T> + Send + 'static,
    ) -> Pin<Box<dyn Future<Output = Ended<T>> + Send>> {
        let (reply, answer) = oneshot::channel();
        let bound = max.unwrap_or(self.max);
        let (chain, step) = (self.name.clone(), step.to_owned());
        let on_stall = self.on_stall.clone();
        let pending = self.pending.clone();
        pending.send_modify(|count| *count += 1);
        let job: Job = Box::pin(async move {
            let mut reply = reply;
            // A step whose caller was stopped (its future dropped) before its turn never starts.
            if reply.is_closed() {
                pending.send_modify(|count| *count -= 1);
                return;
            }
            let mut task = tokio::spawn(work);
            let abort = task.abort_handle();
            let ended = tokio::select! {
                ended = tokio::time::timeout(bound, &mut task) => match ended {
                    Ok(Ok(value)) => Ended::Done(value),
                    Ok(Err(error)) => Ended::Failed(error.to_string()),
                    Err(_) => {
                        abort.abort();
                        let stall = Stalled {
                            chain,
                            step,
                            ms: bound.as_millis() as u64,
                        };
                        if let Some(on_stall) = &on_stall {
                            on_stall(&stall);
                        }
                        Ended::Stalled(stall)
                    }
                },
                // The caller was stopped while the step ran: it is fenced to its caller, so it ends with it.
                () = reply.closed() => {
                    abort.abort();
                    pending.send_modify(|count| *count -= 1);
                    return;
                }
            };
            pending.send_modify(|count| *count -= 1);
            let _ = reply.send(ended);
        });
        let queued = self.jobs.send(job).is_ok();
        Box::pin(async move {
            if !queued {
                return Ended::Failed("the chain is closed".into());
            }
            answer
                .await
                .unwrap_or_else(|_| Ended::Failed("the chain is closed".into()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn steps_run_one_at_a_time_in_order() {
        let steps = Steps::new("chain", Duration::from_secs(5), None);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut runs = Vec::new();
        for n in 0..4u64 {
            let seen = seen.clone();
            runs.push(steps.run("step", None, async move {
                seen.lock().unwrap().push(format!("start {n}"));
                tokio::time::sleep(Duration::from_millis(5 * (4 - n))).await;
                seen.lock().unwrap().push(format!("end {n}"));
                n
            }));
        }
        for (n, run) in runs.into_iter().enumerate() {
            assert!(matches!(run.await, Ended::Done(done) if done == n as u64));
        }
        let seen = seen.lock().unwrap();
        for n in 0..4 {
            assert_eq!(seen[2 * n], format!("start {n}"));
            assert_eq!(seen[2 * n + 1], format!("end {n}"));
        }
    }

    #[tokio::test]
    async fn a_step_past_its_bound_is_stopped_and_the_next_one_runs() {
        let stalls = Arc::new(AtomicUsize::new(0));
        let counted = stalls.clone();
        let steps = Steps::new(
            "autopilot x",
            Duration::from_millis(50),
            Some(Arc::new(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
            })),
        );
        let late = Arc::new(AtomicUsize::new(0));
        let after = late.clone();
        let stuck = steps.run("nudge", None, async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            after.fetch_add(1, Ordering::SeqCst);
        });
        let next = steps.run("settle", None, async { 7 });
        match stuck.await {
            Ended::Stalled(stall) => {
                assert_eq!(stall.step, "nudge");
                assert!(
                    stall.message().contains("did not finish in 0 s"),
                    "{}",
                    stall.message()
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(next.await, Ended::Done(7)));
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(
            late.load(Ordering::SeqCst),
            0,
            "a stopped step acts on nothing after its stop"
        );
        assert_eq!(stalls.load(Ordering::SeqCst), 1);
        steps.idle().await;
    }

    #[tokio::test]
    async fn a_step_ends_with_the_caller_that_was_stopped() {
        let steps = Steps::new("c", Duration::from_secs(5), None);
        let ran = Arc::new(AtomicUsize::new(0));
        let (counted, queued) = (ran.clone(), ran.clone());
        let running = steps.run("first", None, async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let waiting = steps.run("second", None, async move {
            queued.fetch_add(10, Ordering::SeqCst);
        });
        // Both callers are stopped: the running step is aborted, the queued one never starts.
        drop(running);
        drop(waiting);
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(ran.load(Ordering::SeqCst), 0);
        assert!(matches!(
            steps.run("third", None, async { 3 }).await,
            Ended::Done(3)
        ));
        steps.idle().await;
    }

    #[tokio::test]
    async fn a_step_that_panics_fails_alone() {
        let steps = Steps::new("c", Duration::from_secs(5), None);
        let failed = steps.run::<()>("boom", None, async { panic!("x") }).await;
        assert!(matches!(failed, Ended::Failed(_)));
        assert!(matches!(
            steps.run("ok", None, async { 1 }).await,
            Ended::Done(1)
        ));
    }
}
