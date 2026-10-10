/**
 * Workspace directories (TUI /dirs /add-dir /remove-dir /move parity).
 *
 * Listing and add/remove run on the live SessionManager through the gui-bridge
 * (typed refusals, post-mutation list, no chat noise). `move_session` is stock
 * `/move`: it re-scopes process-global cwd state (project dir, settings,
 * memory backend, plugin caches) only omp itself can reach. `/move` reports
 * refusals as chat text, so the refusals the GUI can foresee are checked here
 * first and the outcome is read back from the session afterwards.
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { RpcWorkspaceDirectoriesResult } from "../../shared/rpc-types";
import { runSlashCommand } from "./slash";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

function requirePath(raw: unknown): string {
	if (typeof raw !== "string" || raw.trim().length === 0) throw new Error("path must be a non-empty string");
	// The slash line is one line; a newline would end the argument early.
	if (/[\r\n\0]/.test(raw)) throw new Error("path must not contain line breaks or NUL");
	return raw.trim();
}

function directories(ctx: LocalCommandContext): Promise<RpcWorkspaceDirectoriesResult> {
	return ctx.bridge.request<RpcWorkspaceDirectoriesResult>("workspace.directories");
}

export const handlers: Record<string, LocalHandler> = {
	get_directories: async (_command, ctx) => directories(ctx),

	add_directory: async (command, ctx) =>
		ctx.bridge.request<RpcWorkspaceDirectoriesResult>("workspace.add_directory", { path: requirePath(command.path) }),

	remove_directory: async (command, ctx) =>
		ctx.bridge.request<RpcWorkspaceDirectoriesResult>("workspace.remove_directory", {
			path: requirePath(command.path),
		}),

	move_session: async (command, ctx): Promise<{ cwd: string }> => {
		const raw = requirePath(command.path);
		const [state, before] = await Promise.all([
			ctx.send<{ isStreaming?: boolean }>({ type: "get_state" }),
			directories(ctx),
		]);
		if (state?.isStreaming) throw new LocalCommandError("Cannot move while streaming.", "busy");
		const previousCwd = before.directories.find(directory => directory.primary)?.path ?? ctx.cwd;
		const { path: target } = await ctx.bridge.request<{ path: string }>("workspace.resolve_path", { path: raw });
		let info: Stats;
		try {
			info = await stat(target);
		} catch {
			throw new Error(`Directory does not exist: ${target}`);
		}
		if (!info.isDirectory()) throw new Error(`Not a directory: ${target}`);

		await runSlashCommand(ctx, `/move ${target}`);
		const after = await directories(ctx);
		const cwd = after.directories.find(directory => directory.primary)?.path;
		if (!cwd) throw new Error("Move failed: the session reported no working directory");
		// `/move` explains its own refusals in the session output; here only the outcome is visible.
		if (cwd === previousCwd && path.resolve(target) !== previousCwd) {
			throw new Error(`Move failed: the session is still in ${previousCwd}`);
		}
		return { cwd };
	},
};
