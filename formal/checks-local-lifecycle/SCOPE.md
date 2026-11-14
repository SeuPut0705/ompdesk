# Scope: local checkout lifecycle

## Promise and harm

A local check, its Git and setup commands, and their cleanup own the checkout until they are finished. A reopened hub must not mutate it beside a surviving worker. A stale delayed worker must not touch a newer generation. A paused destination refuses a new paired request, and a stopped hub does not dispatch its fallback. Breaking these promises can mix commits or mutate files under a running check.

## Bounds

The matrix retains one checkout and both two and three core generations, with one local child per worker. Every core can crash at any modeled step; a check starter can be named after cancellation. The initial runner completed two workers (898,880 distinct states, depth 44) but three workers timed out at 600 seconds with no verdict. Runner 43564558766 kept the same bounds and frozen invariants, used worker-name permutation symmetry, and raised the timeout to 3,600 seconds. Its two-worker row passed at 449,514 distinct states, depth 44; its three-worker row passed at 104,365,604 distinct states, depth 65. The reachable busy-prefix row passed at 13,938 distinct states, depth 27. No state constraint or fairness was added.

## What is modeled

An admission linearization point, pause and stop, a prepared fallback followed by a separately guarded dispatch, A and B ownership, atomic epoch advance, corruption, delayed child spawn and B acquisition, generation and SHA checks, active work, cleanup, cancellation before and after observing a run id, and a request's return. A core crash releases its locks but not a surviving child's B. The environment may leave a worker or an unreadable epoch unresolved indefinitely. No fairness, recovery, automatic retry, or liveness property is assumed.

The additional `MC_busy.cfg` starts at a reachable three-worker prefix, without replacing the full initial-state runs. A delayed epoch-1 starter exists after its core crashed; an epoch-2 worker is active while its own core has crashed; a third core owns A and waits for the active worker's B. This is obtained by the normal Admit/TakeA/TakeCoreB/Reserve/Launch/Crash steps, then TakeWorkerB/BeginWork for epoch 2, followed by the third Admit/TakeA. It exercises the existing missing-worker-B mutation at the three-worker bound where the generation guard alone no longer masks an overwritten lock owner.

Worker identities appear only as map keys, equalities, set membership and SHA representatives. Renaming all workers together preserves every action and frozen invariant. `WorkerSymmetry` therefore quotients interchangeable names; it does not remove a schedule or select a favored worker. There are no liveness properties in this model.

## Exclusions and limits

The model assumes OS locks are exclusive and a supervisor holds B until the supervised process and the cleanup it can observe end. The source starts its POSIX supervisor in a different process group from the core; core-group death therefore closes stdin rather than killing that B owner. A real regression kills the core-shaped group and observes both the child cleanup barrier and exclusion of a new B holder. This does not prove containment of a process escaping the Unix session or Windows taskkill tree, or an independently killed supervisor. Already-running pre-upgrade binaries without B and generation fencing are outside scope. Filesystem durability, PID reuse, journal corruption, SHA collision and Git internals are abstracted. Epoch corruption is explicit; a missing or corrupt existing epoch fails closed, while a new checkout can initialize it. A crash may leave an unreferenced atomic-writer temporary file. External lock-file removal is not modeled.

The model does not decide test verdicts, quarantine history, placement capacity or remote admission. Runner 43564558766 detected all nine protocol mutations but its TypeOK negative case was INVALID: TLC cannot compare the injected string with a Boolean. The corrected negative case instead puts a numeric epoch just outside the finite epoch domain, so the unchanged TypeOK can reject it without an evaluator type error. The complete corrected mutation audit and stamp remain unverified until its next runner finishes. The root-owned dispatch fence checks stop after preflight awaits and before the network write; fallback's initial check alone is not its linearization point.
