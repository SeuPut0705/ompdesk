/**
 * The ECC pack's project hint (Settings › Agent behavior › ECC; the pack in `resources/omp-builtin/ecc/`): one short
 * prompt section naming the hidden ECC skills that fit the session's folder, registered like the other OMPdesk
 * sections (../prompt-sections.ts) so the context inspector shows it too. The rules are in ./ecc-hint-core.ts (no omp
 * imports, so the GUI's vitest runs them).
 */
import { guard } from "../health";

export { install } from "./ecc-hint-core";

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("eccHint", {});
