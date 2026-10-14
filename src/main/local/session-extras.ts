/**
 * Session side commands answered GUI-side: foreign-session import, local
 * pastes, copy targets, slash-argument completions, session stats history.
 * Registered through `sessions.ts`.
 *
 * Foreign import, pastes, completions and journal totals run in the omp
 * process via the gui-bridge (`resources/gui-bridge/session-extras.ts`) so they
 * reuse omp's own importers, local:// root and builtin command registry.
 */
import { z } from "zod";
import type { SessionStats } from "../../shared/rpc-types";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

const foreignSource = z.enum(["claude", "codex"]);

/** Foreign-source failures carry the fork's `source_unavailable` code. */
async function foreignRequest(method: string, params: unknown, ctx: LocalCommandContext): Promise<unknown> {
	try {
		return await ctx.bridge.request(method, params);
	} catch (error) {
		throw new LocalCommandError(error instanceof Error ? error.message : String(error), "source_unavailable");
	}
}

export const handlers: Record<string, LocalHandler> = {
	list_foreign_sessions: async (command, ctx) =>
		foreignRequest("sessions.foreign_list", { source: foreignSource.parse(command.source) }, ctx),

	import_foreign_session: async (command, ctx) => {
		const { source, foreignId } = z.object({ source: foreignSource, foreignId: z.string().min(1) }).parse(command);
		return foreignRequest("sessions.foreign_import", { source, foreignId }, ctx);
	},

	write_local_paste: async (command, ctx) =>
		ctx.bridge.request("sessions.write_local_paste", { content: z.string().parse(command.content) }),

	resolve_local_url: async (command, ctx) =>
		ctx.bridge.request("sessions.resolve_local_url", {
			url: z
				.string()
				.regex(/^local:/i)
				.parse(command.url),
		}),

	get_copy_targets: async (_command, ctx) => ctx.bridge.request("composer.copy_targets"),

	get_last_link: async (_command, ctx) => ctx.bridge.request("composer.last_link"),

	get_command_arg_completions: async (command, ctx) => {
		const { command: name, prefix } = z.object({ command: z.string(), prefix: z.string() }).parse(command);
		return ctx.bridge.request("sessions.arg_completions", { cwd: ctx.cwd, command: name, prefix });
	},

	// Stock stats cover the active context; `history` adds whole-journal totals for the title bar and usage window.
	get_session_stats: async (_command, ctx) => {
		const [stats, history] = await Promise.all([
			ctx.send<SessionStats>({ type: "get_session_stats" }),
			ctx.bridge.request<SessionStats["history"]>("sessions.usage_history"),
		]);
		return { ...stats, history };
	},
};
