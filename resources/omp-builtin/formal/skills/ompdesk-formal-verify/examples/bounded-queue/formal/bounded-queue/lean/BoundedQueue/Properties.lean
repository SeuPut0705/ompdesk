-- Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.
import BoundedQueue.System

/-!
# Properties (frozen)

Source of both: the doc comments of `src/queue.ts` ("refuses when full", "removes the oldest item").
Do not weaken a statement here without the user's approval; record a change in formal/findings.json.
-/
namespace BoundedQueue
open Explore

/-- Plain English: whatever the capacity is, the queue never holds more items than it can. -/
theorem never_overflows {cap : Nat} {s : S} (h : Reach Step (init cap) s) : s.size ≤ s.cap :=
  Reach.inv (fun s => s.size ≤ s.cap) (by simp [init])
    (fun s s' hi hs => by cases hs <;> simp_all <;> omega) h

/-- Plain English: every item pushed is either still queued or was taken out: nothing is lost or invented. -/
theorem nothing_lost {cap : Nat} {s : S} (h : Reach Step (init cap) s) : s.size + s.recvd = s.sent :=
  Reach.inv (fun s => s.size + s.recvd = s.sent) (by simp [init])
    (fun s s' hi hs => by cases hs <;> simp_all <;> omega) h

/-- Non-vacuity: a full queue is reachable, so `never_overflows` is not true only because nothing happens. -/
example : Reach Step (init 2) { cap := 2, size := 2, sent := 2, recvd := 0 } :=
  .tail (.tail .refl (Step.push _ (by decide))) (Step.push _ (by decide))

end BoundedQueue
