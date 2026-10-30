/**
 * OMPdesk's MCP hub, main's side: ONE Bun process per app (resources/gui-bridge/mcp-hub.ts) that serves the built-in
 * MCP servers every omp mounts (`rea`, `ompdesk-memory`) over loopback HTTP, instead of three helper processes per
 * omp. Kept out of main's event loop on purpose: main keeps the window responsive, and REA results and memory traffic
 * stay in the hub.
 *
 * - The secret is minted once per launch and the port is kept across restarts (a crashed hub comes back on it), so
 *   every omp's env (`ompEnv`, expanded by stock when it reads the `.mcp.json`) stays valid for the app's lifetime and
 *   an omp's http MCP client reconnects to the restarted hub by itself.
 * - stdin stays an open pipe: the hub exits when it closes, so a crashed or force-killed app leaves no hub or REA.
 * - It runs at the agents' scheduling priority (agent-priority.ts): what it does is agent work.
 * - Started before the first omp; an omp's spawn waits for its first listening line (tens of ms), at most
 *   `READY_WAIT_MS`, then goes on without it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MCP_AUTH_ENV, MCP_CWD_ENV, MCP_HUB_ENV } from "../../resources/gui-bridge/mcp-hub-contracts";
import type { LowerAgentPriority } from "./agent-priority";
import { RestartBudget } from "./restart-policy";

const READY_WAIT_MS = 10_000;
const STOP_WAIT_MS = 5_000;

export interface McpHubLaunch {
	/** `<bridgeDir>/mcp-hub.ts`. */
	script: string;
	/** The hub's environment over main's: PATH with Bun and npx (the omp spawn PATH), proxy settings. */
	env: () => Promise<Record<string, string>>;
	/** Where REA's startup cache lives (`<userData>/rea`). */
	reaCacheDir: string;
	/** Memory's state file (src/main/ai-memory/recall-state.ts). */
	memoryStateFile: string;
	lowerPriority?: LowerAgentPriority;
	/** One line per start, exit and restart (`gui-runtime.jsonl`). */
	log?: (message: string, details?: Record<string, unknown>) => void;
}

export class McpHub {
	readonly #launch: McpHubLaunch;
	readonly #secret = randomBytes(32).toString("hex");
	readonly #budget = new RestartBudget();
	#child: ChildProcess | null = null;
	#port = 0;
	#ready = Promise.withResolvers<void>();
	#restartTimer: NodeJS.Timeout | null = null;
	#started = false;
	#spawning = false;
	#disposed = false;

	constructor(launch: McpHubLaunch) {
		this.#launch = launch;
	}

	get port(): number {
		return this.#port;
	}

	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.#spawn();
	}

	/**
	 * What an omp spawned in `cwd` needs to reach the hub. Empty when the hub never listened (its server entries then
	 * fail to connect, as a missing helper did before).
	 */
	async ompEnv(cwd: string): Promise<Record<string, string>> {
		this.start();
		this.#revive();
		if (this.#port === 0) {
			const timer = Promise.withResolvers<void>();
			const handle = setTimeout(timer.resolve, READY_WAIT_MS);
			await Promise.race([this.#ready.promise, timer.promise]);
			clearTimeout(handle);
		}
		if (this.#port === 0) return {};
		return {
			[MCP_HUB_ENV]: `http://127.0.0.1:${this.#port}`,
			[MCP_AUTH_ENV]: `Bearer ${this.#secret}`,
			[MCP_CWD_ENV]: encodeURIComponent(cwd),
		};
	}

	async #spawn(): Promise<void> {
		if (this.#disposed) return;
		const { script, reaCacheDir, memoryStateFile } = this.#launch;
		let child: ChildProcess;
		this.#spawning = true;
		try {
			const env = await this.#launch.env();
			if (this.#disposed) return;
			child = spawn("bun", [script], {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					...env,
					OMP_GUI_MCP_HUB_SECRET: this.#secret,
					OMP_GUI_MCP_HUB_PORT: String(this.#port),
					OMP_GUI_REA_CACHE: reaCacheDir,
					OMP_GUI_MEMORY: memoryStateFile,
				},
				windowsHide: true,
			});
		} catch (error) {
			this.#restart(error instanceof Error ? error.message : String(error));
			return;
		} finally {
			this.#spawning = false;
		}
		this.#child = child;
		this.#launch.lowerPriority?.(child.pid);
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString("utf8")).slice(-512);
			const match = /mcp-hub listening http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
			if (!match) return;
			stdout = "";
			this.#port = Number(match[1]);
			this.#budget.noteReady();
			this.#launch.log?.("listening", { port: this.#port, pid: child.pid });
			this.#ready.resolve();
		});
		// REA's own stderr comes through here too; it has no reader but must not fill the pipe.
		child.stderr?.resume();
		child.on("error", error => {
			if (this.#child !== child) return;
			this.#child = null;
			this.#restart(error.message);
		});
		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#child = null;
			this.#restart(`exit code ${code}${signal ? ` (${signal})` : ""}`);
		});
	}

	#restart(reason: string): void {
		if (this.#disposed) return;
		const delay = this.#budget.nextDelay();
		this.#launch.log?.("exited", { reason, restartInMs: delay });
		if (delay === null) return;
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			void this.#spawn();
		}, delay);
	}

	/** A spawn wants the hub after its restarts were spent: bring it up again (bounded by the budget's rounds). */
	#revive(): void {
		if (!this.#started || this.#disposed || this.#spawning || this.#child || this.#restartTimer) return;
		if (this.#budget.revive(Date.now()) === "scheduled") void this.#spawn();
	}

	/** Stops the hub for good (its REAs with it); resolves once it is gone. */
	kill(): Promise<void> {
		this.#disposed = true;
		clearTimeout(this.#restartTimer ?? undefined);
		this.#restartTimer = null;
		const child = this.#child;
		this.#child = null;
		if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
		const exited = new Promise<void>(done => child.once("exit", () => done()));
		child.stdin?.end();
		return Promise.race([exited, new Promise<void>(done => setTimeout(done, STOP_WAIT_MS).unref())]);
	}
}
