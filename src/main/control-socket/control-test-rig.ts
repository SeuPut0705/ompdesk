/**
 * The control socket's tests run against the real core (native/ompdesk/crates/core): a backend that plays main's
 * agent-control service, a JSON-lines client over the real Unix socket or named pipe, and the teardown of everything a
 * test opened. No timer is faked: the core's own timers run, shortened through the server's tuning, and every step
 * waits on a signal (a line that came, a call the backend got, main starting or stopping to watch).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlResponse,
	type EventFrame,
	type SessionState,
} from "../../shared/control-protocol";
import type { ToolOutcome } from "../agent-control/service";
import type { TabActivity } from "../sidecar-pool";
import { RM_TEMP } from "../test-fake-omp";
import type { ControlBackend, OutsideCaller, SessionView } from "./backend";
import { type ControlSocketHandle, type ControlSocketOptions, startControlSocket } from "./index";
import { ControlServer, type ControlServerOptions } from "./server";

type ServerOptions = Omit<ControlServerOptions, "token" | "backend">;

const posix = process.platform !== "win32";

/** Predicates re-checked whenever what they read changed. */
class Changes {
	readonly #waiting: { check: () => boolean; resolve: () => void }[] = [];

	notify(): void {
		for (const waiter of [...this.#waiting]) {
			if (!waiter.check()) continue;
			this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
			waiter.resolve();
		}
	}

	until(check: () => boolean): Promise<void> {
		if (check()) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiting.push({ check, resolve });
		return promise;
	}
}

/**
 * Main's side as the server sees it: sessions, the pool's activity and the reports addressed to outside callers.
 * Main forwards activity and reports only while the core asks it to watch (a wait or a subscription runs), so
 * `listeners` is empty whenever nothing needs them, and `fire`/`mail` refuse to go nowhere.
 */
export class TestBackend implements ControlBackend {
	readonly sessions = new Map<string, SessionView>();
	readonly listeners = new Set<(activity: TabActivity) => void>();
	readonly mailListeners = new Set<(callerId: string, text: string) => void>();
	readonly runs: { caller: OutsideCaller; tool: string; args: unknown }[] = [];
	/** Every name `resolve` was asked for, in order. */
	readonly resolved: string[] = [];
	readonly released: string[] = [];
	readonly #changes = new Changes();
	onRun: (tool: string, args: unknown) => Promise<ToolOutcome> = async (tool, args) => ({
		text: `ran ${tool} ${JSON.stringify(args)}`,
		isError: false,
	});

	add(session: string, state: SessionState, title = `title of ${session}`): void {
		this.sessions.set(session, { session, title, state });
	}

	setState(session: string, state: SessionState): void {
		const view = this.sessions.get(session);
		if (view) this.sessions.set(session, { ...view, state });
	}

	fire(activity: TabActivity): void {
		if (this.listeners.size === 0) throw new Error(`${activity.type} fired while main does not watch the tabs`);
		for (const listener of [...this.listeners]) listener(activity);
	}

	mail(callerId: string, text: string): void {
		if (this.mailListeners.size === 0) throw new Error("a report sent while main does not forward reports");
		for (const listener of [...this.mailListeners]) listener(callerId, text);
	}

	/** Resolves once `check` holds after a call, a release or a watch change. */
	until(check: () => boolean): Promise<void> {
		return this.#changes.until(check);
	}

	/** Main forwards tab activity (and with `mail`, reports) to the core: `on` false waits for it to stop. */
	watched(on = true, { mail = false }: { mail?: boolean } = {}): Promise<void> {
		return this.until(() => this.listeners.size > 0 === on && (!mail || this.mailListeners.size > 0 === on));
	}

	run(caller: OutsideCaller, tool: string, args: unknown): Promise<ToolOutcome> {
		this.runs.push({ caller, tool, args });
		const outcome = this.onRun(tool, args);
		this.#changes.notify();
		return outcome;
	}

	async resolve(_caller: OutsideCaller, name: string): Promise<SessionView> {
		this.resolved.push(name);
		this.#changes.notify();
		const view = this.sessions.get(name);
		if (!view) throw new Error(`No session "${name}" is open`);
		return view;
	}

	view(session: string): SessionView | null {
		return this.sessions.get(session) ?? null;
	}

	views(): SessionView[] {
		return [...this.sessions.values()];
	}

	observe(listener: (activity: TabActivity) => void): () => void {
		this.listeners.add(listener);
		this.#changes.notify();
		return () => {
			this.listeners.delete(listener);
			this.#changes.notify();
		};
	}

	onOutsideMail(listener: (callerId: string, text: string) => void): () => void {
		this.mailListeners.add(listener);
		this.#changes.notify();
		return () => {
			this.mailListeners.delete(listener);
			this.#changes.notify();
		};
	}

	release(caller: OutsideCaller): void {
		this.released.push(caller.id);
		this.#changes.notify();
	}
}

type Line = Record<string, unknown>;

const isEventFrame = (line: Line): line is EventFrame & Line => "sub" in line;

/** One connection, reading JSON lines as they come. */
export class LineClient {
	readonly socket: Socket;
	readonly lines: Line[] = [];
	readonly closed: Promise<void>;
	/** The connection's error, when it ended with one (a reset when the server hung up first). */
	error: Error | undefined;
	#ended = false;
	#read = 0;
	#nextId = 1_000;
	#partial: string[] = [];
	readonly #changes = new Changes();

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (text: string) => this.#take(text));
		socket.on("error", error => {
			this.error = error;
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		socket.once("close", () => {
			this.#ended = true;
			this.#changes.notify();
			resolve();
		});
		this.closed = promise;
	}

	static async open(path: string): Promise<LineClient> {
		const socket = connect(path);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		socket.once("connect", resolve);
		socket.once("error", reject);
		try {
			await promise;
		} finally {
			socket.off("error", reject);
		}
		return new LineClient(socket);
	}

	#take(text: string): void {
		let from = 0;
		for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", from)) {
			this.#partial.push(text.slice(from, end));
			this.lines.push(JSON.parse(this.#partial.join("")) as Line);
			this.#partial = [];
			from = end + 1;
		}
		if (from < text.length) this.#partial.push(text.slice(from));
		this.#changes.notify();
	}

	/** Resolves once `check` holds; rejects when the connection closed first. */
	async until(check: () => boolean, what: string): Promise<void> {
		await this.#changes.until(() => check() || this.#ended);
		if (!check()) throw new Error(`The connection closed before ${what}`);
	}

	send(frame: unknown): void {
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}

	/** The next line not read yet by `next`, in arrival order. */
	async next(): Promise<unknown> {
		await this.until(() => this.lines.length > this.#read, "the next line");
		return this.lines[this.#read++];
	}

	#answer(id: number, after = 0): ControlResponse | undefined {
		return this.lines.slice(after).find(line => !isEventFrame(line) && line.id === id) as ControlResponse | undefined;
	}

	answered(id: number): boolean {
		return this.#answer(id) !== undefined;
	}

	async answer(id: number, after = 0): Promise<ControlResponse> {
		await this.until(() => this.#answer(id, after) !== undefined, `the answer to request ${id}`);
		return this.#answer(id, after) as ControlResponse;
	}

	/** Sends one request (numbered here unless it has an `id`) and resolves with its answer. */
	call(request: Line): Promise<ControlResponse> {
		const id = typeof request.id === "number" ? request.id : this.#nextId++;
		const after = this.lines.length;
		this.send({ ...request, id });
		return this.answer(id, after);
	}

	/** The frames of subscription `sub` so far. */
	frames(sub: number): EventFrame[] {
		return this.lines.filter(isEventFrame).filter(frame => frame.sub === sub);
	}

	/** Resolves with the frames of `sub` once there are at least `count`. */
	async framesOf(sub: number, count: number): Promise<EventFrame[]> {
		await this.until(() => this.frames(sub).length >= count, `${count} frames of subscription ${sub}`);
		return this.frames(sub);
	}

	/** Stops reading: what the server writes stays in its own output once the OS buffers are full. */
	pause(): void {
		this.socket.pause();
	}

	resume(): void {
		this.socket.resume();
	}

	close(): void {
		this.socket.destroy();
	}
}

/** A connection that said hello, and the caller the server made of it. */
export interface Connected {
	client: LineClient;
	caller: OutsideCaller;
}

/** Everything one test file opens: servers, sockets, connections and temp folders, ended by `cleanup`. */
export class ControlRig {
	readonly token = randomBytes(32).toString("hex");
	readonly #dirs: string[] = [];
	readonly #clients: LineClient[] = [];
	readonly #closes: (() => Promise<void>)[] = [];

	tempDir(prefix = "ompdesk-ctl-"): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		this.#dirs.push(dir);
		return dir;
	}

	/** A fresh socket path of this platform: a socket file in a temp folder, or a named pipe. */
	socketPath(): string {
		return posix ? join(this.tempDir(), "s.sock") : `\\\\.\\pipe\\ompdesk-test-${randomBytes(8).toString("hex")}`;
	}

	/** A `ControlServer` with this rig's token, listening at a fresh path; resolves with that path. */
	async serve(backend: ControlBackend, options: ServerOptions = {}): Promise<string> {
		const server = new ControlServer({ token: this.token, backend, ...options });
		let closing: Promise<void> | undefined;
		this.#closes.push(() => (closing ??= server.close()));
		const path = this.socketPath();
		await server.listen(path);
		return path;
	}

	/** `startControlSocket`, its handle closed at cleanup unless the test closed it. */
	async start(options: ControlSocketOptions): Promise<ControlSocketHandle | null> {
		const handle = await startControlSocket(options);
		if (handle === null) return null;
		let closing: Promise<void> | undefined;
		const close = () => (closing ??= handle.close());
		this.#closes.push(close);
		return { ...handle, close };
	}

	async open(path: string): Promise<LineClient> {
		const client = await LineClient.open(path);
		this.#clients.push(client);
		return client;
	}

	/** A connection that said hello as `caller` from `cwd` (a temp folder by default), with this rig's token unless given. */
	async connect(
		path: string,
		{ caller = "cli", cwd, token = this.token }: { caller?: string; cwd?: string; token?: string } = {},
	): Promise<Connected> {
		const client = await this.open(path);
		const folder = cwd ?? this.tempDir();
		const hello = await client.call({
			id: 1,
			method: "hello",
			token,
			protocol: CONTROL_PROTOCOL_VERSION,
			caller,
			cwd: folder,
		});
		if (!hello.ok) throw new Error(`hello refused: ${hello.error.code}: ${hello.error.message}`);
		const { result } = hello;
		if (typeof result !== "object" || result === null || !("caller" in result) || typeof result.caller !== "string")
			throw new Error(`hello named no caller: ${JSON.stringify(result)}`);
		return {
			client,
			caller: { id: result.caller, name: caller, title: `outside process "${caller}" (self-declared)`, cwd: folder },
		};
	}

	async cleanup(): Promise<void> {
		for (const client of this.#clients.splice(0)) client.close();
		await Promise.all(this.#closes.splice(0).map(close => close()));
		for (const dir of this.#dirs.splice(0)) rmSync(dir, RM_TEMP);
	}
}
