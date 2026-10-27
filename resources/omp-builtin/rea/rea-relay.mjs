import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import config from "./rea-config.json" with { type: "json" };

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
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const rpcError = (code, message, data) =>
	Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });

/**
 * What a started REA answered omp's startup with (initialize, the full catalog, prompts/list), per REA version and
 * client handshake. With it a relay answers that startup itself and starts REA at the first call that needs it:
 * an idle REA held ~320 MB of memory in every omp.
 */
const cacheFile = dir => join(dir, `rea-${config.version}.json`);
function readCache(dir) {
	if (!dir) return undefined;
	try {
		const cached = JSON.parse(readFileSync(cacheFile(dir), "utf8"));
		return object(cached) &&
			cached.version === config.version &&
			typeof cached.client === "string" &&
			object(cached.initialize) &&
			Array.isArray(cached.tools) &&
			cached.tools.every(tool => object(tool) && typeof tool.name === "string" && object(tool.inputSchema))
			? cached
			: undefined;
	} catch {
		return undefined;
	}
}
function writeCache(dir, entry) {
	const temp = `${cacheFile(dir)}.${process.pid}.tmp`;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temp, JSON.stringify(entry));
		renameSync(temp, cacheFile(dir));
	} catch {
		/* Unwritable (or a rename Windows refused): the next relay starts REA with omp, as without a cache. */
		rmSync(temp, { force: true });
	}
}

/** Stock has no server tool filter; keep the full REA server behind two discovery tools. */
export function startRelay(
	command = process.platform === "win32" ? "npx.cmd" : "npx",
	args = ["-y", `rea-agents@${config.version}`, "mcp"],
	cacheDir = process.env.OMP_GUI_REA_CACHE,
) {
	let cache = readCache(cacheDir);
	let child;
	let started;
	/** REA has answered its handshake and had `initialized`: until then omp's notifications wait in `early`. */
	let ready = false;
	let clientInit;
	let initializedNotice;
	const early = [];
	/** Calls omp cancelled while REA was starting: they never reach REA. */
	const cancelledDuringStart = new Set();
	const pending = new Map();
	const clientRequests = new Map();
	const serverRequests = new Map();
	let sequence = 0;
	let tools = cache ? new Map(cache.tools.map(tool => [tool.name, tool])) : undefined;
	let prompts = cache?.prompts;
	let initializeResult;
	let remembered = false;
	let catalogLoad;
	let stopping = false;
	let killTimer;
	const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
	const toChild = message => child.stdin.write(`${JSON.stringify(message)}\n`);
	const request = (method, params, clientId) => {
		const id = `relay:${++sequence}`;
		if (clientId !== undefined) clientRequests.set(clientId, id);
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject, clientId });
			toChild({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
		});
	};
	/** Record this REA's startup answers once its catalog is known; a changed prompt list is announced. */
	const remember = async () => {
		if (!cacheDir || !initializeResult) return;
		if (object(initializeResult.capabilities) && initializeResult.capabilities.prompts) {
			const fresh = await request("prompts/list", {});
			if (prompts !== undefined && JSON.stringify(fresh) !== JSON.stringify(prompts))
				send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
			prompts = fresh;
		}
		writeCache(cacheDir, {
			version: config.version,
			client: JSON.stringify(clientInit ?? null),
			initialize: initializeResult,
			tools: [...tools.values()],
			...(prompts === undefined ? {} : { prompts }),
		});
	};
	const loadCatalog = () => {
		if (!catalogLoad) {
			catalogLoad = (async () => {
				const collected = [];
				let cursor;
				do {
					const page = await request("tools/list", cursor === undefined ? {} : { cursor });
					if (
						!object(page) ||
						!Array.isArray(page.tools) ||
						page.tools.some(tool => !object(tool) || typeof tool.name !== "string" || !object(tool.inputSchema))
					) {
						throw rpcError(-32603, "REA returned an invalid tool catalog");
					}
					collected.push(...page.tools);
					cursor = page.nextCursor;
				} while (typeof cursor === "string" && cursor.length > 0);
				tools = new Map(collected.map(tool => [tool.name, tool]));
				if (!remembered) {
					remembered = true;
					remember().catch(() => {});
				}
				return tools;
			})().finally(() => {
				catalogLoad = undefined;
			});
		}
		return catalogLoad;
	};
	const catalog = () => (tools ? Promise.resolve(tools) : loadCatalog());
	let changes = Promise.resolve();
	const spawnChild = () => {
		child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: process.platform === "win32" && command.endsWith(".cmd"),
			windowsHide: true,
		});
		child.stderr.pipe(process.stderr);
		const output = createInterface({ input: child.stdout });
		output.on("line", line => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				stop(1);
				return;
			}
			if (!object(message) || message.jsonrpc !== "2.0") {
				stop(1);
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
						.catch(() => stop(1));
				} else if (message.id !== undefined) {
					const id = `rea-server:${++sequence}`;
					serverRequests.set(id, message.id);
					send({ ...message, id });
				} else send(message);
				return;
			}
			const waiting = pending.get(message.id);
			if (!waiting) return;
			pending.delete(message.id);
			if (waiting.clientId !== undefined) clientRequests.delete(waiting.clientId);
			if (message.error) waiting.reject(rpcError(message.error.code, message.error.message, message.error.data));
			else waiting.resolve(message.result);
		});
		child.on("error", () => stop(1));
		child.stdin.on("error", () => stop(1));
		child.on("exit", () => {
			if (!stopping) stop(1);
		});
		child.on("close", () => {
			clearTimeout(killTimer);
			// A descendant with closed stdio can survive its parent and ignore SIGTERM.
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* The process group has already exited. */
				}
			}
			for (const waiting of pending.values()) waiting.reject(rpcError(-32603, "REA child exited"));
			pending.clear();
			// The rejections answer the calls waiting on REA (promise reactions, before setImmediate); exit once those
			// answers have left stdout, or omp would see only a dead server and reconnect into the same failure.
			setImmediate(() => process.stdout.write("", () => process.exit(process.exitCode ?? 1)));
		});
		started = Promise.resolve();
	};
	/** Start REA behind a startup the relay answered from the cache: the same handshake, then a catalog check. */
	const ensureStarted = () => {
		if (!started) {
			spawnChild();
			started = (async () => {
				try {
					initializeResult = await request("initialize", clientInit ?? JSON.parse(cache.client));
				} catch (error) {
					// REA cannot start (no npx, offline, a refused handshake). Without the cache the next omp starts REA with
					// its own startup and sees the failure there, instead of a healthy cached REA failing at every call.
					rmSync(cacheFile(cacheDir), { force: true });
					stop(1);
					throw error;
				}
				if (initializedNotice) toChild(initializedNotice);
				for (const message of early.splice(0)) toChild(message);
				ready = true;
				changes = changes
					.then(async () => {
						if (catalogLoad) await catalogLoad;
						const before = JSON.stringify([...tools.values()]);
						tools = undefined;
						await loadCatalog();
						if (JSON.stringify([...tools.values()]) !== before)
							send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
					})
					.catch(() => stop(1));
			})();
		}
		return started;
	};
	/** Wait for REA before forwarding call `id`; a call omp cancelled meanwhile is answered as cancelled instead. */
	const startedFor = async id => {
		await ensureStarted();
		if (cancelledDuringStart.delete(id)) throw rpcError(-32800, "Request cancelled");
	};
	if (!cache) {
		spawnChild();
		ready = true;
	}
	const handle = async message => {
		if (
			!object(message) ||
			message.jsonrpc !== "2.0" ||
			(message.id !== undefined &&
				typeof message.id !== "string" &&
				typeof message.id !== "number" &&
				message.id !== null)
		)
			throw rpcError(-32600, "Invalid JSON-RPC request");
		if (typeof message.method !== "string") {
			if (!serverRequests.has(message.id)) throw rpcError(-32600, "Unknown server request");
			const id = serverRequests.get(message.id);
			serverRequests.delete(message.id);
			toChild({ ...message, id });
			return;
		}
		if (message.id === undefined) {
			if (!ready) {
				if (message.method === "notifications/initialized") initializedNotice = message;
				else if (message.method === "notifications/cancelled") {
					if (object(message.params)) cancelledDuringStart.add(message.params.requestId);
				} else early.push(message);
			} else if (message.method === "notifications/cancelled" && object(message.params)) {
				const requestId = clientRequests.get(message.params.requestId);
				if (requestId !== undefined) toChild({ ...message, params: { ...message.params, requestId } });
			} else toChild(message);
			return;
		}
		let result;
		if (message.method === "initialize") {
			clientInit = message.params;
			if (!child && JSON.stringify(clientInit ?? null) === cache.client) result = cache.initialize;
			else {
				// Another handshake than the cached one: REA answers it, and the catalog comes from it too.
				if (!child) {
					cache = undefined;
					tools = undefined;
					prompts = undefined;
					spawnChild();
					ready = true;
				}
				result = await request(message.method, message.params, message.id);
				initializeResult = result;
			}
			if (object(result))
				result = { ...result, capabilities: { ...result.capabilities, tools: { listChanged: true } } };
		} else if (message.method === "ping" && !child) {
			result = {};
		} else if (
			message.method === "prompts/list" &&
			!child &&
			prompts !== undefined &&
			(message.params === undefined || (object(message.params) && message.params.cursor === undefined))
		) {
			result = prompts;
		} else if (message.method === "tools/list") {
			if (message.params !== undefined && (!object(message.params) || message.params.cursor !== undefined))
				throw rpcError(-32602, "The relay tool list is not paginated");
			await changes;
			const all = await catalog();
			result = { tools: [...all.values()].filter(tool => curated.has(tool.name)).concat(metaTools) };
		} else if (message.method === "tools/call") {
			const params = message.params;
			if (
				!object(params) ||
				typeof params.name !== "string" ||
				(params.arguments !== undefined && !object(params.arguments))
			)
				throw rpcError(-32602, "Expected tool name and object arguments");
			await changes;
			const all = await catalog();
			const input = params.arguments ?? {};
			if (params.name === "rea_catalog") {
				if (
					Object.keys(input).some(key => key !== "query" && key !== "name") ||
					(input.query !== undefined && typeof input.query !== "string") ||
					(input.name !== undefined && typeof input.name !== "string")
				)
					throw rpcError(-32602, "Expected optional query and name strings");
				if (input.name !== undefined && !all.has(input.name))
					throw rpcError(-32602, `Unknown REA tool: ${input.name}`);
				const keywords = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
				const matches = [...all.values()].filter(
					tool =>
						(!input.name || tool.name === input.name) &&
						keywords.every(keyword => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(keyword)),
				);
				result = {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								tools: matches.map(tool =>
									input.name
										? tool
										: { name: tool.name, description: (tool.description ?? "").split(/\r?\n/)[0] },
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
				await startedFor(message.id);
				result = await request(
					"tools/call",
					{ ...params, name: input.name, arguments: input.arguments },
					message.id,
				);
			} else {
				if (!curated.has(params.name) || !all.has(params.name))
					throw rpcError(-32602, `Tool is not exposed: ${params.name}; use rea_call`);
				await startedFor(message.id);
				result = await request("tools/call", params, message.id);
			}
		} else {
			await startedFor(message.id);
			result = await request(message.method, message.params, message.id);
		}
		send({ jsonrpc: "2.0", id: message.id, result });
	};
	const input = createInterface({ input: process.stdin });
	input.on("line", line => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}
		handle(message).catch(error => {
			if (message?.id === undefined && object(message) && typeof message.method === "string") return;
			send({
				jsonrpc: "2.0",
				id: message?.id ?? null,
				error: {
					code: error.code ?? -32603,
					message: error.message,
					...(error.data === undefined ? {} : { data: error.data }),
				},
			});
		});
	});
	function stop(code) {
		if (stopping) return;
		stopping = true;
		process.exitCode = code;
		input.close();
		process.stdin.pause();
		// Never started: nothing to stop, and the relay ends with its last handle.
		if (!child) return;
		child.stdin.end();
		if (child.pid) {
			if (process.platform === "win32") {
				const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				});
				killer.on("error", () => child.kill());
			} else {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					/* Already gone. */
				}
				killTimer = setTimeout(() => {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						/* Already gone. */
					}
				}, 2000);
				killTimer.unref();
			}
		}
	}
	process.stdout.on("error", () => stop(1));
	process.stderr.on("error", () => stop(1));
	process.stdin.on("error", () => stop(1));
	input.on("close", () => stop(0));
	process.on("SIGTERM", () => stop(0));
	process.on("SIGINT", () => stop(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startRelay();
