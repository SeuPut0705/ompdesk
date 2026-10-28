Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.
The @code paths point into an imaginary Rails app: this example shows the method, it is not run against a repo.
---------------------------- MODULE CancelOrder ----------------------------
(* CURRENT code: cancel takes a row lock (SELECT ... FOR UPDATE) AND uses a *)
(* conditional UPDATE ... WHERE status='pending'. The payment webhook does   *)
(* an atomic conditional UPDATE and never takes the lock.                   *)
(* Question for the simplify workflow: which of the two protections is doing work? *)
EXTENDS Naturals

CONSTANTS UseLock, UseCAS
States == {"pending", "paid", "shipped", "cancelled"}
Allowed == {<<"pending", "paid">>, <<"pending", "cancelled">>, <<"paid", "shipped">>}

VARIABLES status, cpc, cread, lock
vars == <<status, cpc, cread, lock>>

Init == status = "pending" /\ cpc = "start" /\ cread = "pending" /\ lock = "free"

\* @code api/webhooks.rb:12 (UPDATE orders SET status='paid' WHERE id=? AND status='pending')
Pay  == status = "pending" /\ status' = "paid" /\ UNCHANGED <<cpc, cread, lock>>
\* @code jobs/fulfil.rb:8
Ship == status = "paid" /\ status' = "shipped" /\ UNCHANGED <<cpc, cread, lock>>

\* @code api/orders_controller.rb:39-40 (Order.lock.find(id))
CancelRead ==
    /\ cpc = "start"
    /\ UseLock => lock = "free"
    /\ lock' = (IF UseLock THEN "cancel" ELSE lock)
    /\ cread' = status /\ cpc' = "decide" /\ UNCHANGED status

\* @code api/orders_controller.rb:41-43 (update where status='pending'; commit releases lock)
CancelWrite ==
    /\ cpc = "decide" /\ cread = "pending"
    /\ UseCAS => status = "pending"
    /\ status' = "cancelled" /\ cpc' = "done" /\ UNCHANGED cread
    /\ lock' = (IF UseLock THEN "free" ELSE lock)

CancelSkip ==
    /\ cpc = "decide"
    /\ cread # "pending" \/ (UseCAS /\ status # "pending")
    /\ cpc' = "done" /\ UNCHANGED <<status, cread>>
    /\ lock' = (IF UseLock THEN "free" ELSE lock)

Next == Pay \/ Ship \/ CancelRead \/ CancelWrite \/ CancelSkip
Spec == Init /\ [][Next]_vars

ValidTransitions == [][status' # status => <<status, status'>> \in Allowed]_vars
TypeOK == status \in States /\ lock \in {"free", "cancel"}
=============================================================================
