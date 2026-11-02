/**
 * The automatic update's last look and its quit as one step (src/main/background-work.ts `freeze`, read by
 * src/main/app-auto-update.ts at the countdown's end). `composer.freeze_jobs` reads this omp's job tree and, in the
 * same synchronous step, closes the gate every tool call passes in stock's `tool_call` hook when nothing runs and no
 * tool call is under way (a call past the gate may still register a job: a `task`, a `bash` that goes to the
 * background). A call that reaches the closed gate waits there until `composer.thaw_jobs`, the lease or the quit; the
 * relaunch continues the turn it belonged to. Every job starts from a tool call, so nothing can start between main's
 * last look and the quit. Before this, a job started in the second between that look and the install was cut by it
 * (2 Nov 2026).
 *
 * One gate per process, on `globalThis`: stock binds the extension again for each in-process subagent, and an isolated
 * subagent evaluates the module graph afresh, so a module-level gate would let its calls through.
 */

/** Stock's `tool_call` handler timeout is 30 s (`extensionHandlers.toolCallTimeoutMs`): a held call must be let go before it. */
export const JOB_GATE_MAX_LEASE_MS = 25_000;

export interface JobGateTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const NODE_TIMERS: JobGateTimers = {
	set: (run, ms) => {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return timer;
	},
	clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** What a freeze answers: whether the gate closed, and how many tool calls under way kept it open. */
export interface JobGateFreeze {
	frozen: boolean;
	starting: number;
}

export class JobGate {
	readonly #timers: JobGateTimers;
	/** Tool calls past the gate and not ended yet, by tool call id: the agent that made each. */
	readonly #underWay = new Map<string, string>();
	#closed: PromiseWithResolvers<void> | undefined;
	#lease: unknown;

	constructor(timers: JobGateTimers = NODE_TIMERS) {
		this.#timers = timers;
	}

	get frozen(): boolean {
		return this.#closed !== undefined;
	}

	/** A tool call reached stock's gate: wait while the gate is closed, then count it under way until it ends. */
	async enter(toolCallId: string, agent: string): Promise<void> {
		while (this.#closed) await this.#closed.promise;
		this.#underWay.set(toolCallId, agent);
	}

	/** A tool call ended (`tool_execution_end`, its error included). */
	leave(toolCallId: string): void {
		this.#underWay.delete(toolCallId);
	}

	/** An agent's loop ended: none of its calls is under way any more, whatever events a failure skipped. */
	agentEnded(agent: string): void {
		for (const [id, owner] of this.#underWay) if (owner === agent) this.#underWay.delete(id);
	}

	/**
	 * Close the gate for `leaseMs` (at most `JOB_GATE_MAX_LEASE_MS`) when nothing runs (`running`: the job tree's
	 * running jobs) and no tool call is under way; a second freeze renews the lease. Otherwise the gate stays as it is.
	 */
	freeze(running: boolean, leaseMs: number): JobGateFreeze {
		const starting = this.#underWay.size;
		if (running || starting > 0) return { frozen: false, starting };
		this.#closed ??= Promise.withResolvers<void>();
		if (this.#lease !== undefined) this.#timers.clear(this.#lease);
		this.#lease = this.#timers.set(() => this.thaw(), Math.min(Math.max(0, leaseMs), JOB_GATE_MAX_LEASE_MS));
		return { frozen: true, starting: 0 };
	}

	/** Open the gate; the calls it held run. False when it was open. */
	thaw(): boolean {
		const closed = this.#closed;
		if (!closed) return false;
		if (this.#lease !== undefined) this.#timers.clear(this.#lease);
		this.#lease = undefined;
		this.#closed = undefined;
		closed.resolve();
		return true;
	}
}

const PROCESS_GATE = Symbol.for("ompdesk.job-gate");

/** This process's gate (shared by every module graph the extension is evaluated in). */
export function processJobGate(): JobGate {
	const holder = globalThis as Record<symbol, unknown>;
	holder[PROCESS_GATE] ??= new JobGate();
	return holder[PROCESS_GATE] as JobGate;
}
