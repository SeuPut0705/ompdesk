/**
 * Main's synchronous connection to the core's hub (`native/ompdesk/crates/core/src/hub`): the pool and turn resume run
 * there, and main's code reads and changes them in the same tick it always did, so main's thread waits for each call.
 *
 * A worker thread holds the socket (a pipe on Windows) and keeps every line the hub sends, in order. Main posts a
 * request to the worker and blocks on `Atomics.wait` until the worker has the call's answer, or a question the hub asks
 * synchronously (`sync: true`), which main answers at once and then waits again: a rule in the core can suspend on
 * main (a sidecar it starts emits as it starts, a hook runs) and the nested calls that causes are answered meanwhile,
 * as listeners ran inside the TypeScript method. Lines that come while main does not wait (a timer of the core, an
 * answer to a question main answered later) make the worker ping, and main fetches them on its next turn; one
 * consumer, so nothing is reordered.
 *
 * A wait that passes {@link HUB_CALL_DEADLINE_MS}, or a connection that ends, is the loss of the hub: every instance is
 * told (`lost`), the connection is dropped, and the next call opens a new one to the core then running; an instance
 * re-seeds itself there. Main's thread is never held longer than the deadline per wait.
 */
import { Worker } from "node:worker_threads";
import { CoreError, core } from "./process";

/**
 * How long main's thread may wait for one answer. The hub answers from memory: measured calls take 0.03–0.2 ms, the
 * slowest rule (a 20-tab restore) a few ms. Two seconds is far past any of them and well under the hang watchdog's
 * 5 s (`HANG_TIMEOUT_MS`), so a hub that stopped answering is a lost hub, never a frozen window.
 */
export const HUB_CALL_DEADLINE_MS = 2_000;

/** Control words of the shared buffer: [state, length]; the lines follow at {@link DATA_OFFSET}. */
const STATE = 0;
const LENGTH = 1;
const IDLE = 0;
const WAITING = 1;
const READY = 2;
const DATA_OFFSET = 16;
const INITIAL_BYTES = 1 << 16;
const MAX_BYTES = 1 << 30;

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const net = require("node:net");
const { sab } = workerData;
const control = new Int32Array(sab, 0, 4);
const encoder = new TextEncoder();
let socket = null;
let connecting = false;
let lost = null;
let partial = "";
let lines = [];
/** The id main waits for (null: none), or "drain": hand over what there is. */
let waiting = null;
let pinged = false;

function handOver() {
	const text = JSON.stringify({ lines, lost });
	lines = [];
	const bytes = encoder.encode(text);
	const need = ${DATA_OFFSET} + bytes.length;
	if (sab.byteLength < need) sab.grow(Math.min(${MAX_BYTES}, Math.max(need, sab.byteLength * 2)));
	new Uint8Array(sab, ${DATA_OFFSET}, bytes.length).set(bytes);
	Atomics.store(control, ${LENGTH}, bytes.length);
	waiting = null;
	pinged = false;
	Atomics.store(control, ${STATE}, ${READY});
	Atomics.notify(control, ${STATE});
}

/** Whether the lines hold what main waits for: its answer and the tick that ends its microtasks, or a question it must answer now. */
function settled() {
	if (waiting === "drain") return true;
	let answered = false;
	for (const line of lines) {
		if (line.id !== undefined && line.id === waiting) answered = true;
		else if (line.tick && answered) return true;
		else if (line.event === "hub.out" && line.data.items.some(item => item.k === "ask" && item.sync === true)) return true;
	}
	return false;
}

function look() {
	if (waiting === null) {
		if ((lines.length > 0 || lost) && !pinged) {
			pinged = true;
			parentPort.postMessage("ping");
		}
		return;
	}
	if (lost || (lines.length > 0 && settled())) handOver();
}

function connect(endpoint, deadline) {
	connecting = true;
	const attempt = () => {
		const candidate = net.connect(endpoint.address);
		candidate.once("connect", () => {
			connecting = false;
			socket = candidate;
			socket.setNoDelay?.(true);
			socket.write(JSON.stringify({ token: endpoint.token }) + "\\n");
			for (const line of queued) socket.write(line);
			queued.length = 0;
		});
		candidate.once("error", error => {
			if (socket === candidate) return;
			if (Date.now() < deadline && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
				setTimeout(attempt, 2);
				return;
			}
			connecting = false;
			lost = "the hub did not accept a connection: " + error.message;
			look();
		});
		candidate.on("data", chunk => {
			partial += chunk.toString("utf8");
			let end;
			while ((end = partial.indexOf("\\n")) >= 0) {
				const text = partial.slice(0, end);
				partial = partial.slice(end + 1);
				if (text) lines.push(JSON.parse(text));
			}
			look();
		});
		candidate.on("close", () => {
			if (socket !== candidate) return;
			lost = lost ?? "the hub's connection ended";
			look();
		});
	};
	attempt();
}

const queued = [];
parentPort.on("message", message => {
	if (message.endpoint && !socket && !connecting) connect(message.endpoint, Date.now() + ${HUB_CALL_DEADLINE_MS});
	if (message.line) {
		if (socket) socket.write(message.line);
		else queued.push(message.line);
	}
	if (message.wait !== undefined) {
		waiting = message.wait;
		look();
	}
});
`;

interface Line {
	tick?: true;
	id?: number;
	ok?: boolean;
	result?: unknown;
	error?: { code?: string; message?: string };
	event?: string;
	data?: { to: number; items: HubItem[] };
}

/** One thing an instance told main: `k` names it. A question (`k: "ask"`) carries `ask`, `q` and `sync`. */
export interface HubItem {
	k: string;
	[key: string]: unknown;
}

/** What main does with what one instance tells it. */
export interface HubInstanceHandler {
	/** An item the instance pushed, in order. */
	item(item: HubItem): void;
	/**
	 * A question: return the answer, or (only for `sync: false`) a promise of it. A throw answers the error, with its
	 * `code` when it has one.
	 */
	ask(q: string, item: HubItem): unknown;
	/** The hub was lost (the core ended or stopped answering): the instance is gone there. */
	lost(error: CoreError): void;
}

/** Per-call timing of main's blocked waits, for the ledger's measurement (`OMP_GUI_HUB_STATS=1` logs it). */
export interface HubStats {
	calls: number;
	/** Every wait's duration in microseconds, in order (kept only while measuring). */
	waitsUs: number[];
	totalUs: number;
}

class Connection {
	readonly worker: Worker;
	readonly sab: SharedArrayBuffer;
	readonly control: Int32Array;
	readonly generation: number;
	dead: CoreError | null = null;

	constructor(endpoint: { address: string; token: string }, generation: number) {
		this.generation = generation;
		this.sab = new SharedArrayBuffer(DATA_OFFSET + INITIAL_BYTES, { maxByteLength: DATA_OFFSET + MAX_BYTES });
		this.control = new Int32Array(this.sab, 0, 4);
		this.worker = new Worker(WORKER, { eval: true, name: "ompdesk-hub", workerData: { sab: this.sab } });
		this.worker.unref();
		this.worker.postMessage({ endpoint });
	}
}

export class Hub {
	#connection: Connection | null = null;
	readonly #instances = new Map<number, HubInstanceHandler>();
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	#sequence = 0;
	/** Calls main waits for now (nested ones count): a question answered inside one must not wait itself. */
	#depth = 0;
	readonly stats: HubStats = { calls: 0, waitsUs: [], totalUs: 0 };
	measuring = process.env.OMP_GUI_HUB_STATS === "1";

	/** A new instance id, unique in this process (the core keys instances by it); the instance is opened with {@link open}. */
	nextId(): number {
		return ++instanceCount;
	}

	/** Opens instance `id` of `kind` and routes what it says to `handler`. */
	open(id: number, kind: string, opts: unknown, handler: HubInstanceHandler): void {
		this.#instances.set(id, handler);
		try {
			this.#call("hub.open", { id, kind, opts });
		} catch (error) {
			this.#instances.delete(id);
			throw error;
		}
	}

	close(id: number): void {
		if (!this.#instances.delete(id) || !this.#connection || this.#connection.dead) return;
		this.#write({ id: ++this.#sequence, method: "hub.close", params: { id } });
	}

	/** A synchronous call of instance `to`'s `method`: its value, after every item it made was handled. */
	call<T>(to: number, method: string, params: unknown = {}): T {
		return this.#call("hub.call", { to, method, params }) as T;
	}

	/** A call main does not wait for: what the instance's async rule answers when it is done. */
	callLater<T>(to: number, method: string, params: unknown = {}): Promise<T> {
		const connection = this.#connect();
		const id = ++this.#sequence;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#post(connection, { id, method: "hub.call", params: { to, method, params } });
		return promise as Promise<T>;
	}

	/** The generation of the connection now in use (a new one after each loss); 0 when none is open. */
	get generation(): number {
		return this.#connection?.generation ?? 0;
	}

	#connect(): Connection {
		const current = this.#connection;
		if (current && !current.dead) return current;
		const endpoint = core().hubEndpoint();
		const connection = new Connection(endpoint, endpoint.generation);
		connection.worker.on("message", () => this.#drain(connection));
		connection.worker.on("error", error =>
			this.#lose(connection, new CoreError("hub_lost", `the hub's thread failed: ${error.message}`)),
		);
		this.#connection = connection;
		return connection;
	}

	#post(connection: Connection, request: object): void {
		connection.worker.postMessage({ line: `${JSON.stringify(request)}\n` });
	}

	#write(request: object): void {
		const connection = this.#connect();
		this.#post(connection, request);
	}

	#call(method: string, params: unknown): unknown {
		const connection = this.#connect();
		const id = ++this.#sequence;
		this.#post(connection, { id, method, params });
		this.stats.calls++;
		this.#depth++;
		try {
			for (;;) {
				const lines = this.#wait(connection, id);
				let answer: Line | undefined;
				const after: Line[] = [];
				for (const line of lines) {
					if (answer) after.push(line);
					else if (line.id === id) answer = line;
					else this.#handle(line);
				}
				if (connection.dead) throw connection.dead;
				if (answer) {
					// What the call's own promise continuations made runs as they did: in microtasks after the caller's code.
					if (after.length > 0)
						queueMicrotask(() => {
							for (const line of after) this.#handle(line);
						});
					if (answer.ok) return answer.result;
					throw new CoreError(answer.error?.code ?? "hub_error", answer.error?.message ?? "the hub failed");
				}
			}
		} finally {
			this.#depth--;
		}
	}

	/** Blocks until the worker handed over the lines that settle `id` (or `"drain"`: whatever there is). */
	#wait(connection: Connection, id: number | "drain"): Line[] {
		const { control, worker } = connection;
		Atomics.store(control, STATE, WAITING);
		worker.postMessage({ wait: id });
		const started = this.measuring ? performance.now() : 0;
		const outcome = Atomics.wait(control, STATE, WAITING, HUB_CALL_DEADLINE_MS);
		if (this.measuring) {
			const us = Math.round((performance.now() - started) * 1000);
			this.stats.waitsUs.push(us);
			this.stats.totalUs += us;
		}
		if (outcome === "timed-out") {
			this.#lose(connection, new CoreError("hub_lost", `the hub did not answer within ${HUB_CALL_DEADLINE_MS} ms`));
			return [];
		}
		const length = Atomics.load(control, LENGTH);
		const text = new TextDecoder().decode(new Uint8Array(connection.sab, DATA_OFFSET, length).slice());
		Atomics.store(control, STATE, IDLE);
		const handed = JSON.parse(text) as { lines: Line[]; lost: string | null };
		// Lost now, not in a microtask: the caller's loop reads `dead` before it waits again.
		if (handed.lost) this.#lose(connection, new CoreError("hub_lost", handed.lost));
		return handed.lines;
	}

	/** The worker has lines and main is not waiting: fetch and handle them now. */
	#drain(connection: Connection): void {
		if (connection.dead || this.#connection !== connection) return;
		for (const line of this.#wait(connection, "drain")) this.#handle(line);
	}

	/** One line, at once, also inside another's handling: a nested call's effects run inside it, as a listener did. */
	#handle(line: Line): void {
		if (line.id !== undefined) {
			const waiting = this.#pending.get(line.id);
			if (!waiting) return;
			this.#pending.delete(line.id);
			if (line.ok) waiting.resolve(line.result);
			else waiting.reject(new CoreError(line.error?.code ?? "hub_error", line.error?.message ?? "the hub failed"));
			return;
		}
		if (line.event !== "hub.out" || !line.data) return;
		const handler = this.#instances.get(line.data.to);
		if (!handler) return;
		for (const item of line.data.items) {
			if (item.k === "ask") this.#answer(handler, item);
			else handler.item(item);
		}
	}

	#answer(handler: HubInstanceHandler, item: HubItem): void {
		const ask = item.ask as number;
		const send = (body: { value?: unknown; error?: { code?: string; message: string } }) => {
			const params = { ask, ...body };
			// Inside a call main waits for, the answer goes and that wait picks up what it wakes; otherwise main waits
			// for the continuation it wakes, as a promise's continuation ran in the resolving tick's microtasks.
			if (this.#depth > 0) this.#write({ id: ++this.#sequence, method: "hub.answer", params });
			else {
				try {
					this.#call("hub.answer", params);
				} catch {
					// A lost hub told every instance already.
				}
			}
		};
		const fail = (error: unknown) =>
			send({
				error: {
					...(error instanceof Error && "code" in error && typeof error.code === "string"
						? { code: error.code }
						: {}),
					message: error instanceof Error ? error.message : String(error),
				},
			});
		let value: unknown;
		try {
			value = handler.ask(item.q as string, item);
		} catch (error) {
			fail(error);
			return;
		}
		if (value instanceof Promise) {
			if (item.sync === true) {
				fail(new Error(`main answered the synchronous question ${String(item.q)} with a promise`));
				return;
			}
			value.then(resolved => send({ value: resolved ?? null }), fail);
			return;
		}
		send({ value: value ?? null });
	}

	#lose(connection: Connection, error: CoreError): void {
		if (connection.dead) return;
		connection.dead = error;
		// A core whose hub stopped answering, or whose hub connection ended, is a lost core: ended, and everything it ran
		// opens again on the next one (a core that already died is only forgotten).
		if (core().hubEndpointGeneration() === connection.generation) core().abandon(error.message);
		void connection.worker.terminate();
		if (this.#connection === connection) this.#connection = null;
		for (const [id, waiting] of this.#pending) {
			this.#pending.delete(id);
			waiting.reject(error);
		}
		const instances = [...this.#instances];
		this.#instances.clear();
		for (const [, handler] of instances) handler.lost(error);
	}
}

let instanceCount = 0;
let shared: Hub | null = null;

/** The one hub connection of this process. */
export function hub(): Hub {
	shared ??= new Hub();
	return shared;
}
