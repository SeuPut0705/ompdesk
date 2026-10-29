# Correspondence: checkout-claims

Sync commit: the `syncCommit` of `checkout-claims` in `formal/manifest.json` (the manifest wins if this file disagrees).

The `@code` tags in `tla/CheckoutClaims.tla` are the machine-checked half of this map.

## Map

| Model element | Code | Kind | Abstraction |
|---|---|---|---|
| `Start(o, k, runs)` | `checkout-claims.ts` `ClaimBook.begin` (from `CheckoutLedger.call`, the `tool_call` hook) | action | claims F with a fresh stamp, remembers the claim it took over; `runs = FALSE` is a call stock refused after the hook (denied approval) |
| `Land(id)` | the tool itself | environment | the bytes reach F; git lists it |
| `End(c, ok)` | `ClaimBook.end` (`tool_result`) | action | a failed file tool wrote nothing and reverts (`#revert`); anything else confirms (`#confirm`: the stamp moves on) |
| `AgentEnd(o)` | `ClaimBook.agentEnded` (`agent_end` of that agent's `pi`) | action | stock ends a run once its calls ran, so the calls left never ran |
| `BridgeRetire(m)` | `ClaimBook.retireFrom` / `retire` (`checkout_retire`) | action | drops F only for this load's stamp with no call writing; a running call that took over that claim reverts to none |
| `Restart` | `checkout-peers.ts` `install`: `session_shutdown` journals `ClaimBook.snapshot`, `session_start` calls `restore` | environment | a new instance, stamps from 1; running calls and undelivered retires are lost with the process |
| `Commit`, `BWrite` | a person or B | environment | git lists F or not |
| `PassStatus` | `checkout-peers.ts` `#statusOf` | action | fresh when A's bridge answers (requests are answered in order, so a retire sent before is handled first), else the remembered answer |
| `PassGit` | `#pass` → `gitStatus` | action | dirty, clean, or failed |
| `PassJudge`, `Verdict` | `#pass` loop → `judgeClaim` | action | one synchronous block after git answered; `committed` is `#committed` keyed by member, instance, file and stamp |
| `PassRetired` | `#retire` | action | the bridge's answer becomes main's remembered status; no answer in time keeps it |
| `PassSend` | `#send` → `checkout_peers_set` | action | B hears, or its bridge does not answer |

## Assumptions (each a place a bug could hide)

- A1: the bridge handles one request at a time, in order (stock's RPC loop). A status answered after a retire reflects it.
- A2: every call takes a stamp above every earlier one of the same load (`#seq` only grows; `restore` within one load keeps counting).
- A3: one file. Claims of different files are independent in `ClaimBook` and `judgeClaim`; `holds` (a folder, a path inside a submodule) is out of scope.
- A4: stock's `agent_end` for an agent comes after that agent's calls reported back.

## Mutations declared equivalent

`confirm-keeps-stamp` and `retire-while-writing`: with main's rule that a claim pending in this pass's answer is never judged, and a fresh stamp per call (A2), no retire can carry a stamp a running call holds. Both ledger checks stay as a second line; removing them is not a proven-safe simplification once a retire's read can predate the pending list (an older main).
