# Scope: local checkout lifecycle

## Promise and harm

A local check, its Git and setup commands, and their cleanup own the checkout until they are finished. A reopened hub must not mutate it beside a surviving worker. A stale delayed worker must not touch a newer generation. A paused destination refuses a new paired request, and a stopped hub does not dispatch its fallback. Breaking these promises can mix commits or mutate files under a running check.

## Bounds

The proposed matrix has one checkout and two or three core generations. Each has one local child at a time. A child stands for one Git command, setup command, or check. Every core may crash at any modeled step. The model permits a check starter to be named after cancellation. These bounds and the model are not checked yet; no state count or passing verdict is claimed.

## What is modeled

An admission linearization point, pause and stop, a prepared fallback followed by a separately guarded dispatch, A and B ownership, atomic epoch advance, corruption, delayed child spawn and B acquisition, generation and SHA checks, active work, cleanup, cancellation before and after observing a run id, and a request's return. A core crash releases its locks but not a surviving child's B. The environment may leave a worker or an unreadable epoch unresolved indefinitely. No fairness, recovery, automatic retry, or liveness property is assumed.

## Exclusions and limits

The model assumes OS locks are exclusive and a supervisor holds B until the supervised process and the cleanup it can observe end. The source starts its POSIX supervisor in a different process group from the core; core-group death therefore closes stdin rather than killing that B owner. A real regression kills the core-shaped group and observes both the child cleanup barrier and exclusion of a new B holder. This does not prove containment of a process escaping the Unix session or Windows taskkill tree, or an independently killed supervisor. Already-running pre-upgrade binaries without B and generation fencing are outside scope. Filesystem durability, PID reuse, journal corruption, SHA collision and Git internals are abstracted. Epoch corruption is explicit; a missing or corrupt existing epoch fails closed, while a new checkout can initialize it. A crash may leave an unreferenced atomic-writer temporary file. External lock-file removal is not modeled.

The model does not decide test verdicts, quarantine history, placement capacity or remote admission. Local SANY passed, not TLC or mutations. The root-owned dispatch fence checks stop after preflight awaits and before the network write; fallback's initial check alone is not its linearization point.
