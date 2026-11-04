/**
 * Guards against three measured wastes of agent sessions (rules and text: waste-guards-core.ts, `.omp/rules/waste-guards.md`).
 * A `bash` service start whose `ready.log` cannot match is refused before it runs (stock's public `tool_call` hook,
 * `block`). A poll (sleep then check, `gh run`, `pgrep`, `tail -f`, `read proc://`) and an `edit` the tool refused for
 * anchors or a tag the session never got each get one line, once per kind in this process, appended to the end of the
 * result through the public `tool_result` hook's `content` (stock lets a handler replace the result's content array,
 * a failed call's too; `details` and `isError` stay as they were). Nothing else is blocked or changed; `wait` is left alone.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { createHints, READY_LOG_REASON, readyLogCannotMatch } from "./waste-guards-core";

/** One per omp process: the main agent and every subagent rebinding this module share it. */
const hints = createHints();

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("tool_call", event => {
		if (event.toolName !== "bash" || !readyLogCannotMatch(event.input)) return undefined;
		pi.logger.debug("gui-bridge: bash with a ready.log that cannot match refused");
		return { block: true, reason: READY_LOG_REASON };
	});
	pi.on("tool_result", event => {
		const text = event.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		const hint = hints.note(event.toolName, event.input, { isError: event.isError, text });
		return hint === undefined ? undefined : { content: [...event.content, { type: "text", text: `\n${hint}` }] };
	});
}

/** Hooks only; they use the public extension API, so `capabilities` has nothing to check. */
export const methods = guard("wasteGuards", {});
