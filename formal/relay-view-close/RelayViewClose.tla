------------------------- MODULE RelayViewClose -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Views, Generations, First, Second, Bug
ASSUME /\ Cardinality(Views) = 2 /\ Generations = {First, Second} /\ First # Second
VARIABLES pc, chosen, handle, incarnation, callerGen, grantGen, coreGen,
          connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller,
          receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared,
          outcome, validated, validatedGood, committed, commitGood, preserved,
          runAlive, saved, cleanup, refused
vars == <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen,
          connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller,
          receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared,
          outcome, validated, validatedGood, committed, commitGood, preserved,
          runAlive, saved, cleanup, refused>>
Other(g) == IF g = First THEN Second ELSE First
Init ==
 /\ pc = "start" /\ chosen \in Views /\ handle = chosen
 /\ incarnation = [v \in Views \cup {"targetCore"} |-> First]
 /\ callerGen = First /\ grantGen = First /\ coreGen = First
 /\ connGen = First /\ live = TRUE /\ safe = TRUE
 /\ receipt = "none" /\ receiptView = chosen /\ receiptInc = First
 /\ receiptCaller = First /\ receiptGrant = First /\ receiptCore = First
 /\ fresh = TRUE /\ challenge = First /\ reply = <<First, chosen>>
 /\ attached = Views /\ prepared = FALSE /\ outcome = "pending"
 /\ validated = FALSE /\ validatedGood = [attempt |-> TRUE, ack |-> TRUE] /\ committed = FALSE
 /\ commitGood = TRUE /\ preserved = TRUE /\ runAlive = TRUE /\ saved = Views
 /\ cleanup = [up |-> "pending", local |-> "pending", exit |-> "none", localExit |-> "none"] /\ refused = FALSE

\* @code src/main/remote/view-control.ts:361-395 target checks the exact handle and emits the initial challenge
Start ==
 /\ pc = "start" /\ live /\ chosen \in attached
 /\ pc' = "authorizing" /\ receiptInc' = incarnation[chosen]
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:293-332 initial source checks and person-turn request
AuthorizeStart ==
 /\ pc = "authorizing" /\ safe /\ pc' = "authWait"
 /\ receiptCaller' = callerGen /\ receiptCore' = coreGen
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptGrant, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:333-361 caller recheck and allowed await
AuthorizeAllowed ==
 /\ pc = "authWait" /\ safe /\ callerGen = receiptCaller /\ coreGen = receiptCore
 /\ receiptGrant' = grantGen /\ pc' = "allowWait"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:361-381 allowed answer and confirmation await
AuthorizeConfirm ==
 /\ pc = "allowWait" /\ pc' = "confirmWait"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:382-391 recheck and second provenance await
AuthorizeRecheck ==
 /\ pc = "confirmWait" /\ safe /\ callerGen = receiptCaller /\ grantGen = receiptGrant /\ coreGen = receiptCore /\ pc' = "personWait"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:396-431 receipt minted in the source core
Issue ==
 /\ pc = "personWait" /\ safe /\ callerGen = receiptCaller /\ grantGen = receiptGrant /\ coreGen = receiptCore
 /\ receipt' = "issued" /\ receiptView' = handle /\ fresh' = TRUE
 /\ pc' = "initialAck"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receiptInc, receiptCaller, receiptGrant, receiptCore, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code src/main/remote/view-control.ts:346-359 target receives the matching initial response
InitialAck ==
 /\ pc = "initialAck" /\ live /\ pc' = "prepare"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code src/main/agent-control/view-host.ts:61-108 local close checks and renderer acknowledgement await
\* @code src/main/remote/view-control.ts:398-426 final challenge starts before the local pool commit
Prepare ==
 /\ pc = "prepare" /\ live /\ safe /\ chosen \in attached
 /\ pc' = "final" /\ challenge' = Second /\ prepared' = TRUE
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, reply, attached, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:434-457 receipt removed before the person-turn await
Consume ==
 /\ pc = "final" /\ receipt = "issued" /\ receipt' = "consumed" /\ pc' = "validateWait"
 /\ validatedGood' = [validatedGood EXCEPT !.attempt = (receiptView = handle /\ receiptInc = incarnation[handle] /\ receiptCaller = callerGen /\ receiptGrant = grantGen /\ receiptCore = coreGen /\ fresh)]
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/stop.rs:457-465 final native source checks after await
\* @code src/main/agent-control/host.ts:776-782 source main rechecks its caller after validation
Validate ==
 /\ pc = "validateWait"
 /\ (Bug = "receipt" \/ (validatedGood.attempt /\ receiptView = handle /\ receiptInc = incarnation[handle]
     /\ receiptCaller = callerGen /\ receiptGrant = grantGen /\ receiptCore = coreGen /\ fresh))
 /\ live /\ connGen = First /\ validated' = TRUE /\ pc' = "answer"
 /\ validatedGood' = [validatedGood EXCEPT !.ack = (@ /\ ~validated /\ validatedGood.attempt /\ receiptView = handle /\ receiptInc = incarnation[handle]
     /\ receiptCaller = callerGen /\ receiptGrant = grantGen /\ receiptCore = coreGen /\ fresh)] /\ reply' = <<challenge, handle>>
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, attached, prepared, outcome, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code src/main/remote/view-control.ts:267-305 source sends final authorization after validation
\* @code src/main/remote/view-control.ts:346-359 target matches peer, connection, handle, nonce and phase
FinalAck ==
 /\ pc = "answer" /\ live /\ connGen = First /\ reply = <<challenge, handle>> /\ pc' = "commit"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code src/main/sidecar-pool.ts:1473-1498 final callback, local identity recheck and synchronous hub call, without await
\* @code native/ompdesk/crates/core/src/pool/windows.rs:536-579 guarded exact commit and layout snapshot
Commit ==
 /\ pc = "commit" /\ (Bug = "disconnect" \/ (live /\ connGen = First)) /\ safe
 /\ handle = chosen /\ incarnation[chosen] = receiptInc /\ incarnation["targetCore"] = First /\ chosen \in attached
 /\ attached' = attached \ {chosen} /\ committed' = TRUE
 /\ commitGood' = (~committed /\ live /\ connGen = First /\ safe /\ handle = chosen /\ incarnation[chosen] = receiptInc /\ incarnation["targetCore"] = First /\ validated /\ reply = <<challenge, handle>>)
 /\ preserved' = ((Views \ {chosen}) \subseteq attached')
 /\ runAlive' = runAlive /\ saved' = saved
 /\ pc' = "cleanup"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, prepared, outcome, validated, validatedGood, cleanup, refused>>
\* @code src/main/sidecar-pool.ts:1499-1508 a failed synchronous hub call has an unknown commit outcome
UnknownCommit(applied) ==
 /\ pc = "commit" /\ live /\ connGen = First /\ safe /\ handle = chosen
 /\ incarnation[chosen] = receiptInc /\ incarnation["targetCore"] = First /\ chosen \in attached
 /\ applied \in BOOLEAN /\ attached' = IF applied THEN attached \ {chosen} ELSE attached
 /\ committed' = applied /\ commitGood' = TRUE /\ outcome' = "unknown" /\ pc' = "done"
 /\ incarnation' = [incarnation EXCEPT !["targetCore"] = Second]
 /\ prepared' = FALSE
 /\ UNCHANGED <<chosen, handle, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, validated, validatedGood, preserved, runAlive, saved, cleanup, refused>>

\* @code src/main/remote/remote-sidecar.ts:392-402 the prepared target is sent in tab.leave if it was opened
UpstreamSend ==
 /\ pc = "cleanup" /\ cleanup.up = "pending"
 /\ cleanup' = [cleanup EXCEPT !.up = "sent"]
 /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, refused>>

\* @code src/main/remote/host-services.ts:1766-1806 an exact hosted leave either waits for its own execution or preserves it
HostLeave(waitExit) ==
 /\ pc = "cleanup" /\ cleanup.up = "sent" /\ waitExit \in BOOLEAN
 /\ cleanup' = [cleanup EXCEPT !.up = "host", !.exit = IF waitExit THEN "waiting" ELSE "none"]
 /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, refused>>

\* @code src/main/remote/host-services.ts:2978-2982 captures the exact execution exit before disposal
HostExit ==
 /\ pc = "cleanup" /\ cleanup.exit = "waiting"
 /\ cleanup' = [cleanup EXCEPT !.exit = "done"]
 /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, refused>>

\* @code src/main/remote/host-services.ts:1782-1806 completion follows the captured exit promise
\* @code src/main/remote/remote-sidecar.ts:402-403 tab.leave resolves or rejects
UpstreamAnswer(ok) ==
 /\ pc = "cleanup" /\ cleanup.up = "host" /\ ok \in BOOLEAN
 /\ (~ok \/ cleanup.exit # "waiting")
 /\ cleanup' = [cleanup EXCEPT !.up = IF ok THEN "confirmed" ELSE "failed"]
 /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, refused>>

\* @code src/main/sidecar-pool.ts:1514-1533 capture the original local sidecar exit before finish
\* @code src/main/sidecar-pool.ts:1554-1567 await that exit only if the captured handle was released
\* @code src/main/sidecar.ts:1498-1502 preserve an exit failure
\* @code native/ompdesk/crates/core/src/pool/windows.rs:582-628 native finish has further awaits
LocalEffects(ok, waitExit) ==
 /\ pc = "cleanup" /\ cleanup.local = "pending" /\ ok \in BOOLEAN /\ waitExit \in BOOLEAN
 /\ cleanup' = [cleanup EXCEPT !.local = IF ~ok THEN "failed" ELSE IF waitExit THEN "waiting" ELSE "confirmed",
                               !.localExit = IF ok /\ waitExit THEN "waiting" ELSE "none"]
 /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, refused>>

\* Environment: the captured local execution exits, or its exit wait rejects.
LocalExit(ok) ==
 /\ pc = "cleanup" /\ cleanup.local = "waiting" /\ ok \in BOOLEAN
 /\ cleanup' = [cleanup EXCEPT !.local = IF ok THEN "confirmed" ELSE "failed", !.localExit = "done"]
 /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, refused>>

\* @code src/main/sidecar-pool.ts:1567-1585 all settled effects determine the result
CleanupResult ==
 /\ pc = "cleanup" /\ cleanup.up \in {"confirmed", "failed"} /\ cleanup.local \in {"confirmed", "failed"}
 /\ outcome' = IF cleanup.up = "confirmed" /\ cleanup.local = "confirmed" THEN "Closed" ELSE "partial"
 /\ pc' = "done"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>

\* @code src/main/sidecar-pool.ts:1506-1512 a rejected local commit cancels the reservation
Refuse ==
 /\ pc \in {"prepare", "commit"} /\ pc' = "done" /\ refused' = TRUE
 /\ outcome' = "refused" /\ prepared' = FALSE /\ attached' = attached
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup>>

\* Environment: one outage, source core loss, expiry, and identity/generation ABA.
Disconnect == /\ live /\ live' = FALSE /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
Reconnect == /\ ~live /\ connGen = First /\ live' = TRUE /\ connGen' = Second /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
Expire == /\ fresh /\ fresh' = FALSE /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
CoreLoss == /\ coreGen = First /\ coreGen' = Second /\ receipt' = "none" /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, connGen, live, safe, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
ChangeCaller == /\ callerGen = First /\ callerGen' = Second /\ UNCHANGED <<pc, chosen, handle, incarnation, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
ChangeGrants == /\ grantGen = First /\ grantGen' = Second /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
Reopen == /\ incarnation[chosen] = First /\ incarnation' = [incarnation EXCEPT ![chosen] = Second] /\ UNCHANGED <<pc, chosen, handle, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
TargetCoreLoss == /\ incarnation["targetCore"] = First /\ incarnation' = [incarnation EXCEPT !["targetCore"] = Second] /\ UNCHANGED <<pc, chosen, handle, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
BecomeUnsafe == /\ safe /\ safe' = FALSE /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
\* Environment: an unmatched authorization response may arrive before the matching response.
ForgeReply(n, v) ==
 /\ pc = "answer" /\ n \in Generations /\ v \in Views
 /\ reply' = <<n, v>>
 /\ UNCHANGED <<pc, chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
\* Environment: a delayed duplicate validation or commit request is presented again.
ReplayReceipt ==
 /\ pc = "answer" /\ receipt = "consumed" /\ pc' = "final"
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, attached, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
ReplayCommit ==
 /\ committed /\ incarnation["targetCore"] = Second /\ pc = "cleanup"
 /\ pc' = "commit" /\ attached' = attached \cup {chosen}
 /\ UNCHANGED <<chosen, handle, incarnation, callerGen, grantGen, coreGen, connGen, live, safe, receipt, receiptView, receiptInc, receiptCaller, receiptGrant, receiptCore, fresh, challenge, reply, prepared, outcome, validated, validatedGood, committed, commitGood, preserved, runAlive, saved, cleanup, refused>>
Next == Start \/ AuthorizeStart \/ AuthorizeAllowed \/ AuthorizeConfirm \/ AuthorizeRecheck \/ Issue \/ InitialAck \/ Prepare \/ Consume \/ Validate \/ FinalAck \/ Commit \/ (\E applied \in BOOLEAN : UnknownCommit(applied)) \/ UpstreamSend \/ (\E b \in BOOLEAN : HostLeave(b) \/ UpstreamAnswer(b) \/ LocalExit(b)) \/ (\E ok \in BOOLEAN, waitExit \in BOOLEAN : LocalEffects(ok, waitExit)) \/ HostExit \/ CleanupResult \/ Refuse \/ Disconnect \/ Reconnect \/ Expire \/ CoreLoss \/ TargetCoreLoss \/ ChangeCaller \/ ChangeGrants \/ Reopen \/ BecomeUnsafe \/ ReplayReceipt \/ ReplayCommit \/ (\E n \in Generations, v \in Views : ForgeReply(n, v))
Spec == Init /\ [][Next]_vars
\* BEGIN FROZEN PROPERTIES
ReceiptValid == validated => validatedGood.ack
ExactCommit == committed => commitGood
RefusalKeeps == refused => chosen \in attached
NoFalseClosed == outcome = "Closed" => cleanup.up = "confirmed" /\ cleanup.local = "confirmed"
NoPrematureAck == (cleanup.up = "confirmed" => cleanup.exit # "waiting") /\ (cleanup.local = "confirmed" => cleanup.localExit # "waiting")
OthersPreserved == preserved /\ runAlive /\ saved = Views
\* END FROZEN PROPERTIES
=============================================================================
