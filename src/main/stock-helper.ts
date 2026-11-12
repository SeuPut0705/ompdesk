import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { withoutControlEnv } from "./control-socket/env";
import { ompAvailability, refuseWithoutOmp } from "./omp-availability";
import { ompPackageRoot, ompPathEnv, systemOmp } from "./omp-runtime";
import { spawnPath } from "./shell-env";

/** How long a stopped worker may take to exit before an omp update goes ahead anyway. */
const HELPER_STOP_MS = 5000;

/** How long one request may wait (queued behind others included) before only that request fails. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long past its timeout a stock request may stay unanswered before its worker counts as hung and is replaced. */
const RECYCLE_GRACE_MS = 30_000;

/** How long the extensions worker stays up with nothing in its lane. It holds no state between requests and is
 * asked at launch, then every 4 h and when Settings opens: kept up, its stock module graph (~145 MB footprint,
 * measured on omp 18.14.0, macOS) sat idle between passes; a later request starts it again (~0.35 s). */
const EXTENSIONS_IDLE_EXIT_MS = 60_000;

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
	/** Ends the worker once every request it was sent has been answered and none came for this long (0: never);
	 * the next request starts it again. Default: the extensions worker's `EXTENSIONS_IDLE_EXIT_MS`, others never. */
	idleExitMs?: number;
	/** Test seam: the worker process to talk to; production starts `stock-helper/host.ts` on the user's omp. */
	spawnWorker?: () => Promise<ChildProcessWithoutNullStreams>;
	/** Test seam: what identifies the installed omp now (production: its package.json's time and size), or null. */
	ompStamp?: () => string | null;
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
	/** Requests written to the current worker that it has not answered yet (a timed-out one included: it may
	 * still be running, a plugin upgrade's `bun install`). The idle exit waits for none. */
	#unanswered = new Set<number>();
	#idleTimer: NodeJS.Timeout | null = null;
	readonly #idleExitMs: number;
	readonly #bridgeDir: string;
	readonly #worker: HelperWorker;
	readonly #requestTimeoutMs: number;
	readonly #recycleGraceMs: number;
	readonly #spawnWorker: () => Promise<ChildProcessWithoutNullStreams>;
	readonly #ompStamp: () => string | null;
	/** The omp package the running worker was started on, so a request can see it was replaced since. */
	#ompRoot: string | null = null;
	/** {@link StockHelperOptions.ompStamp} when the running worker started. */
	#startedStamp: string | null = null;

	constructor(bridgeDir: string, options: StockHelperOptions = {}) {
		this.#bridgeDir = bridgeDir;
		this.#worker = options.worker ?? "stock";
		this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#recycleGraceMs = options.recycleGraceMs ?? RECYCLE_GRACE_MS;
		this.#idleExitMs = options.idleExitMs ?? (this.#worker === "extensions" ? EXTENSIONS_IDLE_EXIT_MS : 0);
		this.#spawnWorker = options.spawnWorker ?? (() => this.#spawnStockWorker());
		this.#ompStamp = options.ompStamp ?? (() => this.#packageStamp());
	}

	#packageStamp(): string | null {
		if (!this.#ompRoot) return null;
		try {
			const stat = statSync(join(this.#ompRoot, "package.json"));
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return null;
		}
	}

	async #spawnStockWorker(): Promise<ChildProcessWithoutNullStreams> {
		const [omp, basePath] = await Promise.all([systemOmp(), spawnPath()]);
		if (!omp.ok) throw refuseWithoutOmp(omp.error);
		const root = ompPackageRoot(omp.runtime.bin);
		if (!root) throw new Error("Cannot locate omp package");
		this.#ompRoot = root;
		if (this.#stopped) throw new Error("Stock helper stopped");
		return spawn("bun", [join(this.#bridgeDir, "stock-helper", "host.ts"), this.#worker], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// The control socket's variables reach a terminal only per request (`terminalRequest`), never from here.
			env: {
				...withoutControlEnv(process.env),
				PATH: ompPathEnv(omp.runtime.bin, basePath),
				OMP_PACKAGE_ROOT: root,
				PI_NOTIFICATIONS: "off",
			},
		});
	}

	/**
	 * omp was reinstalled (`omp update`, a terminal's `bun install -g`) while this worker ran, and nothing is in
	 * flight on it. Its module registry holds the old files and any module it imports later comes from the new ones,
	 * so a call can fail on an export one version has and the other lacks (12 Nov 2026, Windows: "Export named
	 * 'JUDGMENT_IMAGE_PATCH_SIDE' not found" on every worktree create after an update OMPdesk did not run). Nothing
	 * in flight means no request the worker was sent is unanswered and no other request is on its way to it (the
	 * asking one is in `#pending` too). The terminals worker is never retired here: its live shells would go with it.
	 */
	#outlivedItsOmp(): boolean {
		if (this.#worker === "terminals" || this.#startedStamp === null) return false;
		if (this.#unanswered.size > 0 || this.#pending.size > 1) return false;
		const now = this.#ompStamp();
		return now !== null && now !== this.#startedStamp;
	}

	/** Lets the worker go with nothing in flight: it ends on its stdin, and the next request starts a fresh one. */
	#retire(child: ChildProcessWithoutNullStreams): void {
		console.warn(`omp stock helper: omp changed under the ${this.#worker} worker; starting a fresh one`);
		this.#child = null;
		this.#clearOverdue();
		this.#clearIdle();
		child.stdin.end();
	}

	async #start(): Promise<ChildProcessWithoutNullStreams> {
		if (this.#stopped) throw new Error("Stock helper stopped");
		if (this.#child && this.#outlivedItsOmp()) this.#retire(this.#child);
		if (this.#child) return this.#child;
		if (this.#starting) return this.#starting;
		this.#starting = (async () => {
			const child = await this.#spawnWorker();
			if (this.#stopped) {
				child.stdin.end();
				throw new Error("Stock helper stopped");
			}
			this.#child = child;
			this.#startedStamp = this.#ompStamp();
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
				this.#unanswered.delete(response.id);
				this.#armIdleExit(child);
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
				this.#clearIdle();
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

	#clearIdle(): void {
		clearTimeout(this.#idleTimer ?? undefined);
		this.#idleTimer = null;
		this.#unanswered.clear();
	}

	/** Every request this worker was sent is answered: end it if nothing new comes within the idle exit. */
	#armIdleExit(child: ChildProcessWithoutNullStreams): void {
		if (this.#idleExitMs <= 0 || this.#unanswered.size > 0 || this.#child !== child) return;
		clearTimeout(this.#idleTimer ?? undefined);
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = null;
			if (this.#child !== child || this.#unanswered.size > 0) return;
			// Its exit then finds another `#child` (or none) and fails nothing; the next request starts a fresh one.
			this.#child = null;
			child.stdin.end();
		}, this.#idleExitMs);
		this.#idleTimer.unref();
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
		this.#clearIdle();
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
		// A request keeps the worker up: the idle exit re-arms once this one is answered.
		clearTimeout(this.#idleTimer ?? undefined);
		this.#idleTimer = null;
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
			if (!this.#pending.has(id)) {
				this.#armIdleExit(started);
				return;
			}
			this.#unanswered.add(id);
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
		this.#clearIdle();
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
