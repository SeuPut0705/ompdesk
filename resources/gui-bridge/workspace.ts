/**
 * Workspace directories (TUI /dirs /add-dir /remove-dir parity) straight on the
 * live SessionManager, so the GUI gets typed refusals and the post-mutation
 * list instead of `/add-dir`'s chat text. `/move` stays a stock slash command:
 * it re-scopes process-global cwd state the extension cannot reach.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { normalizeWorkspaceDirectory } from "@oh-my-pi/pi-coding-agent/session/session-workspace";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

interface WorkspaceDirectory {
	path: string;
	primary: boolean;
}

function directories(session: AgentSession): { directories: WorkspaceDirectory[] } {
	const manager = session.sessionManager;
	return {
		directories: [
			{ path: path.resolve(manager.getCwd()), primary: true },
			...manager.getAdditionalDirectories().map(directory => ({ path: directory, primary: false })),
		],
	};
}

function requirePath(params: unknown): string {
	const value = (params as { path?: unknown } | null)?.path;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("path must be a non-empty string");
	return value;
}

/** Refused while streaming, with the TUI's wording. */
function requireIdle(session: AgentSession, action: string): void {
	if (session.isStreaming) throw new Error(`Cannot ${action} while streaming.`);
}

async function requireExistingDirectory(resolved: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(resolved);
	} catch {
		throw new Error(`Directory does not exist: ${resolved}`);
	}
	if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
}

export const methods: BridgeMethods = guard("workspace", {
	"workspace.directories": async (_params, env) => directories(env.session()),

	"workspace.resolve_path": async (params, env) => {
		const raw = requirePath(params);
		if (/[\r\n\0]/.test(raw)) throw new Error("path must not contain line breaks or NUL");
		return { path: resolveToCwd(raw, env.session().sessionManager.getCwd()) };
	},

	/** Already-present paths are a no-op success; the cwd itself is refused by SessionManager. */
	"workspace.add_directory": async (params, env) => {
		const session = env.session();
		requireIdle(session, "add a directory");
		const manager = session.sessionManager;
		const resolved = normalizeWorkspaceDirectory(requirePath(params), manager.getCwd());
		await requireExistingDirectory(resolved);
		const added = await manager.addWorkspaceDirectory(resolved);
		if (added !== null) await session.refreshBaseSystemPrompt();
		return directories(session);
	},

	/** The primary (cwd) directory is refused with the TUI's /move pointer; unknown paths are a no-op success. */
	"workspace.remove_directory": async (params, env) => {
		const session = env.session();
		requireIdle(session, "remove a directory");
		const manager = session.sessionManager;
		const resolved = normalizeWorkspaceDirectory(requirePath(params), manager.getCwd());
		if (resolved === path.resolve(manager.getCwd())) {
			throw new Error("Cannot remove the working directory; use /move to change it.");
		}
		const removed = await manager.removeWorkspaceDirectory(resolved);
		if (removed !== null) await session.refreshBaseSystemPrompt();
		return directories(session);
	},
});
