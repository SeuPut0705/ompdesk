# Frozen properties: update-job-gate

Frozen at: 2 Nov 2026, the brief of this unit (the user's OK). Any change to a definition below, to a `CONSTRAINT`, or to the fairness of `Spec` is a **model change**: say so in the report, with the old and the new text and the evidence. Never make one to turn a failing check green.

The definitions are the lines between the `\* FROZEN PROPERTIES` and `\* END FROZEN PROPERTIES` banners of `tla/UpdateJobGate.tla`.

## NoJobCutByQuit

- Kind: invariant
- Statement: `mphase = "quit" => \A o \in Omps : jobs[o] = 0 /\ Underway(o) = {}`
- Meaning: when the app quits, no omp has a running job and no tool call is past the gate (a call past the gate may still register a job).
- Source: `resources/gui-bridge/job-gate.ts:1-9` ("nothing can start between main's last look and the quit"); `src/main/app-auto-update.ts:9-15`.
- Level: protocol
- Config: `MC.cfg`, `MC_bug*.cfg` (`INVARIANT NoJobCutByQuit`)
- Result: holds for the fixed protocol; violated by variants A, B, C (matrix)

## FrozenEventuallyThawed

- Kind: liveness
- Statement: `\A o \in Omps : [](gate[o] = "closed" => <>(gate[o] = "open" \/ mphase = "quit"))`
- Meaning: a gate main closed is opened again by main (thaw) or the app quits; the lease is a safety net, not part of this guarantee (no fairness on `Expire`).
- Source: `src/main/background-work.ts:279-283` ("none stays stopped"), `job-gate.ts:6-8`.
- Level: protocol
- Config: `MC_live.cfg` (`PROPERTIES FrozenEventuallyThawed`)
- Result: holds

## HeldEventuallyRuns

- Kind: liveness
- Statement: `\A o \in Omps : \A c \in Calls : [](call[o][c] = "waiting" => <>(call[o][c] # "waiting" \/ mphase = "quit"))`
- Meaning: a tool call held at the closed gate runs once the gate opens, or the app quits.
- Source: `resources/gui-bridge/job-gate.ts:6-8` ("a call that reaches the closed gate waits there until thaw/lease/quit").
- Level: protocol
- Config: `MC_live.cfg`
- Result: holds

## Not frozen (added for the traces)

`NoRunningJobCutByQuit` (the narrow form: a job is running at the quit) is used only by `MC_bug*_job.cfg`, so a trace of a bug variant shows the job that was cut and not only the call that could still have started it. It is implied by `NoJobCutByQuit`.
