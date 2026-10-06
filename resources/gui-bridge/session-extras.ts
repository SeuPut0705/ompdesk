/**
 * Session side methods that need omp's own machinery: Claude/Codex session
 * import (stock foreign-session stores), journal-wide usage totals, and
 * slash-command argument completions. Spread into `sessions.ts`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createForeignSessionStore,
	persistForeignSession,
} from "@oh-my-pi/pi-coding-agent/session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "@oh-my-pi/pi-coding-agent/session/foreign-session-store";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { directoryExists, getMCPConfigPath, isEexist, withFileLock } from "@oh-my-pi/pi-utils";
import { requireFn } from "./capabilities";
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

// /mcp subcommands taking a server name; stock keeps these private (slash-commands/builtin-completions.ts).
const MCP_SERVER_NAME_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	test: true,
	remove: true,
	reconnect: true,
	reauth: true,
	unauth: true,
};
const MCP_DISABLED_ONLY_ELIGIBLE: Readonly<Record<string, true>> = { enable: true, disable: true };
const MCP_DISABLED_CONFIG_ELIGIBLE: Readonly<Record<string, true>> = { enable: true, disable: true, unauth: true };

interface ArgCompletionItem {
	value: string;
	label?: string;
	description?: string;
	hint?: string;
}

/** collectMcpServerNames without the TUI context: user/project config plus the live MCPManager. */
async function mcpServerNames(cwd: string, includeDisabledOnly: boolean, includeDisabledConfigured: boolean) {
	const [userConfig, projectConfig] = await Promise.all([
		readMCPConfigFile(getMCPConfigPath("user", cwd)),
		readMCPConfigFile(getMCPConfigPath("project", cwd)),
	]);
	const names = new Set<string>(includeDisabledOnly ? (userConfig.disabledServers ?? []) : []);
	const addConfigured = (config: MCPConfigFile) => {
		for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
			if (server && (includeDisabledConfigured || server.enabled !== false)) names.add(name);
		}
	};
	addConfigured(userConfig);
	addConfigured(projectConfig);
	for (const name of MCPManager.instance()?.getAllServerNames() ?? []) names.add(name);
	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** `/mcp remove` only succeeds against config entries; user-only names get `--scope user` appended. */
async function mcpRemoveCompletions(rawSubcommand: string, namePrefix: string, cwd: string) {
	const [projectConfig, userConfig] = await Promise.all([
		readMCPConfigFile(getMCPConfigPath("project", cwd)),
		readMCPConfigFile(getMCPConfigPath("user", cwd)),
	]);
	const projectNames = new Set(Object.keys(projectConfig.mcpServers ?? {}));
	const allNames = new Set([...projectNames, ...Object.keys(userConfig.mcpServers ?? {})]);
	return [...allNames]
		.filter(name => name.toLowerCase().startsWith(namePrefix))
		.map(name =>
			projectNames.has(name)
				? { value: `${rawSubcommand} ${name} `, label: name }
				: { value: `${rawSubcommand} ${name} --scope user `, label: `${name} (user)` },
		)
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

async function argCompletions(cwd: string, commandName: string, prefix: string): Promise<ArgCompletionItem[] | null> {
	const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(
		command => command.name === commandName || command.aliases?.includes(commandName),
	);
	if (!spec) return null;
	if (spec.subcommands) {
		if (spec.name !== "mcp") return buildArgumentCompletions(spec.subcommands)(prefix);
		const spaceIndex = prefix.indexOf(" ");
		if (spaceIndex === -1) return buildArgumentCompletions(spec.subcommands)(prefix);
		const rawSubcommand = prefix.slice(0, spaceIndex);
		const subcommand = rawSubcommand.toLowerCase();
		if (MCP_SERVER_NAME_SUBCOMMANDS[subcommand] !== true) return null;
		const namePrefix = prefix.slice(spaceIndex + 1).toLowerCase();
		const matches =
			subcommand === "remove"
				? await mcpRemoveCompletions(rawSubcommand, namePrefix, cwd)
				: (
						await mcpServerNames(
							cwd,
							MCP_DISABLED_ONLY_ELIGIBLE[subcommand] === true,
							MCP_DISABLED_CONFIG_ELIGIBLE[subcommand] === true,
						)
					)
						.filter(name => name.toLowerCase().startsWith(namePrefix))
						.map(name => ({ value: `${rawSubcommand} ${name} `, label: name }));
		return matches.length > 0 ? matches : null;
	}
	if (spec.name === "move") return await buildDirectoryArgumentCompletions()(prefix);
	return null;
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
			const info = (await store.list()).find(candidate => candidate.id === foreignId || candidate.path === foreignId);
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

	/** Usage totals across the whole live journal (pre-compaction history and sibling branches included). */
	"sessions.usage_history": async (_params, env) => {
		const manager = env.session().sessionManager;
		requireFn(manager, "getUsageStatistics", "usage", "SessionManager");
		return { ...manager.getUsageStatistics(), sampledAt: Date.now() };
	},

	/** `{cwd, command, prefix}` → argument candidates for a builtin slash command, or `[]`. */
	"sessions.arg_completions": async params => {
		const cwd = param(params, "cwd");
		const command = param(params, "command");
		const prefix = param(params, "prefix");
		if (typeof cwd !== "string" || typeof command !== "string" || typeof prefix !== "string") {
			throw new Error("arg_completions requires string cwd, command, prefix");
		}
		return { items: (await argCompletions(cwd, command, prefix)) ?? [] };
	},
};
