/**
 * GUI-side command table: every command type the renderer sends that stock omp
 * does not implement. The sidecar's RpcClient consults `localHandlerFor` before
 * forwarding; a hit is answered here and never reaches omp.
 */
import type { RpcResponse } from "../../shared/rpc-types";
import { handlers as agentFiles } from "./agent-files";
import { handlers as autoMode } from "./auto-mode";
import { handlers as autoTitle } from "./auto-title";
import { handlers as composer } from "./composer";
import { handlers as extensions } from "./extensions";
import { handlers as git } from "./git";
import { handlers as misc } from "./misc";
import { handlers as modes } from "./modes";
import { handlers as nextPrompt } from "./next-prompt";
import { handlers as queue } from "./queue";
import { handlers as sessions } from "./sessions";
import { handlers as settings } from "./settings";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";
import { handlers as workspace } from "./workspace";

/** Merge the per-area tables; a command claimed by two areas is a startup error. */
export function mergeHandlers(areas: Record<string, Record<string, LocalHandler>>): Record<string, LocalHandler> {
	const merged: Record<string, LocalHandler> = {};
	for (const [area, table] of Object.entries(areas)) {
		for (const [type, handler] of Object.entries(table)) {
			if (Object.hasOwn(merged, type)) throw new Error(`Local RPC command "${type}" is defined twice (${area})`);
			merged[type] = handler;
		}
	}
	return merged;
}

const LOCAL_HANDLERS = mergeHandlers({
	sessions,
	autoTitle,
	autoMode,
	queue,
	composer,
	modes,
	nextPrompt,
	git,
	workspace,
	extensions,
	settings,
	agentFiles,
	misc,
});

export function localHandlerFor(type: string): LocalHandler | undefined {
	return Object.hasOwn(LOCAL_HANDLERS, type) ? LOCAL_HANDLERS[type] : undefined;
}

/** Run a handler and shape the outcome as the omp response frame the renderer expects. */
export async function runLocalCommand(
	handler: LocalHandler,
	command: { type: string; id: string; [k: string]: unknown },
	ctx: LocalCommandContext,
): Promise<RpcResponse> {
	try {
		const data = await handler(command, ctx);
		return { id: command.id, type: "response", command: command.type, success: true, data };
	} catch (err) {
		return {
			id: command.id,
			type: "response",
			command: command.type,
			success: false,
			error: err instanceof Error ? err.message : String(err),
			...(err instanceof LocalCommandError ? { code: err.code } : {}),
		};
	}
}
