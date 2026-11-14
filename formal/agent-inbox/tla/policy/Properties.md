# Frozen native wake-policy properties

Frozen from Main d36/d37 before this additive model. The original InboxHop properties, actions, bounds, fairness and matrix stay unchanged. This module is safety-only: no fairness, liveness or symmetry claim.

| Property | Contract | Source |
| --- | --- | --- |
| RequestedIntentPreserved | An accepted explicit follow_up never becomes immediate. | d36; InboxLogicalMessage::validate |
| FirstDeliveryStable | A retry after a card closes preserves the first effective intent and dispatch, not its new proposal. | d36/d37; InboxLedger::keep/known |
| HistoricalProofCannotConsume | A well-formed different-incarnation receipt cannot mark an existing key consumed. | d37; InboxLedger::reconcile |
| MalformedProofCannotAffect | A malformed/wrong-envelope receipt list cannot advance admission or partially consume an earlier valid item in that list. | d37; all-receipts validation before mutation |
| ObservedReplayDoesNotWake | Replaying an already ContextObserved key cannot notify a second blocking wait. | d36; receiving wake selection |
| WakeRequiresDiskCardAndFirstImmediate | A notification requires this admission's Disk success, no current ask, and the first accepted effective immediate intent. | d36; Runtime::accept_inbox |
| HistoryDoesNotSuppressOrNotify | Well-formed history neither blocks a fresh batch nor independently causes a notification. | d37 |

Baseline bounds are two logical IDs, two admission attempts and one incarnation change. The second positive configuration keeps two IDs and permits three attempts/two incarnation changes. Ten negative modes and ten mutations are unexecuted kill hypotheses. A parse is not TLC, a counterexample, a mutation result or a stamp.
