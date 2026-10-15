/**
 * The GUI's stats dashboard server: omp's own dashboard API (`@oh-my-pi/omp-stats`
 * from the user's omp install), hosted by resources/gui-bridge/stats-host.ts.
 * `omp stats` itself is not used: it always opens a browser tab.
 *
 * Spawned on app start, killed on quit, localhost-only on a private ephemeral
 * port (separate GUI instances must not share an index or listener). If an
 * external process already owns the port, this reports the conflict rather
 * than silently using it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { MAX_RESTART_ATTEMPTS, RestartBudget, type Revive } from "./stats-restart-policy";

/** How long `kill()` waits for the process to exit (an omp update replaces the files it reads). */
const STOP_WAIT_MS = 5000;

/** How to start the dashboard process; it must print `http://127.0.0.1:<port>` once listening. */
export interface StatsLaunch {
	command: string;
	args: string[];
	/** Overlaid on the inherited environment. */
	env?: Record<string, string>;
}

export class StatsServerManager extends EventEmitter {
	#child: ChildProcess | null = null;
	#budget = new RestartBudget();
	#restartTimer: NodeJS.Timeout | null = null;
	#disposed = false;
	#port = 0;
	readonly #launch: StatsLaunch;

	constructor(launch: StatsLaunch) {
		super();
		this.#launch = launch;
	}

	get port(): number {
		return this.#port;
	}

	start(): void {
		if (this.#disposed) return;
		this.#spawn();
	}

	/**
	 * Bring the server up because something now wants to read it. Without this,
	 * a manager that spent its restart budget stays at port 0 for the rest of the
	 * session and every dashboard read answers "not ready" forever.
	 */
	ensureRunning(): Revive {
		if (this.#disposed) return "exhausted";
		if (this.#child || this.#restartTimer) return "already-pending";
		const verdict = this.#budget.revive(Date.now());
		if (verdict === "scheduled") this.#spawn();
		return verdict;
	}

	#spawn(): void {
		const { command, args, env } = this.#launch;
		console.log(`[stats-server] spawning: ${command} ${args.join(" ")}`);
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				// stdin stays an open pipe: stats-host exits when it closes, so a
				// crashed or force-killed app never leaves the server orphaned.
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...env, PI_NOTIFICATIONS: "off" },
				windowsHide: true,
			});
		} catch (err) {
			// spawn() throws synchronously (e.g. EBADF/ENOENT) — treat like a
			// failed child so it retries gracefully instead of crashing the main
			// process with an uncaught-exception dialog.
			this.#attemptRestart(err instanceof Error ? err.message : String(err));
			return;
		}
		this.#child = child;

		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString("utf-8")).slice(-4096);
			const text = stripVTControlCharacters(stdout);
			const match = /http:\/\/(?:localhost|127\.0\.0\.1):([0-9]+)(?=[\s/])/.exec(text);
			if (match && Number(match[1]) > 0) {
				this.#port = Number(match[1]);
				this.#budget.noteReady();
				console.log(`[stats-server] ready on http://localhost:${this.#port}`);
				this.emit("ready", this.#port);
				stdout = "";
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8").trim();
			if (text) console.error(`[stats-server stderr] ${text}`);
		});
		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#child = null;
			if (this.#disposed) return;
			if (code === 0) {
				this.emit("exit", code);
				return;
			}
			this.#attemptRestart(`exit code ${code}${signal ? ` (${signal})` : ""}`);
		});
		child.on("error", err => {
			if (this.#child !== child) return;
			this.#child = null;
			if (this.#disposed) return;
			this.#attemptRestart(err.message);
		});
	}

	#attemptRestart(reason: string): void {
		this.#port = 0;
		this.emit("exit", null);
		const delay = this.#budget.nextDelay();
		if (delay === null) {
			console.error(`[stats-server] failed after ${MAX_RESTART_ATTEMPTS} attempts: ${reason}`);
			return;
		}
		console.warn(`[stats-server] restart in ${delay}ms: ${reason}`);
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			if (!this.#disposed) this.#spawn();
		}, delay);
	}

	/** Stops the server for good; resolves once its process is gone (immediately when none runs). */
	kill(): Promise<void> {
		this.#disposed = true;
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		const child = this.#child;
		this.#child = null;
		if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
		const exited = new Promise<void>(done => child.once("exit", () => done()));
		child.kill("SIGTERM");
		return Promise.race([exited, new Promise<void>(done => setTimeout(done, STOP_WAIT_MS).unref())]);
	}
}
