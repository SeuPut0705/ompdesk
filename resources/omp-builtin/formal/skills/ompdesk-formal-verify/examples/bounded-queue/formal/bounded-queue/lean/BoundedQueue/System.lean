import BoundedQueue.Explore

/-!
# System model: bounded queue

Code: `src/queue.ts` (`BoundedQueue.push` and `BoundedQueue.shift`).
Atomicity rule: one `Step` constructor per method call, because each method runs to completion
without an `await`. Adapted from the template of opum-ai/proof-skills (MIT, Opum AI).
-/
namespace BoundedQueue
open Explore

/-- State: how many items wait, the capacity, and counters that show nothing is lost or invented. -/
structure S where
  cap : Nat
  size : Nat
  sent : Nat
  recvd : Nat
  deriving DecidableEq, Repr

def init (cap : Nat) : S := { cap := cap, size := 0, sent := 0, recvd := 0 }

inductive Step : S → S → Prop
  /-- @code src/queue.ts:8-10 push: a full queue refuses, so the guard is `size < cap` -/
  | push (s : S) (h : s.size < s.cap) : Step s { s with size := s.size + 1, sent := s.sent + 1 }
  /-- @code src/queue.ts:15-16 shift: an empty queue returns undefined, so the guard is `0 < size` -/
  | pop (s : S) (h : 0 < s.size) : Step s { s with size := s.size - 1, recvd := s.recvd + 1 }

end BoundedQueue
