import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
	AGENT_CONTROL_REVIEW,
	AGENT_CONTROL_VIEW,
	AGENT_CONTROL_TOOLS as T,
} from "../../shared/agent-control";
import type { IpcOpenExtensionRequest, IpcSpawnTabPayload, IpcTabInfo } from "../../shared/ipc-types";
import type { ExtensionUIRequest, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { SchedulesRequest, SchedulesState } from "../../shared/schedules";
import { gitSync, initRepo } from "../local/git/test-repos";
import { WORKTREE_COMMAND_BUDGETS_MS } from "../local/git/worktree";
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
		sessions?: AgentControlHostDeps["sessions"];
		remote?: AgentControlHostDeps["remote"];
		app?: AgentControlHostDeps["app"];
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
			setTabOpener: openers,
			hasDraft: () => false,
			windowOfTab: tabId =>
				otherTabs.some(tab => tab.tabId === tabId) ? win2 : tabs.some(tab => tab.tabId === tabId) ? win : null,
			tabWindows: () => (otherTabs.length ? [win, win2] : [win]),
			sessionOwner: () => null,
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

	it("records the caller as the opener of a session the tool opens", async () => {
		const { runtime, win, openers } = setup();
		await runtime.run(win, "main0001", T.open, {});
		expect(openers).toHaveBeenCalledWith("new00003", "main0001");
	});

	it("brings a change nobody announced onto the work board: the sweep timer pushes the review list when it differs", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, win } = setup({ tabs: [{ tabId: "main0001" }, { tabId: "new00003" }], sweepMs: 20 });
			const opening = runtime.run(win, "main0001", T.open, {});
			await vi.advanceTimersByTimeAsync(60_000);
			await opening;
			let current: unknown[] = [{ tabId: "new00003" }];
			vi.spyOn(runtime.control, "reviewItems").mockImplementation(async () => current as never);
			const frames = () =>
				win.sent
					.filter(([channel]) => channel === AGENT_CONTROL_REVIEW)
					.map(([, payload]) => JSON.stringify(payload));
			await vi.advanceTimersByTimeAsync(200);
			expect(frames().at(-1)).toBe(JSON.stringify({ tabId: "main0001", items: [{ tabId: "new00003" }] }));
			// Unchanged: the timer sends nothing more than it did.
			const before = frames().length;
			await vi.advanceTimersByTimeAsync(200);
			expect(frames()).toHaveLength(before);
			// A commit or push outside the app changed the list: the next sweep sends it.
			current = [];
			await vi.advanceTimersByTimeAsync(200);
			expect(frames().at(-1)).toBe(JSON.stringify({ tabId: "main0001", items: [] }));
			expect(frames()).toHaveLength(before + 1);
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
				defaultBranch: async () => "trunk",
			},
		});
		prefs.autopilotShip = { autoPush: true, autoRelease: { on: false }, remote: "up" };
		prefs.agentControlManage = true;
		const started = await runtime.run(win, "main0001", T.autopilot, { action: "start", ship: "push" });
		expect(started.isError).toBe(false);
		expect(sent[0]).toEqual({
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

	it("reads the stored ship level and the default branch for the card rules", async () => {
		const { runtime, win, prefs, commands } = setup({
			autopilot: {
				command: async () =>
					({ type: "response", success: true, data: { active: true, tabId: "run00005" } }) as RpcResponse,
				defaultBranch: async (_cwd, remote) => (remote === "up" ? "trunk" : null),
			},
		});
		prefs.autopilotShip = { autoPush: true, autoRelease: { on: true }, remote: "up" };
		prefs.agentControlManage = true;
		prefs.agentControlFull = false;
		await runtime.run(win, "main0001", T.autopilot, { action: "start" });
		const cards = commands.filter(entry => entry.command.type === "agent_control_confirm");
		expect(cards).toHaveLength(1);
		await runtime.run(win, "main0001", T.autopilot, {
			action: "start",
			ship: "commit",
			branch: { kind: "existing", name: "trunk" },
		});
		expect(commands.filter(entry => entry.command.type === "agent_control_confirm")).toHaveLength(2);
	});

	it("starts a run on a paired host through that host's coordinator and shows it here as a view of its session", async () => {
		const local = vi.fn(async () => ({ type: "response", success: false, error: "local" }) as RpcResponse);
		const { runtime, win, deps, prefs, spawned, openers, sidecars } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss", device: "dev1", cwd: "/h/repo" },
				{ tabId: "new00003", title: "Run", device: "dev1", cwd: "/h/wt" },
			],
			autopilot: { command: local, defaultBranch: async () => "local-only" },
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
					branches: { repo: "/h/repo", remote: "origin", defaultBranch: "trunk", suggested: "x", branches: [] },
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
		expect(start?.command).toEqual({ type: "set_autopilot", action: "start" });
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

	it("creates an agent's schedule through the Schedules service, lists it and cancels it", async () => {
		let state: SchedulesState = { paused: false, schedules: [], runs: [], nextRuns: {} };
		const requests: SchedulesRequest[] = [];
		const service = {
			state: () => state,
			command: vi.fn(async (request: SchedulesRequest) => {
				requests.push(request);
				if (request.action === "save") {
					const made = { ...request.draft, id: "sched-1", createdAt: "2026-10-18T00:00:00Z" };
					state = { ...state, schedules: [...state.schedules, made], nextRuns: { "sched-1": "10:30" } };
				}
				if (request.action === "delete")
					state = { ...state, schedules: state.schedules.filter(schedule => schedule.id !== request.id) };
				return state;
			}),
		};
		const { runtime, win } = setup({ schedules: () => service });
		const created = await runtime.run(win, "main0001", T.schedule, {
			action: "create",
			name: "Nightly check",
			prompt: "run the checks",
			every_minutes: 60,
		});
		expect(created.isError, created.text).toBe(false);
		expect(created.text).toContain("id sched-1; next run 10:30");
		expect(requests.find(request => request.action === "save")).toMatchObject({
			action: "save",
			draft: { prompt: "run the checks", cwd: "/repo", autoApprove: false, enabled: true },
		});
		const listed = await runtime.run(win, "main0001", T.schedule, { action: "list" });
		expect(listed.text).toContain("[made by an agent: you can cancel it]");
		const cancelled = await runtime.run(win, "main0001", T.schedule, { action: "cancel", id: "sched-1" });
		expect(cancelled.isError).toBe(false);
		expect(requests.at(-1)).toEqual({ action: "delete", id: "sched-1" });
		expect(state.schedules).toEqual([]);
	});

	it("sends a paired host's schedules to that host's own service over the link", async () => {
		let state: SchedulesState = { paused: false, schedules: [], runs: [], nextRuns: {} };
		const request = vi.fn(async (_device: string, _method: string, params: unknown) => {
			const { request: command } = params as { request: SchedulesRequest };
			if (command.action === "save")
				state = {
					...state,
					schedules: [...state.schedules, { ...command.draft, id: "host-s1", createdAt: "2026-10-19T00:00:00Z" }],
					nextRuns: { "host-s1": "11:00" },
				};
			if (command.action === "delete")
				state = { ...state, schedules: state.schedules.filter(schedule => schedule.id !== command.id) };
			return state;
		});
		const local = { command: vi.fn() };
		const { runtime, win } = setup({
			schedules: () => local,
			remote: { hosts: () => [{ deviceId: "dev-1", name: "Studio", state: "online" }], request: request as never },
		});
		const created = await runtime.run(win, "main0001", T.schedule, {
			action: "create",
			name: "Nightly",
			prompt: "p",
			every_minutes: 60,
			device: "Studio",
			folder: "/srv/app",
		});
		expect(created.isError, created.text).toBe(false);
		expect(created.text).toContain("in /srv/app on Studio; id host-s1");
		expect(request).toHaveBeenCalledWith("dev-1", "host.schedules.command", {
			request: expect.objectContaining({
				action: "save",
				draft: expect.objectContaining({ name: "[agent] Nightly", cwd: "/srv/app", autoApprove: false }),
			}),
		});
		expect((await runtime.run(win, "main0001", T.schedule, { action: "list", device: "Studio" })).text).toContain(
			"host-s1 “[agent] Nightly” every 60 min in /srv/app",
		);
		await runtime.run(win, "main0001", T.schedule, { action: "cancel", id: "host-s1", device: "Studio" });
		expect(request).toHaveBeenLastCalledWith("dev-1", "host.schedules.command", {
			request: { action: "delete", id: "host-s1" },
		});
		expect(state.schedules).toEqual([]);
		expect(
			request.mock.calls.every(([device, method]) => device === "dev-1" && method === "host.schedules.command"),
		).toBe(true);
		expect(local.command).not.toHaveBeenCalled();
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
			const request = vi.fn(async () => ({ ...facts, uncommitted: 0, untracked: 0, merged: false }));
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
			expect(request).toHaveBeenCalledTimes(1);
			expect(request).toHaveBeenCalledWith(
				"dev-1",
				"host.git.facts",
				{ worktree: { branch: "omp/agent/far", baseCwd: "C:\\repo", path: "C:\\wt\\far" } },
				expect.any(Number),
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

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
});
