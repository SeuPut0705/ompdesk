/**
 * MCP server management for the GUI: listing with live connection state,
 * enable/disable/reconnect/remove, add, connection test, and OAuth reauth.
 *
 * Stock omp's headless `/mcp` only edits config files (no reconnect, no
 * reauth, no live tool rebind), so these drive the process-global MCPManager
 * the way the TUI's MCPCommandController does. Ported from the omp-gui fork's
 * rpc-domains / rpc-actions / rpc-mcp-extra, with the stock controller's
 * reload and reauth details (mcp-command-controller.ts in omp 18.6).
 */
import * as path from "node:path";
import {
	isForeignUserProvider,
	isProviderEnabled,
	isUserSourceEnabled,
	loadCapability,
} from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { connectToServer, disconnectServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { loadAllMCPConfigs, validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import {
	addMCPServer,
	readMCPConfigFile,
	removeMCPServer,
	setMcpServerEnabled,
	updateMCPServer,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	hasMcpAuthorizationHeader,
	lookupMcpOAuthCredential,
	lookupMcpOAuthCredentialForServer,
	removeManagedMcpOAuthCredential,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import {
	MCPOAuthFlow,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPServerConfig, MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { applyMcpToggleRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component } from "@oh-my-pi/pi-tui";
import { inferMcpTransport } from "@oh-my-pi/pi-tui/overlays/extensions/mcp-runtime";
import { getMCPConfigPath, Snowflake } from "@oh-my-pi/pi-utils";
import { guard } from "../health";
import type { BridgeEnv, BridgeMethods } from "../types";
import type { McpSyncResult } from "./mcp-contracts";
import { adoptedEntry, authStateOf, offReasonOf } from "./mcp-core";
import { OAUTH_PASTE_PROMPT } from "./oauth-contracts";
import { errorMessage, optScope, optString, paramsOf, requireString } from "./shared";

const MCP_TEST_TIMEOUT_MS = 30_000;
const MCP_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout?: () => void): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, createError: () => Error): Promise<T> {
	if (signal.aborted) return Promise.reject(createError());
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	return entries.every(([, item]) => typeof item === "string") ? Object.fromEntries(entries) : undefined;
}

/** Map the GUI wizard's config form (`RpcMcpServerInput`) onto the on-disk MCPServerConfig shape. */
function inputToServerConfig(raw: unknown): MCPServerConfig {
	const input = paramsOf(raw);
	const timeout = typeof input.timeoutMs === "number" ? { timeout: input.timeoutMs } : {};
	switch (input.transport) {
		case "stdio": {
			const args = stringList(input.args);
			const env = stringRecord(input.env);
			return {
				type: "stdio",
				command: optString(input, "command") ?? "",
				...(args ? { args } : {}),
				...(env ? { env } : {}),
				...timeout,
			};
		}
		case "http":
		case "sse": {
			const headers = stringRecord(input.headers);
			return {
				type: input.transport,
				url: optString(input, "url") ?? "",
				...(headers ? { headers } : {}),
				...timeout,
			};
		}
		default:
			throw new Error(`Unsupported transport: ${String(input.transport)}`);
	}
}

/**
 * Serializes every shared-MCPManager mutation started from the GUI: a reauth
 * reload interleaving with add/remove would drop in-flight connections
 * unclosed and double-connect discoveries. Config writes and the browser
 * OAuth step stay outside, so a cancel can overtake a login.
 */
let mcpReloadChain: Promise<void> = Promise.resolve();
export function serializeMcpReload<T>(reload: () => Promise<T>): Promise<T> {
	const result = mcpReloadChain.then(reload, reload);
	mcpReloadChain = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/**
 * MCPCommandController.reloadServers: full rediscovery with startup's filters, then a tool rebind. A server that
 * fails to connect (a 401 asking for a sign-in, one offline) is no failure of the reload: stock's TUI shows it as a
 * warning after the reload ran, and the config change or credential that led here is already saved. The warning
 * text is returned and the server's state stays readable in the list (`lastError`, `authState`).
 */
function reloadMcpServers(session: AgentSession): Promise<string | undefined> {
	return serializeMcpReload(async () => {
		const manager = MCPManager.instance();
		if (!manager) throw new Error("MCP manager not available.");
		let warning: string | undefined;
		// reloadServers reads only these context members; its only output is the connection-error warning.
		const context = {
			mcpManager: manager,
			session,
			settings: session.settings,
			presentCommandOutput: (output: Component): void => {
				warning = output.render(120).join("\n").trim();
			},
		} as InteractiveModeContext;
		await new MCPCommandController(context).reloadServers();
		return warning;
	});
}

/**
 * The last connect failure of each server, as stock keeps them (`MCPManager.waitForStartup`'s `failed`, the TUI's
 * status line source): an RPC host shows none, so a server that answered 401 with an OAuth challenge read as
 * "disconnected" with no reason. A 1 ms bound: never waits on a server still connecting.
 */
async function connectFailures(manager: MCPManager | undefined): Promise<Map<string, string>> {
	if (!manager) return new Map();
	const status = await manager.waitForStartup(1);
	return new Map(status.failed.map(failure => [failure.name, failure.error]));
}

/** Stock's own reading of an auth failure (`/mcp add` and the TUI reconnect start OAuth on it). */
function challenged(failure: string | undefined, url: string | undefined): boolean {
	return failure !== undefined && analyzeAuthError(new Error(failure), url).requiresAuth;
}

/** Union of user config, project config, disabled markers and runtime-discovered servers (`/mcp list`). */
async function listMcpServers(session: AgentSession) {
	const failures = await connectFailures(MCPManager.instance());
	const cwd = session.sessionManager.getCwd();
	const manager = MCPManager.instance();
	const enableProjectConfig = cfgMcpEnableProjectConfig.get(session.settings);
	const [userConfig, projectConfig, inventory, active] = await Promise.all([
		readMCPConfigFile(getMCPConfigPath("user", cwd)),
		readMCPConfigFile(getMCPConfigPath("project", cwd)),
		loadCapability<MCPServer>("mcps", {
			cwd,
			agentDir: session.settings.getAgentDir(),
			includeDisabled: true,
			extensionRoots: session.effectiveExtensionRoots,
		}),
		loadAllMCPConfigs(cwd, {
			enableProjectConfig,
			filterExa: false,
			extensionRoots: session.effectiveExtensionRoots,
		}),
	]);
	// Stock's dashboard uses all rows, including equivalent aliases. The GUI
	// has one row per name; keep stock's priority-ordered first occurrence.
	const configured = new Map<string, MCPServer>();
	// A foreign tool's user config declaring a name omp's own config also declares (an adopted copy).
	const foreignAlso = new Map<string, string>();
	for (const server of inventory.all) {
		if (!configured.has(server.name)) configured.set(server.name, server);
		else if (server._source.level === "user" && isForeignUserProvider(server._source.provider))
			foreignAlso.set(server.name, server._source.providerName);
	}
	const disabledNames = new Set(userConfig.disabledServers ?? []);
	const forcedNames = new Set(userConfig.enabledServers ?? []);
	const names = new Set([...configured.keys(), ...disabledNames, ...(manager?.getAllServerNames() ?? [])]);

	const authStorage = session.modelRegistry.authStorage;
	const tools = manager?.getTools() ?? [];
	const servers = [...names].map(name => {
		const server = configured.get(name);
		const config =
			active.configs[name] ??
			(server
				? ({ ...server, type: inferMcpTransport(server) } as MCPServerConfig)
				: manager?.getServerConfig(name));
		const scope = projectConfig.mcpServers?.[name] ? "project" : userConfig.mcpServers?.[name] ? "user" : undefined;
		const credential = config ? lookupMcpOAuthCredential(authStorage, config) : undefined;
		const headerAuth = config ? hasMcpAuthorizationHeader(config) : false;
		const url = config && "url" in config ? config.url : undefined;
		const authState = authStateOf({
			configured: config !== undefined,
			credential: credential ? { valid: credential.credential.expires > Date.now() } : undefined,
			headerAuth,
			declaresOAuth: config?.auth?.type === "oauth" || config?.oauth !== undefined,
			challenged: challenged(failures.get(name), url),
		});
		const enabled = Object.hasOwn(active.configs, name);
		const source = server?._source;
		const offReason = offReasonOf({
			active: enabled,
			denied: disabledNames.has(name),
			sourceDisabled: server?.enabled === false,
			forced: forcedNames.has(name),
			ownConfig: scope !== undefined,
			source: source && {
				provider: source.provider,
				providerName: source.providerName,
				level: source.level,
				origin: source.origin,
			},
			providerEnabled: source ? isProviderEnabled(source.provider) : true,
			userSourceEnabled: source ? isUserSourceEnabled(source.provider) : true,
			projectConfigEnabled: enableProjectConfig,
		});
		const lastError = failures.get(name);
		const alsoIn = scope !== undefined ? foreignAlso.get(name) : undefined;
		return {
			name,
			transport: config?.type ?? (config ? "stdio" : "unknown"),
			status: manager?.getConnectionStatus(name) ?? "disconnected",
			toolCount: tools.filter(tool => tool.mcpServerName === name).length,
			enabled,
			authed: credential !== undefined || headerAuth,
			...(name === "rea" &&
			process.env.OMP_GUI_REA_ROOT &&
			server?._source.path === path.join(process.env.OMP_GUI_REA_ROOT, ".mcp.json")
				? { builtin: "rea" as const }
				: {}),
			...(scope !== undefined ? { scope } : {}),
			...(config && "command" in config && config.command ? { command: config.command } : {}),
			...(url ? { url } : {}),
			authState,
			...(offReason ? { offReason } : {}),
			...(alsoIn ? { alsoIn } : {}),
			...(lastError ? { lastError } : {}),
		};
	});
	servers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	return servers;
}

async function mcpAction(session: AgentSession, name: string, action: unknown, scope: "user" | "project" | undefined) {
	if (!name.trim()) throw new Error("Server name cannot be empty");
	const cwd = session.sessionManager.getCwd();
	const manager = MCPManager.instance();
	switch (action) {
		case "adopt":
			return await adoptServer(session, name);
		case "enable":
		case "disable": {
			const enabled = action === "enable";
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);
			const known =
				projectConfig.mcpServers?.[name] ??
				userConfig.mcpServers?.[name] ??
				manager?.getSource(name) ??
				userConfig.disabledServers?.includes(name);
			if (!known && !(await listMcpServers(session)).some(server => server.name === name)) {
				throw new Error(`Server "${name}" not found.`);
			}
			if (!manager) throw new Error("MCP manager not available.");
			await setMcpServerEnabled({ userPath, projectPath, name, enabled });
			await serializeMcpReload(() =>
				applyMcpToggleRuntime({
					name,
					enabled,
					cwd,
					manager,
					session,
					discovery: {
						enableProjectConfig: cfgMcpEnableProjectConfig.get(session.settings),
						filterExa: true,
						filterBrowser: session.getEvalPreludes().some(definition => definition.name === "browser"),
						extensionRoots: session.effectiveExtensionRoots,
					},
				}),
			);
			return { name, action, status: manager?.getConnectionStatus(name) ?? "disconnected" };
		}
		case "reconnect": {
			if (!manager) throw new Error("MCP manager not available.");
			const connection = await serializeMcpReload(async () => {
				const reconnected = await manager.reconnectServer(name, { manual: true });
				if (reconnected) await session.refreshMCPTools(manager.getTools());
				return reconnected;
			});
			if (!connection) throw new Error(`Failed to reconnect to "${name}". Check server status and logs.`);
			return { name, action, status: manager.getConnectionStatus(name) };
		}
		case "remove": {
			const target = scope ?? "project";
			const filePath = getMCPConfigPath(target, cwd);
			if (!(await readMCPConfigFile(filePath)).mcpServers?.[name]) {
				throw new Error(`Server "${name}" not found in ${target} config.`);
			}
			await removeMCPServer(filePath, name);
			await reloadMcpServers(session);
			return { name, action };
		}
		default:
			throw new Error(`Unknown MCP action: ${String(action)}`);
	}
}

/** Startup's discovery filters (sdk.ts, `/mcp reload`, `/mcp enable`). */
function startupDiscovery(session: AgentSession) {
	return {
		enableProjectConfig: cfgMcpEnableProjectConfig.get(session.settings),
		filterExa: true,
		filterBrowser: session.getEvalPreludes().some(definition => definition.name === "browser"),
		extensionRoots: session.effectiveExtensionRoots,
	};
}

/**
 * Use one server another tool's user config declares (~/.codex/config.toml, ~/.claude.json, …) without opting that
 * tool's whole `~/` config in. Stock's dashboard has only the provider-wide opt-in (`enabledProviders`), which
 * also brings the tool's other servers, skills and rules; stock's `enabledServers` allowlist overrides an
 * `enabled: false` but not a foreign source that is not opted in (`isUserSourceEnabled`). So the server's
 * definition, as stock discovered it, is written into omp's own user mcp.json with stock's writer, and connected.
 */
async function adoptServer(session: AgentSession, name: string) {
	const cwd = session.sessionManager.getCwd();
	const inventory = await loadCapability<MCPServer>("mcps", {
		cwd,
		agentDir: session.settings.getAgentDir(),
		includeDisabled: true,
		extensionRoots: session.effectiveExtensionRoots,
	});
	const foreign = inventory.all.find(
		server =>
			server.name === name &&
			server._source.level === "user" &&
			isForeignUserProvider(server._source.provider) &&
			!isUserSourceEnabled(server._source.provider),
	);
	if (!foreign) throw new Error(`Server "${name}" is not declared only in another tool's config.`);
	const userPath = getMCPConfigPath("user", cwd);
	const entry = adoptedEntry(foreign as unknown as Record<string, unknown>, inferMcpTransport(foreign), process.env);
	await addMCPServer(userPath, name, entry as unknown as MCPServerConfig);
	const result = await syncMcpServers(session, [name]);
	const manager = MCPManager.instance();
	return {
		name,
		action: "adopt" as const,
		from: foreign._source.providerName,
		status: manager?.getConnectionStatus(name) ?? "disconnected",
		...(result.failed.includes(name)
			? { error: (await connectFailures(manager)).get(name) ?? "connect failed" }
			: {}),
	};
}

/**
 * Bring this session's MCP connections to what the configuration and credentials on disk say now, for the named
 * servers (all known and configured ones when `names` is omitted). Another omp changed them: an add, remove,
 * enable or disable in another tab, an adopted server, a sign-in whose credential another process wrote. A server
 * no longer configured is disconnected; one configured but not connected (never was, or failed for want of a
 * sign-in) is connected; one connected with a config that changed is connected again; one connected with the same
 * config is left alone, so the tab that made the change does nothing twice. Stock's `/mcp reload` would drop and
 * reconnect every server of the session; this touches only what moved.
 */
async function syncMcpServers(session: AgentSession, names?: readonly string[]): Promise<McpSyncResult> {
	const manager = MCPManager.instance();
	const result: McpSyncResult = { connected: [], disconnected: [], unchanged: [], failed: [] };
	if (!manager) return result;
	// Another process wrote the files and the credential row: stock caches both per process.
	clearFsCache();
	await session.modelRegistry.authStorage.credentials.reload();
	return serializeMcpReload(async () => {
		const { configs, sources } = await loadAllMCPConfigs(session.sessionManager.getCwd(), startupDiscovery(session));
		const known = new Set(manager.getAllServerNames());
		const targets = names ?? [...new Set([...known, ...Object.keys(configs)])];
		const connect: Record<string, MCPServerConfig> = {};
		for (const name of targets) {
			const config = configs[name];
			const status = manager.getConnectionStatus(name);
			if (!config) {
				if (known.has(name) || status !== "disconnected") {
					await manager.disconnectServer(name);
					result.disconnected.push(name);
				} else result.unchanged.push(name);
				continue;
			}
			if (status === "connecting") {
				result.unchanged.push(name);
				continue;
			}
			if (status === "connected") {
				if (Bun.deepEquals(manager.getServerConfig(name), config)) {
					result.unchanged.push(name);
					continue;
				}
				await manager.disconnectServer(name);
			}
			connect[name] = config;
		}
		const connecting = Object.keys(connect);
		if (connecting.length > 0) {
			await manager.connectServers(
				connect,
				Object.fromEntries(connecting.flatMap(name => (sources[name] ? [[name, sources[name]]] : []))),
			);
			for (const name of connecting) {
				(manager.getConnectionStatus(name) === "disconnected" ? result.failed : result.connected).push(name);
			}
		}
		if (connecting.length > 0 || result.disconnected.length > 0) await session.refreshMCPTools(manager.getTools());
		return result;
	});
}

/** `/mcp test` lookup: project shadows user, disabled servers are invisible. */
async function findTestTarget(cwd: string, name: string): Promise<MCPServerConfig | undefined> {
	const [userConfig, projectConfig] = await Promise.all([
		readMCPConfigFile(getMCPConfigPath("user", cwd)),
		readMCPConfigFile(getMCPConfigPath("project", cwd)),
	]);
	const projectHit = projectConfig.mcpServers?.[name];
	if (projectHit && projectHit.enabled !== false) return projectHit;
	const userHit = userConfig.mcpServers?.[name];
	if (userHit && userHit.enabled !== false) return userHit;
	return undefined;
}

/** Probe with a THROWAWAY manager so the shared connection pool is never touched. */
async function probeServer(session: AgentSession, probeName: string, config: MCPServerConfig, signal: AbortSignal) {
	let connection: MCPServerConnection | undefined;
	try {
		const manager = new MCPManager(session.sessionManager.getCwd());
		manager.setAuthStorage(session.modelRegistry.authStorage);
		const resolved = await manager.prepareConfig(config);
		connection = await connectToServer(probeName, resolved, { signal });
		const tools = await listTools(connection, { signal });
		return { ok: true, toolNames: tools.map(tool => tool.name), toolCount: tools.length };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	} finally {
		if (connection) await disconnectServer(connection).catch(() => {});
	}
}

// ── OAuth reauth ────────────────────────────────────────────────────────────
// Kept: stock MCPCommandController.#handleReauth is private and constructs
// terminal OAuth UI. MCPOAuthFlow supplies the engine; this adapts RPC
// open_url/input, cancellation and timeout without fake terminal widgets.

class OAuthCancelledError extends Error {
	constructor() {
		super("OAuth flow cancelled");
		this.name = "OAuthCancelledError";
	}
}

/** One reauth per omp process (not a queue): a concurrent claim is refused as busy. */
let activeReauth: { name: string; abort: AbortController } | undefined;

/** Writable user/project configs first, then the project-root `mcp.json` / `.mcp.json` fallbacks. */
async function findConfiguredServer(cwd: string, name: string) {
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);
	const [userConfig, projectConfig] = await Promise.all([readMCPConfigFile(userPath), readMCPConfigFile(projectPath)]);
	const userHit = userConfig.mcpServers?.[name];
	if (userHit) return { filePath: userPath, config: userHit };
	const projectHit = projectConfig.mcpServers?.[name];
	if (projectHit) return { filePath: projectPath, config: projectHit };
	for (const standalone of [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")]) {
		const config = (await readMCPConfigFile(standalone).catch(() => null))?.mcpServers?.[name];
		if (config) return { filePath: standalone, config };
	}
	return null;
}

/** Also accepts runtime-discovered servers; their changes persist into the user config under the same name. */
async function resolveServerForAuth(cwd: string, name: string) {
	const found = await findConfiguredServer(cwd, name);
	if (found) return found;
	const manager = MCPManager.instance();
	const config = manager?.getServerConfig(name);
	if (!config || !manager?.getSource(name)) return null;
	return { filePath: getMCPConfigPath("user", cwd), config };
}

function stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const { auth: _auth, ...rest } = config;
	return rest;
}

async function testConnection(session: AgentSession, config: MCPServerConfig, oauth: boolean): Promise<void> {
	let manager = MCPManager.instance();
	if (!manager) {
		manager = new MCPManager(session.sessionManager.getCwd());
		manager.setAuthStorage(session.modelRegistry.authStorage);
	}
	const resolved = await manager.prepareConfig(config, { oauth });
	await disconnectServer(await connectToServer(`test_${Date.now()}`, resolved));
}

async function resolveOAuthEndpoints(session: AgentSession, config: MCPServerConfig): Promise<OAuthEndpoints> {
	// Stdio servers manage credentials in the child process; OMP's OAuth covers http/sse only.
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new Error(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
				: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
		);
	}
	let connectionError: Error | undefined;
	try {
		await testConnection(session, stripOAuthAuth(config), false);
	} catch (error) {
		connectionError = error instanceof Error ? error : new Error(String(error));
	}
	if (!connectionError) {
		// A clean `initialize` is weak evidence: honor the explicit reauth when the server advertises OAuth.
		const discovered = config.url ? await discoverOAuthEndpoints(config.url) : null;
		if (!discovered) throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		return discovered;
	}
	const authResult = analyzeAuthError(connectionError, config.url);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
	if (!oauth && config.url) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}
	if (!oauth) throw new Error("Could not discover OAuth endpoints from server response.");
	return oauth;
}

interface OAuthFlowOptions {
	authUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	callbackPort?: number;
	callbackPath?: string;
	redirectUri?: string;
	prompt?: string;
	registrationUrl?: string;
	issuerUrl?: string;
	serverUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	signal: AbortSignal;
}

/**
 * MCPCommandController.#handleOAuthFlow with GUI plumbing: the browser URL
 * rides an `extension_ui_request` `open_url` frame (what stock `login` emits),
 * progress rides `notify`, and the manual code paste-back rides the session's
 * `input` dialog. Cancellation through `signal` is neutral, never a failure.
 */
async function runOAuthFlow(session: AgentSession, env: BridgeEnv, opts: OAuthFlowOptions) {
	let parsedAuthUrl: URL;
	try {
		parsedAuthUrl = new URL(opts.authUrl);
		new URL(opts.tokenUrl);
	} catch {
		throw new Error(
			`Invalid OAuth URLs. Please check:\n  Authorization URL: ${opts.authUrl}\n  Token URL: ${opts.tokenUrl}`,
		);
	}
	const resolvedClientId = opts.clientId.trim() || parsedAuthUrl.searchParams.get("client_id")?.trim() || undefined;
	const resolvedClientSecret = opts.clientSecret.trim() || undefined;
	const ui = env.context().ui;

	const oauthTimeout = new AbortController();
	let cancelled = false;
	const onCancel = (): void => {
		cancelled = true;
		if (!oauthTimeout.signal.aborted) oauthTimeout.abort("MCP OAuth flow cancelled");
	};
	if (opts.signal.aborted) onCancel();
	else opts.signal.addEventListener("abort", onCancel, { once: true });
	let manualInput: Promise<string> | undefined;
	try {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: opts.authUrl,
				tokenUrl: opts.tokenUrl,
				registrationUrl: opts.registrationUrl,
				issuerUrl: opts.issuerUrl,
				clientId: resolvedClientId,
				clientSecret: resolvedClientSecret,
				scopes: opts.scopes || undefined,
				prompt: opts.prompt,
				redirectUri: opts.redirectUri,
				callbackPort: opts.callbackPort,
				callbackPath: opts.callbackPath,
				resource: opts.resource,
				stripSameOriginResource: opts.stripSameOriginResource,
			},
			{
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					env.emit({
						type: "extension_ui_request",
						id: Snowflake.next() as string,
						method: "open_url",
						url: info.url,
						launchUrl: info.launchUrl,
						instructions: info.instructions,
					});
				},
				onProgress: (message: string) => ui.notify(message, "info"),
				onManualCodeInput: () => {
					if (!manualInput) {
						manualInput = ui
							.input("MCP OAuth authorization", OAUTH_PASTE_PROMPT, {
								signal: oauthTimeout.signal,
							})
							.then(value => {
								// Dismissing the dialog is a user cancel, like the TUI's Esc.
								if (value === undefined) {
									onCancel();
									throw new OAuthCancelledError();
								}
								return value;
							});
						// The flow may settle without ever awaiting the paste-back.
						manualInput.catch(() => {});
					}
					return manualInput;
				},
				signal: oauthTimeout.signal,
			},
		);
		const createAbortError = (): Error =>
			cancelled
				? new OAuthCancelledError()
				: new Error(String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted"));
		const credentials = await withTimeout(
			raceAbortSignal(flow.login(), oauthTimeout.signal, createAbortError),
			MCP_OAUTH_TIMEOUT_MS,
			"OAuth flow timed out after 5 minutes",
			() => oauthTimeout.abort("MCP OAuth flow timed out"),
		);

		// Deterministic per-URL id keeps shared project configs profile-isolated.
		const credentialId = opts.serverUrl
			? mcpOAuthCredentialId(opts.serverUrl)
			: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
		const stored: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: opts.tokenUrl,
			clientId: flow.resolvedClientId?.trim() || resolvedClientId,
			clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};
		await session.modelRegistry.authStorage.credentials.set(credentialId, stored);
		return { credentialId, clientId: flow.resolvedClientId, resource: flow.resource };
	} catch (error) {
		if (cancelled || error instanceof OAuthCancelledError) throw new OAuthCancelledError();
		const message = errorMessage(error);
		if (message.includes("timeout") || message.includes("timed out")) {
			throw new Error("OAuth flow timed out. Please try again.");
		}
		if (message.includes("403") || message.includes("unauthorized")) {
			throw new Error("OAuth authorization failed. Please check your client credentials.");
		}
		if (message.includes("invalid_grant")) {
			throw new Error("OAuth authorization code is invalid or expired. Please try again.");
		}
		if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
			throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
		}
		throw new Error(`OAuth authentication failed: ${message}`);
	} finally {
		opts.signal.removeEventListener("abort", onCancel);
		// Dismiss a still-open paste-back dialog.
		if (!oauthTimeout.signal.aborted) oauthTimeout.abort("MCP OAuth flow finished");
	}
}

/** MCPCommandController.#handleReauth: endpoints, OAuth, credential + config persistence, reload. */
async function runReauth(session: AgentSession, env: BridgeEnv, name: string, signal: AbortSignal): Promise<void> {
	const cwd = session.sessionManager.getCwd();
	const found = await resolveServerForAuth(cwd, name);
	if (!found) throw new Error(`Server "${name}" not found.`);
	if (found.config.enabled === false) throw new Error(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);

	const authStorage = session.modelRegistry.authStorage;
	const currentAuth = found.config.auth;
	const baseConfig = stripOAuthAuth(found.config);
	// Runtime values are env-expanded; the file keeps its raw `${…}` placeholders.
	const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
	const oauth = await resolveOAuthEndpoints(session, runtimeBaseConfig);
	const serverUrl =
		runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;
	const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
	const configuredClientId = runtimeBaseConfig.oauth?.clientId?.trim() || undefined;
	const configuredClientSecret = runtimeBaseConfig.oauth?.clientSecret;
	const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
	const persistedClientId = runtimeAuth?.clientId?.trim() || undefined;
	const storedClientId = existingCredential?.clientId?.trim() || undefined;
	const discoveredClientId = oauth.clientId?.trim() || undefined;
	// A metadata-advertised client is only a fallback; prefer DCR when offered.
	const flowClientId =
		configuredClientId ??
		persistedClientId ??
		storedClientId ??
		(oauth.registrationUrl ? undefined : discoveredClientId) ??
		"";
	const storedClientSecret = storedClientId === flowClientId ? existingCredential?.clientSecret : undefined;
	const flowClientSecret =
		(configuredClientId === flowClientId ? configuredClientSecret : undefined) ??
		(persistedClientId === flowClientId ? runtimeAuth?.clientSecret : undefined) ??
		storedClientSecret ??
		"";
	const userClientSecret =
		(configuredClientId === flowClientId ? found.config.oauth?.clientSecret : undefined) ??
		(persistedClientId === flowClientId ? currentAuth?.clientSecret : undefined);
	const hasConfiguredOnlySecret = configuredClientId === undefined && configuredClientSecret !== undefined;
	const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
	const oauthResource =
		oauth.resource ?? currentAuthResource ?? ("url" in runtimeBaseConfig ? runtimeBaseConfig.url : undefined);
	const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

	const result = await runOAuthFlow(session, env, {
		authUrl: oauth.authorizationUrl,
		tokenUrl: oauth.tokenUrl,
		clientId: flowClientId,
		clientSecret: flowClientSecret,
		scopes: oauth.scopes || runtimeBaseConfig.oauth?.scope || "",
		callbackPort: found.config.oauth?.callbackPort,
		callbackPath: found.config.oauth?.callbackPath,
		redirectUri: found.config.oauth?.redirectUri,
		prompt: found.config.oauth?.prompt,
		registrationUrl: oauth.registrationUrl,
		issuerUrl: oauth.issuerUrl,
		serverUrl,
		resource: oauthResource,
		stripSameOriginResource: oauthResourceIsFallback,
		signal,
	});

	// GC a superseded legacy pointer row only after success, so a cancel keeps the old login.
	if (currentAuth?.type === "oauth" && currentAuth.credentialId !== result.credentialId) {
		await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
	}
	// Definition-only entries resolve through the url-keyed binding alone; keep a committed mcp.json clean.
	const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
	if (currentAuth || result.credentialId !== urlKeyedId) {
		const clientId = result.clientId?.trim() || oauth.clientId?.trim() || baseConfig.oauth?.clientId?.trim();
		const resource =
			result.resource ?? (oauthResourceIsFallback ? undefined : oauthResource) ?? baseConfig.auth?.resource;
		await updateMCPServer(found.filePath, name, {
			...baseConfig,
			auth: {
				type: "oauth",
				credentialId: result.credentialId,
				tokenUrl: oauth.tokenUrl,
				clientId,
				clientSecret: userClientSecret,
				resource,
			},
			// A configured-only secret must not become a persisted client pair.
			oauth: { ...baseConfig.oauth, clientId: hasConfiguredOnlySecret ? undefined : clientId },
		});
	}
	await reloadMcpServers(session);
}

export const methods: BridgeMethods = guard("mcp", {
	get_mcp_servers: async (_params, env) => ({ servers: await listMcpServers(env.session()) }),

	mcp_action: async (params, env) => {
		const p = paramsOf(params);
		return await mcpAction(env.session(), requireString(p, "name"), p.action, optScope(p));
	},

	mcp_add: async (params, env) => {
		const p = paramsOf(params);
		const name = requireString(p, "name");
		if (!name.trim()) throw new Error("Server name cannot be empty");
		const session = env.session();
		const filePath = getMCPConfigPath(optScope(p) ?? "project", session.sessionManager.getCwd());
		await addMCPServer(filePath, name, inputToServerConfig(p.config));
		// A server that does not connect (needs a sign-in, offline) was still added: its row says why.
		const warning = await reloadMcpServers(session);
		const server = (await listMcpServers(session)).find(entry => entry.name === name);
		if (!server) throw new Error(`Server "${name}" was added but is not visible in the refreshed server list.`);
		return { added: true, server, ...(warning ? { warning } : {}) };
	},

	/** Never throws: every outcome rides `{ ok, error }`. */
	mcp_test: async (params, env) => {
		const p = paramsOf(params);
		const name = typeof p.name === "string" ? p.name : undefined;
		if ((name === undefined) === (p.config === undefined)) {
			return {
				ok: false,
				error: "Provide exactly one of `name` (configured server) or `config` (inline definition).",
			};
		}
		const session = env.session();
		let config: MCPServerConfig;
		let probeName: string;
		try {
			if (name !== undefined) {
				const found = await findTestTarget(session.sessionManager.getCwd(), name);
				if (!found) return { ok: false, error: `Server "${name}" not found.` };
				config = found;
				probeName = name;
			} else {
				config = inputToServerConfig(p.config);
				const errors = validateServerConfig("test", config);
				if (errors.length > 0) return { ok: false, error: `Invalid server config: ${errors.join("; ")}` };
				probeName = `mcp_test_${Date.now()}`;
			}
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
		const timeout = new AbortController();
		return await withTimeout(
			probeServer(session, probeName, config, timeout.signal),
			MCP_TEST_TIMEOUT_MS,
			`Connection test timed out after ${MCP_TEST_TIMEOUT_MS / 1000} seconds`,
			() => timeout.abort("MCP connection test timed out"),
		).catch(error => ({ ok: false, error: errorMessage(error) }));
	},

	/**
	 * Resolves after login + persist + reload. `{ busy }` reports a reauth
	 * already in flight (the GUI maps it to `oauth_busy`); a user cancel is
	 * `{ ok: false, error: "cancelled" }`.
	 */
	mcp_reauth: async (params, env) => {
		const name = requireString(paramsOf(params), "name");
		if (!name.trim()) throw new Error("Server name cannot be empty");
		if (activeReauth) return { busy: activeReauth.name };
		const abort = new AbortController();
		activeReauth = { name, abort };
		try {
			await runReauth(env.session(), env, name, abort.signal);
			return { ok: true };
		} catch (error) {
			if (error instanceof OAuthCancelledError) return { ok: false, error: "cancelled" };
			return { ok: false, error: errorMessage(error) };
		} finally {
			if (activeReauth?.abort === abort) activeReauth = undefined;
		}
	},

	mcp_reauth_cancel: async params => {
		const name = requireString(paramsOf(params), "name");
		if (!activeReauth || activeReauth.name !== name) return { cancelled: false };
		activeReauth.abort.abort("Reauthorization cancelled by user");
		return { cancelled: true };
	},

	/**
	 * Follow MCP changes another tab or process made (main sends it to every live tab after one tab changed the
	 * configuration or signed in): `names` the servers that changed, none for all of them.
	 */
	mcp_sync: async (params, env) => {
		const raw = paramsOf(params).names;
		if (raw !== undefined && !(Array.isArray(raw) && raw.every(name => typeof name === "string" && name !== "")))
			throw new Error("names must be a list of server names");
		return await syncMcpServers(env.session(), raw as string[] | undefined);
	},

	/** `/mcp reload` for the GUI: stock's full rediscovery of this session (MCPCommandController.reloadServers). */
	mcp_reload: async (_params, env) => {
		clearFsCache();
		await env.session().modelRegistry.authStorage.credentials.reload();
		const warning = await reloadMcpServers(env.session());
		return { servers: await listMcpServers(env.session()), ...(warning ? { warning } : {}) };
	},
});
