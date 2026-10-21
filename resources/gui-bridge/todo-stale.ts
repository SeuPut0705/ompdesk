/**
 * A todo list left from earlier work (rules and text: todo-stale-core.ts). At the start of a turn a new request
 * opens, the main agent gets one hidden custom message naming that list and what to do. A message, not a
 * system-prompt section: a section that comes and goes changes the prompt in front of the whole conversation, so the
 * provider's prompt cache would miss twice; a message after the prompt costs only its own few tokens. Stock's journal
 * readers (`tools/todo`) give the list and the entry holding it; the reminder is journaled, which is how the rule
 * knows a list was named already.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries, getLatestTodoSnapshotIdentity } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { guard } from "./health";
import { autopilotRunning } from "./modes/autopilot-core";
import { staleTodoMessage, type TodoStaleEntry, todoStaleness } from "./todo-stale-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
		if (!session?.getActiveToolNames().includes("todo") || session.getPlanModeState()?.enabled) return undefined;
		const branch = ctx.sessionManager.getBranch();
		if (autopilotRunning(branch)) return undefined;
		const stale = todoStaleness({
			branch: branch as readonly TodoStaleEntry[],
			snapshotId: getLatestTodoSnapshotIdentity(branch)?.sourceEntryId,
			phases: getLatestTodoPhasesFromEntries(branch),
			prompt: event.prompt,
		});
		if (!stale) return undefined;
		pi.logger.debug("gui-bridge: stale todo list named", { kind: stale.kind, done: stale.done, total: stale.total });
		return { message: staleTodoMessage(stale) };
	});
}

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("todoStale", {});
