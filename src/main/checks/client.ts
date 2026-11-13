/**
 * Main's client of the checks hub in the core process (`native/ompdesk/crates/core/src/checks`): one hub per
 * instance, opened on its first call and again after a core that ended (the hub's state is the core's, so a fresh
 * core starts from what its sources read). `fake: true` opens the scripted hub of tests and the dev harness.
 */
import {
	type Answer,
	CHECKS_WIRE,
	type FakeCall,
	type FakeOp,
	type MainFact,
	type Origin,
	type RunResult,
	type Snapshot,
	type StartReply,
	type StartRequest,
	type StatusRequest,
	type WaitRequest,
} from "../../shared/checks-contract";
import type { FakeChecksHub } from "../../shared/checks-fixture";
import { CORE_EXITED, CoreError, core } from "../core/process";
import type { CoreRunner } from "../local/git/exec";

/** A wait is the core's to end (its own timeout, at most an hour); this only outlasts it. */
const WAIT_CALL_MS = 2 ** 31 - 1;

interface Route {
	snapshot(snapshot: Snapshot): void;
	result(result: RunResult): void;
	/** The core ended: the hub is gone with it. */
	lost(): void;
}

/** The instances by hub id: one subscription per event serves them all. */
const routes = new Map<number, Route>();
let listening = false;
let lastHub = 0;

function listen(): void {
	if (listening) return;
	listening = true;
	core().on(CHECKS_WIRE.snapshot, data => {
		const { hub, snapshot } = data as { hub: number; snapshot: Snapshot };
		routes.get(hub)?.snapshot(snapshot);
	});
	core().on(CHECKS_WIRE.result, data => {
		const { hub, result } = data as { hub: number; result: RunResult };
		routes.get(hub)?.result(result);
	});
	core().on(CORE_EXITED, () => {
		for (const route of [...routes.values()]) route.lost();
	});
}

export class CoreChecksHub implements FakeChecksHub {
	readonly #fake: boolean;
	#id = 0;
	#opened: Promise<void> | null = null;
	#closed = false;
	#last: Snapshot | null = null;
	readonly #watchers = new Set<(snapshot: Snapshot) => void>();
	readonly #resultListeners = new Set<(result: RunResult) => void>();

	constructor(options: { fake?: boolean } = {}) {
		this.#fake = options.fake === true;
	}

	start(origin: Origin, request: StartRequest): Promise<StartReply> {
		return this.#call(CHECKS_WIRE.start, { origin, request });
	}

	async wait(origin: Origin, request: WaitRequest, signal?: AbortSignal): Promise<Answer> {
		signal?.throwIfAborted();
		return this.#call(CHECKS_WIRE.wait, { origin, request }, { timeoutMs: WAIT_CALL_MS, signal });
	}

	status(origin: Origin, request: StatusRequest): Promise<Snapshot> {
		return this.#call(CHECKS_WIRE.status, { origin, request });
	}

	watch(listener: (snapshot: Snapshot) => void): () => void {
		this.#watchers.add(listener);
		if (this.#watchers.size === 1) this.#setWatching(true);
		else if (this.#last) listener(this.#last);
		return () => {
			if (this.#watchers.delete(listener) && this.#watchers.size === 0) this.#setWatching(false);
		};
	}

	onResult(listener: (result: RunResult) => void): () => void {
		this.#resultListeners.add(listener);
		// Results are sent from the hub's opening on.
		this.#open().catch(() => {});
		return () => this.#resultListeners.delete(listener);
	}

	async pause(paused: boolean): Promise<void> {
		await this.#call(CHECKS_WIRE.pause, { paused });
	}

	async told(fact: MainFact): Promise<void> {
		await this.#call(CHECKS_WIRE.facts, { fact });
	}

	/** How gh and git run from now on (`ghRunner`, `gitRunner`; null: not installed); `home` is where gh runs. */
	async runners(gh: CoreRunner | null, git: CoreRunner | null, home: string): Promise<void> {
		await this.#call(CHECKS_WIRE.runners, { gh, git, home });
	}

	apply(op: FakeOp): Promise<FakeCall[] | null> {
		return this.#call(CHECKS_WIRE.fake, { op });
	}

	/** Ends the hub in the core; this instance answers nothing after. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#watchers.clear();
		this.#resultListeners.clear();
		const opened = this.#opened;
		this.#opened = null;
		if (!opened) return;
		const id = this.#id;
		routes.delete(id);
		await opened.then(
			() => core().call(CHECKS_WIRE.close, { hub: id }),
			() => {},
		);
	}

	#setWatching(on: boolean): void {
		this.#call<Snapshot>(CHECKS_WIRE.watch, { on }).then(
			snapshot => {
				if (on) this.#show(snapshot);
			},
			// A core that cannot answer shows nothing; the next core's hub is watched again by `lost`.
			() => {},
		);
	}

	#show(snapshot: Snapshot): void {
		this.#last = snapshot;
		for (const watcher of [...this.#watchers]) watcher(snapshot);
	}

	#open(): Promise<void> {
		if (this.#closed) return Promise.reject(new CoreError("no_hub", "this checks hub was closed"));
		if (this.#opened) return this.#opened;
		listen();
		lastHub += 1;
		const id = lastHub;
		this.#id = id;
		routes.set(id, {
			snapshot: snapshot => this.#show(snapshot),
			result: result => {
				for (const listener of [...this.#resultListeners]) listener(result);
			},
			lost: () => {
				if (this.#id !== id) return;
				routes.delete(id);
				this.#opened = null;
				if (this.#watchers.size > 0) this.#setWatching(true);
				else if (this.#resultListeners.size > 0) this.#open().catch(() => {});
			},
		});
		const opened = core()
			.call(CHECKS_WIRE.open, { hub: id, fake: this.#fake })
			.then(
				() => undefined,
				error => {
					if (this.#opened === opened) this.#opened = null;
					routes.delete(id);
					throw error;
				},
			);
		this.#opened = opened;
		return opened;
	}

	async #call<T>(
		method: string,
		params: Record<string, unknown>,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
		retry = true,
	): Promise<T> {
		await this.#open();
		try {
			return (await core().call<T>(method, { hub: this.#id, ...params }, options)).result;
		} catch (error) {
			// The core started again between the open and this call: its hub is opened again, once.
			if (retry && error instanceof CoreError && error.code === "no_hub" && !this.#closed) {
				this.#opened = null;
				return this.#call(method, params, options, false);
			}
			throw error;
		}
	}
}
