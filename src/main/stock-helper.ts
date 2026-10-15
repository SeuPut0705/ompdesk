import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ompPackageRoot, ompPathEnv, systemOmp } from "./omp-runtime";
import { spawnPath } from "./shell-env";

/** How long a stopped worker may take to exit before an omp update goes ahead anyway. */
const HELPER_STOP_MS = 5000;

/** How long one request may wait (queued behind others included) before only that request fails. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface StockHelperOptions {
	requestTimeoutMs?: number;
	/** Test seam: the worker process to talk to; production starts `stock-helper/host.ts` on the user's omp. */
	spawnWorker?: () => Promise<ChildProcessWithoutNullStreams>;
}

/** One lazy worker for all main-side stock operations. Keeps stock caches warm
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
	readonly #bridgeDir: string;
	readonly #requestTimeoutMs: number;
	readonly #spawnWorker: () => Promise<ChildProcessWithoutNullStreams>;

	constructor(bridgeDir: string, options: StockHelperOptions = {}) {
		this.#bridgeDir = bridgeDir;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#spawnWorker = options.spawnWorker ?? (() => this.#spawnStockWorker());
	}

	async #spawnStockWorker(): Promise<ChildProcessWithoutNullStreams> {
		const [omp, basePath] = await Promise.all([systemOmp(), spawnPath()]);
		if (!omp.ok) throw new Error(omp.error);
		const root = ompPackageRoot(omp.runtime.bin);
		if (!root) throw new Error("Cannot locate omp package");
		if (this.#stopped) throw new Error("Stock helper stopped");
		return spawn("bun", [join(this.#bridgeDir, "stock-helper", "host.ts")], {
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
				const pending = response.id === undefined ? undefined : this.#pending.get(response.id);
				if (!pending || response.id === undefined) return;
				this.#pending.delete(response.id);
				clearTimeout(pending.timer);
				if (response.error) pending.reject(new Error(response.error));
				else pending.resolve(response.result);
			});
			const failed = (error: Error) => {
				if (this.#child !== child) return;
				this.#child = null;
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

	async request<T>(method: string, params: unknown): Promise<T> {
		const child = await this.#start();
		const id = ++this.#sequence;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		// Only this request fails. The worker also holds every terminal and may be mid-mutation for another
		// caller, so a slow request never ends it; the worker is told to skip this one if it has not started.
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error("omp stock helper request timed out"));
			if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ cancel: id })}\n`, () => {});
		}, this.#requestTimeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
			if (!error) return;
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(error);
		});
		return promise as Promise<T>;
	}

	/** Ends the worker; resolves once its process is gone (an omp update must not replace files a live worker still reads). */
	stop(): Promise<void> {
		this.#stopped = true;
		const child = this.#child;
		const exited = child ? once(child, "exit").then(() => undefined) : Promise.resolve();
		child?.stdin.end();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Stock helper stopped"));
		}
		this.#pending.clear();
		return Promise.race([exited, new Promise<void>(done => setTimeout(done, HELPER_STOP_MS).unref())]);
	}
}

let bridgeDirectory = resolve("resources/gui-bridge");
let helper: StockHelper | null = null;

/** Configure the packaged resources path before the first main-side request. */
export function configureStockHelper(bridgeDir: string): void {
	if (bridgeDirectory === bridgeDir) return;
	stopStockHelper();
	bridgeDirectory = bridgeDir;
}

export function stockHelperRequest<T>(method: string, params: unknown = {}): Promise<T> {
	helper ??= new StockHelper(bridgeDirectory);
	return helper.request<T>(method, params);
}

export function stopStockHelper(): Promise<void> {
	const stopping = helper?.stop() ?? Promise.resolve();
	helper = null;
	return stopping;
}
