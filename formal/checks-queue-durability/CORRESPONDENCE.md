# Correspondence

Each `@code` tag names the code behind an action. `Enqueue` and `Complete` abstract queue transitions into versions 1 and 2. `memOut`, `diskOut`, and `keptOut` are the corresponding pending effects. Version 1 abstracts Build, Test, and Land. Version 2 abstracts Tell and Drop. `Effect` represents durable destination acceptance, and `TellDone` removes an accepted terminal effect from memory before a later save. `Ack` records the enqueue reply.

`SaveFull` and `DeferredSave` represent retained ENOSPC writes. `Save` represents the lane's own synchronous `write_kept` success, clearing a retained write and setting `ready`. Every transition and reopen clears `ready`; effects, enqueue ACK and receipt retirement require it. A deferred write merely making `disk = mem` cannot authorize them. The first runner trace omitted this real `Lane::after` boundary and therefore let a reopened lane act before its own save, then an older retained snapshot overwrite that action. The source always calls its synchronous save before those effects. This was a model correspondence error, not a reproduced product defect; no frozen protocol property changed.

After a Tell is durably accepted, `TellDone` replaces it with a retirement request. The lane saves that request before `Retire` lets the host delete its receipt. `RetireDone` records that deletion; a restart can repeat it. The host's idempotence is assumed, not modeled.

`Stop` stops a lane. `Reopen` reloads the lane and outbox. The model keeps external acknowledgements and accepted effects across a reopen. It assumes the destination's acceptance is durable and idempotent; it does not prove the host journal or git implementation satisfies that assumption.
