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
	type LocalPool,
	type LocalRunAsk,
	type MainFact,
	type Origin,
	type RemoteRun,
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
import type { AdmissionKey } from "./admission-key";

/** A wait is the core's to end (its own timeout, at most an hour); this only outlasts it. */
const WAIT_CALL_MS = 2 ** 31 - 1;

/** One durable notification. The delivery id is opaque and identifies its delivery phase. */
export interface ChecksDelivery {
	deliveryId: string;
	result: RunResult;
}

interface Route {
	snapshot(snapshot: Snapshot): void;
	result(delivery: ChecksDelivery): void;
	remoteRun(run: RemoteRun): void;
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
		const { hub, result, deliveryId } = data as { hub: number } & ChecksDelivery;
		routes.get(hub)?.result({ result, deliveryId });
	});
	core().on(CHECKS_WIRE.remoteRun, data => {
		const { hub, run } = data as { hub: number; run: RemoteRun };
		routes.get(hub)?.remoteRun(run);
	});
	core().on(CORE_EXITED, () => {
		for (const route of [...routes.values()]) route.lost();
	});
}

export class CoreChecksHub implements FakeChecksHub {
	readonly #fake: boolean;
	readonly #admission: (() => Promise<AdmissionKey | null>) | undefined;
	#id = 0;
	#opened: Promise<void> | null = null;
	#closed = false;
	#last: Snapshot | null = null;
	readonly #watchers = new Set<(snapshot: Snapshot) => void>();
	readonly #resultListeners = new Set<(result: RunResult) => void>();
	readonly #deliveryListeners = new Set<(delivery: ChecksDelivery) => void>();
	readonly #remoteListeners = new Set<(run: RemoteRun) => void>();

	/** `admission`: this computer's admission key for the hub's tickets, asked at each open (`admission-key.ts`). */
	constructor(options: { fake?: boolean; admission?: () => Promise<AdmissionKey | null> } = {}) {
		this.#fake = options.fake === true;
		this.#admission = options.admission;
	}

	/**
	 * The id the core knows this hub by, opening it first: what code in the core that asks the hub in-process is given
	 * (the agent tool's body, `agentControl.open {checks}`). It changes when the hub is opened again after a core ended.
	 */
	async id(): Promise<number> {
		await this.#open();
		return this.#id;
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

	/** Results may be redelivered until `ackResult` follows durable acceptance by the consumer. */
	onDelivery(listener: (delivery: ChecksDelivery) => void): () => void {
		this.#deliveryListeners.add(listener);
		this.#open().catch(() => {});
		return () => this.#deliveryListeners.delete(listener);
	}

	/** Acknowledge only after the consumer has durably accepted this delivery. */
	async ackResult(deliveryId: string): Promise<void> {
		await this.#call(CHECKS_WIRE.ackResult, { deliveryId });
	}

	/** Every check the hub placed on a paired computer, for main to send over the link (`remoteAnswer` its answer). */
	onRemoteRun(listener: (run: RemoteRun) => void): () => void {
		this.#remoteListeners.add(listener);
		this.#open().catch(() => {});
		return () => this.#remoteListeners.delete(listener);
	}

	/** What the paired computer answered for a `RemoteRun`, or why it gave none (the hub then runs it on GitHub). */
	async remoteAnswer(id: string, outcome: { answer: Answer } | { error: string }): Promise<void> {
		await this.#call(CHECKS_WIRE.remoteAnswer, { id, ...outcome });
	}

	/** Runs a check another computer's hub placed on this one; ends with its answer, as long as the run takes. */
	runLocal(ask: LocalRunAsk, signal?: AbortSignal): Promise<Answer> {
		return this.#call(CHECKS_WIRE.runLocal, { ask }, { timeoutMs: WAIT_CALL_MS, signal });
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

	/** This computer's own pool as its hub's poller reads it (device `local`); a paired link forwards it as `devicePool`. */
	localPool(): Promise<LocalPool> {
		return this.#call(CHECKS_WIRE.localPool, {});
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
		this.#deliveryListeners.clear();
		this.#remoteListeners.clear();
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
			result: delivery => {
				for (const listener of [...this.#resultListeners]) listener(delivery.result);
				for (const listener of [...this.#deliveryListeners]) listener(delivery);
			},
			remoteRun: run => {
				for (const listener of [...this.#remoteListeners]) listener(run);
			},
			lost: () => {
				if (this.#id !== id) return;
				routes.delete(id);
				this.#opened = null;
				if (this.#watchers.size > 0) this.#setWatching(true);
				else if (
					this.#resultListeners.size > 0 ||
					this.#deliveryListeners.size > 0 ||
					this.#remoteListeners.size > 0
				)
					this.#open().catch(() => {});
			},
		});
		// A key that cannot be read leaves this computer's dispatches without a ticket, never the hub unopened.
		const admission = this.#admission ? this.#admission().catch(() => null) : Promise.resolve(null);
		const opened = admission
			.then(given =>
				core().call(CHECKS_WIRE.open, { hub: id, fake: this.#fake, ...(given ? { admission: given } : {}) }),
			)
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
