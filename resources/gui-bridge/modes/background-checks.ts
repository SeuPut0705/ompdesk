/**
 * Background checks (rules and text: background-checks-core.ts): the per-turn section that tells the agent to run
 * long checks as background jobs. Stock `async.enabled` is reached by id through `config/registry` `lookup` (a module
 * of the running omp's bundle), read from the process Settings on every prompt, so a Settings write applies from
 * the next turn.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import { autopilotRunning } from "./autopilot-core";
import { BACKGROUND_CHECKS_SECTION_ID, backgroundChecksSection } from "./background-checks-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerPromptSection(pi, BACKGROUND_CHECKS_SECTION_ID, ctx =>
		backgroundChecksSection({
			asyncEnabled: lookup("async.enabled")?.get(pi.pi.Settings.instance) === true,
			autopilot: autopilotRunning(ctx.sessionManager.getBranch()),
		}),
	);
}

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("backgroundChecks", {});
