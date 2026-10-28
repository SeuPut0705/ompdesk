/**
 * The formal-verification hint (see ./formal-hint-core.ts): one per-turn prompt section, added when the turn's
 * request is a race, ordering, retry or never-happens problem, so the agent reads `ompdesk-formal-verify` first.
 */
import { guard } from "../health";

export { install } from "./formal-hint-core";

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("formalHint", {});
