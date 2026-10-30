/**
 * REA behind the MCP hub (./mcp-hub.ts): one MCP session per omp, the whole REA server behind its two curated tools
 * plus `rea_catalog` / `rea_call`, and REA itself started at the first call that needs it.
 *
 * Stock has no server tool filter, so every session exposes `config.curatedTools` with their original descriptors and
 * the two meta tools; every upstream tool stays reachable through them. What a started REA answered omp's startup with
 * (initialize, the whole catalog, prompts/list) is kept in `<cache dir>/rea-<version>.json`, keyed by the pinned
 * version and omp's exact handshake; the hub reads it once and every session shares it. With it a session answers
 * `initialize`, `tools/list`, `prompts/list`, `ping` and `rea_catalog` itself and spawns REA at the first call that
 * needs it (a curated tool, `rea_call`, any other method): the same handshake and `initialized`, then the
 * notifications held since (none reaches REA before its handshake is answered; a call omp cancelled meanwhile never
 * reaches REA and is answered `-32800`), then a catalog check that announces `tools/list_changed` (and
 * `prompts/list_changed`) when REA's answers differ and rewrites the file. No file, an unreadable one, or another
 * handshake: REA starts with the session as before and the file is written once its catalog is read. A REA that cannot
 * start late answers the waiting calls with its error, deletes the file (the next session starts REA with its startup
 * and fails at connect, as without a cache) and ends the session after those answers went out.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import config from "../omp-builtin/rea/rea-config.json" with { type: "json" };

export type RpcId = string | number | null;
export type RpcMessage = Record<string, unknown> & { jsonrpc?: unknown; id?: RpcId; method?: unknown };
interface Tool extends Record<string, unknown> {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}
interface CacheEntry {
	version: string;
	client: string;
	initialize: Record<string, unknown>;
	tools: Tool[];
	prompts?: unknown;
}
interface RpcFailure extends Error {
	code?: number;
	data?: unknown;
}

const curated = new Set(config.curatedTools);
const metaTools = [
	{
		name: "rea_catalog",
		description:
			"Search the full REA tool catalog by keyword or target. Request a named tool's input schema before using rea_call.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Keywords or target, e.g. JavaScript, Android, native, process." },
				name: { type: "string", description: "Exact tool name whose input schema should be returned." },
			},
			additionalProperties: false,
		},
	},
	{
		name: "rea_call",
		description:
			"Invoke any REA tool by its exact catalog name with its original arguments. Discover its input schema with rea_catalog first.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
			required: ["name", "arguments"],
			additionalProperties: false,
		},
	},
];

export const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const isTool = (tool: unknown): tool is Tool =>
	object(tool) && typeof tool.name === "string" && object(tool.inputSchema);
export const rpcError = (code: number, message: string, data?: unknown): RpcFailure =>
	Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });

/** The startup cache file, read once per hub and shared by every session; a session that learns more rewrites it. */
export class ReaCacheStore {
	readonly #dir: string | undefined;
	#entry: CacheEntry | undefined;
	#tools: Map<string, Tool> | undefined;
	#read = false;

	constructor(dir: string | undefined) {
		this.#dir = dir || undefined;
	}

	get #file(): string {
		return join(this.#dir ?? "", `rea-${config.version}.json`);
	}

	/** The cached startup and its catalog by name, or undefined without a usable file. */
	get(): { entry: CacheEntry; tools: Map<string, Tool> } | undefined {
		if (!this.#read) {
			this.#read = true;
			this.#entry = this.#load();
			this.#tools = this.#entry ? new Map(this.#entry.tools.map(tool => [tool.name, tool])) : undefined;
		}
		return this.#entry && this.#tools ? { entry: this.#entry, tools: this.#tools } : undefined;
	}

	#load(): CacheEntry | undefined {
		if (!this.#dir) return undefined;
		try {
			const cached: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
			return object(cached) &&
				cached.version === config.version &&
				typeof cached.client === "string" &&
				object(cached.initialize) &&
				Array.isArray(cached.tools) &&
				cached.tools.every(isTool)
				? (cached as unknown as CacheEntry)
				: undefined;
		} catch {
			return undefined;
		}
	}

	/** Whether a cache file can be written at all (no dir: a session never records its startup). */
	get enabled(): boolean {
		return this.#dir !== undefined;
	}

	write(entry: CacheEntry): void {
		if (!this.#dir) return;
		const temp = `${this.#file}.${process.pid}.tmp`;
		try {
			mkdirSync(this.#dir, { recursive: true });
			writeFileSync(temp, JSON.stringify(entry));
			renameSync(temp, this.#file);
			this.#entry = entry;
			this.#tools = new Map(entry.tools.map(tool => [tool.name, tool]));
			this.#read = true;
		} catch {
			/* Unwritable (or a rename Windows refused): the next session starts REA with omp, as without a cache. */
			rmSync(temp, { force: true });
		}
	}

	forget(): void {
		this.#entry = undefined;
		this.#tools = undefined;
		this.#read = true;
		if (this.#dir) rmSync(this.#file, { force: true });
	}
}

export interface ReaSessionOptions {
	store: ReaCacheStore;
	command: string;
	args: string[];
	cwd: string | undefined;
	env: NodeJS.ProcessEnv;
	/** A message for omp: an answer to one of its requests, or REA's own notification or request. */
	send(message: RpcMessage): void;
	/** REA is gone (it exited, failed to start, spoke garbage): the hub ends the session; omp reconnects. */
	end(): void;
}

export interface ReaSession {
	/** One message from omp: a request (answered through `send`), a notification, or an answer to REA's request. */
	receive(message: unknown): void;
	/** REA's process is up (started and not yet closed). */
	readonly running: boolean;
	/** omp closed the session: stop REA and its descendants; resolves once REA's process is gone (at once without one). */
	close(): Promise<void>;
}

export function createReaSession(options: ReaSessionOptions): ReaSession {
	const { store, command, args, send } = options;
	const cached = store.get();
	let cache = cached?.entry;
	let child: ChildProcessWithoutNullStreams | undefined;
	let started: Promise<void> | undefined;
	/** REA has answered its handshake and had `initialized`: until then omp's notifications wait in `early`. */
	let ready = false;
	let clientInit: unknown;
	let initializedNotice: RpcMessage | undefined;
	const early: RpcMessage[] = [];
	/** Calls omp cancelled while REA was starting: they never reach REA. */
	const cancelledDuringStart = new Set<unknown>();
	const pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: RpcFailure) => void; clientId: RpcId | undefined }
	>();
	const clientRequests = new Map<RpcId, string>();
	const serverRequests = new Map<string, RpcId>();
	let sequence = 0;
	let tools = cached?.tools;
	let prompts = cache?.prompts;
	let initializeResult: Record<string, unknown> | undefined;
	let remembered = false;
	let catalogLoad: Promise<Map<string, Tool>> | undefined;
	let stopping = false;
	let ended = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;

	const toChild = (message: RpcMessage) => child?.stdin.write(`${JSON.stringify(message)}\n`);
	const request = (method: string, params: unknown, clientId?: RpcId) => {
		const id = `relay:${++sequence}`;
		if (clientId !== undefined) clientRequests.set(clientId, id);
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		pending.set(id, { resolve, reject, clientId });
		toChild({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
		return promise;
	};
	const finish = () => {
		if (ended) return;
		ended = true;
		options.end();
	};
	/** REA's process closed. */
	let closed = false;
	/** Settles once REA's process closed (or at `close` when none ever started). */
	const gone = Promise.withResolvers<void>();
	/** Record this REA's startup answers once its catalog is known; a changed prompt list is announced. */
	const remember = async () => {
		if (!store.enabled || !initializeResult || !tools) return;
		if (object(initializeResult.capabilities) && initializeResult.capabilities.prompts) {
			const fresh = await request("prompts/list", {});
			if (prompts !== undefined && JSON.stringify(fresh) !== JSON.stringify(prompts))
				send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
			prompts = fresh;
		}
		store.write({
			version: config.version,
			client: JSON.stringify(clientInit ?? null),
			initialize: initializeResult,
			tools: [...tools.values()],
			...(prompts === undefined ? {} : { prompts }),
		});
	};
	const loadCatalog = (): Promise<Map<string, Tool>> => {
		if (!catalogLoad) {
			catalogLoad = (async () => {
				const collected: Tool[] = [];
				let cursor: unknown;
				do {
					const page = await request("tools/list", cursor === undefined ? {} : { cursor });
					if (!object(page) || !Array.isArray(page.tools) || !page.tools.every(isTool)) {
						throw rpcError(-32603, "REA returned an invalid tool catalog");
					}
					collected.push(...page.tools);
					cursor = page.nextCursor;
				} while (typeof cursor === "string" && cursor.length > 0);
				const loaded = new Map(collected.map(tool => [tool.name, tool]));
				tools = loaded;
				if (!remembered) {
					remembered = true;
					remember().catch(() => {});
				}
				return loaded;
			})().finally(() => {
				catalogLoad = undefined;
			});
		}
		return catalogLoad;
	};
	const catalog = () => (tools ? Promise.resolve(tools) : loadCatalog());
	let changes: Promise<void> = Promise.resolve();

	function stop(): void {
		if (stopping) return;
		stopping = true;
		const own = child;
		// Never started: nothing to stop.
		if (!own) return;
		own.stdin.end();
		if (!own.pid) return;
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(own.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => own.kill());
			return;
		}
		try {
			process.kill(-own.pid, "SIGTERM");
		} catch {
			/* Already gone. */
		}
		killTimer = setTimeout(() => {
			try {
				process.kill(-(own.pid ?? 0), "SIGKILL");
			} catch {
				/* Already gone. */
			}
		}, 2000);
		killTimer.unref();
	}

	const spawnChild = () => {
		const own = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: options.cwd,
			env: options.env,
			detached: process.platform !== "win32",
			shell: process.platform === "win32" && command.endsWith(".cmd"),
			windowsHide: true,
		});
		child = own;
		own.stderr.pipe(process.stderr, { end: false });
		createInterface({ input: own.stdout }).on("line", line => {
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				stop();
				return;
			}
			if (!object(message) || message.jsonrpc !== "2.0") {
				stop();
				return;
			}
			if (typeof message.method === "string") {
				if (message.method === "notifications/tools/list_changed" && message.id === undefined) {
					changes = changes
						.then(async () => {
							if (catalogLoad) await catalogLoad;
							tools = undefined;
							await loadCatalog();
							send(message);
						})
						.catch(() => stop());
				} else if (message.id !== undefined) {
					const id = `rea-server:${++sequence}`;
					serverRequests.set(id, message.id as RpcId);
					send({ ...message, id });
				} else send(message);
				return;
			}
			const id = String(message.id);
			const waiting = pending.get(id);
			if (!waiting) return;
			pending.delete(id);
			if (waiting.clientId !== undefined) clientRequests.delete(waiting.clientId);
			const error = message.error;
			if (object(error))
				waiting.reject(
					rpcError(Number(error.code), String(error.message), error.data === undefined ? undefined : error.data),
				);
			else waiting.resolve(message.result);
		});
		own.on("error", () => stop());
		own.stdin.on("error", () => stop());
		own.on("exit", () => {
			if (!stopping) stop();
		});
		own.on("close", () => {
			clearTimeout(killTimer);
			// A descendant with closed stdio can survive its parent and ignore SIGTERM.
			if (process.platform !== "win32" && own.pid) {
				try {
					process.kill(-own.pid, "SIGKILL");
				} catch {
					/* The process group has already exited. */
				}
			}
			for (const waiting of pending.values()) waiting.reject(rpcError(-32603, "REA child exited"));
			pending.clear();
			// The rejections answer the calls waiting on REA (promise reactions, before setImmediate); end the session
			// once those answers have gone out, or omp would see only a dead server and reconnect into the same failure.
			setImmediate(finish);
			gone.resolve();
			closed = true;
		});
		started = Promise.resolve();
	};
	/** Start REA behind a startup the session answered from the cache: the same handshake, then a catalog check. */
	const ensureStarted = () => {
		if (!started) {
			spawnChild();
			started = (async () => {
				try {
					const answer = await request("initialize", clientInit ?? JSON.parse(cache?.client ?? "null"));
					initializeResult = object(answer) ? answer : undefined;
				} catch (error) {
					// REA cannot start (no npx, offline, a refused handshake). Without the cache the next session starts REA
					// with its own startup and sees the failure there, instead of a healthy cached REA failing at every call.
					store.forget();
					stop();
					throw error;
				}
				if (initializedNotice) toChild(initializedNotice);
				for (const message of early.splice(0)) toChild(message);
				ready = true;
				changes = changes
					.then(async () => {
						if (catalogLoad) await catalogLoad;
						const before = JSON.stringify([...(tools?.values() ?? [])]);
						tools = undefined;
						const after = await loadCatalog();
						if (JSON.stringify([...after.values()]) !== before)
							send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
					})
					.catch(() => stop());
			})();
		}
		return started;
	};
	/** Wait for REA before forwarding call `id`; a call omp cancelled meanwhile is answered as cancelled instead. */
	const startedFor = async (id: RpcId | undefined) => {
		await ensureStarted();
		if (cancelledDuringStart.delete(id)) throw rpcError(-32800, "Request cancelled");
	};
	if (!cache) {
		spawnChild();
		ready = true;
	}

	const handle = async (message: unknown) => {
		if (
			!object(message) ||
			message.jsonrpc !== "2.0" ||
			(message.id !== undefined &&
				typeof message.id !== "string" &&
				typeof message.id !== "number" &&
				message.id !== null)
		)
			throw rpcError(-32600, "Invalid JSON-RPC request");
		const id = message.id as RpcId | undefined;
		if (typeof message.method !== "string") {
			const key = String(id);
			if (!serverRequests.has(key)) throw rpcError(-32600, "Unknown server request");
			const original = serverRequests.get(key);
			serverRequests.delete(key);
			toChild({ ...message, id: original });
			return;
		}
		const method = message.method;
		if (id === undefined) {
			if (!ready) {
				if (method === "notifications/initialized") initializedNotice = message;
				else if (method === "notifications/cancelled") {
					if (object(message.params)) cancelledDuringStart.add(message.params.requestId);
				} else early.push(message);
			} else if (method === "notifications/cancelled" && object(message.params)) {
				const requestId = clientRequests.get(message.params.requestId as RpcId);
				if (requestId !== undefined) toChild({ ...message, params: { ...message.params, requestId } });
			} else toChild(message);
			return;
		}
		let result: unknown;
		if (method === "initialize") {
			clientInit = message.params;
			if (!child && cache && JSON.stringify(clientInit ?? null) === cache.client) result = cache.initialize;
			else {
				// Another handshake than the cached one: REA answers it, and the catalog comes from it too.
				if (!child) {
					cache = undefined;
					tools = undefined;
					prompts = undefined;
					spawnChild();
					ready = true;
				}
				result = await request(method, message.params, id);
				initializeResult = object(result) ? result : undefined;
			}
			if (object(result))
				result = {
					...result,
					capabilities: {
						...(object(result.capabilities) ? result.capabilities : {}),
						tools: { listChanged: true },
					},
				};
		} else if (method === "ping" && !child) {
			result = {};
		} else if (
			method === "prompts/list" &&
			!child &&
			prompts !== undefined &&
			(message.params === undefined || (object(message.params) && message.params.cursor === undefined))
		) {
			result = prompts;
		} else if (method === "tools/list") {
			if (message.params !== undefined && (!object(message.params) || message.params.cursor !== undefined))
				throw rpcError(-32602, "The relay tool list is not paginated");
			await changes;
			const all = await catalog();
			result = { tools: [...all.values()].filter(tool => curated.has(tool.name)).concat(metaTools) };
		} else if (method === "tools/call") {
			const params = message.params;
			if (
				!object(params) ||
				typeof params.name !== "string" ||
				(params.arguments !== undefined && !object(params.arguments))
			)
				throw rpcError(-32602, "Expected tool name and object arguments");
			await changes;
			const all = await catalog();
			const input = (params.arguments ?? {}) as Record<string, unknown>;
			if (params.name === "rea_catalog") {
				if (
					Object.keys(input).some(key => key !== "query" && key !== "name") ||
					(input.query !== undefined && typeof input.query !== "string") ||
					(input.name !== undefined && typeof input.name !== "string")
				)
					throw rpcError(-32602, "Expected optional query and name strings");
				const name = input.name as string | undefined;
				if (name !== undefined && !all.has(name)) throw rpcError(-32602, `Unknown REA tool: ${name}`);
				const keywords = ((input.query as string | undefined) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
				const matches = [...all.values()].filter(
					tool =>
						(!name || tool.name === name) &&
						keywords.every(keyword => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(keyword)),
				);
				result = {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								tools: matches.map(tool =>
									name ? tool : { name: tool.name, description: (tool.description ?? "").split(/\r?\n/)[0] },
								),
							}),
						},
					],
				};
			} else if (params.name === "rea_call") {
				if (
					Object.keys(input).some(key => key !== "name" && key !== "arguments") ||
					typeof input.name !== "string" ||
					!object(input.arguments)
				)
					throw rpcError(-32602, "Expected REA name and object arguments");
				if (!all.has(input.name)) throw rpcError(-32602, `Unknown REA tool: ${input.name}`);
				await startedFor(id);
				result = await request("tools/call", { ...params, name: input.name, arguments: input.arguments }, id);
			} else {
				if (!curated.has(params.name) || !all.has(params.name))
					throw rpcError(-32602, `Tool is not exposed: ${params.name}; use rea_call`);
				await startedFor(id);
				result = await request("tools/call", params, id);
			}
		} else {
			await startedFor(id);
			result = await request(method, message.params, id);
		}
		send({ jsonrpc: "2.0", id, result });
	};

	return {
		get running() {
			return child !== undefined && !closed;
		},
		receive(message) {
			handle(message).catch((error: RpcFailure) => {
				if (object(message) && message.id === undefined && typeof message.method === "string") return;
				const id = object(message) ? ((message.id as RpcId | undefined) ?? null) : null;
				send({
					jsonrpc: "2.0",
					id,
					error: {
						code: error.code ?? -32603,
						message: error.message,
						...(error.data === undefined ? {} : { data: error.data }),
					},
				});
			});
		},
		close() {
			ended = true;
			stop();
			if (!child) gone.resolve();
			return gone.promise;
		},
	};
}

/** How the hub starts REA: the pinned release through npx (`npx.cmd` on Windows). */
export function reaCommand(): { command: string; args: string[] } {
	return {
		command: process.platform === "win32" ? "npx.cmd" : "npx",
		args: ["-y", `rea-agents@${config.version}`, "mcp"],
	};
}
