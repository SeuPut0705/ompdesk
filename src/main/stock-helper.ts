import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ompAvailability, refuseWithoutOmp } from "./omp-availability";
import { ompPackageRoot, ompPathEnv, systemOmp } from "./omp-runtime";
import { spawnPath } from "./shell-env";

/** How long a stopped worker may take to exit before an omp update goes ahead anyway. */
const HELPER_STOP_MS = 5000;

/** How long one request may wait (queued behind others included) before only that request fails. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long past its timeout a stock request may stay unanswered before its worker counts as hung and is replaced. */
const RECYCLE_GRACE_MS = 30_000;

/** Terminals (`terminal.*`, `pty.*`) run in their own worker: it holds every live shell, so it never ends
 * because a session scan or model validation hung; the stock worker can then be replaced without a notice
 * to anyone. The extensions worker (`extensions.*`) is a serial lane of its own: a plugin upgrade runs
 * `bun install` for minutes and must neither block the stock lane nor be recycled as hung. Everything else
 * shares the stock worker's serial lane. */
export type HelperWorker = "stock" | "terminals" | "extensions";
export function helperWorker(method: string): HelperWorker {
	if (method.startsWith("terminal.") || method.startsWith("pty.")) return "terminals";
	if (method.startsWith("extensions.")) return "extensions";
	return "stock";
}

/** Per-request options; `timeoutMs` replaces the 30 s default for calls that legitimately run long. */
export interface StockHelperRequestOptions {
	timeoutMs?: number;
}

export interface StockHelperOptions {
	/** Which worker this helper runs (`host.ts <worker>`); only the stock worker is replaced when a request hangs. */
	worker?: HelperWorker;
	requestTimeoutMs?: number;
	recycleGraceMs?: number;
	/** Test seam: the worker process to talk to; production starts `stock-helper/host.ts` on the user's omp. */
	spawnWorker?: () => Promise<ChildProcessWithoutNullStreams>;
}

/** One lazy worker for main-side stock operations. Keeps stock caches warm
 * without agent boots or per-refresh process launches; stdin ties it to the app.
 */
export class StockHelper {
	#child: ChildProcessWithoutNullStreams | null = null;
	#starting: Promise<ChildProcessWithoutNullStreams> | null = null;
	#stopped = false;
	#sequence = 0;
	#pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	/** Timed-out stock requests the worker has not answered yet: any answer (a late result, the
	 * withdrawal) shows the lane still moves; none within the grace means it is stuck. */
	#overdue = new Map<number, NodeJS.Timeout>();
	readonly #bridgeDir: string;
	readonly #worker: HelperWorker;
	readonly #requestTimeoutMs: number;
	readonly #recycleGraceMs: number;
	readonly #spawnWorker: () => Promise<ChildProcessWithoutNullStreams>;

	constructor(bridgeDir: string, options: StockHelperOptions = {}) {
		this.#bridgeDir = bridgeDir;
		this.#worker = options.worker ?? "stock";
		this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#recycleGraceMs = options.recycleGraceMs ?? RECYCLE_GRACE_MS;
		this.#spawnWorker = options.spawnWorker ?? (() => this.#spawnStockWorker());
	}

	async #spawnStockWorker(): Promise<ChildProcessWithoutNullStreams> {
		const [omp, basePath] = await Promise.all([systemOmp(), spawnPath()]);
		if (!omp.ok) throw refuseWithoutOmp(omp.error);
		const root = ompPackageRoot(omp.runtime.bin);
		if (!root) throw new Error("Cannot locate omp package");
		if (this.#stopped) throw new Error("Stock helper stopped");
		return spawn("bun", [join(this.#bridgeDir, "stock-helper", "host.ts"), this.#worker], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				PATH: ompPathEnv(omp.runtime.bin, basePath),
				OMP_PACKAGE_ROOT: root,
				PI_NOTIFICATIONS: "off",
			},
		});
	}

	async #start(): Promise<ChildProcessWithoutNullStreams> {
		if (this.#stopped) throw new Error("Stock helper stopped");
		if (this.#child) return this.#child;
		if (this.#starting) return this.#starting;
		this.#starting = (async () => {
			const child = await this.#spawnWorker();
			if (this.#stopped) {
				child.stdin.end();
				throw new Error("Stock helper stopped");
			}
			this.#child = child;
			// Stock warnings stay off the JSON-lines response stream. Do not log session data.
			child.stderr.resume();
			const input = createInterface({ input: child.stdout });
			input.on("line", line => {
				let response: { id?: number; result?: unknown; error?: string };
				try {
					response = JSON.parse(line);
				} catch {
					return;
				}
				if (response.id === undefined) return;
				clearTimeout(this.#overdue.get(response.id));
				this.#overdue.delete(response.id);
				const pending = this.#pending.get(response.id);
				if (!pending) return;
				this.#pending.delete(response.id);
				clearTimeout(pending.timer);
				if (response.error) pending.reject(new Error(response.error));
				else pending.resolve(response.result);
			});
			const failed = (error: Error) => {
				if (this.#child !== child) return;
				this.#child = null;
				this.#clearOverdue();
				for (const pending of this.#pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(error);
				}
				this.#pending.clear();
			};
			child.on("error", failed);
			child.stdin.on("error", failed);
			child.on("exit", () => failed(new Error("omp stock helper exited")));
			return child;
		})();
		try {
			return await this.#starting;
		} finally {
			this.#starting = null;
		}
	}

	#clearOverdue(): void {
		for (const timer of this.#overdue.values()) clearTimeout(timer);
		this.#overdue.clear();
	}

	/** The stock lane has not moved for a timed-out request's whole grace: end that worker (its queue
	 * would hold every later scan and validation forever) and let the next request start a fresh one. */
	#recycle(child: ChildProcessWithoutNullStreams, method: string): void {
		if (this.#child !== child) return;
		console.warn(
			`omp stock helper: "${method}" hung for ${this.#requestTimeoutMs + this.#recycleGraceMs} ms; restarting the worker`,
		);
		const error = new Error(`omp stock helper restarted: "${method}" hung`);
		this.#child = null;
		this.#clearOverdue();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		child.stdin.end();
		child.kill();
	}

	request<T>(method: string, params: unknown, options: StockHelperRequestOptions = {}): Promise<T> {
		const id = ++this.#sequence;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		// Armed before the worker starts, so a start that never finishes fails the request too.
		let child: ChildProcessWithoutNullStreams | null = null;
		// Only this request fails at first, and the worker is told to skip it if it has not started. The stock
		// worker is replaced only when its lane then stays silent past the grace; the terminals and extensions
		// workers never are (a plugin upgrade may run for minutes, a live shell must not be lost).
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error("omp stock helper request timed out"));
			if (!child) return;
			if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ cancel: id })}\n`, () => {});
			if (this.#worker !== "stock") return;
			const worker = child;
			this.#overdue.set(
				id,
				setTimeout(() => this.#recycle(worker, method), this.#recycleGraceMs),
			);
		}, options.timeoutMs ?? this.#requestTimeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		const failed = (error: Error) => {
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(error);
		};
		this.#start().then(started => {
			child = started;
			if (!this.#pending.has(id)) return;
			started.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
				if (error) failed(error);
			});
		}, failed);
		return promise as Promise<T>;
	}

	/** Ends the worker; resolves once its process is gone (an omp update must not replace files a live worker still reads). */
	stop(): Promise<void> {
		this.#stopped = true;
		const child = this.#child;
		const exited = child ? once(child, "exit").then(() => undefined) : Promise.resolve();
		child?.stdin.end();
		this.#clearOverdue();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Stock helper stopped"));
		}
		this.#pending.clear();
		return Promise.race([exited, new Promise<void>(done => setTimeout(done, HELPER_STOP_MS).unref())]);
	}
}

let bridgeDirectory = resolve("resources/gui-bridge");
const helpers: Partial<Record<HelperWorker, StockHelper>> = {};

/** Configure the packaged resources path before the first main-side request. */
export function configureStockHelper(bridgeDir: string): void {
	if (bridgeDirectory === bridgeDir) return;
	stopStockHelper();
	bridgeDirectory = bridgeDir;
}

export function stockHelperRequest<T>(
	method: string,
	params: unknown = {},
	options: StockHelperRequestOptions = {},
): Promise<T> {
	// Machine setup has omp missing or installing: no worker starts on a half-installed or absent omp.
	if (ompAvailability() === "missing") return Promise.reject(refuseWithoutOmp("omp is not installed yet"));
	const worker = helperWorker(method);
	helpers[worker] ??= new StockHelper(bridgeDirectory, { worker });
	return helpers[worker].request<T>(method, params, options);
}

/** Ends all three workers (an omp update, app quit); the next request starts them again. */
export function stopStockHelper(): Promise<void> {
	const stopping = Promise.all([helpers.stock?.stop(), helpers.terminals?.stop(), helpers.extensions?.stop()]).then(
		() => undefined,
	);
	delete helpers.stock;
	delete helpers.terminals;
	delete helpers.extensions;
	return stopping;
}
