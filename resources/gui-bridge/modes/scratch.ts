/**
 * The session's scratch folder (text: scratch-core.ts): the per-turn section that tells the agent where its
 * throwaway files go. The folder is this omp's for its whole life, so the section is read once.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import { SCRATCH_ENV, SCRATCH_SECTION_ID, scratchSection } from "./scratch-core";

const section = scratchSection(process.env[SCRATCH_ENV]);

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerPromptSection(pi, SCRATCH_SECTION_ID, () => section);
}

/** Hook only. */
export const methods = guard("scratch", {});
