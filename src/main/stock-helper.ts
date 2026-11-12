/**
 * Main-side stock operations without a tab (session scans, model validation, terminals, extension updates) run in Bun
 * workers on the user's omp (`resources/gui-bridge/stock-helper/host.ts`). The core process starts and supervises them
 * (`native/ompdesk/crates/core/src/stock`): which worker a method runs in, each request's timeout and withdrawal, the
 * stock worker that hung, the extensions worker's idle exit, the worker that outlived a reinstall of omp. This file
 * is its client: the request, and how a worker starts when the core asks (omp is resolved only then).
 */
import { join, resolve } from "node:path";
import { withoutControlEnv } from "./control-socket/env";
import { CoreError, core } from "./core/process";
import { OmpUnavailableError, ompAvailability, refuseWithoutOmp } from "./omp-availability";
import { ompPackageRoot, ompPathEnv, systemOmp } from "./omp-runtime";
import { spawnPath } from "./shell-env";

/** How long one request may wait (queued behind others included) before only that request fails. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The core fails a request at its timeout; main's own bound on the core's answer sits this far behind it. */
const CORE_ANSWER_SLACK_MS = 10_000;

/** The workers the core runs: `terminal.*`/`pty.*` → terminals, `extensions.*` → extensions, everything else → stock. */
export type HelperWorker = "stock" | "terminals" | "extensions";

/** Per-request options; `timeoutMs` replaces the 30 s default for calls that legitimately run long. */
export interface StockHelperRequestOptions {
	timeoutMs?: number;
}

/** How a worker starts. */
export interface WorkerLaunch {
	bin: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	/** The file whose time and size identify the installed omp (its package.json): a stock or extensions worker that
	 * was started on another install is let go when idle and started fresh. */
	stampFile?: string;
}

export interface StockHelperOptions {
	requestTimeoutMs?: number;
	/** Test seam: the one worker every method of this helper runs in; production routes by method. */
	worker?: HelperWorker;
	/** Test seam: how long past its timeout a stock request may stay unanswered before its worker is replaced. */
	recycleGraceMs?: number;
	/** Test seam: ends a worker this long after its last answer (0: never); default 60 s for extensions, others never. */
	idleExitMs?: number;
	/** Test seam: how a worker starts; production starts `stock-helper/host.ts` on the user's omp. */
	launch?: (worker: HelperWorker) => Promise<WorkerLaunch>;
}

/** How each live helper's workers start, by the name the core knows the helper under. */
const launchers = new Map<string, (worker: HelperWorker) => Promise<WorkerLaunch>>();
let hosts = 0;
let answering = false;

/** Answers the core whenever it needs a worker started; subscribed once, across every core this app starts. */
function answerLaunches(): void {
	if (answering) return;
	answering = true;
	core().on("stock.launch", data => {
		const { host, worker, launch } = data as { host: string; worker: HelperWorker; launch: number };
		const started = launchers.get(host)?.(worker) ?? Promise.reject(new Error("Stock helper stopped"));
		void started
			.then(
				start => ({ start }),
				(error: unknown) => ({
					error: {
						message: error instanceof Error ? error.message : String(error),
						unavailable: error instanceof OmpUnavailableError,
					},
				}),
			)
			.then(how => core().call("stock.launched", { host, worker, launch, ...how }))
			// A core that ended meanwhile failed the requests that waited on this start.
			.catch(() => {});
	});
}

async function ompWorkerLaunch(bridgeDir: string, worker: HelperWorker): Promise<WorkerLaunch> {
	const [omp, basePath] = await Promise.all([systemOmp(), spawnPath()]);
	if (!omp.ok) throw refuseWithoutOmp(omp.error);
	const root = ompPackageRoot(omp.runtime.bin);
	if (!root) throw new Error("Cannot locate omp package");
	return {
		bin: "bun",
		args: [join(bridgeDir, "stock-helper", "host.ts"), worker],
		// The control socket's variables reach a terminal only per request (`terminalRequest`), never from here.
		env: {
			...withoutControlEnv(process.env),
			PATH: ompPathEnv(omp.runtime.bin, basePath),
			OMP_PACKAGE_ROOT: root,
			PI_NOTIFICATIONS: "off",
		},
		stampFile: join(root, "package.json"),
	};
}

/** One set of lazy workers in the core. They keep stock caches warm without agent boots or per-refresh process
 * launches, and end with the core, which ends with the app. */
export class StockHelper {
	readonly #host = `${process.pid}-${++hosts}`;
	readonly #requestTimeoutMs: number;
	readonly #tuning: Pick<StockHelperOptions, "worker" | "recycleGraceMs" | "idleExitMs">;
	#stopped = false;

	constructor(bridgeDir: string, options: StockHelperOptions = {}) {
		const { requestTimeoutMs, launch, ...tuning } = options;
		this.#requestTimeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#tuning = tuning;
		launchers.set(this.#host, launch ?? (worker => ompWorkerLaunch(bridgeDir, worker)));
		answerLaunches();
	}

	async request<T>(method: string, params: unknown, options: StockHelperRequestOptions = {}): Promise<T> {
		if (this.#stopped) throw new Error("Stock helper stopped");
		const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
		// The params and the result cross the core as the JSON text main and the worker wrote, in the frame's bytes: the
		// core passes them on unread (a terminal's scrollback is a megabyte). No bytes is JavaScript's `undefined`.
		const text: string | undefined = JSON.stringify(params);
		try {
			const { bin } = await core().call(
				"stock.request",
				{ host: this.#host, method, timeoutMs, tuning: this.#tuning },
				{ bin: text === undefined ? undefined : Buffer.from(text), timeoutMs: timeoutMs + CORE_ANSWER_SLACK_MS },
			);
			return (bin ? JSON.parse(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).toString()) : undefined) as T;
		} catch (error) {
			// The helper's own failures are plain errors with its message, as its callers read them; a failure of the
			// core itself stays a `CoreError`.
			if (!(error instanceof CoreError)) throw error;
			if (error.code === "omp_unavailable") throw new OmpUnavailableError(error.message);
			throw error.code.startsWith("stock_") ? new Error(error.message) : error;
		}
	}

	/** Ends the workers; resolves once their processes are gone (an omp update must not replace files a live worker
	 * still reads), or 5 s later. */
	async stop(): Promise<void> {
		this.#stopped = true;
		launchers.delete(this.#host);
		// No core, no workers (they end with it); a core is never started to stop nothing.
		if (core().pid === null) return;
		await core()
			.call("stock.stop", { host: this.#host })
			.catch(() => {});
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

export function stockHelperRequest<T>(
	method: string,
	params: unknown = {},
	options: StockHelperRequestOptions = {},
): Promise<T> {
	// Machine setup has omp missing or installing: no worker starts on a half-installed or absent omp.
	if (ompAvailability() === "missing") return Promise.reject(refuseWithoutOmp("omp is not installed yet"));
	helper ??= new StockHelper(bridgeDirectory);
	return helper.request<T>(method, params, options);
}

/** Ends every worker (an omp update, app quit); the next request starts them again. */
export function stopStockHelper(): Promise<void> {
	const stopping = helper?.stop() ?? Promise.resolve();
	helper = null;
	return stopping;
}
