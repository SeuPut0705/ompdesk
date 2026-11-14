# Correspondence

Each `@code` tag names the code behind an action. `Enqueue` and `Complete` abstract queue transitions into versions 1 and 2. `memOut`, `diskOut`, and `keptOut` are the corresponding pending effects. Version 1 abstracts Build, Test, and Land. Version 2 abstracts Tell and Drop. `Effect` represents durable destination acceptance, and `TellDone` removes an accepted terminal effect from memory before a later save. `Ack` records the enqueue reply.

`SaveFull` and `DeferredSave` represent retained ENOSPC writes. `Save` represents a synchronous `write_kept` success that clears a retained write. The model permits an effect or acknowledgement immediately after a deferred write makes `disk = mem`; the implementation waits for its own synchronous save to return success. This is an overapproximation for the safety properties.

After a Tell is durably accepted, `TellDone` replaces it with a retirement request. The lane saves that request before `Retire` lets the host delete its receipt. `RetireDone` records that deletion; a restart can repeat it. The host's idempotence is assumed, not modeled.

`Stop` stops a lane. `Reopen` reloads the lane and outbox. The model keeps external acknowledgements and accepted effects across a reopen. It assumes the destination's acceptance is durable and idempotent; it does not prove the host journal or git implementation satisfies that assumption.
