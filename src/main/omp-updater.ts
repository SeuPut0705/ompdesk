/**
 * Keeps this computer's omp current. While OMPdesk runs it asks stock
 * `omp update --check` (SetupService.latestOmp: the omp OMPdesk runs, with the
 * user's registry, channel and install method) for the newest omp at launch and
 * then every few hours, backing off after errors. When that is newer than the
 * installed omp it runs stock `omp update` on its own (SetupService.updateOmp,
 * under the setup supervisor, in the same environment as the check): no click,
 * and without waiting for any turn to end, because a running omp keeps the code
 * it loaded — `bun install -g` replaces package files with new ones (new inodes)
 * instead of rewriting them, and the bridge's `@oh-my-pi/*` imports resolve to
 * omp's bundled singletons, not to files on disk. The processes that do read
 * omp's files from disk (the stats server and the stock helper) are stopped
 * before the installer starts and brought back after it. Windows locks files a
 * running omp holds, so there stock's own update fails or repairs the launcher;
 * that attempt is just a failure here, shown in Settings and retried on the next
 * check.
 *
 * OMPdesk's own update is not part of this: it stays manual (updater.ts).
 * Each computer runs its own instance under its own pref. A paired device
 * that wants a host's omp updated asks that host's instance (`host.ompUpdate.now`,
 * LocalMachine.startOmpUpdate) and follows its state, which the host pushes.
 */
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { OmpUpdatedNotice, OmpUpdateFailure, OmpUpdateState } from "../shared/omp-update";
import { isNewer } from "../shared/version";
import type { OmpUpdateOutcome } from "./setup/service";
import type { IpcRegistry } from "./web/ipc-registry";

/** Between checks while all is well. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** The longest wait after repeated failures. */
export const MAX_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Delay before the next scheduled check after `failures` failed ones in a row. */
export function nextCheckDelay(failures: number): number {
	return Math.min(CHECK_INTERVAL_MS * 2 ** Math.min(failures, 8), MAX_CHECK_INTERVAL_MS);
}

export interface OmpUpdaterDeps {
	/** This launch checks on a timer: a packaged app, or a test launch that opts in. Dev and test launches never do. */
	scheduled: boolean;
	/** The pref `ompAutoUpdate` (default on). */
	enabled: () => boolean;
	/** The newest omp for the installed one (stock `omp update --check`); rejects with the reason it could not tell. */
	fetchLatest: () => Promise<string>;
	/** The omp that runs now (from machine setup's detection); null while omp is missing. */
	installed: () => string | null;
	/** Stock `omp update` and the re-detection after it. `beforeInstall` runs just before the installer starts. */
	update: (target: string, beforeInstall: () => Promise<void>) => Promise<OmpUpdateOutcome>;
	/** Stop what reads omp's files from disk (stats server, stock helper); resolves once they are gone. */
	releaseHelpers: () => Promise<void>;
	/**
	 * The install ended and the helpers were released: bring them back, on the new omp when
	 * `updated`. Then, for an update, re-resolve omp and restart the tabs on it (idle ones now,
	 * busy ones after their turn); their bridges answer the capabilities probe again.
	 */
	resume: (updated: boolean) => Promise<void>;
	onState: (state: OmpUpdateState) => void;
	/** One quiet "omp updated to X". */
	onUpdated: (notice: OmpUpdatedNotice) => void;
	now?: () => number;
}

export class OmpUpdater {
	readonly #deps: OmpUpdaterDeps;
	#state: OmpUpdateState;
	#timer: NodeJS.Timeout | null = null;
	#failures = 0;
	#running: Promise<void> | null = null;
	#started = false;
	#disposed = false;

	constructor(deps: OmpUpdaterDeps) {
		this.#deps = deps;
		this.#state = {
			enabled: deps.enabled(),
			scheduled: deps.scheduled,
			phase: "idle",
			installed: deps.installed(),
			latest: null,
			checkedAt: null,
			updatedTo: null,
			failure: null,
		};
	}

	state(): OmpUpdateState {
		return {
			...this.#state,
			enabled: this.#deps.enabled(),
			installed: this.#deps.installed() ?? this.#state.installed,
		};
	}

	/** Machine setup finished its first pass: check now (when this launch schedules) and then on the timer. */
	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		if (this.#deps.scheduled) void this.#cycle();
	}

	/** The pref changed: turning it on checks right away, turning it off lets the next timer pass. */
	prefChanged(): void {
		this.#emit();
		if (this.#started && this.#deps.scheduled && this.#deps.enabled() && !this.#running) void this.#cycle();
	}

	/** Settings › Update now: check and install whatever the pref or the schedule says. */
	updateNow(): Promise<void> {
		return this.#run();
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
	}

	async #cycle(): Promise<void> {
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
		try {
			if (this.#deps.enabled()) await this.#run();
		} catch {
			// A throw from a dependency (a destroyed window in `onUpdated`) must not end the schedule.
		} finally {
			if (!this.#disposed) this.#timer = setTimeout(() => void this.#cycle(), nextCheckDelay(this.#failures));
		}
	}

	#run(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#running ??= this.#check().finally(() => {
			this.#running = null;
			this.#set({ phase: "idle" });
		});
		return this.#running;
	}

	#set(patch: Partial<OmpUpdateState>): void {
		this.#state = { ...this.#state, ...patch };
		this.#emit();
	}

	#emit(): void {
		if (!this.#disposed) this.#deps.onState(this.state());
	}

	#fail(failure: OmpUpdateFailure): void {
		this.#failures += 1;
		this.#set({ failure });
	}

	async #check(): Promise<void> {
		// Missing, outdated or broken omp is machine setup's to install; there is nothing to check or update yet.
		if (this.#deps.installed() === null) return;
		this.#set({ phase: "checking" });
		let latest: string;
		try {
			latest = await this.#deps.fetchLatest();
		} catch (error) {
			this.#fail({ reason: "check", detail: error instanceof Error ? error.message : String(error) });
			return;
		}
		this.#set({ latest, checkedAt: (this.#deps.now ?? Date.now)() });
		const installed = this.#deps.installed();
		if (installed === null) return;
		if (!isNewer(latest, installed)) {
			this.#failures = 0;
			this.#set({ failure: null });
			return;
		}
		this.#set({ phase: "updating" });
		let released = false;
		const outcome = await this.#deps.update(latest, async () => {
			released = true;
			await this.#deps.releaseHelpers();
		});
		// Quit while the installer ran: teardown is under way, so nothing starts again (helpers, tabs, toast).
		if (this.#disposed) return;
		if (outcome.kind === "updated") {
			this.#failures = 0;
			this.#set({ failure: null, updatedTo: outcome.version });
			await this.#deps.resume(true).catch(() => undefined);
			this.#deps.onUpdated({ version: outcome.version });
			return;
		}
		if (released) await this.#deps.resume(false).catch(() => undefined);
		if (outcome.kind === "failed") this.#fail(outcome.failure);
	}
}

/** IPC for the renderer: a snapshot and "Update now". Nothing else crosses; no handler takes a version, command or path. */
export function registerOmpUpdateIpc(ipc: IpcRegistry, updater: Pick<OmpUpdater, "state" | "updateNow">): void {
	ipc.handle(IPC_COMMANDS.OMP_UPDATE_GET_STATE, () => updater.state());
	// Runs in the background; progress arrives as OMP_UPDATE_STATE pushes.
	ipc.handle(IPC_COMMANDS.OMP_UPDATE_NOW, () => {
		void updater.updateNow().catch(() => undefined);
	});
}
