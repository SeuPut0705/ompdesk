# Scope: queue lane durability

The model covers one lane and one entry, with an enqueue transition and a terminal transition. `mem` and `disk` are abstract versions 0, 1, and 2. Version 2 represents a terminal state and does not assert that the entry is still stored there. An effect at version 1 represents build, test, or land. An effect at version 2 represents Tell or Drop. The test of this property on real git is `a_failed_save_blocks_the_reply_and_candidate_until_the_same_entry_is_saved` in `queue_run_tests.rs`.

A failed save leaves the old file and can retain the attempted bytes for an ENOSPC retry. Stop, reopening, deferred writes, and a new synchronous save are separate steps. No fairness or liveness claim is made. The model has not been parsed or run.

The model assumes destination acceptance is durable and idempotent. It represents a stopped lane's candidate or Tell delivery draining before the same-process owner can reopen. It does not cover filesystem power-loss durability, exact effect payloads, external subprocesses surviving a process crash, or two computers. `write_kept` serializes its own retries with newer saves. The terminal effect abstracts both Tell and Drop, so the model does not check their relative order. It makes no fairness or eventual-delivery claim.
