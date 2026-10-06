/**
 * seucode's gui-bridge: an omp extension the GUI loads with `-e` so its main process
 * can reach live session state stock RPC does not expose.
 *
 * Transport: the GUI passes a unix socket path (macOS) or named pipe (Windows)
 * in `OMP_GUI_BRIDGE`; this extension listens there. Newline-delimited JSON:
 *   GUI → bridge  `{ id, method, params }`
 *   bridge → GUI  `{ id, ok: true, result }` | `{ id, ok: false, error }`
 *   bridge → GUI  `{ event: { type, … } }` (pushed, see `BridgeEnv.emit`)
 * Without `OMP_GUI_BRIDGE` the extension is inert.
 *
 * Area modules load independently: a module whose static omp import vanished
 * (a link error) takes down only its own features, which `capabilities` and
 * `unsupported_omp` errors then name, instead of the whole extension.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type AreaFailure, type FeatureId, mergeAreaFailures, UnsupportedOmpError } from "./capabilities";
import { probe } from "./health";
import type { BridgeEnv, BridgeEvent, BridgeMethods } from "./types";

interface Area {
	name: string;
	/** Everything the module serves; unavailable as a whole when it fails to load. */
	features: readonly FeatureId[];
	load(): Promise<{ methods: BridgeMethods }>;
}

// Dynamic on purpose: a static import of an area whose omp export vanished
// fails the whole extension at link time (verified on omp 18.6.1).
const AREAS: readonly Area[] = [
	{ name: "composer", features: ["composer", "share"], load: () => import("./composer") },
	{ name: "sessions", features: ["sessionTree"], load: () => import("./sessions") },
	{
		name: "session-extras",
		features: ["sessionImport", "composer", "usage"],
		load: () => import("./session-extras"),
	},
	{ name: "workspace", features: ["workspace"], load: () => import("./workspace") },
	{
		name: "settings",
		features: ["settings", "models", "providers", "usage", "modelRoles"],
		load: () => import("./settings"),
	},
	{ name: "misc", features: ["voice", "debug", "security", "ssh"], load: () => import("./misc") },
	{ name: "extensions/agents", features: ["agents", "themes"], load: () => import("./extensions/agents") },
	{ name: "extensions/mcp", features: ["mcp"], load: () => import("./extensions/mcp") },
	{ name: "extensions/plugins", features: ["plugins"], load: () => import("./extensions/plugins") },
	{ name: "extensions/skills", features: ["skills"], load: () => import("./extensions/skills") },
	{ name: "modes/plan", features: ["planMode"], load: () => import("./modes/plan") },
	{ name: "modes/vibe", features: ["vibeMode"], load: () => import("./modes/vibe") },
	{ name: "modes/goal", features: ["goalMode"], load: () => import("./modes/goal") },
	{ name: "modes/loop", features: ["loopMode"], load: () => import("./modes/loop") },
	{ name: "modes/btw", features: ["btw"], load: () => import("./modes/btw") },
	{ name: "modes/actions", features: ["tan", "omfg", "agentPause"], load: () => import("./modes/actions") },
];

function builtins(failures: readonly AreaFailure[]): BridgeMethods {
	return {
		ping: async (_params, env) => ({ version: env.pi.pi.VERSION }),
		session_info: async (_params, env) => {
			const session = env.session();
			return { sessionId: session.sessionId, sessionFile: session.sessionFile ?? null };
		},
		/** Startup compatibility self-check: which GUI features this omp cannot serve, and why. */
		capabilities: async (_params, env) => ({
			ompVersion: env.pi.pi.VERSION,
			unavailable: mergeAreaFailures(await probe(env), failures),
		}),
	};
}

interface LoadedMethods {
	table: BridgeMethods;
	failures: AreaFailure[];
}

async function loadMethods(pi: ExtensionAPI): Promise<LoadedMethods> {
	const settled = await Promise.allSettled(AREAS.map(area => area.load()));
	const failures: AreaFailure[] = [];
	const tables: Record<string, BridgeMethods> = {};
	settled.forEach((result, index) => {
		const area = AREAS[index];
		if (result.status === "fulfilled") {
			tables[area.name] = result.value.methods;
			return;
		}
		const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
		pi.logger.error("gui-bridge: area failed to load", { area: area.name, error });
		failures.push({ area: area.name, features: area.features, error });
	});
	const table: BridgeMethods = {};
	for (const [area, methods] of Object.entries({ builtins: builtins(failures), ...tables })) {
		for (const [name, method] of Object.entries(methods)) {
			if (Object.hasOwn(table, name)) throw new Error(`gui-bridge: method "${name}" is defined twice (${area})`);
			table[name] = method;
		}
	}
	return { table, failures };
}

interface BridgeRequest {
	id: unknown;
	method: unknown;
	params?: unknown;
}

function isRequest(value: unknown): value is BridgeRequest {
	return typeof value === "object" && value !== null && "id" in value && "method" in value;
}

export default function guiBridge(pi: ExtensionAPI): void {
	const address = process.env.OMP_GUI_BRIDGE;
	if (!address) return;

	const loading = loadMethods(pi);
	// Requests rethrow it; this only keeps a broken table from being an unhandled rejection.
	loading.catch(err => pi.logger.error("gui-bridge: method table failed", { error: String(err) }));
	const clients = new Set<net.Socket>();
	let latestContext: ExtensionContext | undefined;
	const remember = (_event: unknown, ctx: ExtensionContext) => {
		latestContext = ctx;
	};
	pi.on("session_start", remember);
	pi.on("session_switch", remember);
	pi.on("session_branch", remember);
	pi.on("session_tree", remember);

	const write = (socket: net.Socket, frame: unknown) => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
	};

	const env: BridgeEnv = {
		pi,
		session() {
			const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
			if (!session) throw new Error("No live omp session");
			return session;
		},
		context() {
			if (!latestContext) throw new Error("omp session has not started yet");
			return latestContext;
		},
		emit(event: BridgeEvent) {
			for (const socket of clients) write(socket, { event });
		},
	};

	const respond = async (method: unknown, params: unknown): Promise<unknown> => {
		const { table, failures } = await loading;
		const fn = typeof method === "string" && Object.hasOwn(table, method) ? table[method] : undefined;
		if (fn) return fn(params, env);
		// Most likely served by a module this omp could not load.
		if (failures.length > 0) throw new UnsupportedOmpError(mergeAreaFailures([], failures), pi.pi.VERSION);
		throw new Error(`Unknown bridge method: ${String(method)}`);
	};

	const handle = async (socket: net.Socket, line: string) => {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRequest(request)) return;
		const { id, method, params } = request;
		try {
			write(socket, { id, ok: true, result: await respond(method, params) });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			write(socket, { id, ok: false, error, ...(err instanceof UnsupportedOmpError ? { code: err.code } : {}) });
		}
	};

	const server = net.createServer(socket => {
		clients.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) void handle(socket, line);
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("close", () => clients.delete(socket));
		socket.on("error", () => clients.delete(socket));
	});

	const isPipe = process.platform === "win32";
	// A previous crash can leave the socket file behind; listen() fails on it.
	if (!isPipe) fs.rmSync(address, { force: true });
	server.on("error", err => pi.logger.error("gui-bridge: socket error", { error: err.message }));
	server.listen(address);
	// The bridge must never be what keeps omp alive after it decides to exit.
	server.unref();
	process.once("exit", () => {
		server.close();
		if (!isPipe) fs.rmSync(address, { force: true });
	});
}
