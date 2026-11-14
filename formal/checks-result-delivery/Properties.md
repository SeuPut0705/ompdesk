# Frozen properties

| Property | Promise | Source |
|---|---|---|
| `NoLossAfterPublication` | A published delivery remains the durable responsibility of source or receiver through crashes. | Main d49/d51/d52, source outbox until Disk acceptance. |
| `DiskBeforeAck` | No Memory receipt or error releases source ownership. | Main d51; `agentRuntime.enqueueMail` frozen Persistence contract. |
| `NoDuplicateReceiverAcceptance` | Replaying a stable namespaced phase ID creates at most one receiver journal responsibility. | Main d49/d52, stable receiver journal ID and idempotent replay. |
| `NoSendBeforePersistence` | The source does not publish its volatile-only notification. | Main d49, crash before/after source persistence. |

These are responsibility-transfer guarantees, not exactly-once transport or evidence that a model read the result.
