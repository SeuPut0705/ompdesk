# Model and code correspondence

> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

The correspondence between the model and the code is the contract between them. Without it:
- a counterexample cannot be explained in code terms,
- a fix cannot be mirrored in the model,
- drift cannot be detected, and
- the simplify workflow (W4) cannot justify deleting anything.

It has two parts, and both are required:

1. **`@code` tags in the model.** Machine-checked. They tie each action to the lines it stands for.
2. **`formal/<concern>/CORRESPONDENCE.md`.** Human-read. It records what each tag abstracts, the assumptions the model relies on, and the granularity rule. Template: [CORRESPONDENCE.md](../assets/CORRESPONDENCE.md).

## `@code` tags

A tag is one comment line directly above an action definition (or inside its body):

```tla
\* @code src/worker.ts:40-58 claimNext(): read the row and take the lease
Claim(w) ==
    /\ ...
```

```lean
/-- @code src/queue.ts:12-30 enqueue() -/
def enqueue (q : Queue) (x : Nat) : Queue := ...
```

Syntax: `@code <path>:<first>[-<last>] <optional note>`. The path is relative to the code root: the nearest ancestor of the spec with a `.git` folder, or `--code-root DIR` to `tlc.ts`, or `codeRoot` in `formal/manifest.json`. One action can carry several tags when one model step stands for lines in several places. A tag is not a comment about intent; it must be a location a reviewer can open and compare.

What reads the tags:

- `tlc.ts` shows the tag of each action on every row of a counterexample trace, so a trace reads as a code-level story.
- `verify-all.ts` resolves every tag of every model in the manifest and **fails on an unresolved one**: the file is missing, or the line range runs past the end of the file. That catches moved and deleted code mechanically. It also lists the covered files that changed since the model's `syncCommit`.
- The drift loop ([persist.md](persist.md#b-maintain-the-verification-the-drift-loop)) uses the tags to find which actions a code change touches.

A resolved tag only proves that the lines exist. It does not prove that they still do what the model says. Semantic drift (the code at the same lines now does something else) needs one of: reading the diff against the model (the drift loop), trace validation, model-based testing or differential testing ([trace-validation.md](trace-validation.md), [ci-and-drift.md](ci-and-drift.md)).

Tag every action, including the ones for the environment (a timer firing, a crash), by pointing at the code that makes that event possible (the lease expiry check, the process supervisor). An action with no code behind it is an assumption; list it in CORRESPONDENCE.md instead.

## The CORRESPONDENCE.md table

One row per model element (TLA+ action or variable, Lean function or structure field):

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `RMiss(r)` | `src/cache.py:41-48` `get()` miss branch through `await db.get` | action | the DB read is atomic; latency not modeled | |
| `cache` | `src/cache.py:12` `self._store` | variable | one key only | multi-key is symmetric |
| `WInval` | `src/writer.py:88` `cache.delete(k)` | action | the delete cannot fail | failure is out of scope (SCOPE.md) |

The Code column matches the `@code` tags. If you change one, change the other in the same edit.

Also add a short **Assumptions** list: the facts about the environment that the model relies on ("single event loop", "the DB is linearizable", "no process crash between L88 and L90"). Every assumption is a place a real bug can hide. The simplify workflow (W4) must not delete code that only an assumption makes redundant, unless the assumption is enforced elsewhere.

The first line of the file records the sync commit (`verify-all.ts --stamp` writes it to the manifest; copy it here when you stamp).

## Granularity rule

One model step is one atomic region in the code:
- **async/await code:** the code between two `await` points (single-threaded event loops interleave only there),
- **locked code:** a critical section,
- **lock-free or threaded code without locks:** each shared read or write, each CAS,
- **distributed code:** each message handler, each timer firing, each crash point,
- **SQL:** one statement is atomic only at the isolation level actually in use. Model what the database really does:
  - Under READ COMMITTED, `UPDATE ... WHERE id = (SELECT ... LIMIT 1)` re-checks only the outer `WHERE` after a concurrent write. Two workers can then claim the same row, or re-open a row that another worker already finished.
  - `SELECT ... FOR UPDATE` blocks only writers that also lock the row.

  Either model these semantics, or list them as an assumption and flag them in the report.

If the code splits a region the model treats as atomic, the model hides the race. MongoDB's Raft conformance effort failed partly because the spec merged a step-down and a step-up that the code performs separately ([evidence.md](evidence.md)). When in doubt, split. More interleavings cost states, not correctness.

State the rule you used at the end of CORRESPONDENCE.md, and list every place where the model merges steps the code performs separately.
