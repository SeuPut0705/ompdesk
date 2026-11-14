-------------------------- MODULE Schedules --------------------------
EXTENDS Naturals, TLC
CONSTANTS MaxGeneration, FenceReservation, FenceLaunch, DedupStart, RefundAbort, FenceSource
VARIABLES generation, reservedAt, phase, launches, quota, staleStarted,
          sourceGeneration, readAt, reading, stalePublished
vars == <<generation, reservedAt, phase, launches, quota, staleStarted,
          sourceGeneration, readAt, reading, stalePublished>>

Init == /\ generation = 0 /\ reservedAt = 0 /\ phase = "idle"
        /\ launches = 0 /\ quota = "none" /\ staleStarted = FALSE
        /\ sourceGeneration = 0 /\ readAt = 0 /\ reading = FALSE /\ stalePublished = FALSE

\* @code native/ompdesk/crates/core/src/schedules/engine.rs:683-704 reserve
Reserve == /\ phase = "idle" /\ phase' = "reserve" /\ reservedAt' = generation
           /\ quota' = "reserved"
           /\ UNCHANGED <<generation, launches, staleStarted, sourceGeneration, readAt, reading, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/engine.rs:450-469 pause/disable invalidation
Invalidate == /\ generation < MaxGeneration /\ generation' = generation + 1
              /\ UNCHANGED <<reservedAt, phase, launches, quota, staleStarted, sourceGeneration, readAt, reading, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/engine.rs:767-792 reservation completion
Reserved == /\ phase = "reserve"
            /\ IF FenceReservation /\ reservedAt # generation
                  THEN /\ phase' = "done" /\ quota' = IF RefundAbort THEN "refunded" ELSE quota
                  ELSE /\ phase' = "resolve" /\ UNCHANGED quota
            /\ UNCHANGED <<generation, reservedAt, launches, staleStarted, sourceGeneration, readAt, reading, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/application.rs:592-600 async runtime preparation
Resolve == /\ phase = "resolve" /\ phase' = "ready"
           /\ UNCHANGED <<generation, reservedAt, launches, quota, staleStarted, sourceGeneration, readAt, reading, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/application.rs:604-622 final commit under engine lock
Commit == /\ phase = "ready"
          /\ IF FenceLaunch /\ reservedAt # generation
                THEN /\ phase' = "done" /\ quota' = IF RefundAbort THEN "refunded" ELSE quota
                     /\ UNCHANGED <<launches, staleStarted>>
                ELSE /\ phase' = "running" /\ quota' = "spent" /\ launches' = launches + 1
                     /\ staleStarted' = staleStarted \/ (reservedAt # generation)
          /\ UNCHANGED <<generation, reservedAt, sourceGeneration, readAt, reading, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/application.rs:567-583 duplicate run-slot start suppression
DuplicateStart == /\ phase = "running" /\ launches < 2 /\ ~DedupStart
                  /\ launches' = launches + 1
                  /\ UNCHANGED <<generation, reservedAt, phase, quota, staleStarted, sourceGeneration, readAt, reading, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/application.rs:624-639 native run completion
Finish == /\ phase = "running" /\ phase' = "done"
          /\ UNCHANGED <<generation, reservedAt, launches, quota, staleStarted, sourceGeneration, readAt, reading, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/triggers.rs:110-155 source instance replacement
RetireSource == /\ sourceGeneration < MaxGeneration /\ sourceGeneration' = sourceGeneration + 1
                /\ UNCHANGED <<generation, reservedAt, phase, launches, quota, staleStarted, readAt, reading, stalePublished>>
ReadSource == /\ ~reading /\ reading' = TRUE /\ readAt' = sourceGeneration
              /\ UNCHANGED <<generation, reservedAt, phase, launches, quota, staleStarted, sourceGeneration, stalePublished>>

\* @code native/ompdesk/crates/core/src/schedules/application.rs:250-270 generation-fenced mark and fire
Publish == /\ reading /\ reading' = FALSE
           /\ stalePublished' = stalePublished \/ (~FenceSource /\ readAt # sourceGeneration)
           /\ UNCHANGED <<generation, reservedAt, phase, launches, quota, staleStarted, sourceGeneration, readAt>>

Next == Reserve \/ Invalidate \/ Reserved \/ Resolve \/ Commit \/ DuplicateStart \/ Finish \/ RetireSource \/ ReadSource \/ Publish
Spec == Init /\ [][Next]_vars

\* FROZEN PROPERTIES
NoStaleStart == ~staleStarted
AtMostOnce == launches <= 1
RefundUnstarted == (phase = "done" /\ launches = 0) => quota = "refunded"
NoStalePublish == ~stalePublished
\* END FROZEN PROPERTIES
NeverStarted == launches = 0
=============================================================================
