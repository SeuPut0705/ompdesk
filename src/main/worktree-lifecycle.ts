/**
 * omp's per-session worktrees (`worktree.onStart` / `worktree.onExit`, omp
 * 18.8.6+) for OMPdesk tabs. Stock runs this lifecycle only in interactive mode,
 * so in rpc-ui the settings would do nothing; this module gives a GUI tab the
 * same semantics:
 *
 * - Start (stock `main.ts` 726-728 + `InteractiveMode.maybeAutoCreateWorktree`,
 *   interactive-mode.ts 7711-7733): a fresh session, not a resumed one, whose
 *   cwd is a primary git checkout with commits gets a new `wt/<timestamp>`
 *   worktree at clean `HEAD` when `onStart` is `create`, or after a yes when it
 *   is `ask`. Stock moves the session into it; the GUI holds the tab's first
 *   omp at `starting` (SidecarManager start gate) and restarts it in the
 *   worktree, so the tab's session begins there. Settings, the start condition
 *   and creation are stock's own helpers through the bridge
 *   (resources/gui-bridge/worktree-lifecycle.ts). A failure is a notice and the
 *   tab starts in its checkout, as stock's warning lets startup continue.
 * - Exit (`InteractiveMode.shutdown` + `#planOwnedWorktreeExit`,
 *   interactive-mode.ts 6817-6826 and 6855-6878; `planWorktreeExit` /
 *   `removeExitWorktrees`, session-worktree.ts 243-302): when the tab closes,
 *   or the app quits, `keep` leaves the worktree, `remove` removes a clean one
 *   silently, and anything that could lose work (or every worktree under `ask`)
 *   asks first. Removal waits for the tab's omp to exit and keeps a worktree
 *   that changed since it was inspected, or whose omp did not exit in time
 *   (it could still be writing there). The git steps run in main
 *   (local/git/session-worktree.ts): the tab's omp is gone by then.
 *
 * Electron-free: windows are webContents ids and the IPC send is injected.
 */
import { z } from "zod";
import type { IpcTabWorktree, IpcWorktreeNotice, IpcWorktreePrompt } from "../shared/ipc-types";
import { IPC_EVENTS } from "../shared/ipc-types";
import {
	decideWorktreeExit,
	type LifecycleWorktree,
	removeSessionWorktree,
	snapshotSessionWorktree,
	type WorktreeOnExit,
	type WorktreeSnapshot,
} from "./local/git/session-worktree";
import type { BridgeClient } from "./local/types";
import type { RpcClient } from "./rpc-client";
import type { SidecarStartGate } from "./sidecar";

export type WorktreeOnStart = "off" | "ask" | "create";

const settingsSchema = z.object({
	onStart: z.enum(["off", "ask", "create"]),
	onExit: z.enum(["keep", "ask", "remove"]),
	eligible: z.boolean(),
});

/** The bridge's `worktree_lifecycle_settings`: both policies and stock's start condition for the session's cwd. */
export type LifecycleSettings = z.infer<typeof settingsSchema>;

const createdSchema = z.object({
	path: z.string().min(1),
	branch: z.string().min(1),
	sourceCwd: z.string().min(1),
	baseCommit: z.string().min(1),
	root: z.string().min(1),
});

/** Settings answer, or null when it is malformed. */
export function parseLifecycleSettings(value: unknown): LifecycleSettings | null {
	const parsed = settingsSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** The tab's live `worktree_lifecycle_settings` (local handler over its bridge); rejects when it cannot answer. */
export async function readLiveLifecycleSettings(sidecar: {
	readonly rpcClient: Pick<RpcClient, "command"> | null;
}): Promise<unknown> {
	if (!sidecar.rpcClient) throw new Error("omp is not running");
	const response = await sidecar.rpcClient.command({ type: "worktree_lifecycle_settings" });
	if (!response.success) throw new Error(response.error);
	return response.data;
}

/** What `worktree.onStart` does for a new tab. */
export type WorktreeStartAction = "skip" | "ask" | "create";

/**
 * Stock `maybeAutoCreateWorktree` (interactive-mode.ts 7716-7720): nothing when
 * the setting is off or the cwd is not a primary git checkout with commits.
 * Null settings = an omp without the feature, or a bridge that could not answer.
 */
export function decideWorktreeStart(settings: LifecycleSettings | null): WorktreeStartAction {
	if (!settings || settings.onStart === "off" || !settings.eligible) return "skip";
	return settings.onStart;
}

/** How a tab is being opened, as SidecarPool.acquire sees it. */
export interface TabSpawnFacts {
	kind: "agent" | "chat";
	/** Session file the tab resumes. */
	sessionPath?: string;
	/** Paired host the tab runs on. */
	device?: string;
	/** Worktree binding the tab was spawned with (the worktree dialog). */
	worktree?: IpcTabWorktree;
	/** No autoResume: an explicit new session. */
	fresh: boolean;
	/** Untargeted startup tab, disposable once a real tab exists. */
	placeholder: boolean;
	/** Restored from the saved layout, spawned on first view. */
	deferStart: boolean;
}

/**
 * Tabs stock would consider: a fresh session (main.ts 726: not resuming).
 * Chat tabs live in the GUI's workspace, placeholders and restored tabs are not
 * sessions the user started now, a worktree-dialog tab already has its
 * worktree, and a paired host's tab runs on the host, out of this machine's
 * reach.
 */
export function isWorktreeStartCandidate(facts: TabSpawnFacts): boolean {
	return (
		facts.kind === "agent" &&
		facts.fresh &&
		!facts.sessionPath &&
		!facts.device &&
		!facts.worktree &&
		!facts.placeholder &&
		!facts.deferStart
	);
}

/** The tab binding for a lifecycle worktree: the chip label is the branch. */
export function lifecycleBinding(worktree: LifecycleWorktree): IpcTabWorktree {
	return {
		name: worktree.branch,
		branch: worktree.branch,
		baseCwd: worktree.sourceCwd,
		path: worktree.path,
		lifecycle: true,
	};
}

/** Window plumbing: webContents ids and an IPC send. */
export interface WorktreeWindows {
	/** Live windows, the one to prefer (focused) first. */
	live(): number[];
	send(winId: number, channel: string, payload: unknown): void;
}

type PromptBody =
	| { kind: "start"; cwd: string }
	| { kind: "exit"; path: string; branch: string; dirty: boolean; moved: boolean; offBranch: boolean };

interface OpenPrompt {
	winId: number;
	prompt: IpcWorktreePrompt;
	/** The tab a start question is about; withdrawn when that tab goes away. */
	tabId?: string;
	resolve(accept: boolean): void;
}

/**
 * The questions the lifecycle asks in a window's renderer (WorktreeLifecycleDialog):
 * the whole open list is pushed on every change, so a reloaded renderer, a
 * withdrawn question or a second window never sees a stale one.
 */
export class WorktreePrompts {
	readonly #windows: WorktreeWindows;
	#open: OpenPrompt[] = [];
	#nextId = 0;

	constructor(windows: WorktreeWindows) {
		this.#windows = windows;
	}

	/**
	 * Ask in `winId`, else the preferred live window. False without asking when
	 * no window is left: an unanswerable question never deletes or creates anything.
	 */
	ask(winId: number, body: PromptBody, tabId?: string): Promise<boolean> {
		const live = this.#windows.live();
		const target = live.includes(winId) ? winId : live[0];
		if (target === undefined) return Promise.resolve(false);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const prompt: IpcWorktreePrompt = { id: `wt-${++this.#nextId}`, ...body };
		this.#open.push({ winId: target, prompt, tabId, resolve });
		this.#push(target);
		return promise;
	}

	/** Settle `id` when `winId` owns it. */
	answer(winId: number, id: string, accept: boolean): boolean {
		const open = this.#open.find(entry => entry.prompt.id === id && entry.winId === winId);
		if (!open) return false;
		this.#settle(open, accept);
		return true;
	}

	forWindow(winId: number): IpcWorktreePrompt[] {
		return this.#open.filter(entry => entry.winId === winId).map(entry => entry.prompt);
	}

	/** A closed tab's start question has nobody to start for. */
	withdrawTab(tabId: string): void {
		for (const open of this.#open.filter(entry => entry.tabId === tabId)) this.#settle(open, false);
	}

	/** A closed window cannot answer: its questions settle as no. */
	windowClosed(winId: number): void {
		for (const open of this.#open.filter(entry => entry.winId === winId)) this.#settle(open, false);
	}

	#settle(open: OpenPrompt, accept: boolean): void {
		this.#open = this.#open.filter(entry => entry !== open);
		open.resolve(accept);
		this.#push(open.winId);
	}

	#push(winId: number): void {
		if (this.#windows.live().includes(winId)) {
			this.#windows.send(winId, IPC_EVENTS.WORKTREE_PROMPTS, this.forWindow(winId));
		}
	}
}

/** Tab-side operations the lifecycle needs from the pool. */
export interface WorktreeLifecycleTabs {
	/** Bind `worktree` to the tab; false when the tab is gone. */
	bind(tabId: string, worktree: IpcTabWorktree): boolean;
}

interface OwnedWorktree {
	worktree: LifecycleWorktree;
	/** `worktree.onExit` as last read from the tab's live session. */
	onExit: WorktreeOnExit;
	winId: number;
}

/** A decided removal and the fingerprint it was decided on (stock `WorktreeExitPlan`). */
interface PlannedRemoval {
	owned: OwnedWorktree;
	approvedFingerprint: string;
}

const START_SETTINGS_TIMEOUT_MS = 10_000;
const EXIT_SETTINGS_TIMEOUT_MS = 3_000;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
	work.then(resolve, reject).finally(() => clearTimeout(timer));
	return promise;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface WorktreeLifecycleOptions {
	/** How long removal waits for the tab's omp to exit before keeping the worktree. */
	processExitTimeoutMs?: number;
}

export class WorktreeLifecycle {
	readonly #tabs: WorktreeLifecycleTabs;
	readonly #prompts: WorktreePrompts;
	readonly #windows: WorktreeWindows;
	readonly #processExitTimeoutMs: number;
	/** Tab → the worktree `onStart` created for it this launch. */
	readonly #owned = new Map<string, OwnedWorktree>();
	/** Exits under way; quit waits for them. */
	readonly #exits = new Set<Promise<void>>();

	constructor(
		tabs: WorktreeLifecycleTabs,
		prompts: WorktreePrompts,
		windows: WorktreeWindows,
		options: WorktreeLifecycleOptions = {},
	) {
		this.#tabs = tabs;
		this.#prompts = prompts;
		this.#windows = windows;
		this.#processExitTimeoutMs = options.processExitTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS;
	}

	/** Whether the tab owns a lifecycle worktree. */
	owns(tabId: string): boolean {
		return this.#owned.has(tabId);
	}

	/**
	 * The start gate for a candidate tab (see isWorktreeStartCandidate): resolves
	 * the cwd the tab's omp must restart in, or null to report ready where it is.
	 */
	startGate(tabId: string, winId: number): SidecarStartGate {
		return async (bridge: BridgeClient, cwd: string) => {
			let settings: LifecycleSettings | null;
			try {
				settings = parseLifecycleSettings(
					await withTimeout(bridge.request("worktree_lifecycle_settings"), START_SETTINGS_TIMEOUT_MS),
				);
			} catch {
				// An omp without the feature answers `unsupported_omp`: start as before.
				return null;
			}
			const action = decideWorktreeStart(settings);
			if (action === "skip" || !settings) return null;
			if (action === "ask" && !(await this.#prompts.ask(winId, { kind: "start", cwd }, tabId))) return null;
			// Closed meanwhile: its omp (and the bridge with it) is gone, and so is the session to start.
			if (!bridge.connected) return null;
			let worktree: LifecycleWorktree;
			try {
				const created = createdSchema.safeParse(await bridge.request("worktree_lifecycle_create"));
				if (!created.success) throw new Error("omp returned an unexpected worktree");
				worktree = created.data;
			} catch (error) {
				if (bridge.connected) this.#notify(winId, { kind: "create-failed", cwd, message: message(error) });
				return null;
			}
			const owned: OwnedWorktree = { worktree, onExit: settings.onExit, winId };
			this.#owned.set(tabId, owned);
			if (this.#tabs.bind(tabId, lifecycleBinding(worktree))) return worktree.path;
			// The tab closed while the worktree was being made: that is its exit.
			this.#owned.delete(tabId);
			this.#track(this.#exit(owned, Promise.resolve()));
			return null;
		};
	}

	/**
	 * Re-read `worktree.onExit` from the tab's live session right before it
	 * closes: stock reads the setting at shutdown. Keeps the last value when the
	 * session cannot answer in time.
	 */
	async refreshExitPolicy(tabId: string, read: () => Promise<unknown>): Promise<void> {
		const owned = this.#owned.get(tabId);
		if (!owned) return;
		try {
			const settings = parseLifecycleSettings(await withTimeout(read(), EXIT_SETTINGS_TIMEOUT_MS));
			if (settings) owned.onExit = settings.onExit;
		} catch {
			// Closing must never wait on a hung session.
		}
	}

	/** The pool released the tab: its session has exited, so `onExit` applies once its omp is gone. */
	released(tabId: string, exited: Promise<void>): void {
		this.#prompts.withdrawTab(tabId);
		const owned = this.#owned.get(tabId);
		if (!owned) return;
		this.#owned.delete(tabId);
		this.#track(this.#exit(owned, exited));
	}

	/**
	 * Quit: every tab still owning a worktree exits now. `prepare` stops the
	 * tab's run and refreshes its policy (stock aborts before planning), the
	 * questions are asked while the windows are alive, then `release` closes
	 * each tab chosen for removal (so the saved session drops it) and resolves
	 * once its omp exited; one that does not exit in time keeps its worktree.
	 * Kept tabs stay for the next launch as ordinary worktree tabs. Also waits
	 * for exits already under way.
	 */
	async finalize(steps: {
		prepare(tabId: string): Promise<void>;
		release(tabId: string): Promise<void>;
	}): Promise<void> {
		const owned = [...this.#owned];
		await Promise.all(
			owned.map(async ([tabId, entry]) => {
				this.#prompts.withdrawTab(tabId);
				try {
					// Ownership stays through `prepare`: it re-reads the live `onExit`
					// through `refreshExitPolicy`, which only updates owned tabs.
					await steps.prepare(tabId);
				} catch {
					// A session that cannot stop or answer keeps its last known policy.
				}
				// From here finalize owns the exit; a pool release must not run it twice.
				if (this.#owned.get(tabId) !== entry) return;
				this.#owned.delete(tabId);
				try {
					const plan = await this.#plan(entry);
					if (!plan) return;
					if (!(await this.#awaitExit(entry, steps.release(tabId)))) return;
					await this.#remove(plan);
				} catch (error) {
					this.#notify(entry.winId, { kind: "remove-failed", path: entry.worktree.path, message: message(error) });
				}
			}),
		);
		await Promise.allSettled([...this.#exits]);
	}

	async #exit(owned: OwnedWorktree, exited: Promise<void>): Promise<void> {
		if (owned.onExit === "keep") return;
		// Stock removes after teardown; on Windows a live omp in the directory would also block it.
		if (!(await this.#awaitExit(owned, exited))) return;
		const plan = await this.#plan(owned);
		if (plan) await this.#remove(plan);
	}

	/**
	 * Waits for the tab's omp to exit. An omp that does not exit in time (or a
	 * release that fails) may still be writing into the worktree: keep it.
	 */
	async #awaitExit(owned: OwnedWorktree, exited: Promise<void>): Promise<boolean> {
		try {
			await withTimeout(exited, this.#processExitTimeoutMs);
			return true;
		} catch {
			this.#notify(owned.winId, { kind: "kept-running", path: owned.worktree.path });
			return false;
		}
	}

	/** Stock `planWorktreeExit` for one worktree: inspect, decide, ask when it asks. */
	async #plan(owned: OwnedWorktree): Promise<PlannedRemoval | null> {
		if (owned.onExit === "keep") return null;
		let snapshot: WorktreeSnapshot;
		try {
			snapshot = await snapshotSessionWorktree(owned.worktree);
		} catch (error) {
			// Inspection errors keep that worktree.
			this.#notify(owned.winId, { kind: "remove-failed", path: owned.worktree.path, message: message(error) });
			return null;
		}
		const action = decideWorktreeExit(owned.onExit, snapshot.state);
		if (action === "keep") return null;
		if (action === "prompt") {
			const { path, branch } = owned.worktree;
			const accepted = await this.#prompts.ask(owned.winId, { kind: "exit", path, branch, ...snapshot.state });
			if (!accepted) return null;
		}
		return { owned, approvedFingerprint: snapshot.fingerprint };
	}

	/** Stock `removeExitWorktrees` for one worktree: keep it when anything changed since the decision. */
	async #remove({ owned, approvedFingerprint }: PlannedRemoval): Promise<void> {
		const { worktree, winId } = owned;
		try {
			const now = await snapshotSessionWorktree(worktree);
			// A vanished worktree holds nothing to lose; `moved` still guards the branch.
			if (now.present && now.fingerprint !== approvedFingerprint) {
				this.#notify(winId, { kind: "kept-changed", path: worktree.path });
				return;
			}
			await removeSessionWorktree(worktree, now.state.moved);
		} catch (error) {
			this.#notify(winId, { kind: "remove-failed", path: worktree.path, message: message(error) });
		}
	}

	#track(exit: Promise<void>): void {
		this.#exits.add(exit);
		void exit.finally(() => this.#exits.delete(exit));
	}

	#notify(winId: number, notice: IpcWorktreeNotice): void {
		const live = this.#windows.live();
		const target = live.includes(winId) ? winId : live[0];
		if (target === undefined) {
			console.warn(`[worktree-lifecycle] ${notice.kind}: ${JSON.stringify(notice)}`);
			return;
		}
		this.#windows.send(target, IPC_EVENTS.WORKTREE_NOTICE, notice);
	}
}
