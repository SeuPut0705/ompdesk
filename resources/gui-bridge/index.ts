/**
 * omp GUI bridge: an omp extension the GUI loads with `-e` so its main process
 * can reach live session state stock RPC does not expose.
 *
 * Transport: the GUI passes a unix socket path (macOS) or named pipe (Windows)
 * in `OMP_GUI_BRIDGE`; this extension listens there. Newline-delimited JSON:
 *   GUI → bridge  `{ id, method, params }`
 *   bridge → GUI  `{ id, ok: true, result }` | `{ id, ok: false, error }`
 *   bridge → GUI  `{ event: { type, … } }` (pushed, see `BridgeEnv.emit`)
 * Without `OMP_GUI_BRIDGE` the extension is inert.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { methods as composer } from "./composer";
import { methods as extensions } from "./extensions";
import { methods as misc } from "./misc";
import { methods as modes } from "./modes";
import { methods as sessions } from "./sessions";
import { methods as settings } from "./settings";
import type { BridgeEnv, BridgeEvent, BridgeMethods } from "./types";
import { methods as workspace } from "./workspace";

const builtins: BridgeMethods = {
	ping: async (_params, env) => ({ version: env.pi.pi.VERSION }),
	session_info: async (_params, env) => {
		const session = env.session();
		return { sessionId: session.sessionId, sessionFile: session.sessionFile ?? null };
	},
};

function mergeMethods(): BridgeMethods {
	const merged: BridgeMethods = {};
	const areas: Record<string, BridgeMethods> = {
		builtins,
		sessions,
		composer,
		modes,
		workspace,
		extensions,
		settings,
		misc,
	};
	for (const [area, table] of Object.entries(areas)) {
		for (const [name, method] of Object.entries(table)) {
			if (Object.hasOwn(merged, name)) throw new Error(`gui-bridge: method "${name}" is defined twice (${area})`);
			merged[name] = method;
		}
	}
	return merged;
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

	const table = mergeMethods();
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

	const handle = async (socket: net.Socket, line: string) => {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRequest(request)) return;
		const { id, method, params } = request;
		const fn = typeof method === "string" && Object.hasOwn(table, method) ? table[method] : undefined;
		if (!fn) {
			write(socket, { id, ok: false, error: `Unknown bridge method: ${String(method)}` });
			return;
		}
		try {
			write(socket, { id, ok: true, result: await fn(params, env) });
		} catch (err) {
			write(socket, { id, ok: false, error: err instanceof Error ? err.message : String(err) });
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
