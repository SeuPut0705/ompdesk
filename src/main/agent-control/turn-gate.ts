/**
 * Holds what would start a turn in a session while the bot's conversation in it is renewed (`bot-rotation.ts`). Stock
 * `switch_session` aborts a running turn first (`AgentSession.switchSession`), so the renewal must meet no turn: it
 * holds the session's file, waits for what already went in to be answered (`busy`), re-checks that nothing runs, and
 * only then moves the tab. A prompt, a steer, a mail or a wake that comes meanwhile waits at the gate (`pass`) and goes
 * on once it opens, to the same tab: in the new conversation when the renewal went through, in the old one when it
 * stopped. Nothing is refused or dropped.
 */
/**
 * RPC commands that can start or continue a turn: held while the session renews, refused in a conversation the bot
 * ended. A mail starts one when it asks for a turn, so every mail waits.
 */
export const TURN_COMMANDS: ReadonlySet<string> = new Set([
	"prompt",
	"steer",
	"follow_up",
	"bash",
	"eval",
	"abort_and_prompt",
	"set_goal",
	"goal",
	"agent_control_mail",
]);

export class TurnGate {
	readonly #held = new Map<string, Promise<void>>();
	readonly #inflight = new Map<string, number>();
	readonly #settled = new Map<string, (() => void)[]>();

	/** Holds `sessionPath`; the returned function opens it again (idempotent). */
	hold(sessionPath: string): () => void {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#held.set(sessionPath, promise);
		let open = false;
		return () => {
			if (open) return;
			open = true;
			if (this.#held.get(sessionPath) === promise) this.#held.delete(sessionPath);
			resolve();
		};
	}

	held(sessionPath: string): boolean {
		return this.#held.has(sessionPath);
	}

	/**
	 * Waits while `file()` is held, then counts the command as in flight until `done` is called. `file` is read again
	 * after each wait: the tab may hold another file by then.
	 */
	async pass(file: () => string | null | undefined): Promise<() => void> {
		for (;;) {
			const path = file();
			const held = path ? this.#held.get(path) : undefined;
			if (!held) {
				if (!path) return () => {};
				this.#inflight.set(path, (this.#inflight.get(path) ?? 0) + 1);
				let done = false;
				return () => {
					if (done) return;
					done = true;
					const left = (this.#inflight.get(path) ?? 1) - 1;
					if (left > 0) this.#inflight.set(path, left);
					else {
						this.#inflight.delete(path);
						for (const wake of this.#settled.get(path) ?? []) wake();
						this.#settled.delete(path);
					}
				};
			}
			await held;
		}
	}

	/** Resolves once no command that passed the gate for `sessionPath` waits for its answer. */
	idle(sessionPath: string): Promise<void> {
		if (!this.#inflight.get(sessionPath)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const waiting = this.#settled.get(sessionPath) ?? [];
		waiting.push(resolve);
		this.#settled.set(sessionPath, waiting);
		return promise;
	}
}
