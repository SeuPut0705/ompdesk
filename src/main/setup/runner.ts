/**
 * Runs one install at a time under the supervisor (supervisor.ts) and reports
 * how it ended. A cancel ends the supervisor's stdin, which kills the
 * installer's process tree; the outcome is then `cancelled`, never `failed`.
 */
import type { SpawnSpec } from "./plans";
import { spawnSupervised } from "./supervisor";

export interface SupervisedChild {
	readonly stdin: { end(): void } | null;
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	once(event: "error", listener: (error: Error) => void): unknown;
	once(event: "close", listener: (code: number | null) => void): unknown;
}

export type Spawner = (spec: SpawnSpec, env: NodeJS.ProcessEnv, cwd?: string) => SupervisedChild;

export type RunOutcome =
	| { kind: "succeeded" }
	| { kind: "cancelled" }
	| { kind: "failed"; reason: "exit" | "spawn"; exitCode: number | null; detail?: string };

/** Exit status 127: the supervisor (or a shell) could not start the command. */
const NOT_STARTED = 127;

/** CSI escape sequences (colors, cursor moves), dropped from the one-line failure detail. */
const CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export class SetupRunner {
	readonly #spawn: Spawner;
	#child: SupervisedChild | null = null;
	#cancelled = false;

	constructor(spawner: Spawner = spawnSupervised) {
		this.#spawn = spawner;
	}

	get running(): boolean {
		return this.#child !== null;
	}

	/** Run `spec`; `onOutput` gets stdout and stderr chunks as they arrive. One run at a time. */
	run(spec: SpawnSpec, env: NodeJS.ProcessEnv, onOutput: (chunk: string) => void, cwd?: string): Promise<RunOutcome> {
		if (this.#child) return Promise.reject(new Error("An install is already running"));
		this.#cancelled = false;
		let child: SupervisedChild;
		try {
			child = this.#spawn(spec, env, cwd);
		} catch (error) {
			return Promise.resolve({
				kind: "failed",
				reason: "spawn",
				exitCode: null,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
		const { promise, resolve } = Promise.withResolvers<RunOutcome>();
		this.#child = child;
		let lastLine = "";
		const forward = (chunk: string) => {
			const lines = chunk
				.replace(CSI, "")
				.split(/\r?\n|\r/)
				.filter(line => line.trim());
			lastLine = lines.at(-1)?.trim() ?? lastLine;
			onOutput(chunk);
		};
		for (const stream of [child.stdout, child.stderr]) {
			stream?.setEncoding("utf8");
			stream?.on("data", forward);
		}
		let settled = false;
		const finish = (outcome: RunOutcome) => {
			if (settled) return;
			settled = true;
			this.#child = null;
			resolve(this.#cancelled ? { kind: "cancelled" } : outcome);
		};
		child.once("error", error => finish({ kind: "failed", reason: "spawn", exitCode: null, detail: error.message }));
		child.once("close", code => {
			if (code === 0) finish({ kind: "succeeded" });
			else if (code === NOT_STARTED) finish({ kind: "failed", reason: "spawn", exitCode: code, detail: lastLine });
			else finish({ kind: "failed", reason: "exit", exitCode: code, detail: lastLine || undefined });
		});
		return promise;
	}

	/** Stop the running install and its process tree; false when nothing runs. */
	cancel(): boolean {
		if (!this.#child) return false;
		this.#cancelled = true;
		this.#child.stdin?.end();
		return true;
	}
}
