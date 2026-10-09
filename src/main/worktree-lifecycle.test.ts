import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IPC_EVENTS, type IpcTabWorktree, type IpcWorktreeNotice, type IpcWorktreePrompt } from "../shared/ipc-types";
import type { LifecycleWorktree } from "./local/git/session-worktree";
import { gitSync, initRepo, pathExists, stockShapedWorktree } from "./local/git/test-repos";
import type { BridgeClient } from "./local/types";
import {
	decideWorktreeStart,
	isWorktreeStartCandidate,
	type LifecycleSettings,
	type TabSpawnFacts,
	WorktreeLifecycle,
	type WorktreeLifecycleOptions,
	WorktreePrompts,
	type WorktreeWindows,
} from "./worktree-lifecycle";

const WIN = 1;

/** One live window that records what main pushes to it. */
function fakeWindows(live: number[] = [WIN]) {
	const sent: Array<{ winId: number; channel: string; payload: unknown }> = [];
	const windows: WorktreeWindows = {
		live: () => live,
		send: (winId, channel, payload) => sent.push({ winId, channel, payload }),
	};
	const prompts = () =>
		(sent.filter(entry => entry.channel === IPC_EVENTS.WORKTREE_PROMPTS).at(-1)?.payload ??
			[]) as IpcWorktreePrompt[];
	const notices = () =>
		sent
			.filter(entry => entry.channel === IPC_EVENTS.WORKTREE_NOTICE)
			.map(entry => entry.payload as IpcWorktreeNotice);
	return { windows, sent, prompts, notices, live };
}

function fakeBridge(handlers: Record<string, () => unknown>) {
	const calls: string[] = [];
	let connected = true;
	const bridge: BridgeClient = {
		get connected() {
			return connected;
		},
		request: async <T>(method: string): Promise<T> => {
			calls.push(method);
			const handler = handlers[method];
			if (!handler) throw new Error(`unsupported_omp: ${method}`);
			return (await handler()) as T;
		},
		onEvent: () => () => {},
	};
	return {
		bridge,
		calls,
		disconnect: () => {
			connected = false;
		},
	};
}

const settings = (patch: Partial<LifecycleSettings> = {}): LifecycleSettings => ({
	onStart: "create",
	onExit: "keep",
	eligible: true,
	...patch,
});

describe("decideWorktreeStart (interactive-mode.ts 7716-7720)", () => {
	it.each([
		[null, "skip"],
		[settings({ onStart: "off" }), "skip"],
		[settings({ onStart: "create", eligible: false }), "skip"],
		[settings({ onStart: "ask", eligible: false }), "skip"],
		[settings({ onStart: "create" }), "create"],
		[settings({ onStart: "ask" }), "ask"],
	])("%o → %s", (input, action) => {
		expect(decideWorktreeStart(input)).toBe(action);
	});
});

describe("isWorktreeStartCandidate", () => {
	const fresh: TabSpawnFacts = { kind: "agent", fresh: true, placeholder: false, deferStart: false };
	const binding: IpcTabWorktree = { name: "fix", branch: "omp/gui/fix", baseCwd: "/repo", path: "/wt/gui-fix" };

	it("takes a new agent tab on this machine", () => {
		expect(isWorktreeStartCandidate(fresh)).toBe(true);
	});

	it.each<[string, Partial<TabSpawnFacts>]>([
		["a chat tab", { kind: "chat" }],
		["a resumed session", { sessionPath: "/s/one.jsonl" }],
		["a non-fresh spawn", { fresh: false }],
		["a paired host's tab", { device: "host-1" }],
		["a worktree-dialog tab", { worktree: binding }],
		["the startup placeholder", { placeholder: true }],
		["a restored tab", { deferStart: true }],
	])("skips %s", (_label, patch) => {
		expect(isWorktreeStartCandidate({ ...fresh, ...patch })).toBe(false);
	});
});

describe("WorktreePrompts", () => {
	it("pushes the window's open questions and settles them by answer, tab withdrawal or window close", async () => {
		const ui = fakeWindows([WIN, 2]);
		const prompts = new WorktreePrompts(ui.windows);
		const start = prompts.ask(WIN, { kind: "start", cwd: "/repo" }, "tab-1");
		const other = prompts.ask(2, { kind: "start", cwd: "/repo" }, "tab-2");
		const closing = prompts.ask(WIN, { kind: "start", cwd: "/repo" }, "tab-3");
		expect(prompts.forWindow(WIN).map(prompt => prompt.kind)).toEqual(["start", "start"]);
		const [first] = ui.prompts();
		expect(first).toMatchObject({ kind: "start", cwd: "/repo" });

		// Another window cannot answer it.
		expect(prompts.answer(2, first?.id ?? "", true)).toBe(false);
		expect(prompts.answer(WIN, first?.id ?? "", true)).toBe(true);
		expect(await start).toBe(true);

		prompts.withdrawTab("tab-3");
		expect(await closing).toBe(false);
		prompts.windowClosed(2);
		expect(await other).toBe(false);
		expect(prompts.forWindow(WIN)).toEqual([]);
	});

	it("falls back to another live window, and says no when none is left", async () => {
		const ui = fakeWindows([2]);
		const prompts = new WorktreePrompts(ui.windows);
		void prompts.ask(WIN, { kind: "start", cwd: "/repo" });
		expect(prompts.forWindow(2)).toHaveLength(1);
		const nobody = new WorktreePrompts(fakeWindows([]).windows);
		expect(await nobody.ask(WIN, { kind: "start", cwd: "/repo" })).toBe(false);
	});
});

describe("WorktreeLifecycle", () => {
	let scratch: string;
	let repo: string;
	let root: string;
	let bound: Map<string, IpcTabWorktree>;
	let liveTabs: Set<string>;

	beforeEach(async () => {
		scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-lifecycle-")));
		repo = path.join(scratch, "repo");
		root = path.join(scratch, "wt");
		await initRepo(repo);
		bound = new Map();
		liveTabs = new Set(["tab"]);
	});

	afterEach(async () => {
		await fs.rm(scratch, { recursive: true, force: true });
	});

	function setup(live: number[] = [WIN], options: WorktreeLifecycleOptions = {}) {
		const ui = fakeWindows(live);
		const prompts = new WorktreePrompts(ui.windows);
		const lifecycle = new WorktreeLifecycle(
			{
				bind: (tabId, worktree) => {
					if (!liveTabs.has(tabId)) return false;
					bound.set(tabId, worktree);
					return true;
				},
			},
			prompts,
			ui.windows,
			options,
		);
		/** Waits for every exit under way. */
		const settle = () => lifecycle.finalize({ prepare: async () => {}, release: async () => {} });
		return { ui, prompts, lifecycle, settle };
	}

	/** A bridge whose create step makes a stock-shaped worktree in the temp repo. */
	function creatingBridge(policy: LifecycleSettings, name = "20261009-120000") {
		let created: LifecycleWorktree | undefined;
		const fake = fakeBridge({
			worktree_lifecycle_settings: () => policy,
			worktree_lifecycle_create: async () => {
				created = await stockShapedWorktree(repo, root, name);
				return created;
			},
		});
		return { ...fake, created: () => created };
	}

	it("starts an onStart=create tab in a new worktree bound to it", async () => {
		const { lifecycle } = setup();
		const fake = creatingBridge(settings({ onStart: "create" }));
		const cwd = await lifecycle.startGate("tab", WIN)(fake.bridge, repo);
		const created = fake.created();
		expect(cwd).toBe(created?.path);
		expect(bound.get("tab")).toEqual({
			name: created?.branch,
			branch: created?.branch,
			baseCwd: repo,
			path: created?.path,
			lifecycle: true,
		});
		expect(lifecycle.owns("tab")).toBe(true);
	});

	it("does nothing when onStart is off, the cwd is not eligible, or omp lacks the feature", async () => {
		const { lifecycle } = setup();
		for (const policy of [settings({ onStart: "off" }), settings({ eligible: false })]) {
			const fake = creatingBridge(policy);
			expect(await lifecycle.startGate("tab", WIN)(fake.bridge, repo)).toBeNull();
			expect(fake.calls).toEqual(["worktree_lifecycle_settings"]);
		}
		const old = fakeBridge({});
		expect(await lifecycle.startGate("tab", WIN)(old.bridge, repo)).toBeNull();
		expect(bound.size).toBe(0);
	});

	it("asks under onStart=ask and creates nothing on no", async () => {
		const { lifecycle, prompts, ui } = setup();
		const fake = creatingBridge(settings({ onStart: "ask" }));
		const gate = lifecycle.startGate("tab", WIN)(fake.bridge, repo);
		await expect.poll(() => ui.prompts()).toEqual([expect.objectContaining({ kind: "start", cwd: repo })]);
		prompts.answer(WIN, ui.prompts()[0]?.id ?? "", false);
		expect(await gate).toBeNull();
		expect(fake.calls).toEqual(["worktree_lifecycle_settings"]);

		const yes = creatingBridge(settings({ onStart: "ask" }), "20261009-120001");
		const accepted = lifecycle.startGate("tab", WIN)(yes.bridge, repo);
		await expect.poll(() => ui.prompts()).toHaveLength(1);
		prompts.answer(WIN, ui.prompts()[0]?.id ?? "", true);
		expect(await accepted).toBe(yes.created()?.path);
	});

	it("reports a failed creation and starts in the checkout", async () => {
		const { lifecycle, ui } = setup();
		const fake = fakeBridge({
			worktree_lifecycle_settings: () => settings(),
			worktree_lifecycle_create: () => {
				throw new Error("Branch 'wt/x' already exists; pick another name.");
			},
		});
		expect(await lifecycle.startGate("tab", WIN)(fake.bridge, repo)).toBeNull();
		expect(ui.notices()).toEqual([
			{ kind: "create-failed", cwd: repo, message: "Branch 'wt/x' already exists; pick another name." },
		]);
	});

	it("creates nothing for a tab closed while it was asked about", async () => {
		const { lifecycle, ui } = setup();
		const fake = creatingBridge(settings({ onStart: "ask" }));
		const gate = lifecycle.startGate("tab", WIN)(fake.bridge, repo);
		await expect.poll(() => ui.prompts()).toHaveLength(1);
		fake.disconnect();
		lifecycle.released("tab", Promise.resolve());
		expect(await gate).toBeNull();
		expect(ui.prompts()).toEqual([]);
		expect(fake.calls).toEqual(["worktree_lifecycle_settings"]);
	});

	async function startOwned(lifecycle: WorktreeLifecycle, onExit: LifecycleSettings["onExit"]) {
		const fake = creatingBridge(settings({ onExit }));
		await lifecycle.startGate("tab", WIN)(fake.bridge, repo);
		const created = fake.created();
		if (!created) throw new Error("no worktree");
		return created;
	}

	it("keeps the worktree under onExit=keep, dirty or not, without asking", async () => {
		const { lifecycle, settle, ui } = setup();
		const wt = await startOwned(lifecycle, "keep");
		lifecycle.released("tab", Promise.resolve());
		await settle();
		expect(await pathExists(wt.path)).toBe(true);
		expect(ui.prompts()).toEqual([]);
	});

	it("removes a clean worktree and its branch silently under onExit=remove, once the omp exited", async () => {
		const { lifecycle, settle, ui } = setup();
		const wt = await startOwned(lifecycle, "remove");
		const exited = Promise.withResolvers<void>();
		lifecycle.released("tab", exited.promise);
		expect(await pathExists(wt.path)).toBe(true);
		exited.resolve();
		await settle();
		expect(await pathExists(wt.path)).toBe(false);
		expect(gitSync(repo, "branch", "--list", wt.branch)).toBe("");
		expect(ui.prompts()).toEqual([]);
		expect(lifecycle.owns("tab")).toBe(false);
	});

	it("asks before removing a dirty worktree under onExit=remove and keeps it on no", async () => {
		const { lifecycle, prompts, settle, ui } = setup();
		const wt = await startOwned(lifecycle, "remove");
		await fs.writeFile(path.join(wt.path, "work.txt"), "unsaved");
		lifecycle.released("tab", Promise.resolve());
		await expect
			.poll(() => ui.prompts())
			.toEqual([
				expect.objectContaining({
					kind: "exit",
					path: wt.path,
					branch: wt.branch,
					dirty: true,
					moved: false,
					offBranch: false,
				}),
			]);
		prompts.answer(WIN, ui.prompts()[0]?.id ?? "", false);
		await settle();
		expect(await fs.readFile(path.join(wt.path, "work.txt"), "utf8")).toBe("unsaved");
	});

	it("removes a worktree with new commits on yes but keeps its branch", async () => {
		const { lifecycle, prompts, settle, ui } = setup();
		const wt = await startOwned(lifecycle, "remove");
		await fs.writeFile(path.join(wt.path, "work.txt"), "done");
		gitSync(wt.path, "add", ".");
		gitSync(wt.path, "commit", "-q", "-m", "work");
		lifecycle.released("tab", Promise.resolve());
		await expect.poll(() => ui.prompts()).toEqual([expect.objectContaining({ moved: true, dirty: false })]);
		prompts.answer(WIN, ui.prompts()[0]?.id ?? "", true);
		await settle();
		expect(await pathExists(wt.path)).toBe(false);
		expect(gitSync(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
	});

	it("asks for every worktree under onExit=ask, clean ones included", async () => {
		const { lifecycle, prompts, settle, ui } = setup();
		const wt = await startOwned(lifecycle, "ask");
		lifecycle.released("tab", Promise.resolve());
		await expect.poll(() => ui.prompts()).toEqual([expect.objectContaining({ kind: "exit", dirty: false })]);
		prompts.answer(WIN, ui.prompts()[0]?.id ?? "", true);
		await settle();
		expect(await pathExists(wt.path)).toBe(false);
	});

	it("keeps a worktree that changed after removal was approved", async () => {
		const { lifecycle, prompts, settle, ui } = setup();
		const wt = await startOwned(lifecycle, "ask");
		lifecycle.released("tab", Promise.resolve());
		await expect.poll(() => ui.prompts()).toHaveLength(1);
		await fs.writeFile(path.join(wt.path, "late.txt"), "written while the question was open");
		prompts.answer(WIN, ui.prompts()[0]?.id ?? "", true);
		await settle();
		expect(await pathExists(path.join(wt.path, "late.txt"))).toBe(true);
		expect(ui.notices()).toEqual([{ kind: "kept-changed", path: wt.path }]);
	});

	it("keeps a dirty worktree when no window can ask", async () => {
		const { lifecycle, settle, ui } = setup();
		const wt = await startOwned(lifecycle, "remove");
		await fs.writeFile(path.join(wt.path, "work.txt"), "unsaved");
		ui.live.length = 0;
		lifecycle.released("tab", Promise.resolve());
		await settle();
		expect(await pathExists(path.join(wt.path, "work.txt"))).toBe(true);
	});

	it("applies the onExit value read at close over the one read at start", async () => {
		const { lifecycle, settle } = setup();
		const wt = await startOwned(lifecycle, "keep");
		await lifecycle.refreshExitPolicy("tab", async () => settings({ onExit: "remove" }));
		lifecycle.released("tab", Promise.resolve());
		await settle();
		expect(await pathExists(wt.path)).toBe(false);
	});

	it("treats a tab closed while its worktree was created as exited", async () => {
		const { lifecycle, settle } = setup();
		liveTabs.clear();
		const fake = creatingBridge(settings({ onExit: "remove" }));
		expect(await lifecycle.startGate("tab", WIN)(fake.bridge, repo)).toBeNull();
		await settle();
		const created = fake.created();
		expect(created && (await pathExists(created.path))).toBe(false);
	});

	it("keeps the worktree and says so when the closed tab's omp does not exit in time", async () => {
		const { lifecycle, settle, ui } = setup([WIN], { processExitTimeoutMs: 20 });
		const wt = await startOwned(lifecycle, "remove");
		lifecycle.released("tab", new Promise<void>(() => {}));
		await settle();
		expect(await pathExists(wt.path)).toBe(true);
		expect(gitSync(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
		expect(ui.notices()).toEqual([{ kind: "kept-running", path: wt.path }]);
		expect(ui.prompts()).toEqual([]);
	});

	it("on quit stops each owner's run, asks while windows are up, and releases only the tabs it removes", async () => {
		const { lifecycle, prompts, ui } = setup();
		const kept = await startOwned(lifecycle, "remove");
		liveTabs.add("other");
		const removed = await lifecycle.startGate("other", WIN)(
			creatingBridge(settings({ onExit: "remove" }), "20261009-120002").bridge,
			repo,
		);
		await fs.writeFile(path.join(kept.path, "work.txt"), "unsaved");
		const prepared: string[] = [];
		const released: string[] = [];
		const done = lifecycle.finalize({
			prepare: async tabId => {
				prepared.push(tabId);
			},
			release: async tabId => {
				released.push(tabId);
			},
		});
		await expect.poll(() => ui.prompts()).toHaveLength(1);
		prompts.answer(WIN, ui.prompts()[0]?.id ?? "", false);
		await done;
		expect(prepared.sort()).toEqual(["other", "tab"]);
		expect(released).toEqual(["other"]);
		expect(await pathExists(kept.path)).toBe(true);
		expect(removed && (await pathExists(removed))).toBe(false);
		expect(lifecycle.owns("tab")).toBe(false);
	});

	it("on quit honors an onExit changed to keep while the tab ran, and runs that exit only once", async () => {
		const { lifecycle } = setup();
		const owned = await startOwned(lifecycle, "remove");
		const released: string[] = [];
		await lifecycle.finalize({
			prepare: async tabId => {
				await lifecycle.refreshExitPolicy(tabId, async () => settings({ onExit: "keep" }));
				// The pool releasing the tab mid-quit must not start a second exit with the old policy.
				lifecycle.released(tabId, Promise.resolve());
			},
			release: async tabId => {
				released.push(tabId);
			},
		});
		expect(released).toEqual([]);
		expect(await pathExists(owned.path)).toBe(true);
		expect(lifecycle.owns("tab")).toBe(false);
	});

	it("on quit keeps a worktree whose omp does not exit after release, and says so", async () => {
		const { lifecycle, ui } = setup([WIN], { processExitTimeoutMs: 20 });
		const wt = await startOwned(lifecycle, "remove");
		const released: string[] = [];
		await lifecycle.finalize({
			prepare: async () => {},
			release: tabId => {
				released.push(tabId);
				return new Promise<void>(() => {});
			},
		});
		expect(released).toEqual(["tab"]);
		expect(await pathExists(wt.path)).toBe(true);
		expect(ui.notices()).toEqual([{ kind: "kept-running", path: wt.path }]);
		expect(lifecycle.owns("tab")).toBe(false);
	});
});
