//! One-at-a-time work whose every step has a bound (was `SerialChain`, `src/main/serial-chain.ts`, as Autopilot used it:
//! the run's pipeline and the ship queue's drain). A plain chain of futures stops for good when one step never settles:
//! each later call waits behind it and nothing says so. Here a step that runs past its bound is stopped (its task is
//! aborted, so it ends at its next await and acts on nothing after it: the fence the TypeScript spelled
//! `throwIfStepStalled`), fails its own caller with `Stalled`, `on_stall` hears of it, and the next step starts.
//!
//! Every step has its own `Scope` (`step_scope`, a task-local): the gits and the land check a step runs are handed it, and
//! a step nested in another (the ship queue's drain inside a cycle end) is cancelled with it, as `SerialChain` composed
//! its signals. A stopped step cancels its scope first, then aborts its task, and reports the stall only once every
//! process it ran exited (`trackEffect`'s wait), so the next step never starts beside a process of the one stopped.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{AbortHandle, JoinHandle};

use crate::server::{Gone, Scope};

tokio::task_local! {
    static STEP: Scope;
}

/// The scope of the step this code runs in; a detached one outside any step.
pub fn step_scope() -> Scope {
    STEP.try_with(Clone::clone)
        .unwrap_or_else(|_| Scope::detached())
}

/// A nested step's tie to the step it was started from: its watcher cancels the nested scope when the parent's is, and the
/// parent's scope stays held until the nested step ended, so the parent's stop waits for the nested step's processes too.
struct Link {
    watcher: Option<JoinHandle<()>>,
    _parent: Option<Scope>,
}

impl Link {
    fn to(parent: Option<Scope>, child: &Scope) -> Link {
        let watcher = parent.clone().map(|parent| {
            let child = child.clone();
            tokio::spawn(async move {
                parent.on_cancel().await;
                child.cancel();
            })
        });
        Link {
            watcher,
            _parent: parent,
        }
    }

    /// Stops watching: the watcher holds a clone of the nested scope, which the wait for its processes must not wait on.
    fn unwatch(&mut self) {
        if let Some(watcher) = self.watcher.take() {
            watcher.abort();
        }
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.unwatch();
    }
}

/// Stops a step: its scope is cancelled (every process it ran is ended), then its task aborted, and this returns once the
/// last process exited.
async fn stop(scope: Scope, gone: Gone, mut link: Link, task: &AbortHandle) {
    scope.cancel();
    task.abort();
    link.unwatch();
    drop(scope);
    gone.wait().await;
}

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
        // A step started from inside another is cancelled with it.
        let parent = STEP.try_with(Clone::clone).ok();
        pending.send_modify(|count| *count += 1);
        let job: Job = Box::pin(async move {
            let mut reply = reply;
            // A step whose caller was stopped (its future dropped) before its turn never starts.
            if reply.is_closed() {
                pending.send_modify(|count| *count -= 1);
                return;
            }
            let (scope, gone) = Scope::watched();
            let link = Link::to(parent, &scope);
            let mut task = tokio::spawn(STEP.scope(scope.clone(), work));
            let abort = task.abort_handle();
            let ended = tokio::select! {
                ended = tokio::time::timeout(bound, &mut task) => match ended {
                    Ok(Ok(value)) => Ended::Done(value),
                    Ok(Err(error)) => Ended::Failed(error.to_string()),
                    Err(_) => {
                        stop(scope, gone, link, &abort).await;
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
                    stop(scope, gone, link, &abort).await;
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

    /// A stand-in for a git that traps SIGTERM: it writes `<marker>.exited` only when it is ended, so the file is there
    /// once the process exited, never before.
    #[cfg(unix)]
    fn hung_git(marker: &std::path::Path) -> String {
        format!(
            "trap 'echo ended > \"{m}.exited\"; exit 1' TERM; touch \"{m}.up\"; while :; do sleep 0.05; done",
            m = marker.display()
        )
    }

    #[cfg(unix)]
    fn marker(name: &str) -> std::path::PathBuf {
        let marker =
            std::env::temp_dir().join(format!("ompdesk-core-{name}-{}", std::process::id()));
        for end in ["exited", "up"] {
            let _ = std::fs::remove_file(format!("{}.{end}", marker.display()));
        }
        marker
    }

    /// What the stall callback saw: whether the stand-in had exited when the stall was reported.
    #[cfg(unix)]
    fn reporting(marker: &std::path::Path) -> (OnStall, Arc<std::sync::Mutex<Option<bool>>>) {
        let seen = Arc::new(std::sync::Mutex::new(None));
        let exited = format!("{}.exited", marker.display());
        let into = seen.clone();
        let on_stall: OnStall = Arc::new(move |_| {
            *into.lock().unwrap() = Some(std::path::Path::new(&exited).exists());
        });
        (on_stall, seen)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_stalled_step_s_child_has_exited_when_the_stall_is_reported() {
        use crate::git::run::Git;
        use crate::run::tests::shell;
        let marker = marker("stalled-step");
        let (on_stall, seen) = reporting(&marker);
        let steps = Steps::new("c", Duration::from_secs(30), Some(on_stall));
        let script = hung_git(&marker);
        let stalled = steps
            .run("hung", Some(Duration::from_millis(1_500)), async move {
                let git = Git::new(shell(60_000, 1024), step_scope());
                let _ = git.raw("/", &[script.as_str()]).await;
            })
            .await;
        assert!(matches!(stalled, Ended::Stalled(_)));
        assert_eq!(*seen.lock().unwrap(), Some(true));
        // The next step starts once it exited.
        assert!(matches!(
            steps.run("next", None, async { 1 }).await,
            Ended::Done(1)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_step_nested_in_a_stalled_one_ends_with_it() {
        use crate::git::run::Git;
        use crate::run::tests::shell;
        let marker = marker("nested-step");
        let (on_stall, seen) = reporting(&marker);
        let outer = Steps::new("outer", Duration::from_secs(30), Some(on_stall));
        let inner = Arc::new(Steps::new("inner", Duration::from_secs(30), None));
        let script = hung_git(&marker);
        let stalled = outer
            .run(
                "cycle end",
                Some(Duration::from_millis(1_500)),
                async move {
                    inner
                        .run("drain", None, async move {
                            let git = Git::new(shell(60_000, 1024), step_scope());
                            let _ = git.raw("/", &[script.as_str()]).await;
                        })
                        .await;
                },
            )
            .await;
        assert!(matches!(stalled, Ended::Stalled(_)));
        assert_eq!(*seen.lock().unwrap(), Some(true));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_step_whose_caller_was_stopped_ends_its_child_before_the_next_starts() {
        use crate::git::run::Git;
        use crate::run::tests::shell;
        let marker = marker("caller-stopped");
        let steps = Arc::new(Steps::new("c", Duration::from_secs(30), None));
        let script = hung_git(&marker);
        let running = steps.run("hung", None, async move {
            let git = Git::new(shell(60_000, 1024), step_scope());
            let _ = git.raw("/", &[script.as_str()]).await;
        });
        let up = format!("{}.up", marker.display());
        let waiting = async {
            while !std::path::Path::new(&up).exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        // The caller is dropped once the process runs.
        tokio::select! {
            _ = running => panic!("the step does not end by itself"),
            () = waiting => {}
        }
        let exited = format!("{}.exited", marker.display());
        assert!(matches!(
            steps.run("next", None, async { 1 }).await,
            Ended::Done(1)
        ));
        assert!(std::path::Path::new(&exited).exists());
    }
}
