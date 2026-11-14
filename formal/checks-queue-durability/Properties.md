# Properties (frozen)

Frozen for the queue persistence fix. Definitions are between the frozen-property banners in `tla/ChecksQueueDurability.tla`.

| Property | Promise | Source |
|---|---|---|
| `AckDurable` | An acknowledgement follows a save of the enqueue transition. Version 2 represents a later terminal state, not a saved entry. | `rule://check-control`, merge queue runner: enqueue answers once the step that queued the entry is saved. |
| `EffectsDurable` | The lane starts an effect only after saving the transition that returned it. | `rule://check-control`, merge queue runner: the lane is saved after every step and starts again from the save. The assignment explicitly requires effects after their transition. |
| `NoLostTell` | A saved terminal transition retains its Tell until the destination durably accepts it. | `rule://check-control`, merge queue runner: Tell ends the entry's waits and wakes its session. The assignment requires replay after a crash. |
| `NoOverlappingOwners` | A reopened lane cannot act while the previous lane's canceled candidate is still running. | `rule://check-control`, merge queue runner: a closed and reopened hub never leaves two lanes on one base. |
| `ReceiptCoversReplay` | An accepted result keeps its destination receipt while a saved Tell can replay. | Main's receipt-retention contract: retrying Tell must not wake the session twice. |

`NeverAck` and `NeverEffect` are reachability checks expected to fail. `TypeOK` checks the finite state shape.
