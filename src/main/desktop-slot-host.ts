/**
 * The desktop slot's wiring (rules in desktop-slot.ts): which sidecar is which session, the bridge's three frames
 * (`desktop_slot_acquire` / `_touch` / `_release`, for main only: they leave the sidecar through `frame` and reach
 * no window), the two bridge methods main answers with (`desktop_slot.grant`, `desktop_slot.revoke`), a tab that
 * closes or whose process dies, and the state every window shows. One per app, for this computer's own omp
 * processes: the pool's local tabs and the tabs this host runs for paired devices (they drive this desktop too).
 * A tab on another computer is that computer's slot, never this one.
 */
import { basename } from "node:path";
import type { DesktopSlotState } from "../../resources/gui-bridge/desktop-slot-contracts";
import { DesktopSlot } from "./desktop-slot";
import { DESKTOP_SLOT_BRIDGE_METHODS } from "./local/desktop-slot";
import type { TabActivity } from "./sidecar-pool";
import type { SidecarLike } from "./sidecar-types";

/** What the host reads of the pool. */
export interface DesktopSlotPool {
	tabFacts(tabId: string): { title: string } | null;
	noteStopped(tabId: string): void;
}

export interface DesktopSlotHostDeps {
	pool: DesktopSlotPool;
	/** Every window hears the slot's new state. */
	broadcast(state: DesktopSlotState): void;
	/** Tests shorten the wait for a killed process to exit. */
	killConfirmMs?: number;
}

/** A revoke waits for stock's `revokeControl()` on every controller; the slot gives up on it first (10 s). */
const REVOKE_COMMAND_TIMEOUT_MS = 15_000;
const GRANT_COMMAND_TIMEOUT_MS = 10_000;
/** A killed omp that has not exited by now is not confirmed gone (SIGTERM only: the slot stays held). */
const KILL_CONFIRM_MS = 5_000;

export class DesktopSlotHost {
	readonly #slot: DesktopSlot;
	readonly #deps: DesktopSlotHostDeps;
	/** The slot's id of a sidecar: the pool's tab id, or `host:<n>` for a tab this host runs for a paired device. */
	readonly #idOf = new WeakMap<object, string>();
	readonly #sidecars = new Map<string, SidecarLike>();
	/** Last known title per id: a tab that is gone still shows under its name while it hands over. */
	readonly #titles = new Map<string, string>();
	#hosted = 0;
	readonly #killConfirmMs: number;

	constructor(deps: DesktopSlotHostDeps) {
		this.#deps = deps;
		this.#killConfirmMs = deps.killConfirmMs ?? KILL_CONFIRM_MS;
		this.#slot = new DesktopSlot({
			titleOf: id => this.#title(id),
			revoke: (id, reason) =>
				this.#call(id, DESKTOP_SLOT_BRIDGE_METHODS.revoke, { reason }, REVOKE_COMMAND_TIMEOUT_MS),
			kill: id => this.#kill(id),
			grant: (id, requestId, waited) => {
				// A grant that does not arrive proves nothing about the process, so the slot stays with that session:
				// its lease runs out and the revoke path (confirmed, or revoke-failed) decides.
				this.#call(id, DESKTOP_SLOT_BRIDGE_METHODS.grant, { requestId, waited }, GRANT_COMMAND_TIMEOUT_MS).catch(
					() => undefined,
				);
			},
			onChange: state => deps.broadcast(state),
		});
	}

	state(): DesktopSlotState {
		return this.#slot.state();
	}

	/** A pool tab's sidecar exists (pool acquire); tabs on a paired host are that host's slot. */
	attachSidecar(tabId: string, sidecar: SidecarLike): void {
		if (sidecar.device) return;
		this.#track(tabId, sidecar);
	}

	/** The pool's tab activity: a released tab hands the slot on (revoking it first when it held it). */
	observeActivity(activity: TabActivity): void {
		if (activity.type !== "released") return;
		const id = activity.tabId;
		if (!this.#sidecars.has(id)) return;
		void this.#slot.closed(id).finally(() => {
			this.#sidecars.delete(id);
			this.#titles.delete(id);
		});
	}

	/** The sidecar factory's hook: the bridge's slot frames of one omp process. */
	frame(sidecar: SidecarLike, frame: Record<string, unknown>): void {
		const id = this.#idOf.get(sidecar) ?? this.#trackHosted(sidecar);
		switch (frame.type) {
			case "desktop_slot_acquire":
				if (typeof frame.requestId === "string") this.#slot.acquire(id, frame.requestId);
				break;
			case "desktop_slot_touch":
				this.#slot.touch(id);
				break;
			case "desktop_slot_release":
				this.#slot.release(id);
				break;
		}
	}

	/** The user's Stop on the session using the screen: its run is aborted, its screen use revoked, the next one granted. */
	async stop(): Promise<void> {
		const holder = this.#slot.state().holder;
		if (!holder) return;
		this.#deps.pool.noteStopped(holder.tabId);
		this.#sidecars
			.get(holder.tabId)
			?.rpcClient?.command({ type: "abort" })
			.catch(() => undefined);
		await this.#slot.stop(holder.tabId);
	}

	/** The user's "try again" on a revoke-failed holder. */
	retry(): void {
		this.#slot.retry();
	}

	/** The user's "stop that session" on a revoke-failed holder: abort it and end its omp; frees the slot once it exited. */
	async killHolder(): Promise<boolean> {
		return this.#slot.killHolder();
	}

	/** Abort the session and end its omp process; true only once that process has exited. */
	async #kill(id: string): Promise<boolean> {
		const sidecar = this.#sidecars.get(id);
		if (!sidecar) return true;
		const exited = sidecar.whenExited?.();
		if (!exited) return false;
		this.#deps.pool.noteStopped(id);
		sidecar.rpcClient?.command({ type: "abort" }).catch(() => undefined);
		// Ends the child with SIGTERM and starts the tab's omp afresh, as the tab's own restart does.
		sidecar.restart();
		let timer: NodeJS.Timeout | undefined;
		const gone = await Promise.race([
			exited.then(() => true),
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(false), this.#killConfirmMs);
			}),
		]);
		clearTimeout(timer);
		return gone;
	}

	dispose(): void {
		this.#slot.dispose();
	}

	#track(id: string, sidecar: SidecarLike): void {
		this.#idOf.set(sidecar, id);
		this.#sidecars.set(id, sidecar);
		// The process whose exit proves it is gone: the current child, re-read whenever the sidecar is ready (a status
		// other than ready arrives after the manager already forgot its child, and a restart's `starting` comes before
		// the old child has exited).
		let exited: Promise<void> = sidecar.whenExited?.() ?? Promise.resolve();
		sidecar.on("status", (payload: { status: string }) => {
			if (payload.status === "ready") {
				exited = sidecar.whenExited?.() ?? Promise.resolve();
				return;
			}
			// `error` over a live child is a failed health check, not an exit. Anything else hands the slot on only once
			// the old process has really exited: a holder whose revoke failed may still be driving the desktop.
			if (payload.status === "error") return;
			void exited.then(() => this.#slot.crashed(id));
		});
	}

	#trackHosted(sidecar: SidecarLike): string {
		const id = `host:${++this.#hosted}`;
		this.#titles.set(id, basename(sidecar.cwd) || sidecar.cwd);
		this.#track(id, sidecar);
		return id;
	}

	#title(id: string): string {
		const title = this.#deps.pool.tabFacts(id)?.title;
		if (title) this.#titles.set(id, title);
		else if (!this.#titles.has(id)) {
			const cwd = this.#sidecars.get(id)?.cwd;
			if (cwd) this.#titles.set(id, basename(cwd) || cwd);
		}
		return this.#titles.get(id) ?? "";
	}

	async #call(id: string, method: string, params: unknown, timeoutMs: number): Promise<void> {
		const client = this.#sidecars.get(id)?.rpcClient;
		if (!client) throw new Error("That session's process is gone.");
		const response = await client.command({ type: "desktop_slot_bridge", method, params }, timeoutMs);
		if (!response.success) throw new Error(response.error ?? `${method} failed`);
	}
}
