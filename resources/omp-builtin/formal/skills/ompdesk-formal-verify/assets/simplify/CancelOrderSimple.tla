Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.
The @code paths point into an imaginary Rails app: this example shows the method, it is not run against a repo.
------------------------- MODULE CancelOrderSimple -------------------------
(* SIMPLIFIED code: the row lock is gone; the conditional UPDATE remains.   *)
EXTENDS Naturals

States == {"pending", "paid", "shipped", "cancelled"}
Allowed == {<<"pending", "paid">>, <<"pending", "cancelled">>, <<"paid", "shipped">>}
VARIABLES status, cpc, cread
vars == <<status, cpc, cread>>

Init == status = "pending" /\ cpc = "start" /\ cread = "pending"
\* @code api/webhooks.rb:12 (UPDATE orders SET status='paid' WHERE id=? AND status='pending')
Pay  == status = "pending" /\ status' = "paid" /\ UNCHANGED <<cpc, cread>>
\* @code jobs/fulfil.rb:8
Ship == status = "paid" /\ status' = "shipped" /\ UNCHANGED <<cpc, cread>>
\* @code api/orders_controller.rb:39 (Order.find(id)  -- no FOR UPDATE)
CancelRead  == cpc = "start" /\ cread' = status /\ cpc' = "decide" /\ UNCHANGED status
\* @code api/orders_controller.rb:41-43 (UPDATE ... WHERE status='pending')
CancelWrite == cpc = "decide" /\ cread = "pending" /\ status = "pending"
               /\ status' = "cancelled" /\ cpc' = "done" /\ UNCHANGED cread
CancelSkip  == cpc = "decide" /\ (cread # "pending" \/ status # "pending")
               /\ cpc' = "done" /\ UNCHANGED <<status, cread>>
Next == Pay \/ Ship \/ CancelRead \/ CancelWrite \/ CancelSkip
Spec == Init /\ [][Next]_vars

ValidTransitions == [][status' # status => <<status, status'>> \in Allowed]_vars

(* Refinement: every behavior of the simplified code is a behavior of the   *)
(* current code, under a mapping that reconstructs the removed lock.        *)
Current == INSTANCE CancelOrder WITH
             UseLock <- TRUE, UseCAS <- TRUE,
             lock <- (IF cpc = "decide" THEN "cancel" ELSE "free")
RefinesCurrent == Current!Spec
=============================================================================
