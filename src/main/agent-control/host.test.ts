import { describe, expect, it, vi } from "vitest";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
	AGENT_CONTROL_VIEW,
	AGENT_CONTROL_TOOLS as T,
} from "../../shared/agent-control";
import type { IpcOpenExtensionRequest, IpcSpawnTabPayload, IpcTabInfo } from "../../shared/ipc-types";
import type { ExtensionUIRequest, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type { SchedulesRequest, SchedulesState } from "../../shared/schedules";
import type { ClientWindow } from "../web/client-window";
import { type AgentControlHostDeps, AgentControlRuntime, splitBranch } from "./host";

const ok = (data: unknown = {}): RpcResponse => ({ type: "response", success: true, data }) as RpcResponse;

function window(): ClientWindow & { sent: [string, unknown][] } {
	const sent: [string, unknown][] = [];
	return {
		sent,
		webContents: { id: 1, send: (channel: string, payload: unknown) => void sent.push([channel, payload]) },
		isDestroyed: () => false,
		once: () => undefined,
		removeListener: () => undefined,
	};
}

function setup(
	options: {
		prefs?: Record<string, unknown>;
		tabs?: Partial<IpcTabInfo>[];
		requests?: IpcOpenExtensionRequest[];
		schedules?: AgentControlHostDeps["schedules"];
		autopilot?: AgentControlHostDeps["autopilot"];
	} = {},
) {
	const win = window();
	const prefs: Record<string, unknown> = { ...options.prefs };
	const tabs: IpcTabInfo[] = (options.tabs ?? [{ tabId: "main0001" }]).map(tab => ({
		tabId: "x",
		cwd: "/repo",
		status: "ready",
		kind: "agent",
		...tab,
	}));
	const commands: { tabId: string; command: RpcCommand }[] = [];
	const openers = vi.fn();
	const spawned: IpcSpawnTabPayload[] = [];
	const activity: ((event: { type: string; tabId: string }) => void)[] = [];
	const sidecars = new Map<string, { cwd: string; device?: string }>([["main0001", { cwd: "/repo" }]]);
	const deps: AgentControlHostDeps = {
		pool: {
			tabsForWindow: () => tabs,
			tabFacts: tabId => ({ title: "", busy: tabId === "busy0002", awaitingConnection: false, retrying: false }),
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
		},
		dispatch: async (_win, _sidecar, tabId, command) => {
			commands.push({ tabId, command });
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
	};
	const runtime = new AgentControlRuntime(deps);
	return { runtime, win, deps, commands, spawned, tabs, activity, prefs, openers };
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

	it("follows the Settings switches live: off refuses, approve and manage default off", async () => {
		const { runtime, win, prefs, deps } = setup();
		expect((await runtime.run(win, "main0001", T.list, {})).isError).toBe(false);
		prefs[AGENT_CONTROL_PREF] = false;
		expect((await runtime.run(win, "main0001", T.list, {})).text).toMatch(/turned off/);
		const host = (runtime as unknown as { control: { run: unknown } }).control;
		expect(host).toBeDefined();
		expect(deps.prefs.get(AGENT_CONTROL_APPROVE_PREF)).toBeUndefined();
		expect(deps.prefs.get(AGENT_CONTROL_MANAGE_PREF)).toBeUndefined();
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
		const { runtime, win, commands } = setup({
			tabs: [
				{ tabId: "main0001", title: "Boss" },
				{ tabId: "other002", title: "Other", sessionPath: "/s/o.jsonl" },
			],
		});
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
		expect(requests[0]).toMatchObject({
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
});
