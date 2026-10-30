/**
 * OMPdesk's MCP hub: ONE Bun process per app (started by main, src/main/mcp-hub.ts) that serves the built-in MCP
 * servers every omp mounts, `rea` (./mcp-hub-rea.ts) and `ompdesk-memory` (./mcp-hub-memory.ts), over streamable HTTP
 * on loopback. Before it every omp started its own `node rea-relay.mjs`, `bun memory-relay.mjs` and
 * `ai-memory mcp-bridge` (≈ 68 MB of footprint and three processes per session); the server names, tools,
 * descriptors and instructions omp sees are the same.
 *
 * Routes (every request needs `Authorization: Bearer <OMP_GUI_MCP_HUB_SECRET>`, the per-launch secret main passes to
 * omps as `OMP_GUI_MCP_AUTH`):
 * - `POST /memory`: stateless, one request at a time per omp call, all at once.
 * - `/rea`: one MCP session per omp (`Mcp-Session-Id`, minted at `initialize`). Answers to omp's requests are the
 *   POST's JSON reply; REA's own notifications and requests go on the session's GET event stream (held until omp
 *   opens it, which it does right after `initialized`). The stream ending (omp exited or closed the transport) or a
 *   DELETE ends the session and stops its REA; REA ending ends the stream, so omp reconnects into a new session.
 *   `?cwd=` (the omp's folder, URL-encoded) is where that session's REA runs, as it did as omp's grandchild.
 *
 * Env: `OMP_GUI_MCP_HUB_SECRET` (required), `OMP_GUI_MCP_HUB_PORT` (0 = any; a restart asks for the port it had, so
 * running omps find it again), `OMP_GUI_REA_CACHE` (the startup cache folder), `OMP_GUI_MEMORY` (memory's state file).
 * Prints `mcp-hub listening http://127.0.0.1:<port>` once listening. stdin EOF (the app quit or crashed) or SIGTERM
 * stops every REA and exits.
 */
import { timingSafeEqual } from "node:crypto";
import { memoryPost } from "./mcp-hub-memory";
import { createReaSession, ReaCacheStore, type ReaSession, type RpcMessage, reaCommand } from "./mcp-hub-rea";

export interface HubOptions {
	secret: string;
	port: number;
	reaCacheDir: string | undefined;
	memoryStateFile: string | undefined;
	/** How a session starts REA (tests: a fake). */
	rea?: { command: string; args: string[] };
	env?: NodeJS.ProcessEnv;
}

export interface Hub {
	port: number;
	/** Stops every session's REA; resolves once they are gone (at most 2.5 s). */
	stop(): Promise<void>;
}

/** Messages REA sends before omp opened the session's stream, at most this many (a client that never opens one). */
const HELD_MAX = 1000;
const SESSION_HEADER = "Mcp-Session-Id";

/** One omp's REA session: its stream to omp, what REA said before omp opened it, and the POSTs waiting on answers. */
class Session {
	stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	readonly held: string[] = [];
	readonly replies = new Map<string, (message: RpcMessage) => void>();
	readonly rea: ReaSession;

	constructor(open: (session: Session) => ReaSession) {
		this.rea = open(this);
	}

	send(message: RpcMessage): void {
		if (message.id !== undefined && message.method === undefined) {
			const key = idKey(message.id);
			const reply = this.replies.get(key);
			if (reply) {
				this.replies.delete(key);
				reply(message);
				return;
			}
		}
		const frame = `data: ${JSON.stringify(message)}\n\n`;
		if (this.stream) this.stream.enqueue(encoder.encode(frame));
		else if (this.held.length < HELD_MAX) this.held.push(frame);
	}

	endStream(): void {
		try {
			this.stream?.close();
		} catch {
			/* Already closed by the client. */
		}
	}
}

const encoder = new TextEncoder();
const idKey = (id: unknown) => `${typeof id}:${String(id)}`;

export function startHub(options: HubOptions): Hub {
	const expected = Buffer.from(`Bearer ${options.secret}`);
	const store = new ReaCacheStore(options.reaCacheDir);
	const rea = options.rea ?? reaCommand();
	const sessions = new Map<string, Session>();
	/** REAs of closed sessions still on their way out (a quit waits for them). */
	const dying = new Set<Promise<void>>();

	const authorized = (request: Request) => {
		const given = Buffer.from(request.headers.get("authorization") ?? "");
		return given.length === expected.length && timingSafeEqual(given, expected);
	};

	const openSession = (cwd: string | undefined): [string, Session] => {
		const id = crypto.randomUUID();
		const session = new Session(own =>
			createReaSession({
				store,
				command: rea.command,
				args: rea.args,
				cwd,
				env: options.env ?? process.env,
				send: message => own.send(message),
				end() {
					// REA is gone: omp sees its stream end and reconnects into a new session.
					if (sessions.get(id) === own) sessions.delete(id);
					own.endStream();
				},
			}),
		);
		sessions.set(id, session);
		return [id, session];
	};

	const closeSession = (id: string) => {
		const session = sessions.get(id);
		if (!session) return;
		sessions.delete(id);
		const gone = session.rea.close();
		dying.add(gone);
		void gone.finally(() => dying.delete(gone));
		session.endStream();
	};

	const reaRequest = async (request: Request, url: URL): Promise<Response> => {
		const sessionId = request.headers.get(SESSION_HEADER);
		if (request.method === "DELETE") {
			if (sessionId) closeSession(sessionId);
			return new Response(null, { status: 200 });
		}
		if (request.method === "GET") {
			const session = sessionId ? sessions.get(sessionId) : undefined;
			if (!session || !sessionId) return new Response(null, { status: 404 });
			try {
				session.stream?.close();
			} catch {
				/* The old stream's client is gone already. */
			}
			let own: ReadableStreamDefaultController<Uint8Array> | undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					own = controller;
					session.stream = controller;
					// A comment frame sends the headers now: Bun holds them until the first bytes, and omp gives up on a
					// stream that does not open within its connect timeout (and this session would end with it).
					controller.enqueue(encoder.encode(": open\n\n"));
					for (const frame of session.held.splice(0)) controller.enqueue(encoder.encode(frame));
				},
				cancel() {
					dropped(own);
				},
			});
			// omp exited or closed its transport, or gave up opening the stream (it allows one second, a hub stalled
			// under load can miss that): REA, hundreds of MB, is stopped; a session with no REA stays, a few objects, so
			// a living omp goes on with it (and a call to a session that is gone is a 404 omp answers by reconnecting).
			const dropped = (stream: ReadableStreamDefaultController<Uint8Array> | undefined) => {
				if (session.stream !== stream) return;
				session.stream = undefined;
				if (session.rea.running) closeSession(sessionId);
			};
			request.signal.addEventListener("abort", () => dropped(own));
			return new Response(body, {
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache", [SESSION_HEADER]: sessionId },
			});
		}
		if (request.method !== "POST") return new Response(null, { status: 405 });
		let message: unknown;
		try {
			message = JSON.parse(await request.text());
		} catch {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
				{ status: 400 },
			);
		}
		const record =
			message !== null && typeof message === "object" && !Array.isArray(message)
				? (message as RpcMessage)
				: undefined;
		let id = sessionId;
		let session = id ? sessions.get(id) : undefined;
		if (!sessionId) {
			if (record?.method !== "initialize")
				return Response.json(
					{
						jsonrpc: "2.0",
						id: record?.id ?? null,
						error: { code: -32600, message: "Initialize a session first" },
					},
					{ status: 400 },
				);
			const cwd = url.searchParams.get("cwd") || undefined;
			[id, session] = openSession(cwd);
		}
		if (!session || !id) return new Response(null, { status: 404 });
		const headers = { [SESSION_HEADER]: id };
		if (record && record.id !== undefined && typeof record.method === "string") {
			const { promise, resolve } = Promise.withResolvers<RpcMessage>();
			const key = idKey(record.id);
			session.replies.set(key, resolve);
			const own = session;
			request.signal.addEventListener("abort", () => {
				if (own.replies.get(key) === resolve) own.replies.delete(key);
			});
			session.rea.receive(record);
			return Response.json(await promise, { headers });
		}
		session.rea.receive(message);
		return new Response(null, { status: 202, headers });
	};

	const fetchHandler = async (request: Request): Promise<Response> => {
		if (!authorized(request)) return new Response(null, { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === "/memory") {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			return memoryPost(request, options.memoryStateFile);
		}
		if (url.pathname === "/rea") return reaRequest(request, url);
		return new Response(null, { status: 404 });
	};

	const listen = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: fetchHandler });
	const server = (() => {
		try {
			return listen(options.port);
		} catch {
			// The port a restart asked for is taken: any port (omps started from now on get it).
			return listen(0);
		}
	})();

	return {
		port: server.port ?? 0,
		async stop() {
			for (const id of [...sessions.keys()]) closeSession(id);
			server.stop(true);
			// Each REA gets SIGTERM, then SIGKILL for its process group after 2 s (mcp-hub-rea.ts `stop`).
			await Promise.race([Promise.all(dying), Bun.sleep(2500)]);
		},
	};
}

if (import.meta.main) {
	const secret = process.env.OMP_GUI_MCP_HUB_SECRET;
	if (!secret) {
		process.stderr.write("mcp-hub: OMP_GUI_MCP_HUB_SECRET is required\n");
		process.exit(2);
	}
	// REA inherits the hub's environment (PATH, proxy settings) but never the secret.
	const env = { ...process.env };
	Reflect.deleteProperty(env, "OMP_GUI_MCP_HUB_SECRET");
	const hub = startHub({
		secret,
		port: Number(process.env.OMP_GUI_MCP_HUB_PORT) || 0,
		reaCacheDir: process.env.OMP_GUI_REA_CACHE,
		memoryStateFile: process.env.OMP_GUI_MEMORY,
		env,
	});
	process.stdout.write(`mcp-hub listening http://127.0.0.1:${hub.port}\n`);
	let stopping = false;
	const quit = () => {
		if (stopping) return;
		stopping = true;
		void hub.stop().finally(() => process.exit(0));
	};
	process.stdin.on("end", quit);
	process.stdin.on("error", quit);
	process.stdin.resume();
	process.on("SIGTERM", quit);
	process.on("SIGINT", quit);
}
