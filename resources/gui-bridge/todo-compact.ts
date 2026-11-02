/**
 * A todo list that only grows (rules and text: todo-compact-core.ts). After a `todo` call that appended to a long
 * list, the agent reads one line asking it to fold the finished items. Stock's public `tool_result` hook with
 * `additionalContext`: the line goes into the next provider request of the same run, after the call, so the cached
 * prefix in front of it stays as it was; the tool result itself (the list the work board draws) is untouched.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { compactTodoText, type TodoCompactPhase, todoCompaction } from "./todo-compact-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("tool_result", event => {
		if (event.toolName !== "todo" || event.isError) return undefined;
		const details = event.details as { op?: unknown; phases?: unknown } | undefined;
		if (!Array.isArray(details?.phases)) return undefined;
		const long = todoCompaction(details.op, details.phases as TodoCompactPhase[]);
		if (!long) return undefined;
		pi.logger.debug("gui-bridge: long todo list asked to fold", { ...long });
		return { additionalContext: compactTodoText(long) };
	});
}

/** Hook only; it uses the public extension API, so `capabilities` has nothing to check. */
export const methods = guard("todoCompact", {});
