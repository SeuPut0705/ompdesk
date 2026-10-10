import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ompPackageRoot, ompPathEnv, systemOmp } from "./omp-runtime";
import { spawnPath } from "./shell-env";

/** One lazy worker for all main-side stock operations. Keeps stock caches warm
 * without agent boots or per-refresh process launches; stdin ties it to the app.
 */
class StockHelper {
	#child: ChildProcessWithoutNullStreams | null = null;
	#starting: Promise<ChildProcessWithoutNullStreams> | null = null;
	#stopped = false;
	#sequence = 0;
	#pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	readonly #bridgeDir: string;

	constructor(bridgeDir: string) {
		this.#bridgeDir = bridgeDir;
	}

	async #start(): Promise<ChildProcessWithoutNullStreams> {
		if (this.#stopped) throw new Error("Stock helper stopped");
		if (this.#child) return this.#child;
		if (this.#starting) return this.#starting;
		this.#starting = (async () => {
			const [omp, basePath] = await Promise.all([systemOmp(), spawnPath()]);
			if (!omp.ok) throw new Error(omp.error);
			const root = ompPackageRoot(omp.runtime.bin);
			if (!root) throw new Error("Cannot locate omp package");
			if (this.#stopped) throw new Error("Stock helper stopped");
			const child = spawn("bun", [join(this.#bridgeDir, "stock-helper", "host.ts")], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				env: {
					...process.env,
					PATH: ompPathEnv(omp.runtime.bin, basePath),
					OMP_PACKAGE_ROOT: root,
					PI_NOTIFICATIONS: "off",
				},
			});
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
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error("omp stock helper request timed out"));
			// Avoid queued mutations executing after their caller has timed out.
			child.kill();
		}, 30_000);
		this.#pending.set(id, { resolve, reject, timer });
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
			if (!error) return;
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(error);
		});
		return promise as Promise<T>;
	}

	stop(): void {
		this.#stopped = true;
		this.#child?.stdin.end();
		this.#child?.kill();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Stock helper stopped"));
		}
		this.#pending.clear();
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

export function stopStockHelper(): void {
	helper?.stop();
	helper = null;
}
