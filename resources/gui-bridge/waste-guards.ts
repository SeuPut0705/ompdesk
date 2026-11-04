/**
 * Guards against two measured wastes of agent sessions (rules and text: waste-guards-core.ts, `.omp/rules/waste-guards.md`).
 * A `bash` service start whose `ready.log` cannot match is refused before it runs (stock's public `tool_call` hook,
 * `block`). A poll (sleep then check, `gh run`, `pgrep`, `tail -f`, `read proc://`) gets one line, once per kind in this
 * process, through the public `tool_result` hook's `additionalContext`: it goes into the next provider request of the
 * same run, after the call, so the cached prefix stays as it was and the tool result itself is untouched. Nothing else is
 * blocked or changed; `wait` is left alone.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { createPollHints, READY_LOG_REASON, readyLogCannotMatch } from "./waste-guards-core";

/** One per omp process: the main agent and every subagent rebinding this module share it. */
const pollHints = createPollHints();

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("tool_call", event => {
		if (event.toolName !== "bash" || !readyLogCannotMatch(event.input)) return undefined;
		pi.logger.debug("gui-bridge: bash with a ready.log that cannot match refused");
		return { block: true, reason: READY_LOG_REASON };
	});
	pi.on("tool_result", event => {
		const hint = pollHints.note(event.toolName, event.input);
		return hint === undefined ? undefined : { additionalContext: hint };
	});
}

/** Hooks only; they use the public extension API, so `capabilities` has nothing to check. */
export const methods = guard("wasteGuards", {});
