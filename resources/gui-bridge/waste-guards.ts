/**
 * Guards against four measured wastes of agent sessions (rules and text: waste-guards-core.ts, `.omp/rules/waste-guards.md`).
 * A `bash` service start whose `ready.log` cannot match is refused before it runs (stock's public `tool_call` hook,
 * `block`). A poll (sleep then check, `gh run`, `pgrep`, `tail -f`, `read proc://`) and an `edit` the tool refused for
 * anchors or a tag the session never got each get one line, once per kind in this process, appended to the end of the
 * result through the public `tool_result` hook's `content` (stock lets a handler replace the result's content array,
 * a failed call's too; `details` and `isError` stay as they were). `wait` is re-registered (public `registerTool` over a
 * built-in) to call stock's own `wait` (`ctx.invokeTool`) again whenever its window ran out with the jobs still running,
 * so it returns only with news.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import {
	createHints,
	READY_LOG_REASON,
	readyLogCannotMatch,
	WAIT_DESCRIPTION,
	waitWindowElapsed,
} from "./waste-guards-core";

/** One per omp process: the main agent and every subagent rebinding this module share it. */
const hints = createHints();

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerWait(pi);
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

/**
 * Stock's `wait` returns after a window (5 s up to 300 s) while every job it watches still runs, and the model is
 * asked again only to wait again. This `wait` calls stock's until it returns anything else: a job settled, a service
 * ended, a message or reply came, nothing was left to wait on, or the call was interrupted; stock keeps its own ladder,
 * delivery and interrupt handling. No limit of its own: the job's own timeout, a message (the tool is interruptible,
 * as stock's is) and the user's stop end it.
 */
function registerWait(pi: ExtensionAPI): void {
	const definition = {
		name: "wait",
		label: "Wait",
		description: WAIT_DESCRIPTION,
		parameters: pi.pi.z.object({}),
		strict: true,
		loadMode: "essential" as const,
		approval: "read" as const,
		// Not in `ToolDefinition`'s type; stock's adapter passes every key of the definition to the loop's tool, and
		// without them a queued message would no longer cut the wait short.
		interruptible: true,
		handlesToolInterrupt: true,
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const native = ctx.invokeTool;
			if (!native) throw new Error("This omp cannot run its own wait for OMPdesk (no ctx.invokeTool)");
			for (;;) {
				const result = await native(params, { signal, onUpdate });
				if (!waitWindowElapsed(result)) return result;
			}
		},
	};
	pi.registerTool(definition);
}

/** Hooks and a re-registered built-in only; they use the public extension API, so `capabilities` has nothing to check. */
export const methods = guard("wasteGuards", {});
