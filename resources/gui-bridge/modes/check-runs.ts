/**
 * Check runs (text: check-runs-core.ts): the per-turn section that sends heavy commands and test suites through the
 * `ompdesk` CLI's heavy slots and `ompdesk check`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import { CHECK_RUNS_SECTION, CHECK_RUNS_SECTION_ID } from "./check-runs-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerPromptSection(pi, CHECK_RUNS_SECTION_ID, () => CHECK_RUNS_SECTION);
}

/** Hook only. */
export const methods = guard("checkRuns", {});
