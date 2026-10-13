/**
 * Session side methods that need omp's own machinery: Claude/Codex session
 * import (stock foreign-session stores), journal-wide usage totals, large pastes
 * in the session's local:// store, and slash-command argument completions.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	createForeignSessionStore,
	persistForeignSession,
} from "@oh-my-pi/pi-coding-agent/session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "@oh-my-pi/pi-coding-agent/session/foreign-session-store";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildMcpArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { directoryExists, getProjectDir, isEexist, withFileLock } from "@oh-my-pi/pi-utils";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

/** One field of the GUI's untyped params object. */
function param(params: unknown, key: string): unknown {
	return typeof params === "object" && params !== null && key in params ? params[key] : undefined;
}

function foreignSource(params: unknown): ForeignSessionSource {
	const source = param(params, "source");
	if (source !== "claude" && source !== "codex") {
		throw new Error(`Unsupported foreign session source: ${String(source)}. Expected "claude" or "codex".`);
	}
	return source;
}

function foreignToWire(info: ForeignSessionInfo) {
	return {
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		title: info.title,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

interface ArgCompletionItem {
	value: string;
	label?: string;
	description?: string;
	hint?: string;
}

/**
 * A builtin's argument candidates and editor inline hint for `prefix`, from
 * stock's materialized `BUILTIN_SLASH_COMMANDS` (the declarative subcommand,
 * directory and static-hint builders the TUI editor uses).
 */
async function argCompletions(
	cwd: string,
	commandName: string,
	prefix: string,
): Promise<{ items: ArgCompletionItem[]; hint: string | null }> {
	const command = BUILTIN_SLASH_COMMANDS.find(
		candidate => candidate.name === commandName || candidate.aliases?.includes(commandName),
	);
	if (!command) return { items: [], hint: null };
	const hint = command.getInlineHint?.(prefix) ?? null;
	if (command.name !== "mcp" || !command.subcommands) {
		return { items: (await command.getArgumentCompletions?.(prefix)) ?? [], hint };
	}
	// /mcp narrows its subcommands to configured servers, as the TUI does with
	// a live runtime. Stock completion disk reads use the live process project
	// directory. Main always requests this sidecar's cwd; reject other
	// directories instead of changing the process-global cwd during concurrent calls.
	if (path.resolve(cwd) !== path.resolve(getProjectDir())) {
		throw new Error("MCP completions require the live session project directory");
	}
	// The MCP builder reads only ctx.mcpManager, not terminal widgets.
	const runtime = { ctx: { mcpManager: MCPManager.instance() } } as TuiSlashCommandRuntime;
	return { items: (await buildMcpArgumentCompletions(command.subcommands, runtime)(prefix)) ?? [], hint };
}

export const methods: BridgeMethods = {
	...guard("sessionImport", {
		/** `{source}` → stock ForeignSessionStore listing, newest first, in the RpcForeignSessionInfo wire shape. */
		"sessions.foreign_list": async params => {
			const sessions = await createForeignSessionStore(foreignSource(params)).list();
			return { sessions: sessions.map(foreignToWire) };
		},

		/**
		 * `{source, foreignId}` → convert one foreign transcript into a new omp session file
		 * (source data untouched). The destination name is a digest of the source identity,
		 * so a retry or a second import of the unchanged source reuses the earlier copy.
		 */
		"sessions.foreign_import": async (params, env) => {
			const source = foreignSource(params);
			const foreignId = param(params, "foreignId");
			if (typeof foreignId !== "string" || !foreignId) throw new Error("import requires a foreignId");
			const store = createForeignSessionStore(source);
			const info = (await store.list()).find(
				candidate => candidate.id === foreignId || candidate.path === foreignId,
			);
			if (!info) throw new Error(`Foreign session not found: ${foreignId}`);
			const cwd = (await directoryExists(info.cwd)) ? info.cwd : env.session().sessionManager.getCwd();
			const sessionDir = SessionManager.getDefaultSessionDir(cwd);
			const digest = new Bun.CryptoHasher("sha256")
				.update(JSON.stringify([source, info.path, info.id, info.modified.toISOString()]))
				.digest("hex");
			const destination = path.join(sessionDir, `import_${digest}.jsonl`);
			await fs.mkdir(sessionDir, { recursive: true });
			return withFileLock(destination, async () => {
				if (await Bun.file(destination).exists()) {
					const header = (await loadSessionFile(destination)).entries.find(entry => entry.type === "session");
					if (header?.type !== "session") {
						throw new Error("The existing imported session cannot be read. Inspect it before retrying.");
					}
					return { sessionPath: destination, sessionId: header.id, cwd: header.cwd, reused: true };
				}
				// Stock persistCopy picks its own file name; move it to the stable destination.
				const imported = await persistForeignSession(store, info, {
					fallbackCwd: cwd,
					sessionDir,
					suppressBreadcrumb: true,
				});
				const written = imported.getSessionFile();
				if (!written) throw new Error("Import did not produce a session file");
				await fs.rename(written, destination);
				return { sessionPath: destination, sessionId: imported.getSessionId(), cwd: imported.getCwd() };
			});
		},
	}),

	/** Usage totals across the whole live journal (pre-compaction history and sibling branches included). */
	...guard("usage", {
		"sessions.usage_history": async (_params, env) => ({
			...env.session().sessionManager.getUsageStatistics(),
			sampledAt: Date.now(),
		}),
	}),

	...guard("composer", {
		/**
		 * `{content}` → write a large paste into the live session's local:// store (the read
		 * tool's own root). `wx` claims paste-N.md exclusively, so concurrent writers never collide.
		 */
		"sessions.write_local_paste": async (params, env) => {
			const content = param(params, "content");
			if (typeof content !== "string") throw new Error("write_local_paste requires string content");
			const manager = env.session().sessionManager;
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			});
			await fs.mkdir(localRoot, { recursive: true });
			for (let counter = 1; ; counter++) {
				const name = `paste-${counter}.md`;
				try {
					await fs.writeFile(path.join(localRoot, name), content, { encoding: "utf8", flag: "wx", mode: 0o600 });
					return { name, url: `local://${name}` };
				} catch (error) {
					if (!isEexist(error)) throw error;
				}
			}
		},

		/** `{cwd, command, prefix}` → a builtin slash command's argument candidates and inline hint. */
		"sessions.arg_completions": async params => {
			const cwd = param(params, "cwd");
			const command = param(params, "command");
			const prefix = param(params, "prefix");
			if (typeof cwd !== "string" || typeof command !== "string" || typeof prefix !== "string") {
				throw new Error("arg_completions requires string cwd, command, prefix");
			}
			return argCompletions(cwd, command, prefix);
		},
	}),
};
