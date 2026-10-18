/**
 * pstack engineering mode (Settings › Agent behavior; the pack in `resources/omp-builtin/pstack/`): one always-on
 * system-prompt section, registered like the other OMPdesk sections (../prompt-sections.ts) so the context
 * inspector shows it too. The rules and the registration are in ./pstack-core.ts (no omp imports, so the GUI's
 * vitest runs them), the static texts in ./pstack-text.ts (generated from the pack by scripts/sync-pstack.ts).
 * index.ts calls `install` once per extension instance, main and every subagent rebinding; a subagent never gets the
 * section.
 */
import { guard } from "../health";

export { install } from "./pstack-core";

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("pstack", {});
