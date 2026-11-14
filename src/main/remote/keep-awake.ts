/**
 * Keep-awake policy for the host role: while the option is on and a paired
 * device is connected, or a host tab is still running a turn, this computer
 * must not sleep. The policy itself lives in the core
 * (`crates/core/src/keepawake.rs`): the blocker is wanted at once and let go
 * after a quiet period, so a device that drops and reconnects does not flap
 * it; turning the option off lets it go immediately. This is its client, which
 * owns what must stay here: the blocker. No Electron imports — the caller
 * injects the shell's keep-awake blocker (`awakeBlocker`, `boot.awakeStart`). index.ts
 * runs a second instance for "keep awake while working": this computer's own
 * tabs, `connected` always false.
 */
import { CORE_EXITED, core } from "../core/process";

/** Quiet period after the last use before the blocker goes. */
export const KEEP_AWAKE_RELEASE_MS = 60_000;

export interface KeepAwakeBlocker {
	/** Acquire; returns the blocker id `stop` takes. */
	start(): number;
	stop(id: number): void;
}

export interface KeepAwakeInput {
	/** The option is on (and the host role is running). */
	enabled: boolean;
	/** At least one paired device is connected. */
	connected: boolean;
	/** At least one host tab is running a turn. */
	running: boolean;
}

export interface KeepAwakeOptions {
	blocker: KeepAwakeBlocker;
	releaseMs?: number;
	/**
	 * `held` changed on the policy's own schedule (the debounced release).
	 * Changes made inside `update()` are visible to its caller right away.
	 */
	onChange?: () => void;
}

/** What the core's `keepAwake.changed` event carries. */
interface Changed {
	policy: number;
	held: boolean;
	own: boolean;
}

interface Route {
	changed(held: boolean, own: boolean): void;
	/** The core ended: its policy is gone with it. */
	lost(): void;
}

/** The instances by their core policy: one subscription serves them all. */
const routes = new Map<number, Route>();
let listening = false;

function listen(): void {
	if (listening) return;
	listening = true;
	core().on("keepAwake.changed", data => {
		const { policy, held, own } = data as Changed;
		routes.get(policy)?.changed(held, own);
	});
	core().on(CORE_EXITED, () => {
		for (const route of [...routes.values()]) route.lost();
	});
}

export class KeepAwakePolicy {
	readonly #blocker: KeepAwakeBlocker;
	readonly #releaseMs: number | undefined;
	readonly #onChange: (() => void) | undefined;
	/** The blocker's id while the core says it is held; written only from its events. */
	#blockerId: number | null = null;
	/** The core's policy; opened again after a core that ended, until `dispose`. */
	#opened: Promise<number> | null = null;
	/** Calls to the core run one after another, so the core sees the updates in the order they were made. */
	#tail: Promise<unknown> = Promise.resolve();
	#disposed = false;

	constructor(options: KeepAwakeOptions) {
		this.#blocker = options.blocker;
		this.#releaseMs = options.releaseMs;
		this.#onChange = options.onChange;
		// A failure here surfaces on the first `update`, which opens again.
		this.#policy().catch(() => {});
	}

	/** The blocker is held now (in use, or within the quiet period after). */
	get held(): boolean {
		return this.#blockerId !== null;
	}

	/** The core's policy number, for what runs in the core and drives this policy itself (the host role). */
	policyId(): Promise<number> {
		return this.#policy();
	}

	/** Resolves once the core has applied the input and main has heard every change it caused. */
	update(input: KeepAwakeInput): Promise<void> {
		const run = this.#tail.then(async () => {
			if (this.#disposed) return;
			const policy = await this.#policy();
			await core().call("keepAwake.update", { policy, ...input });
		});
		this.#tail = run.catch(() => {});
		return run;
	}

	/** Release now, whatever the state (quit): the blocker goes here at once, the core is told after. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#releaseBlocker();
		const opened = this.#opened;
		this.#opened = null;
		if (!opened) return;
		this.#tail = this.#tail
			.then(async () => {
				const policy = await opened;
				routes.delete(policy);
				await core().call("keepAwake.dispose", { policy });
			})
			.catch(() => {});
	}

	#policy(): Promise<number> {
		if (this.#opened) return this.#opened;
		listen();
		const opened = core()
			.call<{ policy: number }>(
				"keepAwake.open",
				this.#releaseMs === undefined ? {} : { releaseMs: this.#releaseMs },
			)
			.then(({ result }) => {
				if (!this.#disposed) routes.set(result.policy, this.#route(result.policy));
				return result.policy;
			});
		this.#opened = opened;
		// A failed open is tried again by the next call.
		opened.catch(() => {
			if (this.#opened === opened) this.#opened = null;
		});
		return opened;
	}

	#route(policy: number): Route {
		return {
			changed: (held, own) => {
				if (this.#disposed) return;
				if (held) {
					this.#blockerId ??= this.#blocker.start();
					return;
				}
				this.#releaseBlocker();
				if (own) this.#onChange?.();
			},
			lost: () => {
				routes.delete(policy);
				this.#opened = null;
				const held = this.held;
				this.#releaseBlocker();
				if (held) this.#onChange?.();
			},
		};
	}

	#releaseBlocker(): void {
		if (this.#blockerId === null) return;
		const id = this.#blockerId;
		this.#blockerId = null;
		this.#blocker.stop(id);
	}
}
