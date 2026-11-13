# Correspondence: ChecksAdmission.tla ↔ the hub's admission

There is no code yet (workflow W3). `native/ompdesk/crates/core/src/checks/admission.rs` (the tool session's part) implements these actions. When it lands, its owner puts a `\* @code native/ompdesk/crates/core/src/checks/admission.rs:<lines> <what>` line above each action marked **code** below, adds the file to `covers` of `checks-admission` in `formal/manifest.json`, reruns the model and stamps it (`.omp/skills/checks-admission-verify/SKILL.md`).

## Actions

| Action | Kind | Hub step it stands for | Must be one atomic step because | Properties it serves |
|---|---|---|---|---|
| `Start(j)` | **code** | `ChecksHub::start` after the caller's input digest is known: refuse while paused; answer `reused` from a green run of the same digest; else enqueue `held` with the next arrival number and a lease, and in the same step mark the older governed runs of the same repo, ref and workflow that are neither `release` nor `land` as superseded (an entry that only waited leaves the queue `cancelled`; a dispatched or running one is sent GitHub's cancel and keeps its place, `cancelling`) | the pause read, the reuse lookup and the supersede must see one state; a pause between them could cancel an old run and queue nothing | P5, P6, P7 |
| `Admit(j)` | **code** | The pump, one pass: the first entry in line (lane rank, then arrival) whose lease holds and whose pool and the account have room, taken while not paused. For an account pool, the room counts the account places held by release entries ahead of it (`HeldAhead`). Its place is written into the hub's ledger (`dispatching`) **before** the dispatch request is awaited; it records the arrival counter as `at` (ghost) | two passes must never see the same free place; a pass that awaits the dispatch before it records the place admits a second job into it | P1, P2, P3, P4, P7, P8, P9, P10, P12 |
| `Dispatched(j)` | **code** | The dispatch request answered OK: the entry is `running` | one message | P1, P10 |
| `DispatchFails(j)` | **code** | The dispatch failed or timed out: the entry ends `failed`, its place goes back, its owner is answered; it is never put back in the queue (a dispatch whose answer was lost may have started the run, P2) | one message | P2, P10 |
| `RunEnds(j)` | **code** | The poller sees a run end: green or red for the hub's own, gone for an outside one; the place goes back | one poll result | P1, P6, P10 |
| `CancelLands(j)` | **code** | The poller sees a superseded run end: only now does its place go back | one poll result | P1 |
| `Reap(j)` | **code** | The lease sweep, and a heartbeat that arrives after its deadline: the entry leaves the queue `expired` and its owner is told | one sweep step per entry | P8, P9, P11 |
| `Renew(j)` | mutation only | A heartbeat handler that renews a lapsed lease (`LateHeartbeatRenews`); the code must read the deadline first and answer `expired` | n/a | P8 |
| `Pause` / `Resume` | **code** | The owner's `pause(true)` / `pause(false)` | one write the pump and `start` read | P7 |
| `OutsideStarts(j)` | environment | A job the hub does not govern starts (a person's run, another repo's on the account, another program's heavy command); GitHub or the heavy pool let it in only while a place is free (`at` records when, for P12) | n/a | P1, P12 |
| `Lapse(j)` | environment | A lease's deadline passes with no heartbeat (the owner died, slept or lost its link) | n/a | P8, P11 |
| `Terminated` | model | Everything is over | n/a | — |

Definitions the code mirrors one to one:

| Definition | What the code holds |
|---|---|
| `Rank(j)` | lane order release 0, land 1, branch 2, local 3 |
| `Ahead(a, b)` | the queue's order: rank, then arrival number |
| `Counted(j)`, `Places(p)` | the hub's ledger of places: its own dispatching, running and cancelling jobs, plus the poller's count of jobs it does not govern |
| `Room(j)` | the job's pool below its limit and, for a hosted pool, the account's places plus the places held for release entries ahead of it below the account's limit |
| `Holds(r)`, `HeldAhead(j)` | a held release entry with a live lease in an account pool (macOS) whose own pool is full holds one account place; `HeldAhead(j)` are the holders ahead of `j` in line (the owner's F1 decision, 14 Nov 2026). Derived from the queue and the ledger on every pump pass, never stored |
| `Superseded(j)` | same repo, ref and workflow; governed; lane neither release nor land; held, dispatching or running |
| `ReuseSources(j)` | a green run with the same input digest (workflow file hash, inputs and tool digest, design §5) |
| `Waiting(j)` | held and its lease not lapsed |

## Assumptions (each a place a bug could hide)

- **A1. One admission at a time.** `Start`, `Admit`, `Reap` and `Pause` run under one lock or on one task (an actor's inbox). Two pumps running at once can admit two jobs into one place.
- **A2. The place is in the ledger before the dispatch's `await`.** The pump counts its own jobs from its ledger, not from GitHub's list. Mutation `count-from-the-poll-only` shows the double admit when it does not.
- **A3. Outside jobs are counted as soon as they run.** In the code the poller sees them one poll late, so the hub can admit into a place an outside job just took; GitHub then queues that job (no harm beyond a wait), and a computer's heavy pool makes it wait for its OS lock. The account limit itself is never broken by the hub's count alone. The model gives the hub an exact view; a lagging view is out of scope.
- **A4. A dispatch's answer arrives** (accepted, failed or timed out) and a run ends (GitHub's job timeout, the heavy pool's file lock). The liveness properties rest on these and on the pump and the sweep running.
- **A5. Lane, pool, key and digest are fixed at `start`.** Placement and lane come from policy (design §6), never from a later step.
