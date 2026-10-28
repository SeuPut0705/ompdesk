\* Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.
--------------------------- MODULE BatchPipeline ---------------------------
(* Pattern: dataflow pipeline  producer -> bounded queue -> batcher -> sink. *)
(* Properties: no loss / duplication / reordering, backpressure bound, and  *)
(* liveness (everything is eventually delivered).                           *)
(* FlushOnEos = FALSE is the classic bug: the last partial batch is never   *)
(* flushed when the stream ends. Only the liveness property catches it.     *)
EXTENDS Naturals, Sequences

CONSTANTS N,        \* number of items produced
          Cap,      \* queue capacity (backpressure)
          BatchSize,
          FlushOnEos

Input == [i \in 1..N |-> i]
RECURSIVE Flat(_)
Flat(s) == IF s = <<>> THEN <<>> ELSE Head(s) \o Flat(Tail(s))
IsPrefix(p, s) == Len(p) <= Len(s) /\ SubSeq(s, 1, Len(p)) = p

VARIABLES next, queue, batch, out, eos
vars == <<next, queue, batch, out, eos>>

Init == next = 1 /\ queue = <<>> /\ batch = <<>> /\ out = <<>> /\ eos = FALSE

\* @code pipeline/source.ts:20 await queue.put(item)
Produce ==
    /\ next <= N /\ Len(queue) < Cap
    /\ queue' = Append(queue, next) /\ next' = next + 1
    /\ UNCHANGED <<batch, out, eos>>

\* @code pipeline/source.ts:24 await queue.close()
Close ==
    /\ next = N + 1 /\ ~eos /\ eos' = TRUE
    /\ UNCHANGED <<next, queue, batch, out>>

\* @code pipeline/batcher.ts:31-36 for await (const x of queue) batch.push(x)
Take ==
    /\ queue # <<>> /\ Len(batch) < BatchSize
    /\ batch' = Append(batch, Head(queue)) /\ queue' = Tail(queue)
    /\ UNCHANGED <<next, out, eos>>

\* @code pipeline/batcher.ts:37-40 if (batch.length === size) await sink.write(batch)
\* @code pipeline/batcher.ts:43 after the loop: if (batch.length) await sink.write(batch)  <- the fix
Flush ==
    /\ \/ Len(batch) = BatchSize
       \/ FlushOnEos /\ eos /\ queue = <<>> /\ batch # <<>>
    /\ out' = Append(out, batch) /\ batch' = <<>>
    /\ UNCHANGED <<next, queue, eos>>

Next == Produce \/ Close \/ Take \/ Flush
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

----------------------------------------------------------------------------
Backpressure == Len(queue) <= Cap
NoLossDupReorder == IsPrefix(Flat(out) \o batch \o queue, Input)   \* in-flight order preserved
AllDelivered == <>(Flat(out) = Input)

\* Sanity (must FAIL): the stream really closes.
NeverCloses == ~eos
=============================================================================
