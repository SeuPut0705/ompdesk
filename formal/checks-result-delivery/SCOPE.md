# Checks result responsibility transfer

The model follows one opaque key per hub instance, run and delivery phase. The matrix uses two keys, then four keys representing two hubs and two phases. Preparation, source persistence, send, receiver Disk/Memory/error outcomes, response loss, ACK and crashes are separate steps. No fairness or eventual delivery is assumed. Permanent storage or recipient failure can retain source responsibility indefinitely.

A receiver Disk entry abstracts its durable outbox or its stable bridge journal responsibility. The receiver implementation and its canonical recipient resolver are separate owners; this model is conditional on their frozen contract. It does not claim a model consumed a prompt, process-tree containment, filesystem crash durability beyond the atomic-write seam, unbounded key uniqueness, or correctness of session permissions. Actual source namespace collision/reopen tests and consumer lost-response tests establish the corresponding code edges.

No TLC, mutation or passing state count is claimed before runner verification. Local SANY is syntax/semantic parsing only.
