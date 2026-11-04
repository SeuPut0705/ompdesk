/**
 * A quit while a tool runs journals the tool's aborted result before the process ends, whatever else listens to
 * `tool_result` (rules: `.omp/rules/interrupted-work.md` › Quit during a tool).
 *
 * Stock's dispose records `session_exit` (with the unfinished calls), emits `session_shutdown`, and only then aborts
 * the agent loop; the aborted call's result is journaled by the unwinding loop while the exit already runs. Each
 * `tool_result` handler on the way costs that unwind a few turns of the event loop (stock awaits the handler runner
 * once any extension subscribes, whatever the handler returns), and from the second subscriber on the exit won in
 * every run: the journal ended on the assistant's tool call. The relaunch's restore then read a different tail than
 * before. The shutdown handler here aborts the loop itself, as dispose does a moment later, and holds dispose until
 * every started call's result message has been emitted (bounded), so the journaled tail no longer depends on how
 * many handlers sit on that path.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { createPendingToolCalls } from "./quit-journal-core";

/** Longer than a tool needs to see its abort and return; a tool that ignores the abort does not hold the quit past it. */
export const QUIT_TOOL_SETTLE_MS = 1_500;

/**
 * The one tool the quit leaves as stock does. A `wait` cut by a quit stays pending in the journal (its result never
 * reaches it, before and after v0.110.0), and stock's restore runs it again; with its aborted result and the aborted
 * reply journaled the restore reads the turn as ended and the parent is told by a follow-up instead
 * (`bridge-restore-subagents-stock.test.ts`: "while the parent waited on it", red 10 of 10 with the hold on `wait`).
 */
const LEFT_PENDING_TOOL = "wait";

/** The live registry as omp's package index reaches it: a session's agent loop by its agent id. */
interface RegistryApi {
	pi: {
		AgentRegistry: {
			global(): { get(id: unknown): { session?: { agent?: { abort?: () => void } } } | undefined };
		};
	};
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	const calls = createPendingToolCalls();
	pi.on("tool_execution_start", event => {
		if (event.toolName !== LEFT_PENDING_TOOL) calls.start(event.toolCallId);
	});
	pi.on("message_end", event => {
		if (event.message.role === "toolResult") calls.settle(event.message.toolCallId);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (calls.size === 0) return;
		const agent = (pi as unknown as RegistryApi).pi.AgentRegistry.global().get(ctx.agent.id)?.session?.agent;
		if (typeof agent?.abort !== "function") return;
		agent.abort();
		const settled = await calls.settled(QUIT_TOOL_SETTLE_MS);
		if (!settled) pi.logger.debug("gui-bridge: a tool call did not return before the quit's wait ended");
	});
}

export const methods = guard("quitJournal", {});
