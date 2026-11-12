# Correspondence: StockLane.tla ↔ code

All code is `native/ompdesk/crates/core/src/stock/mod.rs`. A lane is one task (`Lane::start`) that takes one message at a time from its inbox, so each lane action is atomic: nothing of the lane's state is shared with another task.

| Model | Code | Atomic because |
|---|---|---|
| `Request(r)` | `Lane::request`: the request is pending; a worker that outlived its omp is let go; the request is written to the worker, or waits and a start is asked for (`stock.launch`) | one message |
| `Outlived` | `Lane::outlived_its_omp`: not the terminals worker, nothing unanswered, no other request pending, omp's stamp differs from the one read when the worker started | read inside `request`; the stamp is one `metadata` call |
| `Ask` | the `stock.launch` event, numbered from `NEXT_ID` (one sequence for the whole process) | inside `request` |
| `Launched(l, ok)` | main's `stock.launched` → `Msg::Launched` → `Lane::launched`: spawn and write what waited, or fail it | one message; `answers` models how late main answers, or never |
| `TimerFires(r)` | the `stock.request` handler's `select!` chose the timer (or main's cancel) over the answer: the caller is answered at once and `Msg::GaveUp` is sent | the handler decides once; `biased` takes an answer that is already there |
| `GaveUp(r)` | `Lane::gave_up`: forgets the request, writes `{cancel}` to the worker, arms the grace for a stock worker | one message |
| `WorkerAnswers(g, r)` | the worker writes `{id, result}` / `{id, error}` (also `withdrawn`) | environment |
| `ReadLine(g, r)` | `read_lines` → `Msg::Line` → `Lane::line`: a line of a worker that is not the lane's is dropped (`Lane::current`) | one message |
| `Grace(g, r)` | the sleeping task of `gave_up` → `Msg::Overdue` → `Lane::overdue` | one message |
| `Idle(g)` | the sleeping task of `arm_idle_exit` → `Msg::Idle` → `Lane::idle` | one message |
| `WorkerExits(g)` / `ReadExit(g)` | the worker's waiter task → `Msg::Exited` → `Lane::exited` | one message |
| `LetGo(why)` | `Lane::let_go` (the worker's stdin sender is dropped, which closes the pipe once its writer wrote what was queued); `overdue` also asks the waiter task to kill | inside the message |
| `Fail` | `Lane::fail_pending` | inside the message |
| `Stop` | `stock.stop` / `close_all` → `end_lanes` → `Msg::Stop` → `Lane::stop`; the lane's task ends and its table entry is removed under the table's lock, so a later request makes a fresh lane | one message; the model keeps one lane and empties it, which is the fresh lane's state |
| `OmpChanges` | another process replaces omp's `package.json` | environment |

## Abstractions that could hide a bug

- **The fresh lane after a stop is the same lane, emptied.** The code makes a new task with a new inbox; timers and reader tasks of the old one send into a closed inbox. The model lets those late messages reach the emptied lane, which is more than the code allows.
- **Launch numbers never repeat.** They come from one process-wide counter. A per-lane counter would restart after a stop and the model's `launching # l` check would not describe the code.
- **The idle timer's epoch is not modelled.** `idle_epoch` makes an idle timer armed before a newer request or answer do nothing, so a worker stays its whole idle time after its last answer. Without it a worker could be let go early but still only with nothing unanswered; that is a timing property, outside an untimed model. The model lets every idle timer ever armed fire.
- **Time.** Timers fire at any moment after they were armed. That a grace is 30 s or an idle exit 60 s is not checked.
- **`unanswered` belongs to the worker.** In the code it is a field of `Running`, so it empties when the worker goes; the model empties it in `LetGo` and `ReadExit`.
- **The worker's queue is not modelled.** That a withdrawn request never runs is the worker's own rule (`resources/gui-bridge/stock-helper/dispatch.ts`, pinned by `stock-helper.test.ts` "createDispatcher"); here a worker answers any request it was sent, in any order, or never.
- **A worker's last lines and its exit are two messages.** A line read after the exit was handled is dropped, in the model and in the code; the request then failed with the exit, as it did in the TypeScript (`exit` before the last `data`).
- **Writes to a worker never block the lane.** They go through an unbounded channel to the worker's writer task; a worker that stopped reading its stdin cannot stop the lane from handling timeouts.
