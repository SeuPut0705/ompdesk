import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AGENT_CLOSED_CHILDREN_PREF,
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
	AGENT_CONTROL_REVIEW,
	AGENT_CONTROL_VIEW,
	type AgentReviewEvent,
	type AgentReviewResult,
	AGENT_CONTROL_TOOLS as T,
} from "../../shared/agent-control";
import type { IpcOpenExtensionRequest, IpcSpawnTabPayload, IpcTabInfo } from "../../shared/ipc-types";
import type { ExtensionUIRequest, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { ScheduleCreated, ScheduleDraft, SchedulesRequest, SchedulesState } from "../../shared/schedules";
import { gitSync, initRepo } from "../local/git/test-repos";
import { WORKTREE_COMMAND_BUDGETS_MS } from "../local/git/worktree";
import { SchedulesCommandParams, SchedulesCreateParams } from "../remote/app-protocol";
import type { ScheduleService } from "../schedules";
import type { ClientWindow } from "../web/client-window";
import { type AgentControlHostDeps, AgentControlRuntime, splitBranch } from "./host";

const ok = (data: unknown = {}): RpcResponse => ({ type: "response", success: true, data }) as RpcResponse;

function window(id = 1): ClientWindow & { sent: [string, unknown][] } {
	const sent: [string, unknown][] = [];
	return {
		sent,
		webContents: { id, send: (channel: string, payload: unknown) => void sent.push([channel, payload]) },
		isDestroyed: () => false,
		once: () => undefined,
		removeListener: () => undefined,
	};
}

function setup(
	options: {
		prefs?: Record<string, unknown>;
		tabs?: Partial<IpcTabInfo>[];
		/** Tabs of a second window. */
		otherTabs?: Partial<IpcTabInfo>[];
		requests?: IpcOpenExtensionRequest[];
		schedules?: AgentControlHostDeps["schedules"];
		autopilot?: AgentControlHostDeps["autopilot"];
		/** The sweep timer's period in ms (`AgentControlHostDeps.sweepMs`). */
		sweepMs?: number;
		/** `AgentControlHostDeps.mailOutboxFile`. */
		mailOutboxFile?: string;
		sessions?: AgentControlHostDeps["sessions"];
		remote?: AgentControlHostDeps["remote"];
		app?: AgentControlHostDeps["app"];
		/** Windows viewing a tab (a paired phone's page), by tab id. */
		viewers?: Record<string, ClientWindow[]>;
	} = {},
) {
	const win = window();
	const win2 = window(2);
	const prefs: Record<string, unknown> = { ...options.prefs };
	const info = (tab: Partial<IpcTabInfo>): IpcTabInfo => ({
		tabId: "x",
		cwd: "/repo",
		status: "ready",
		kind: "agent",
		...tab,
	});
	const tabs: IpcTabInfo[] = (options.tabs ?? [{ tabId: "main0001" }]).map(info);
	const otherTabs: IpcTabInfo[] = (options.otherTabs ?? []).map(info);
	const commands: { tabId: string; command: RpcCommand; win: ClientWindow }[] = [];
	const openers = vi.fn();
	const spawned: IpcSpawnTabPayload[] = [];
	const activity: ((event: { type: string; tabId: string }) => void)[] = [];
	const sidecars = new Map<string, { cwd: string; device?: string }>([["main0001", { cwd: "/repo" }]]);
	const deps: AgentControlHostDeps = {
		pool: {
			tabsForWindow: target => (target === win2 ? otherTabs : tabs),
			tabFacts: tabId => ({ title: "", busy: tabId === "busy0002", awaitingConnection: false, retrying: false }),
			pendingPlan: () => null,
			observeTabs: observer => {
				activity.push(observer as never);
				return () => undefined;
			},
			openRequests: () => options.requests ?? [],
			routeSideChannel: vi.fn(async () => true),
			sidecarOf: tabId => (sidecars.get(tabId) ?? { cwd: "/repo" }) as never,
			startTab: vi.fn(() => null),
			setTabTask: vi.fn(),
			formerTabIds: () => [],
			setTabOpener: openers,
			hasDraft: () => false,
			windowOfTab: tabId =>
				otherTabs.some(tab => tab.tabId === tabId) ? win2 : tabs.some(tab => tab.tabId === tabId) ? win : null,
			windowsShowingTab: tabId => {
				const owner = otherTabs.some(tab => tab.tabId === tabId)
					? win2
					: tabs.some(tab => tab.tabId === tabId)
						? win
						: null;
				return owner ? [owner, ...(options.viewers?.[tabId] ?? [])] : [];
			},
			tabWindows: () => (otherTabs.length ? [win, win2] : [win]),
			sessionOwner: () => null,
			whenTabExited: async () => {},
		},
		sessions: options.sessions,
		remote: options.remote,
		app: options.app,
		dispatch: async (target, _sidecar, tabId, command) => {
			commands.push({ tabId, command, win: target });
			if (command.type === "worktree_create")
				return ok({ path: "/wt/agent-1", branch: "omp/agent/agent-1", baseCwd: "/repo" });
			if (command.type === "agent_control_confirm") return ok({ approved: true });
			return ok();
		},
		spawnTab: async (_win, payload) => {
			spawned.push(payload);
			return { tabId: "new00003" };
		},
		prefs: { get: key => prefs[key] },
		deviceName: id => `device ${id}`,
		notify: vi.fn(),
		deleteSession: vi.fn(async () => undefined),
		text: (key, params) => `${key}|${JSON.stringify(params)}`,
		schedules: options.schedules,
		autopilot: options.autopilot,
		sweepMs: options.sweepMs,
		mailOutboxFile: options.mailOutboxFile,
	};
	const runtime = new AgentControlRuntime(deps);
	return { runtime, win, win2, deps, commands, spawned, tabs, otherTabs, activity, prefs, openers, sidecars };
}

describe("AgentControlRuntime", () => {
	it("splits an agent-chosen branch into prefix and name, defaulting to omp/agent/", () => {
		expect(splitBranch(undefined, "agent-1")).toEqual({ branchPrefix: "omp/agent/", name: "agent-1" });
		expect(splitBranch("feat/login/part-a", "x")).toEqual({ branchPrefix: "feat/login/", name: "part-a" });
		expect(splitBranch("solo", "x")).toEqual({ branchPrefix: "", name: "solo" });
	});

	it("lists tabs of the caller's window with asks, busy state, hidden sessions and device names", async () => {
		const request: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "r1",
			method: "select",
			title: "Allow tool: bash",
			options: ["Approve", "Deny"],
		};
		const { runtime, win } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss" },
				{ tabId: "busy0002", title: "Busy", sessionPath: "/s/a.jsonl" },
				{ tabId: "priv0003", title: "Hidden", sessionPath: "/s/b.jsonl" },
				{ tabId: "remo0004", title: "Remote", device: "dev-9", sessionPath: "/s/b.jsonl" },
			],
			requests: [
				{ tabId: "busy0002", request },
				{
					tabId: "busy0002",
					request: { type: "extension_ui_request", id: "s1", method: "notify", message: "fyi" },
				},
			],
			prefs: { sidebar: { agentHidden: ["/s/b.jsonl"] } },
		});
		const outcome = await runtime.run(win, "main0001", T.list, {});
		expect(outcome.isError, outcome.text).toBe(false);
		expect(outcome.text).toContain("4 sessions");
		expect(outcome.text).toContain(`waiting for the user's answer: "Allow tool: bash"`);
		expect(outcome.text).toContain("priv0003 (hidden from agents by the user)");
		expect(outcome.text).toContain("on device dev-9");
		// A paired host's tab is never hidden by this computer's list, whatever its path says.
		expect(outcome.text).toContain(`remo0004 "Remote"`);
	});

	it("resolves the Settings switches from the stored prefs: off refuses, manage is on and approve is off while unset", async () => {
		const request: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "r1",
			method: "select",
			title: "Allow tool: bash",
			options: ["Approve", "Deny"],
		};
		const { runtime, win, prefs, commands, deps } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss" },
				{ tabId: "busy0002", title: "Busy" },
			],
			requests: [{ tabId: "busy0002", request }],
		});
		const cards = () => commands.filter(entry => entry.command.type === "agent_control_confirm").length;
		const answers = () => vi.mocked(deps.pool.routeSideChannel).mock.calls.length;
		expect((await runtime.run(win, "main0001", T.list, {})).isError).toBe(false);
		prefs[AGENT_CONTROL_PREF] = false;
		expect((await runtime.run(win, "main0001", T.list, {})).text).toMatch(/turned off/);
		delete prefs[AGENT_CONTROL_PREF];

		// Full control off: the older gates decide. Nothing else stored: stopping another session needs no card;
		// approving its tool request is refused.
		prefs[AGENT_CONTROL_FULL_PREF] = false;
		expect(prefs[AGENT_CONTROL_MANAGE_PREF]).toBeUndefined();
		expect(prefs[AGENT_CONTROL_APPROVE_PREF]).toBeUndefined();
		expect((await runtime.run(win, "main0001", T.stop, { session: "busy0002" })).isError).toBe(false);
		expect(cards()).toBe(0);
		const refused = await runtime.run(win, "main0001", T.answer, { session: "busy0002", choice: "Approve" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("사용자 승인이 필요해요");
		expect(answers()).toBe(0);

		// Stored false turns manage off (one card); stored true turns approve on.
		prefs[AGENT_CONTROL_MANAGE_PREF] = false;
		await runtime.run(win, "main0001", T.stop, { session: "busy0002" });
		expect(cards()).toBe(1);
		prefs[AGENT_CONTROL_MANAGE_PREF] = true;
		await runtime.run(win, "main0001", T.stop, { session: "busy0002" });
		expect(cards()).toBe(1);
		prefs[AGENT_CONTROL_APPROVE_PREF] = true;
		expect((await runtime.run(win, "main0001", T.answer, { session: "busy0002", choice: "Approve" })).isError).toBe(
			false,
		);
		expect(answers()).toBe(1);

		// Full control (unset is on) covers both gates: manage off and approve off still run with no card.
		delete prefs[AGENT_CONTROL_FULL_PREF];
		prefs[AGENT_CONTROL_MANAGE_PREF] = false;
		prefs[AGENT_CONTROL_APPROVE_PREF] = false;
		await runtime.run(win, "main0001", T.stop, { session: "busy0002" });
		expect(cards()).toBe(1);
		expect((await runtime.run(win, "main0001", T.answer, { session: "busy0002", choice: "Approve" })).isError).toBe(
			false,
		);
		expect(answers()).toBe(2);
	});

	it("opens a session in a worktree through worktree_create with the omp/agent/ prefix and binds the tab to it", async () => {
		const { runtime, win, commands, spawned } = setup();
		const outcome = await runtime.run(win, "main0001", T.open, { worktree: true });
		expect(outcome.isError).toBe(true); // the fake pool never reports the new tab, so readiness fails: the spawn path is what is checked
		const create = commands.find(entry => entry.command.type === "worktree_create");
		expect(create?.command).toMatchObject({ baseCwd: "/repo", baseRef: "HEAD", branchPrefix: "omp/agent/" });
		expect(spawned[0]).toMatchObject({
			cwd: "/wt/agent-1",
			worktree: { path: "/wt/agent-1", branch: "omp/agent/agent-1" },
		});
		expect(runtime.parentOf("new00003")).toEqual({ callerTabId: "main0001" });
	});

	it("records the caller as the opener of a session the tool opens, and hands the spawn its task", async () => {
		const { runtime, win, openers, spawned } = setup();
		await runtime.run(win, "main0001", T.open, { message: "Title: Fix the upload test\nIt times out." });
		expect(openers).toHaveBeenCalledWith("new00003", "main0001");
		// The tab is made with its task, so no window hears of it as "New session" first.
		expect(spawned[0]).toMatchObject({ task: "Fix the upload test" });
	});

	it("brings a change nobody announced onto the work board: the sweep timer pushes the review list when it differs", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, win } = setup({ tabs: [{ tabId: "main0001" }, { tabId: "new00003" }], sweepMs: 20 });
			const opening = runtime.run(win, "main0001", T.open, {});
			await vi.advanceTimersByTimeAsync(60_000);
			await opening;
			let current: unknown[] = [{ tabId: "new00003" }];
			const usage = { "/s/new.jsonl": { cost: 0.25 } };
			vi.spyOn(runtime.control, "review").mockImplementation(async () => ({ items: current, usage }) as never);
			const frames = () =>
				win.sent
					.filter(([channel]) => channel === AGENT_CONTROL_REVIEW)
					.map(([, payload]) => JSON.stringify(payload));
			await vi.advanceTimersByTimeAsync(200);
			expect(frames().at(-1)).toBe(JSON.stringify({ tabId: "main0001", items: [{ tabId: "new00003" }], usage }));
			// Unchanged: the timer sends nothing more than it did.
			const before = frames().length;
			await vi.advanceTimersByTimeAsync(200);
			expect(frames()).toHaveLength(before);
			// A commit or push outside the app changed the list: the next sweep sends it.
			current = [];
			await vi.advanceTimersByTimeAsync(200);
			expect(frames().at(-1)).toBe(JSON.stringify({ tabId: "main0001", items: [], usage }));
			expect(frames()).toHaveLength(before + 1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("tells the opener's board when a child restored by a relaunch closes, though the pool no longer names its opener", async () => {
		vi.useFakeTimers();
		try {
			// After a relaunch only the pool knows the opener (by its session file); once the child's tab is released the
			// pool forgets the child, so the opener is not found from it any more.
			const { runtime, win, tabs, deps, activity } = setup({
				tabs: [
					{ tabId: "main0001", sessionPath: "/s/boss.jsonl" },
					{ tabId: "kid00002", sessionPath: "/s/kid.jsonl", openedBySession: "/s/boss.jsonl" },
				],
				sweepMs: 0,
			});
			deps.pool.sessionOwner = sessionPath =>
				sessionPath === "/s/boss.jsonl" ? ({ tabId: "main0001" } as never) : null;
			let current: unknown[] = [{ tabId: "kid00002" }];
			vi.spyOn(runtime.control, "review").mockImplementation(async () => ({ items: current, usage: {} }) as never);
			// The board asked when it mounted: it lists the child.
			expect((await runtime.review(win, "main0001")).items).toEqual([{ tabId: "kid00002" }]);
			current = [];
			tabs.splice(1, 1);
			for (const observer of activity) observer({ type: "released", tabId: "kid00002" });
			await vi.advanceTimersByTimeAsync(5_000);
			const frames = win.sent.filter(([channel]) => channel === AGENT_CONTROL_REVIEW).map(([, payload]) => payload);
			expect(frames.at(-1)).toEqual({ tabId: "main0001", items: [], usage: {} });
		} finally {
			vi.useRealTimers();
		}
	});
	it("never starts a timer review of an opener while its last one still reads git", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, win } = setup({ tabs: [{ tabId: "main0001" }, { tabId: "new00003" }], sweepMs: 20 });
			const opening = runtime.run(win, "main0001", T.open, {});
			await vi.advanceTimersByTimeAsync(60_000);
			await opening;
			const pending = Promise.withResolvers<AgentReviewResult>();
			const review = vi.spyOn(runtime.control, "review").mockImplementation(() => pending.promise);
			await vi.advanceTimersByTimeAsync(200);
			expect(review).toHaveBeenCalledTimes(1);
			pending.resolve({ items: [], usage: {} });
			await vi.advanceTimersByTimeAsync(20);
			expect(review).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
	it("reads a running child's step and cost again only when a board asks and the child moved on, and sends them only when they moved", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, win, activity } = setup({
				tabs: [{ tabId: "main0001" }, { tabId: "new00003" }],
				sweepMs: 1_000_000,
			});
			const opening = runtime.run(win, "main0001", T.open, {});
			await vi.advanceTimersByTimeAsync(60_000);
			await opening;
			const running = { tabId: "new00003", title: "Kid", state: "running", step: "running bash (build)" };
			vi.spyOn(runtime.control, "review").mockImplementation(
				async () => ({ items: [running], usage: { "/s/new.jsonl": { cost: 0.1 } } }) as never,
			);
			const frames = () =>
				win.sent
					.filter(([channel]) => channel === AGENT_CONTROL_REVIEW)
					.map(([, payload]) => payload as AgentReviewEvent);
			// A full list goes out once (the child started), as before.
			for (const observer of activity) observer({ type: "busy", tabId: "new00003" });
			await vi.advanceTimersByTimeAsync(1_000);
			const live = vi.spyOn(runtime.control, "liveReview").mockImplementation(async (_opener, last) => ({
				items: last.items.map(item => ({ ...item, step: "running bash (tests)" })),
				usage: { "/s/new.jsonl": { cost: 0.4 } },
			}));
			// Nobody shows the board: nothing is read, however long the child runs.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(live).not.toHaveBeenCalled();
			// A board asks, but the child did nothing since the list went out: nothing is read.
			await runtime.liveReview("main0001");
			expect(live).not.toHaveBeenCalled();
			// It moved on (a tool call): the board's next ask reads that child alone.
			for (const observer of activity) observer({ type: "step", tabId: "new00003" });
			await runtime.liveReview("main0001");
			expect(live.mock.calls[0]?.[2]).toEqual(new Set(["new00003"]));
			expect(frames().at(-1)).toMatchObject({
				items: [{ step: "running bash (tests)" }],
				usage: { "/s/new.jsonl": { cost: 0.4 } },
			});
			// Nothing moved since: nothing is read or sent.
			const before = frames().length;
			await runtime.liveReview("main0001");
			expect(frames()).toHaveLength(before);
			expect(live).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("sends the opened sessions' list to a phone viewing the opener too, not only to the window that owns it", async () => {
		vi.useFakeTimers();
		try {
			const phone = window(-1);
			const { runtime, win } = setup({
				tabs: [{ tabId: "main0001" }, { tabId: "new00003" }],
				sweepMs: 20,
				viewers: { main0001: [phone] },
			});
			vi.spyOn(runtime.control, "review").mockImplementation(
				async () => ({ items: [{ tabId: "new00003" }], usage: {} }) as never,
			);
			const opening = runtime.run(win, "main0001", T.open, {});
			await vi.advanceTimersByTimeAsync(2_000);
			await opening;
			const frames = (target: typeof win) =>
				target.sent.filter(([channel]) => channel === AGENT_CONTROL_REVIEW).map(([, payload]) => payload);
			expect(frames(win).at(-1)).toEqual({ tabId: "main0001", items: [{ tabId: "new00003" }], usage: {} });
			expect(frames(phone).at(-1)).toEqual({ tabId: "main0001", items: [{ tabId: "new00003" }], usage: {} });
			// The phone asking for the list does not make it the window the opener's tools answer through.
			await runtime.review(phone, "main0001");
			await runtime.run(win, "main0001", T.open, {});
			await vi.advanceTimersByTimeAsync(2_000);
			expect(frames(win).length).toBeGreaterThan(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("starts Autopilot through the coordinator and records the run as the caller's child", async () => {
		const sent: { tabId: string; command: unknown }[] = [];
		const { runtime, win, openers, prefs } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss" },
				{ tabId: "run00005", title: "Run" },
			],
			autopilot: {
				command: async (_win, _sidecar, tabId, command) => {
					sent.push({ tabId, command });
					const data =
						command.type === "set_autopilot" && command.action === "start"
							? { active: true, state: "running", tabId: "run00005" }
							: { active: true, state: "stopping" };
					return { type: "response", success: true, data } as RpcResponse;
				},
			},
		});
		prefs.agentControlManage = true;
		const started = await runtime.run(win, "main0001", T.autopilot, { action: "start", ship: "push" });
		expect(started.isError).toBe(false);
		// The plan reads the folder's idle status first (its default branch), then the start goes out.
		expect(sent[0]).toMatchObject({ tabId: "main0001", command: { type: "get_autopilot" } });
		expect(sent[1]).toEqual({
			tabId: "main0001",
			command: { type: "set_autopilot", action: "start", preset: "push" },
		});
		expect(openers).toHaveBeenCalledWith("run00005", "main0001");
		expect(runtime.parentOf("run00005")).toEqual({ callerTabId: "main0001" });
		const stopped = await runtime.run(win, "main0001", T.autopilot, {
			action: "stop",
			session: "run00005",
			now: true,
		});
		expect(stopped.isError).toBe(false);
		expect(sent.at(-1)).toEqual({ tabId: "run00005", command: { type: "set_autopilot", action: "abort" } });
	});

	it("names a level on every start (commit when omitted) and reads the default branch for the card rules", async () => {
		const sent: unknown[] = [];
		const { runtime, win, prefs, commands } = setup({
			autopilot: {
				command: async (_win, _sidecar, _tabId, command) => {
					sent.push(command);
					return {
						type: "response",
						success: true,
						data:
							command.type === "get_autopilot"
								? { active: false, branches: { defaultBranch: "trunk" } }
								: { active: true, tabId: "run00005" },
					} as RpcResponse;
				},
			},
		});
		prefs.agentControlManage = true;
		prefs.agentControlFull = false;
		await runtime.run(win, "main0001", T.autopilot, { action: "start" });
		expect(commands.filter(entry => entry.command.type === "agent_control_confirm")).toHaveLength(0);
		expect(sent).toContainEqual({ type: "set_autopilot", action: "start", preset: "local" });
		await runtime.run(win, "main0001", T.autopilot, {
			action: "start",
			ship: "commit",
			branch: { kind: "existing", name: "trunk" },
		});
		expect(commands.filter(entry => entry.command.type === "agent_control_confirm")).toHaveLength(1);
	});

	it("starts a run on a paired host through that host's coordinator and shows it here as a view of its session", async () => {
		const local = vi.fn(async () => ({ type: "response", success: false, error: "local" }) as RpcResponse);
		const { runtime, win, deps, prefs, spawned, openers, sidecars } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss", device: "dev1", cwd: "/h/repo" },
				{ tabId: "new00003", title: "Run", device: "dev1", cwd: "/h/wt" },
			],
			autopilot: { command: local },
		});
		sidecars.set("main0001", { cwd: "/h/repo", device: "dev1" });
		sidecars.set("new00003", { cwd: "/h/wt", device: "dev1" });
		const sent: { tabId: string; command: RpcCommand; timeoutMs?: number }[] = [];
		deps.dispatch = async (_win, _sidecar, tabId, command, timeoutMs) => {
			sent.push({ tabId, command, ...(timeoutMs ? { timeoutMs } : {}) });
			if (command.type === "get_autopilot" && tabId === "main0001")
				return ok({
					active: false,
					ship: { policy: { autoPush: true, autoRelease: { on: false }, remote: "origin" }, queue: [] },
					branches: { repo: "/h/repo", remote: "origin", defaultBranch: "trunk", current: "trunk" },
				});
			if (command.type === "set_autopilot" && command.action === "start")
				return ok({ active: true, state: "running", tabId: "hostrun9", sessionPath: "/h/sessions/run.jsonl" });
			if (command.type === "agent_control_confirm") return ok({ approved: true });
			return ok({ active: true, state: "stopping" });
		};
		prefs.agentControlManage = true;
		prefs.agentControlFull = false;
		const started = await runtime.run(win, "main0001", T.autopilot, { action: "start" });
		expect(started.isError, started.text).toBe(false);
		// The host's default branch decides the card: trunk is the default there, so naming it asks.
		const branchCard = await runtime.run(win, "main0001", T.autopilot, {
			action: "start",
			branch: { kind: "existing", name: "trunk" },
		});
		expect(branchCard.isError, branchCard.text).toBe(false);
		expect(sent.filter(entry => entry.command.type === "agent_control_confirm")).toHaveLength(1);
		expect(local).not.toHaveBeenCalled();
		const start = sent.find(entry => entry.command.type === "set_autopilot");
		expect(start?.tabId).toBe("main0001");
		expect(start?.command).toEqual({ type: "set_autopilot", action: "start", preset: "local" });
		expect(start?.timeoutMs).toBeGreaterThanOrEqual(960_000);
		expect(spawned[0]).toEqual({ device: "dev1", sessionPath: "/h/sessions/run.jsonl" });
		expect(started.text).toContain("new00003");
		expect(runtime.parentOf("new00003")).toEqual({ callerTabId: "main0001" });
		expect(openers).toHaveBeenCalledWith("new00003", "main0001");
		const status = await runtime.run(win, "main0001", T.autopilot, { action: "status", session: "new00003" });
		expect(status.isError, status.text).toBe(false);
		expect(sent.at(-1)).toMatchObject({ tabId: "new00003", command: { type: "get_autopilot" } });
	});

	it("rejects a worktree base that is not HEAD or default, and a folder that does not exist", async () => {
		const { runtime, win, spawned } = setup();
		expect((await runtime.run(win, "main0001", T.open, { worktree: { base: "feature/x" } })).text).toMatch(
			/must be "HEAD"/,
		);
		expect((await runtime.run(win, "main0001", T.open, { folder: "/definitely/not/a/folder" })).text).toMatch(
			/not a folder/,
		);
		expect(spawned).toHaveLength(0);
	});

	it("raises confirmation cards titled for the user only, on the calling tab", async () => {
		const { runtime, win, commands, prefs } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss" },
				{ tabId: "other002", title: "Other", sessionPath: "/s/o.jsonl" },
			],
		});
		prefs.agentControlFull = false;
		const outcome = await runtime.run(win, "main0001", T.stop, { session: "other002", delete: true });
		expect(outcome.isError).toBe(false);
		const card = commands.find(entry => entry.command.type === "agent_control_confirm");
		expect(card?.tabId).toBe("main0001");
		expect(card?.command).toMatchObject({ title: expect.stringMatching(/^\[OMPdesk\] stopTitle/) });
	});

	it("shows a session through the window's view event", async () => {
		const { runtime, win } = setup({ tabs: [{ tabId: "main0001" }, { tabId: "other002" }] });
		await runtime.run(win, "main0001", T.focus, { session: "other002", how: "split-down" });
		expect(win.sent).toContainEqual([AGENT_CONTROL_VIEW, { tabId: "other002", how: "split-down" }]);
	});

	it("forgets a released tab's window, turns and parent", async () => {
		const { runtime, win, activity } = setup();
		await runtime.run(win, "main0001", T.list, {});
		for (const observer of activity) observer({ type: "released", tabId: "main0001" });
		expect((await runtime.run(win, "main0001", T.list, {})).isError).toBe(false);
	});

	/** A Schedules service: `create` names the id it made; `holdCreates` keeps each answer until that many were saved. */
	function fakeSchedules(holdCreates = 0) {
		const fake: { state: SchedulesState; requests: SchedulesRequest[]; drafts: ScheduleDraft[] } = {
			state: { paused: false, schedules: [], runs: [], nextRuns: {} },
			requests: [],
			drafts: [],
		};
		const { promise: allSaved, resolve: releaseCreates } = Promise.withResolvers<void>();
		const command = vi.fn(async (request: SchedulesRequest) => {
			fake.requests.push(request);
			if (request.action === "delete")
				fake.state = { ...fake.state, schedules: fake.state.schedules.filter(item => item.id !== request.id) };
			return fake.state;
		});
		const create = vi.fn(async (draft: ScheduleDraft): Promise<ScheduleCreated> => {
			fake.drafts.push(draft);
			const id = `sched-${fake.drafts.length}`;
			fake.state = {
				...fake.state,
				schedules: [...fake.state.schedules, { ...draft, id, createdAt: "2026-10-19T00:00:00Z" }],
				nextRuns: { ...fake.state.nextRuns, [id]: "10:30" },
			};
			if (fake.drafts.length >= holdCreates) releaseCreates();
			await allSaved;
			return { id, state: fake.state };
		});
		return { fake, service: { command, create } };
	}

	it("creates an agent's schedule through the Schedules service, lists it and cancels it", async () => {
		const { fake, service } = fakeSchedules();
		const { runtime, win } = setup({ schedules: () => service });
		const created = await runtime.run(win, "main0001", T.schedule, {
			action: "create",
			name: "Nightly check",
			prompt: "run the checks",
			every_minutes: 60,
		});
		expect(created.isError, created.text).toBe(false);
		expect(created.text).toContain("id sched-1; next run 10:30");
		expect(fake.drafts[0]).toMatchObject({
			prompt: "run the checks",
			cwd: "/repo",
			autoApprove: false,
			enabled: true,
		});
		const listed = await runtime.run(win, "main0001", T.schedule, { action: "list" });
		expect(listed.text).toContain("[made by an agent: you can cancel it]");
		const cancelled = await runtime.run(win, "main0001", T.schedule, { action: "cancel", id: "sched-1" });
		expect(cancelled.isError).toBe(false);
		expect(fake.requests.at(-1)).toEqual({ action: "delete", id: "sched-1" });
		expect(fake.state.schedules).toEqual([]);
	});

	/** A paired host "dev-1" (Studio) serving `host.schedules.*` from `service`, recording each call. */
	function pairedHost(service: Pick<ScheduleService, "command" | "create">) {
		const request = vi.fn(async (_device: string, method: string, params: unknown) =>
			method === "host.schedules.create"
				? service.create(SchedulesCreateParams.parse(params).draft)
				: service.command(SchedulesCommandParams.parse(params).request),
		);
		return { hosts: () => [{ deviceId: "dev-1", name: "Studio", state: "online" as const }], request };
	}

	it("sends a paired host's schedules to that host's own service over the link", async () => {
		const { fake, service } = fakeSchedules();
		const remote = pairedHost(service);
		const local = fakeSchedules().service;
		const { runtime, win } = setup({ schedules: () => local, remote: remote as never });
		const created = await runtime.run(win, "main0001", T.schedule, {
			action: "create",
			name: "Nightly",
			prompt: "p",
			every_minutes: 60,
			device: "Studio",
			folder: "/srv/app",
		});
		expect(created.isError, created.text).toBe(false);
		expect(created.text).toContain("in /srv/app on Studio; id sched-1");
		expect(remote.request).toHaveBeenCalledWith("dev-1", "host.schedules.create", {
			draft: expect.objectContaining({ name: "[agent] Nightly", cwd: "/srv/app", autoApprove: false }),
		});
		expect((await runtime.run(win, "main0001", T.schedule, { action: "list", device: "Studio" })).text).toContain(
			"sched-1 “[agent] Nightly” every 60 min in /srv/app",
		);
		await runtime.run(win, "main0001", T.schedule, { action: "cancel", id: "sched-1", device: "Studio" });
		expect(remote.request).toHaveBeenLastCalledWith("dev-1", "host.schedules.command", {
			request: { action: "delete", id: "sched-1" },
		});
		expect(fake.state.schedules).toEqual([]);
		expect(remote.request.mock.calls.every(([device]) => device === "dev-1")).toBe(true);
		expect(local.command).not.toHaveBeenCalled();
		expect(local.create).not.toHaveBeenCalled();
	});

	it("gives two concurrent creates each its own schedule, even when both answers list both", async () => {
		const { fake, service } = fakeSchedules(2);
		const { runtime, win } = setup({ remote: pairedHost(service) as never });
		const create = (name: string) =>
			runtime.run(win, "main0001", T.schedule, {
				action: "create",
				name,
				prompt: "p",
				every_minutes: 60,
				device: "Studio",
				folder: "/srv/app",
			});
		const [first, second] = await Promise.all([create("alpha"), create("beta")]);
		const idOf = (text: string) => /; id (\S+);/.exec(text)?.[1];
		const made = new Map(fake.state.schedules.map(schedule => [schedule.name, schedule.id]));
		expect(made.size).toBe(2);
		expect(first.text).toContain("“[agent] alpha”");
		expect(idOf(first.text)).toBe(made.get("[agent] alpha"));
		expect(second.text).toContain("“[agent] beta”");
		expect(idOf(second.text)).toBe(made.get("[agent] beta"));
		expect(idOf(first.text)).not.toBe(idOf(second.text));
	});

	it("lists and steers another window's sessions through that window", async () => {
		const { runtime, win, win2, commands } = setup({
			tabs: [{ tabId: "main0001", title: "Boss" }],
			otherTabs: [{ tabId: "far00002", title: "Far work" }],
		});
		expect((await runtime.run(win, "main0001", T.list, {})).text).not.toContain("far00002");
		expect((await runtime.run(win, "main0001", T.list, { scope: "app" })).text).toContain(
			'far00002 "Far work" [another window]',
		);
		const sent = await runtime.run(win, "main0001", T.send, { session: "far00002", message: "hello" });
		expect(sent.isError, sent.text).toBe(false);
		expect(commands.find(entry => entry.command.type === "prompt")?.win).toBe(win2);
		await runtime.run(win, "main0001", T.focus, { session: "far00002" });
		expect(win2.sent).toContainEqual([AGENT_CONTROL_VIEW, { tabId: "far00002", how: "focus" }]);
	});

	it("opens on a paired device with that device's absolute folder, never a relative folder", async () => {
		const { runtime, win, spawned } = setup({
			remote: {
				hosts: () => [{ deviceId: "dev-1", name: "DESKTOP-91ID999", state: "online" }],
				request: vi.fn(),
			},
		});
		await runtime.run(win, "main0001", T.open, { device: "DESKTOP-91ID999", folder: "C:\\work" });
		expect(spawned[0]).toEqual({ cwd: "C:\\work", device: "dev-1" });
		await runtime.run(win, "main0001", T.open, { device: "dev-1" });
		expect(spawned[1]).toEqual({ device: "dev-1" });
		expect((await runtime.run(win, "main0001", T.open, { device: "dev-1", folder: "rel" })).text).toMatch(
			/must be absolute/,
		);
		expect((await runtime.run(win, "main0001", T.open, { device: "dev-1", worktree: true })).text).toMatch(
			/needs that device's repository/,
		);
		expect(spawned).toHaveLength(2);
	});

	it("makes a worktree on the paired device the session runs on and binds the new tab to it", async () => {
		const request = vi.fn(async (_device: string, method: string) =>
			method === "host.git.worktreeCreate"
				? { path: "C:\\wt\\gui-agent-x", branch: "omp/agent/part-a", baseCwd: "C:\\work" }
				: null,
		);
		const { runtime, win, spawned, commands } = setup({
			remote: { hosts: () => [{ deviceId: "dev-1", name: "PC", state: "online" }], request: request as never },
		});
		// The fake pool never reports the new tab ready: the spawn path is what is checked.
		await runtime.run(win, "main0001", T.open, {
			device: "dev-1",
			folder: "C:\\work",
			worktree: { branch: "omp/agent/part-a", base: "default" },
		});
		expect(request).toHaveBeenCalledWith(
			"dev-1",
			"host.git.worktreeCreate",
			{ name: "part-a", baseCwd: "C:\\work", baseRef: "default", branchPrefix: "omp/agent/" },
			WORKTREE_COMMAND_BUDGETS_MS.worktree_create,
		);
		expect(commands.some(entry => entry.command.type === "worktree_create")).toBe(false);
		expect(spawned[0]).toEqual({
			cwd: "C:\\wt\\gui-agent-x",
			device: "dev-1",
			worktree: { name: "part-a", branch: "omp/agent/part-a", baseCwd: "C:\\work", path: "C:\\wt\\gui-agent-x" },
		});
	});

	it("asks a paired host's git for its session's branch, and this computer's git for a local one", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-git-")));
		try {
			const repo = path.join(root, "repo");
			await initRepo(repo);
			const local = { name: "w", branch: "omp/agent/w", baseCwd: repo, path: path.join(root, "wt-w") };
			gitSync(repo, "worktree", "add", "-q", "-b", local.branch, local.path);
			const facts = { branch: "omp/agent/far", baseBranch: "main", commitsAhead: 4, files: [] };
			const request = vi.fn(async (_device: string, method: string) =>
				method === "host.git.evidence"
					? { diff: "", diffOmitted: 0, merge: { kind: "conflict", files: ["a.ts"] } }
					: { ...facts, uncommitted: 0, untracked: 0, merged: false },
			);
			const remote = {
				name: "far",
				branch: "omp/agent/far",
				baseCwd: "C:\\repo",
				path: "C:\\wt\\far",
			};
			const { runtime, win } = setup({
				tabs: [
					{ tabId: "main0001" },
					{ tabId: "near0002", title: "Near", worktree: local },
					{ tabId: "far00003", title: "Far", device: "dev-1", worktree: remote },
				],
				remote: { hosts: () => [{ deviceId: "dev-1", name: "PC", state: "online" }], request: request as never },
			});
			const result = await runtime.run(win, "main0001", T.compare, { sessions: ["near0002", "far00003"] });
			expect(result.isError, result.text).toBe(false);
			expect(result.text).toContain("branch omp/agent/far → main: 4 commit(s) ahead");
			expect(result.text).toContain("branch omp/agent/w → main: 0 commit(s) ahead");
			expect(result.text).toContain("merge: would conflict in a.ts");
			expect(request.mock.calls.map(call => call.slice(0, 3))).toEqual([
				[
					"dev-1",
					"host.git.facts",
					{ worktree: { branch: "omp/agent/far", baseCwd: "C:\\repo", path: "C:\\wt\\far" } },
				],
				[
					"dev-1",
					"host.git.evidence",
					{ worktree: { branch: "omp/agent/far", baseCwd: "C:\\repo", path: "C:\\wt\\far" }, diffChars: 0 },
				],
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("closes a child restored after a relaunch whose branch was pushed straight to main, and removes its worktree", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-relaunch-")));
		let closed: unknown;
		try {
			const origin = path.join(root, "origin.git");
			const repo = path.join(root, "repo");
			gitSync(root, "init", "-q", "--bare", "-b", "main", origin);
			await initRepo(repo);
			gitSync(repo, "remote", "add", "origin", origin);
			gitSync(repo, "push", "-q", "-u", "origin", "main");
			const worktree = { name: "w", branch: "omp/agent/w", baseCwd: repo, path: path.join(root, "wt-w") };
			gitSync(repo, "worktree", "add", "-q", "-b", worktree.branch, worktree.path);
			await fs.writeFile(path.join(worktree.path, "fix.txt"), "fixed\n");
			gitSync(worktree.path, "add", "fix.txt");
			gitSync(worktree.path, "commit", "-q", "-m", "fix");
			// What the child did: its commits went to origin's main; the parent's own main stayed behind.
			gitSync(worktree.path, "push", "-q", "origin", "HEAD:main");
			// After the relaunch every tab has a new id: the child names its opener by session file only, and this
			// launch never saw it opened.
			const { win, deps, tabs } = setup({
				tabs: [
					{ tabId: "main0001", sessionPath: "/s/boss.jsonl" },
					{
						tabId: "kid00002",
						title: "Kid",
						sessionPath: "/s/kid.jsonl",
						openedBySession: "/s/boss.jsonl",
						worktree,
						lastRun: { stopReason: "stop" },
					},
				],
				sweepMs: 50,
			});
			deps.pool.sessionOwner = sessionPath =>
				sessionPath === "/s/boss.jsonl" ? ({ tabId: "main0001" } as never) : null;
			// The close's last step, written once its worktree removal (and `branch -d`) settled: awaiting it leaves no
			// git running in the repository when the test deletes it (Windows refuses an rmdir while one has it open).
			deps.prefs.set = (key, value) => {
				if (key === AGENT_CLOSED_CHILDREN_PREF) closed = value;
			};
			deps.dispatch = async (_target, _sidecar, _tabId, command) =>
				command.type === "get_state"
					? ok({ isStreaming: false })
					: command.type === "get_last_assistant_text"
						? ok({ text: "Pushed to main.\nResult: ok" })
						: ok();
			await expect
				.poll(
					() =>
						win.sent.some(
							([channel, event]) =>
								channel === AGENT_CONTROL_VIEW &&
								typeof event === "object" &&
								event !== null &&
								"how" in event &&
								event.how === "close",
						),
					{ timeout: 10_000 },
				)
				.toBe(true);
			tabs.splice(
				tabs.findIndex(tab => tab.tabId === "kid00002"),
				1,
			);
			await expect.poll(() => closed, { timeout: 10_000 }).toEqual([expect.objectContaining({ cwd: repo })]);
			await expect(fs.stat(worktree.path)).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("lists and reads saved sessions of this computer and of a paired device", async () => {
		const row = {
			path: "/s/p/a.jsonl",
			id: "aaaa1111-x",
			title: "Saved here",
			cwd: "/repo",
			created: "2026-10-01T00:00:00Z",
			modified: "2026-10-02T00:00:00Z",
			messageCount: 2,
			size: 10,
			status: "complete" as const,
			firstMessage: "hi",
		};
		const request = vi.fn(async (_device: string, method: string) =>
			method === "sessions.list"
				? [{ ...row, path: "C:/s/b.jsonl", id: "bbbb2222-y", title: "Saved on PC" }]
				: [{ role: "assistant", content: "from the PC" }],
		);
		const { runtime, win } = setup({
			sessions: {
				list: async () => [row],
				search: async () => [],
				read: async () => [{ role: "assistant", content: "from here" }] as never,
			},
			remote: { hosts: () => [{ deviceId: "dev-1", name: "PC", state: "online" }], request: request as never },
		});
		expect((await runtime.run(win, "main0001", T.list, { scope: "stored" })).text).toContain(
			'aaaa1111-x "Saved here"',
		);
		expect((await runtime.run(win, "main0001", T.read, { session: "aaaa1111-x" })).text).toContain("from here");
		expect((await runtime.run(win, "main0001", T.list, { scope: "stored", device: "PC" })).text).toContain(
			'bbbb2222-y "Saved on PC"',
		);
		expect((await runtime.run(win, "main0001", T.read, { session: "bbbb2222-y" })).text).toContain("from the PC");
		expect(request).toHaveBeenCalledWith("dev-1", "sessions.messages", { sessionPath: "C:/s/b.jsonl" });
	});

	it("names the saved worktree of a reopen whose folder is gone, and restore: true restores it and opens there", async () => {
		const row = {
			path: "/s/p/w.jsonl",
			id: "cccc3333-z",
			title: "Worktree child",
			cwd: "/wt/gui-agent-z",
			created: "2026-10-01T00:00:00Z",
			modified: "2026-10-02T00:00:00Z",
			messageCount: 2,
			size: 10,
			status: "complete" as const,
			firstMessage: "hi",
		};
		const { runtime, win, deps, spawned } = setup({
			sessions: { list: async () => [row], search: async () => [], read: async () => [] },
		});
		deps.spawnTab = async (_win, payload) => {
			spawned.push(payload);
			return payload.restoreSaved
				? { tabId: "new00003" }
				: {
						tabId: null,
						refusal: "folder-missing",
						folder: "/wt/gui-agent-z",
						saved: { id: "sv1", branch: "omp/agent/z", removedAt: Date.UTC(2026, 9, 20) },
					};
		};
		await runtime.run(win, "main0001", T.list, { scope: "stored" });
		const refused = await runtime.run(win, "main0001", T.open, { reopen: "cccc3333-z" });
		expect(refused.text).toContain("/wt/gui-agent-z");
		expect(refused.text).toContain("omp/agent/z");
		expect(refused.text).toContain('{"reopen":"cccc3333-z","restore":true}');

		// The fake pool never reports the new tab, so readiness fails: the restoring spawn is what is checked.
		const restored = await runtime.run(win, "main0001", T.open, { reopen: "cccc3333-z", restore: true });
		expect(restored.text).not.toContain("disk care");
		expect(spawned.at(-1)).toMatchObject({ sessionPath: "/s/p/w.jsonl", restoreSaved: true });
	});

	it("sends an app action of a session on a paired host to that host's route, and of a local session to this computer's", async () => {
		const invoke = vi.fn(async (_win: ClientWindow, _channel: string, _args: readonly unknown[]) => ({
			mode: "quota",
		}));
		const { runtime, win, sidecars } = setup({
			tabs: [{ tabId: "main0001" }, { tabId: "remo0004", device: "dev-1" }],
			app: { invoke, fire: vi.fn(), localize: en => en },
		});
		sidecars.set("remo0004", { cwd: "/h/repo", device: "dev-1" });
		await runtime.run(win, "remo0004", T.app, { action: "settings.rotation", args: { value: "even" } });
		expect(invoke).toHaveBeenCalledWith(win, "account-rotation:set", ["even", "dev-1"]);
		expect(invoke).not.toHaveBeenCalledWith(win, "prefs:set", expect.anything());

		invoke.mockClear();
		await runtime.run(win, "main0001", T.app, { action: "settings.rotation", args: { value: "even" } });
		expect(invoke).toHaveBeenCalledWith(win, "prefs:set", [{ key: "accountRotation", value: "even" }]);
		expect(invoke).not.toHaveBeenCalledWith(win, "account-rotation:set", expect.anything());
	});

	it("tells the opener when a session it opened on a paired device shows a question card", async () => {
		const request: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "q1",
			method: "select",
			title: "Which wording appeared?",
			options: ["omp is unavailable", "Other (type your own)"],
		};
		const { activity, commands, sidecars } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" },
				{ tabId: "remo0004", title: "Remote", device: "dev-1", openedBy: "main0001" },
			],
			requests: [{ tabId: "remo0004", request }],
		});
		sidecars.set("remo0004", { cwd: "C:\\work", device: "dev-1" });
		for (const observer of activity) observer({ type: "ask", tabId: "remo0004", requestId: "q1" } as never);
		await vi.waitFor(() => expect(commands.some(entry => entry.command.type === "agent_control_mail")).toBe(true));
		const mail = commands.find(entry => entry.command.type === "agent_control_mail");
		expect(mail?.tabId).toBe("main0001");
		expect(mail?.command).toMatchObject({
			triggerTurn: true,
			deliverAs: "aside",
			details: { kind: "question", from: "remo0004" },
		});
	});

	it("sends a done report a busy parent accepted again to the omp that replaces it, until that omp's journal holds it", async () => {
		// Stock queues an aside in memory and journals it at the next step boundary; a killed omp drops the queue. Each
		// fake omp below does the same: a report is queued until the test journals it.
		const omps = new Map<string, { journal: Set<string>; queued: Set<string> }>();
		const received: string[] = [];
		const asks: string[] = [];
		const attach = (deps: AgentControlHostDeps) => {
			const inner = deps.dispatch;
			deps.dispatch = async (target, sidecar, tabId, command, timeoutMs) => {
				if (command.type !== "agent_control_mail") return inner(target, sidecar, tabId, command, timeoutMs);
				asks.push(tabId);
				const omp = omps.get(tabId) ?? { journal: new Set<string>(), queued: new Set<string>() };
				omps.set(tabId, omp);
				const id = String(command.details.id);
				if (omp.journal.has(id)) return ok({ duplicate: true, journaled: true });
				if (omp.queued.has(id)) return ok({ duplicate: true, journaled: false });
				omp.queued.add(id);
				received.push(tabId);
				return ok();
			};
		};
		vi.useFakeTimers();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mail-outbox-"));
		try {
			const file = path.join(dir, "mail-outbox.json");
			const before = setup({
				tabs: [
					{ tabId: "main0001", title: "Boss", sessionPath: "/s/boss.jsonl" },
					{ tabId: "kid00002", title: "Kid", sessionPath: "/s/kid.jsonl", openedBy: "main0001" },
				],
				sweepMs: 1_000,
				mailOutboxFile: file,
			});
			attach(before.deps);
			const reported = await before.runtime.run(before.win, "kid00002", T.report, {
				kind: "done",
				text: "All checks pass",
			});
			expect(reported.isError, reported.text).toBe(false);
			expect(received).toEqual(["main0001"]);

			// The parent's omp is killed mid-turn and the app relaunches: its session comes back in a tab with a new id.
			const after = setup({
				tabs: [{ tabId: "main0009", title: "Boss", sessionPath: "/s/boss.jsonl" }],
				sweepMs: 1_000,
				mailOutboxFile: file,
			});
			after.deps.pool.sessionOwner = sessionPath =>
				sessionPath === "/s/boss.jsonl" ? ({ tabId: "main0009" } as never) : null;
			attach(after.deps);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(received).toEqual(["main0001", "main0009"]);

			// Queued in the new omp: asked again, never sent a second time.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(received).toEqual(["main0001", "main0009"]);

			// Its next step journaled the report: one more look settles it, then nothing is sent.
			const omp = omps.get("main0009");
			for (const id of omp?.queued ?? []) omp?.journal.add(id);
			await vi.advanceTimersByTimeAsync(1_000);
			const asked = asks.length;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(asks.length).toBe(asked);
			expect(received).toEqual(["main0001", "main0009"]);
		} finally {
			vi.useRealTimers();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
