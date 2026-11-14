---------------------- MODULE RetainedViewReopen ----------------------
EXTENDS Naturals
CONSTANTS Mode, RejectJoin
VARIABLE s

Eligible == s.exactPath /\ s.currentRuntime /\ ~s.hidden /\ s.allowed

Init ==
  \E p, r, h, a \in BOOLEAN:
    /\ (Mode = "join" \/ <<p, r, h, a>> = <<TRUE, TRUE, FALSE, TRUE>>)
    /\ s = [ exactPath |-> p, currentRuntime |-> r, hidden |-> h,
             allowed |-> a, phase |-> "check", actual |-> FALSE,
             joined |-> FALSE, custody |-> "original", permission |-> "original",
             saved |-> TRUE, executions |-> 1, alive |-> TRUE,
             view |-> "none", rendererRuntime |-> "A", work |-> "old",
             retired |-> {"A"}, revision |-> 1, serial |-> 1,
             expectedSerial |-> 1, closed |-> TRUE, adopted |-> FALSE,
             bClosed |-> FALSE, frameDelivered |-> FALSE,
             reads |-> [i \in 1..2 |-> [phase |-> "empty", revision |-> 0, item |-> "none"]],
             closes |-> [i \in 1..2 |-> [phase |-> IF i = 1 THEN "pending" ELSE "empty",
                                           serial |-> IF i = 1 THEN 1 ELSE 0,
                                           token |-> IF i = 1 THEN "A" ELSE "none"]] ]

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/open.rs:293-363
CheckReopen ==
  /\ Mode = "join" /\ s.phase = "check"
  /\ s' = [s EXCEPT !.phase = IF Eligible /\ ~RejectJoin THEN "spawn" ELSE "refused"]

\* @code src/main/tab-spawn.ts:137-163
AttachExisting ==
  /\ Mode = "join" /\ s.phase = "spawn"
  /\ s' = [s EXCEPT !.phase = "classify", !.actual = TRUE,
                    !.executions = s.executions]

\* @code src/main/agent-control/host.ts:885-914
\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/open.rs:412-445
ClassifyAttached ==
  /\ Mode = "join" /\ s.phase = "classify"
  /\ LET joined == s.actual IN
       s' = [s EXCEPT !.phase = "setup", !.joined = joined,
                      !.custody = IF joined THEN @ ELSE "caller"]

\* @code native/ompdesk/crates/core/src/agentctl/service/sessions/open.rs:435-481
SetupResult(ok) ==
  /\ Mode = "join" /\ s.phase = "setup" /\ ok \in BOOLEAN
  /\ s' = [s EXCEPT !.phase = IF ok THEN "done" ELSE "failed",
                    !.alive = IF ok \/ s.joined THEN @ ELSE FALSE]

\* @code src/renderer/stores/tabs.ts:981-994
\* @code src/renderer/stores/tabs.ts:775-803
AdoptB ==
  /\ Mode \in {"list", "close", "frame"} /\ ~s.adopted
  /\ s' = [s EXCEPT !.view = "B", !.rendererRuntime = "B", !.work = "busy",
                    !.retired = @ \cup {"A"}, !.revision = @ + 1,
                    !.closed = FALSE, !.adopted = TRUE]

\* @code src/renderer/stores/tabs.ts:733-747
\* @code src/renderer/stores/tabs.ts:1305-1311
BeginRead(i, item) ==
  /\ Mode = "list" /\ i \in 1..2 /\ s.reads[i].phase = "empty"
  /\ item \in IF s.adopted THEN {"B"} ELSE {"none", "A"}
  /\ s' = [s EXCEPT !.reads[i] = [phase |-> "waiting", revision |-> s.revision, item |-> item]]

\* @code src/renderer/stores/tabs.ts:741-755
\* @code src/renderer/stores/tabs.ts:1305-1327
FinishRead(i) ==
  /\ Mode = "list" /\ i \in 1..2 /\ s.reads[i].phase = "waiting"
  /\ LET remove == s.reads[i].item \in {"none", "A"} /\ s.reads[i].revision = s.revision
         revive == s.reads[i].item = "A" /\ "A" \notin s.retired
     IN s' = [s EXCEPT !.reads[i].phase = "done",
                       !.view = IF revive THEN "A" ELSE IF remove THEN "none" ELSE @,
                       !.rendererRuntime = IF revive THEN "A" ELSE IF remove THEN "none" ELSE @]

\* @code src/renderer/stores/tab-actions.ts:69-97
CloseB ==
  /\ Mode = "close" /\ s.view = "B" /\ s.closes[2].phase = "empty"
  /\ s' = [s EXCEPT !.serial = @ + 1, !.expectedSerial = @ + 1,
                    !.closed = TRUE, !.view = "none", !.bClosed = TRUE,
                    !.retired = @ \cup {"B"}, !.revision = @ + 1,
                    !.closes[2] = [phase |-> "pending", serial |-> s.serial + 1, token |-> "B"]]

\* @code src/renderer/stores/tab-actions.ts:95-120
CloseAck(i) ==
  /\ Mode = "close" /\ i \in 1..2 /\ s.closes[i].phase = "pending"
  /\ LET current == s.closed /\ s.serial = s.closes[i].serial /\ s.rendererRuntime = s.closes[i].token IN
       s' = [s EXCEPT !.closes[i].phase = "done",
                      !.rendererRuntime = IF current THEN "none" ELSE @]

\* @code src/renderer/stores/tab-actions.ts:95-105
\* @code src/renderer/stores/tabs.ts:248-257
RollbackStart(i) ==
  /\ Mode = "close" /\ i \in 1..2 /\ s.closes[i].phase = "pending"
  /\ s.closed /\ s.serial = s.closes[i].serial /\ s.rendererRuntime = s.closes[i].token
  /\ s' = [s EXCEPT !.closes[i].phase = "rollbackWait",
                    !.closed = FALSE, !.retired = @ \ {s.closes[i].token}]

\* @code src/renderer/stores/tab-actions.ts:105-110
RollbackFinish(i) ==
  /\ Mode = "close" /\ i \in 1..2 /\ s.closes[i].phase = "rollbackWait"
  /\ LET valid == s.serial = s.closes[i].serial /\ s.view = "none"
     IN s' = [s EXCEPT !.closes[i].phase = "failed",
                       !.serial = IF valid THEN @ + 1 ELSE @,
                       !.expectedSerial = IF s.serial = s.closes[i].serial /\ s.view = "none"
                                          THEN @ + 1 ELSE @,
                       !.closed = IF valid THEN TRUE ELSE @,
                       !.retired = IF valid THEN @ \cup {s.closes[i].token} ELSE @,
                       !.revision = IF valid THEN @ + 1 ELSE @,
                       !.rendererRuntime = IF valid THEN "none" ELSE @]

\* @code src/renderer/hooks/use-rpc-events.ts:156-160
\* @code src/renderer/hooks/use-rpc-events.ts:813-816
\* @code src/renderer/stores/tabs.ts:274-279
OldStartingFrame(token) ==
  /\ Mode = "frame" /\ s.adopted /\ ~s.frameDelivered
  /\ token \in {"A", "none"}
  /\ LET frameToken == token IN
       s' = [s EXCEPT !.frameDelivered = TRUE,
                      !.work = IF frameToken = s.view THEN "starting" ELSE @]

Next == CheckReopen \/ AttachExisting \/ ClassifyAttached
        \/ (\E ok \in BOOLEAN: SetupResult(ok)) \/ AdoptB
        \/ (\E i \in 1..2, item \in {"none", "A", "B"}: BeginRead(i, item))
        \/ (\E i \in 1..2: FinishRead(i) \/ CloseAck(i) \/ RollbackStart(i) \/ RollbackFinish(i))
        \/ CloseB \/ (\E token \in {"A", "none"}: OldStartingFrame(token))
Spec == Init /\ [][Next]_s

\* BEGIN FROZEN PROPERTIES
JoinSafety == /\ s.custody = "original" /\ s.permission = "original"
              /\ s.saved /\ s.alive
              /\ (s.phase = "refused" => ~Eligible)
              /\ (s.phase \in {"spawn", "classify", "setup", "done", "failed"} => Eligible)
              /\ (s.phase \in {"setup", "done", "failed"} => s.actual /\ s.joined)
RuntimeSafety == s.executions = 1
ViewSafety == (s.adopted /\ ~s.bClosed) => (s.view = "B" /\ s.rendererRuntime = "B")
SerialSafety == s.serial = s.expectedSerial
WorkSafety == (s.adopted /\ ~s.bClosed) => s.work = "busy"
\* END FROZEN PROPERTIES
=============================================================================
