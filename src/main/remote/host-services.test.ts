import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../e2e/models-config-fixture";
import type { PromptOriginEnv } from "../../../resources/gui-bridge/prompt-origin-contracts";
import type { AccountRotationMode, AccountRotationState } from "../../shared/account-rotation";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type {
	CustomProviderInput,
	CustomProvidersConfig,
	CustomProviderView,
	HostDesktopState,
	HostLiveSession,
	HostUpdateAction,
	IpcBenchmarkRunOptions,
	IpcBenchmarkRunResult,
	IpcModelSetupRunResult,
	ModelOverrideInput,
} from "../../shared/ipc-types";
import type { ModelSetupRequest, ModelSetupStatus } from "../../shared/model-setup";
import type { OmpUpdateState } from "../../shared/omp-update";
import { MAX_RPC_COMMAND_TIMEOUT_MS, timeoutForCommand } from "../../shared/rpc-client";
import type {
	AgentProgress,
	AgentSessionEvent,
	RpcCommand,
	RpcResponse,
	SidecarStatus,
	SubagentFrame,
} from "../../shared/rpc-types";
import type { ScheduleCreated, ScheduleDraft, SchedulesRequest, SchedulesState } from "../../shared/schedules";
import type { SidebarProjectsRequest, SidebarProjectsState } from "../../shared/sidebar-projects";
import { branchEvidence, branchFacts, landingFacts, type WorktreeRef } from "../agent-control/branches";
import type { MemoryPageCopy } from "../ai-memory/client";
import { serveConclusionPull, serveConclusionPush, servePull, servePush } from "../ai-memory/sync";
import { canonicalCwd } from "../canonical-cwd";
import { deletedSessions, initDeletedSessions } from "../deleted-sessions";
import { SavedWorktreeStore, setSavedWorktreeStore } from "../disk/saved-worktrees";
import { gitSync, initRepo } from "../local/git/test-repos";
import type { MachineServices } from "../machine-services";
import { SidebarProjects } from "../sidebar-projects";
import { type SidecarLike, VIEW_ENDED_EVENT } from "../sidecar-types";
import { setTurnStopLog } from "../turn-stop-log";
import { FS_BINARY_REMOTE_MAX_BYTES } from "../workspace-fs";
import { withRemovalClaim } from "../worktree-removals";
import {
	AUTOPILOT_NOTICE_EVENT,
	decodeBinaryRead,
	LIVE_SESSIONS_EVENT,
	MemoryConclusionPullReply,
	MemoryPullReply,
	MOBILE_WEB_LINK_EVENT,
	OMP_UPDATE_EVENT,
	PROJECTS_EVENT,
	SCHEDULES_EVENT,
	type TabEventMessage,
	TabRunArg,
	TabStatusArg,
} from "./app-protocol";
import type { HostConnection } from "./host-server";
import { type HostServicesDeps, LIVE_SESSIONS_DEBOUNCE_MS, LocalHostServices } from "./host-services";
import type { HostedTabView } from "./hosted-view";
import { createLinkEventDecoder, createReadDecoder, type WireSubagentFrame } from "./link-events";
import { localDay, PeerQuota } from "./peer-quota";
import type { PeerInfo } from "./peers-store";
import { FrameTooLargeError } from "./wire";

/** A SidecarManager stand-in for the host side. */
class FakeHostSidecar extends EventEmitter {
	status: SidecarStatus = "asleep";
	processAlive = false;
	disposed = false;
	started: Array<{ resume: string | undefined }> = [];
	reloads: Array<{ reload: boolean; reconnect: string[] }> = [];
	sideFrames: object[] = [];
	imageSyncs = 0;
	replyLanguageSyncs = 0;
	userProfileSyncs = 0;
	nextPromptSyncs = 0;
	autoTitleSyncs = 0;
	judgeAssistSyncs = 0;
	accountRotationSyncs = 0;
	commands: RpcCommand[] = [];
	readonly rpcClient = {
		command: async (command: RpcCommand): Promise<RpcResponse> => {
			this.commands.push(command);
			return { type: "response", command: command.type, success: true };
		},
	};
	constructor(
		public cwd: string,
		readonly kind: "agent" | "chat",
	) {
		super();
	}
	get statusPayload() {
		return { status: this.status, cwd: this.cwd };
	}
	start(): void {
		this.started.push({ resume: undefined });
		this.setStatus("starting");
	}
	restart(_cwd?: string, resume?: string): void {
		this.started.push({ resume });
		this.setStatus("starting");
	}
	async reloadExtensions(plan: { reload: boolean; reconnect: string[] }): Promise<void> {
		this.reloads.push(plan);
	}
	adoptCwd(cwd: string): boolean {
		this.cwd = cwd;
		return true;
	}
	sendSideChannel(frame: object): void {
		this.sideFrames.push(frame);
	}
	syncImageGeneration(): void {
		this.imageSyncs++;
	}
	syncReplyLanguage(): void {
		this.replyLanguageSyncs++;
	}
	syncUserProfile(): void {
		this.userProfileSyncs++;
	}
	syncNextPrompt(): void {
		this.nextPromptSyncs++;
	}
	syncAutoTitle(): void {
		this.autoTitleSyncs++;
	}
	syncJudgeAssist(): void {
		this.judgeAssistSyncs++;
	}
	syncAccountRotation(): void {
		this.accountRotationSyncs++;
	}
	dispose(): void {
		this.disposed = true;
	}
	readonly exited = Promise.withResolvers<void>();
	whenExited(): Promise<void> {
		return this.exited.promise;
	}
	setStatus(status: SidecarStatus): void {
		this.status = status;
		this.processAlive = status === "ready";
		this.emit("status", { status, cwd: this.cwd });
	}
}

class FakeConnection implements HostConnection {
	readonly events: Array<{ event: string; data: unknown }> = [];
	constructor(readonly peer: PeerInfo) {}
	emit(event: string, data: unknown): void {
		this.events.push({ event, data });
	}
	close(): void {}
	tabEvents(): TabEventMessage[] {
		return this.events.filter(entry => entry.event === "tab.event").map(entry => entry.data as TabEventMessage);
	}
}

function peer(deviceId: string): PeerInfo {
	return { deviceId, name: deviceId, staticPub: "pub", nodeId: `n-${deviceId}`, login: null, pairedAt: 0 };
}

let workDir: string;

beforeEach(() => {
	workDir = canonicalCwd(mkdtempSync(join(tmpdir(), "host-services-")));
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(workDir, { recursive: true, force: true });
});

/** This machine's own pool, reduced to what the host consults: one local tab that may own session files. */
function fakeLocalTabs() {
	const tab = new FakeHostSidecar("/local", "agent");
	const owned = new Map<string, { tabId: string; winId: number }>();
	const closed: string[] = [];
	/** Session files a window tab here runs a turn in. */
	const running = new Set<string>();
	/** Session files whose window tab "Stop and delete" stopped. */
	const stopped: string[] = [];
	/** Views of a window's tab a device may get, by session file, and who asked. */
	const views = new Map<string, FakeHostSidecar>();
	const viewed: Array<{ origin: { deviceId: string; name: string }; hostName: string }> = [];
	const localTabs: HostServicesDeps["localTabs"] = {
		sessionOwner: path => owned.get(path) ?? null,
		sessionOwnerIsLive: path => owned.has(path) && tab.processAlive,
		sessionRunning: path => running.has(path),
		commandForSession: (_path, command) => tab.rpcClient.command(command),
		closeSessionTab: async path => {
			if (running.has(path)) return false;
			const owner = owned.get(path);
			if (owner) closed.push(owner.tabId);
			owned.delete(path);
			return true;
		},
		allSidecars: () => [tab as unknown as SidecarLike],
		viewForDevice: (path, origin, hostName) => {
			const view = views.get(path);
			if (!view) return null;
			viewed.push({ origin, hostName });
			return view as unknown as HostedTabView;
		},
		// A window tab's turn on the file is stopped and ends at once.
		stopSession: async path => {
			if (running.delete(path)) stopped.push(path);
		},
	};
	return { tab, owned, closed, running, stopped, views, viewed, localTabs };
}

const DESKTOP: HostDesktopState = {
	version: "1.2.3",
	update: { state: "downloaded", version: "1.3.0", mode: "relaunch" },
	appearance: { themeName: "dark", language: "ko" },
};

const OMP_UPDATE_IDLE: OmpUpdateState = {
	enabled: true,
	scheduled: true,
	phase: "idle",
	installed: "18.8.7",
	latest: "18.9.0",
	checkedAt: 1,
	updatedTo: null,
	failure: null,
};

const SCHEDULES_EMPTY: SchedulesState = { paused: false, schedules: [], runs: [], nextRuns: {} };

/** This machine's models.yml, stats and bench, recording what the host asked of it. */
function fakeMachine() {
	return {
		listProviders: vi.fn(
			async (): Promise<CustomProvidersConfig> => ({ providers: [PROVIDER_VIEW], options: fixtureProviderOptions }),
		),
		upsertProvider: vi.fn(async (_input: CustomProviderInput) => {}),
		deleteProvider: vi.fn(async (_id: string) => {}),
		setModelOverride: vi.fn(async (_provider: string, _modelId: string, _override: ModelOverrideInput | null) => {}),
		fetchStats: vi.fn(async (path: string, params?: Record<string, string>): Promise<unknown> => ({ path, params })),
		runBenchmark: vi.fn(
			async (
				_caller: string,
				_options: IpcBenchmarkRunOptions,
				cwd: string | null,
			): Promise<IpcBenchmarkRunResult> => ({
				success: false,
				error: `ran in ${cwd}`,
			}),
		),
		abortBenchmark: vi.fn(async (_caller: string) => true),
		runModelSetup: vi.fn(
			async (_caller: string, _request: ModelSetupRequest): Promise<IpcModelSetupRunResult> => ({
				success: false,
				error: "not run",
			}),
		),
		modelSetupStatus: vi.fn(async (_caller: string): Promise<ModelSetupStatus> => ({ running: false })),
		abortModelSetup: vi.fn(async (_caller: string) => true),
		accountRotation: vi.fn(async (): Promise<AccountRotationState> => ({ mode: "quota", evenSupported: true })),
		setAccountRotation: vi.fn(
			async (mode: AccountRotationMode): Promise<AccountRotationState> => ({ mode, evenSupported: true }),
		),
		builtinRea: vi.fn(async () => ({ enabled: true, available: true })),
		setBuiltinRea: vi.fn(async (enabled: boolean) => ({ enabled, available: true })),
		desktop: vi.fn(async (): Promise<HostDesktopState> => DESKTOP),
		desktopUpdate: vi.fn(async (_action: HostUpdateAction): Promise<HostDesktopState> => DESKTOP),
		ompUpdate: vi.fn(async (): Promise<OmpUpdateState> => OMP_UPDATE_IDLE),
		startOmpUpdate: vi.fn(async (): Promise<OmpUpdateState> => ({ ...OMP_UPDATE_IDLE, phase: "checking" })),
		schedules: vi.fn(
			async (_request: SchedulesRequest, _origin?: string): Promise<SchedulesState> => SCHEDULES_EMPTY,
		),
		scheduleLog: vi.fn(async (runId: string) => `log of ${runId}`),
		createSchedule: vi.fn(
			async (_draft: ScheduleDraft, _origin?: string): Promise<ScheduleCreated> => ({
				id: "made-1",
				state: SCHEDULES_EMPTY,
			}),
		),
		sidebarProjects: vi.fn(
			async (_request: SidebarProjectsRequest): Promise<SidebarProjectsState> => ({
				projects: [],
				removed: [],
				worktrees: {},
			}),
		),
	} satisfies MachineServices;
}

const PROVIDER_VIEW: CustomProviderView = {
	id: "host-only",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1234/v1",
	hasApiKey: false,
	models: [{ id: "m1" }],
	builtin: false,
};

function setup(graceMs = 60_000, extra: Partial<HostServicesDeps> = {}) {
	const sidecars: FakeHostSidecar[] = [];
	const origins: PromptOriginEnv[] = [];
	const machine = fakeMachine();
	const local = fakeLocalTabs();
	const deleteSession = vi.fn(async (_path: string) => {});
	const renameStoredSession = vi.fn(async (_path: string, _name: string) => {});
	const recordedCwd = vi.fn(async (_path: string): Promise<string | null> => null);
	const services = new LocalHostServices({
		createSidecar: (cwd, kind, _fresh, origin) => {
			const sidecar = new FakeHostSidecar(cwd, kind);
			sidecars.push(sidecar);
			origins.push(origin);
			return sidecar as unknown as SidecarLike;
		},
		hostName: () => "Host B",
		sessionIndex: {
			list: async () => [],
			searchContent: async () => [],
			kindFor: async () => "chat",
			recordedCwd,
			deleteSession,
			moveSession: async (path: string) => path,
			sessionsDir: join(workDir, "sessions"),
			readMessages: async (path: string) => [{ role: "user", content: `read ${path}`, timestamp: 1 }] as never,
		},
		agentHidden: () => new Set(["/hidden/session.jsonl"]),
		renameStoredSession,
		defaultWorkspace: () => workDir,
		launchProfiles: { get: () => undefined, set: () => {} },
		machine,
		localTabs: local.localTabs,
		trashItem: async () => {},
		graceMs,
		...extra,
	});
	return { services, sidecars, origins, local, deleteSession, renameStoredSession, machine, recordedCwd };
}

describe("LocalHostServices", () => {
	it("scopes rtabs per peer: one device can never reach another device's tab", async () => {
		const { services, sidecars, origins } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));

		const opened = await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		expect(opened).toEqual({ cwd: workDir, kind: "agent", attached: false });
		await services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		// The tab's omp journals its prompts as X's (A85).
		expect(origins).toEqual([{ deviceId: "device-x", name: x.peer.name, hostName: "Host B" }]);

		// Y knows X's rtab but every lookup is scoped to the caller.
		for (const [method, params] of [
			["tab.start", { rtab: "t1" }],
			["tab.command", { rtab: "t1", command: { type: "get_state" } }],
			["tab.sideChannel", { rtab: "t1", frame: { type: "x" } }],
			["tab.close", { rtab: "t1" }],
		] as const) {
			const result = await services.call(y.peer, method, params, y).catch((error: unknown) => error);
			if (method === "tab.close") expect(result).toBeNull();
			else expect(ipcErrorCode(result)).toBe("unknown_tab");
		}
		expect(sidecars[0]?.disposed).toBe(false);
		expect(sidecars[0]?.commands).toEqual([]);

		// Y's own "t1" is a different tab with its own sidecar.
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		expect(sidecars).toHaveLength(2);
		sidecars[0]?.setStatus("ready");
		expect(x.tabEvents().map(event => event.arg)).toContainEqual(expect.objectContaining({ status: "ready" }));
		// Y hears only of its own tab.
		expect(y.tabEvents()).toEqual([
			{ rtab: "t1", name: "signIn", arg: { active: [] } },
			{ rtab: "t1", name: "awaitingConnection", arg: false },
		]);
	});

	it("never reopens a session deleted on this computer for a device whose layout still names it", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		initDeletedSessions(null);
		deletedSessions().add(join(workDir, "gone.jsonl"));
		const refused = await services
			.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, sessionPath: join(workDir, "gone.jsonl") }, x)
			.catch((error: unknown) => error);
		initDeletedSessions(null);
		expect(ipcErrorCode(refused)).toBe("session_deleted");
		expect(sidecars).toHaveLength(0);
	});

	it("opens a device's saved session in the folder its file records here, never in the folder the device guessed", async () => {
		const { services, sidecars, recordedCwd } = setup();
		const x = new FakeConnection(peer("device-x"));
		const home = mkdtempSync(join(tmpdir(), "omp-host-session-home-"));
		try {
			recordedCwd.mockResolvedValue(home);
			const opened = await services.call(
				x.peer,
				"tab.open",
				{ rtab: "t1", cwd: workDir, kind: "agent", sessionPath: join(workDir, "worktree-session.jsonl") },
				x,
			);
			expect(opened).toMatchObject({ cwd: realpathSync(home), attached: false });
			expect(sidecars[0]?.cwd).toBe(realpathSync(home));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("refuses a device's saved session whose recorded folder is gone instead of opening it in another folder", async () => {
		const { services, sidecars, recordedCwd } = setup();
		const x = new FakeConnection(peer("device-x"));
		recordedCwd.mockResolvedValue(join(workDir, "removed-worktree"));
		const refused = await services
			.call(
				x.peer,
				"tab.open",
				{ rtab: "t1", cwd: workDir, kind: "agent", sessionPath: join(workDir, "orphan.jsonl") },
				x,
			)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_folder_missing");
		expect(sidecars).toHaveLength(0);

		// A failed read of the recorded folder opens nothing either: never the folder the device guessed.
		recordedCwd.mockRejectedValue(new Error("stock helper timed out"));
		const failed = await services
			.call(
				x.peer,
				"tab.open",
				{ rtab: "t2", cwd: workDir, kind: "agent", sessionPath: join(workDir, "unread.jsonl") },
				x,
			)
			.catch((error: unknown) => error);
		expect(String(failed)).toContain("stock helper timed out");
		expect(sidecars).toHaveLength(0);
	});

	it("tells a device where its saved session belongs and restores the worktree its own disk care saved", async () => {
		const { services, recordedCwd } = setup();
		const x = new FakeConnection(peer("device-x"));
		const repo = join(workDir, "repo");
		await initRepo(repo);
		const worktree = join(workDir, "wt-saved");
		gitSync(repo, "worktree", "add", "-q", "-b", "omp/agent/saved", worktree);
		const head = gitSync(worktree, "rev-parse", "HEAD").trim();
		gitSync(repo, "worktree", "remove", worktree);
		recordedCwd.mockResolvedValue(worktree);
		const ask = (restore: boolean) =>
			services.call(x.peer, "sessions.folder", { sessionPath: join(workDir, "s.jsonl"), restore }, x);

		// Disk care's store not read yet: still refused, only without an offer.
		setSavedWorktreeStore(null as unknown as SavedWorktreeStore);
		expect(await ask(false)).toEqual({ folder: worktree, missing: true, saved: null });

		const store = new SavedWorktreeStore(join(workDir, "disk-care"));
		setSavedWorktreeStore(store);
		await store.update(() => [
			{
				id: "sv1",
				path: worktree,
				repo,
				branch: "omp/agent/saved",
				head,
				savedBranch: null,
				removedAt: 5,
				archivedFiles: 0,
				archivedBytes: 0,
			},
		]);
		expect(await ask(false)).toEqual({
			folder: worktree,
			missing: true,
			saved: { id: "sv1", branch: "omp/agent/saved", removedAt: 5 },
		});
		expect(await ask(true)).toEqual({ folder: worktree, missing: false, saved: null });
		expect(gitSync(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("omp/agent/saved");
	});

	it("opens no tab for a device in a worktree a removal holds until git is done with it", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		let release: () => void = () => undefined;
		const removal = withRemovalClaim(
			realpathSync.native(workDir),
			() => [],
			() => new Promise<void>(resolve => (release = resolve)),
		);
		const refused = await services
			.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("worktree_removing");
		expect(sidecars).toHaveLength(0);
		release();
		await removal;
	});

	it("forwards allowlisted sidecar events as tab.event and leaves host tool calls to the device", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: false }, x);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");

		sidecar.setStatus("ready");
		sidecar.emit("events", [{ type: "agent_start" }]);
		sidecar.emit("hostToolCall", { id: "ht-1", toolName: "gui_open_url", arguments: { url: "https://x" } });
		sidecar.emit("session", { sessionId: "s1", sessionFile: "/s/one.jsonl" });
		sidecar.emit("frame", { type: "raw" });
		sidecar.emit("stderr", "noise");
		sidecar.emit("bridge", { connected: false, ompVersion: "19.0.0", error: "no socket" });
		await Promise.resolve();

		expect(x.tabEvents()).toEqual([
			// Every open tells the device which sign-ins run (none on a new tab) and whether this computer
			// holds the tab's turn for its connection.
			{ rtab: "t1", name: "signIn", arg: { active: [] } },
			{ rtab: "t1", name: "awaitingConnection", arg: false },
			{
				rtab: "t1",
				name: "status",
				arg: {
					status: "ready",
					statusPayload: {},
					processAlive: true,
					cwd: workDir,
					kind: "agent",
					omp: expect.any(String),
				},
			},
			{ rtab: "t1", name: "events", arg: [{ type: "agent_start" }] },
			{
				rtab: "t1",
				name: "hostToolCall",
				arg: { id: "ht-1", toolName: "gui_open_url", arguments: { url: "https://x" } },
			},
			{ rtab: "t1", name: "session", arg: { sessionId: "s1", sessionFile: "/s/one.jsonl" } },
			{ rtab: "t1", name: "bridge", arg: { connected: false, ompVersion: "19.0.0", error: "no socket" } },
		]);
		// The device answers the tool through the side channel.
		await services.call(
			x.peer,
			"tab.sideChannel",
			{ rtab: "t1", frame: { type: "host_tool_result", id: "ht-1" } },
			x,
		);
		expect(sidecar.sideFrames).toEqual([{ type: "host_tool_result", id: "ht-1" }]);
	});

	it("names the same omp to a device that re-attaches, and a new one once the tab's omp restarted", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: false }, x);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		const ompOf = () => {
			const status = x.tabEvents().findLast(event => event.name === "status");
			return TabStatusArg.parse(status?.arg).omp;
		};
		sidecar.setStatus("ready");
		const first = ompOf();
		expect(first).toEqual(expect.any(String));

		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: false }, x);
		expect(ompOf()).toBe(first);

		sidecar.setStatus("restarting");
		sidecar.setStatus("starting");
		sidecar.setStatus("ready");
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: false }, x);
		expect(ompOf()).not.toBe(first);
	});

	it("tells a re-attaching device how the tab's turn stands, and since when, before its status", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: false }, x);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		sidecar.emit("events", [{ type: "agent_start" }]);
		const started = Date.now();
		const reattach = async () => {
			const from = x.tabEvents().length;
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: false }, x);
			return x.tabEvents().slice(from);
		};
		const events = await reattach();
		expect(events.map(event => event.name).slice(0, 2)).toEqual(["run", "status"]);
		const run = TabRunArg.parse(events[0]?.arg);
		expect(run).toMatchObject({ running: true, turn: true });
		expect(run.elapsedMs).toBeLessThanOrEqual(Date.now() - started + 50);

		// The turn ended while the device was away: the next re-attach says so.
		sidecar.emit("events", [{ type: "agent_end", messages: [] }]);
		const after = TabRunArg.parse((await reattach())[0]?.arg);
		expect(after).toEqual({ running: false, turn: false });
	});

	it("runs commands on the tab and re-syncs every tab on this machine after a login", async () => {
		const { services, sidecars, local } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "a", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "b", cwd: workDir, fresh: true }, y);

		const response = await services.call(
			x.peer,
			"tab.command",
			{ rtab: "a", command: { type: "login", providerId: "p" } },
			x,
		);
		expect(response).toMatchObject({ success: true, command: "login" });
		expect(sidecars[0]?.commands).toEqual([{ type: "login", providerId: "p" }]);
		// Both devices' tabs and this machine's own tab read the new credentials.
		expect(sidecars.map(sidecar => sidecar.imageSyncs)).toEqual([1, 1]);
		expect(local.tab.imageSyncs).toBe(1);
	});

	it("counts a device's model requests and reply tokens and refuses its next request past a daily limit", async () => {
		const { services, sidecars } = setup();
		const stored = new Map<string, PeerInfo>([["device-x", { ...peer("device-x"), limits: { requestsPerDay: 2 } }]]);
		const quota = new PeerQuota(
			{
				get: id => stored.get(id),
				update: (id, patch) => {
					const current = stored.get(id);
					if (!current) return undefined;
					const next = { ...current, ...patch };
					stored.set(id, next);
					return next;
				},
			},
			() => {},
		);
		services.attachQuota(quota);
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		const send = (type: string) => services.call(x.peer, "tab.command", { rtab: "t1", command: { type } }, x);

		await send("prompt");
		// Reading state never counts.
		await send("get_state");
		sidecars[0]?.emit("events", [
			{ type: "message_end", message: { role: "assistant", usage: { totalTokens: 1_200 } } },
			{ type: "message_end", message: { role: "user" } },
		]);
		await send("follow_up");
		expect(stored.get("device-x")?.usage).toMatchObject({ requests: 2, tokens: 1_200 });

		const refused = await send("steer").catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("remote_limit_reached");
		await expect(send("get_state")).resolves.toMatchObject({ success: true });
		expect(sidecars[0]?.commands.map(command => command.type)).toEqual([
			"prompt",
			"get_state",
			"follow_up",
			"get_state",
		]);
	});

	describe("daily limits beyond the first ten commands", () => {
		const MODEL_SETUP_REQUEST: ModelSetupRequest = {
			researchModel: "anthropic/claude-opus-4-1",
			models: [{ selector: "anthropic/claude-opus-4-1", provider: "anthropic" }],
			roles: [{ id: "default", name: "Default" }],
		};
		function limited(limits: { requestsPerDay?: number }, requests = 0) {
			const fixture = setup();
			const stored = new Map<string, PeerInfo>([
				[
					"device-x",
					{
						...peer("device-x"),
						limits,
						usage: { day: localDay(new Date()), requests, tokens: 0 },
					},
				],
			]);
			fixture.services.attachQuota(
				new PeerQuota(
					{
						get: id => stored.get(id),
						update: (id, patch) => {
							const current = stored.get(id);
							if (!current) return undefined;
							const next = { ...current, ...patch };
							stored.set(id, next);
							return next;
						},
					},
					() => {},
				),
			);
			return { ...fixture, stored, x: new FakeConnection(peer("device-x")) };
		}
		const used = (stored: Map<string, PeerInfo>) => stored.get("device-x")?.usage?.requests;

		it("refuses omfg, tan and a summarizing leaf switch once the limit is used up, and still serves reads", async () => {
			const { services, sidecars, stored, x } = limited({ requestsPerDay: 1 }, 1);
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
			const send = (command: Record<string, unknown>) =>
				services.call(x.peer, "tab.command", { rtab: "t1", command }, x).catch((error: unknown) => error);

			for (const command of [
				{ type: "omfg", complaint: "no" },
				{ type: "tan", work: "x" },
				{ type: "switch_leaf", entryId: "e", summarize: true },
				{ type: "restore_interrupted" },
			]) {
				expect(ipcErrorCode(await send(command)), String(command.type)).toBe("remote_limit_reached");
			}
			expect(await send({ type: "switch_leaf", entryId: "e" })).toMatchObject({ success: true });
			expect(await send({ type: "get_state" })).toMatchObject({ success: true });
			expect(sidecars[0]?.commands.map(command => command.type)).toEqual(["switch_leaf", "get_state"]);
			expect(used(stored)).toBe(1);
		});

		it("counts omfg and a summarizing leaf switch as requests", async () => {
			const { services, stored, x } = limited({ requestsPerDay: 10 });
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
			for (const command of [
				{ type: "omfg", complaint: "no" },
				{ type: "switch_leaf", entryId: "e", summarize: true },
			])
				await services.call(x.peer, "tab.command", { rtab: "t1", command }, x);
			expect(used(stored)).toBe(2);
		});

		it("lets exactly one of several parallel prompts through at the limit minus one", async () => {
			const { services, sidecars, stored, x } = limited({ requestsPerDay: 3 }, 2);
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
			const sidecar = sidecars[0];
			if (!sidecar) throw new Error("expected a sidecar");
			// A slow omp: every command is in flight before the first one settles.
			let release = () => {};
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			sidecar.rpcClient.command = async (command: RpcCommand): Promise<RpcResponse> => {
				sidecar.commands.push(command);
				await gate;
				return { type: "response", command: command.type, success: true };
			};

			const settled = Array.from({ length: 5 }, () =>
				services
					.call(x.peer, "tab.command", { rtab: "t1", command: { type: "prompt", message: "hi" } }, x)
					.then(() => "ran")
					.catch((error: unknown) => ipcErrorCode(error)),
			);
			await Promise.resolve();
			release();
			const outcomes = await Promise.all(settled);
			expect(outcomes.filter(outcome => outcome === "ran")).toHaveLength(1);
			expect(outcomes.filter(outcome => outcome === "remote_limit_reached")).toHaveLength(4);
			expect(sidecar.commands).toHaveLength(1);
			expect(used(stored)).toBe(3);
		});

		it("gives the reserved request back when the command fails or throws", async () => {
			const { services, sidecars, stored, x } = limited({ requestsPerDay: 1 });
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
			const sidecar = sidecars[0];
			if (!sidecar) throw new Error("expected a sidecar");
			sidecar.rpcClient.command = async (command: RpcCommand): Promise<RpcResponse> => ({
				type: "response",
				command: command.type,
				success: false,
				error: "busy",
			});
			await services.call(x.peer, "tab.command", { rtab: "t1", command: { type: "prompt" } }, x);
			expect(used(stored)).toBe(0);
			sidecar.rpcClient.command = async () => {
				throw new Error("sidecar exited");
			};
			await expect(
				services.call(x.peer, "tab.command", { rtab: "t1", command: { type: "prompt" } }, x),
			).rejects.toThrow("sidecar exited");
			expect(used(stored)).toBe(0);
		});

		it("refuses host.bench.run and host.modelSetup.run past the limit without starting them", async () => {
			const { services, machine, stored, x } = limited({ requestsPerDay: 1 }, 1);
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
			const bench = await services
				.call(
					x.peer,
					"host.bench.run",
					{ rtab: "t1", options: { models: ["a/b"], profile: "chat", runs: 1, parallel: 1 } },
					x,
				)
				.catch((error: unknown) => error);
			expect(ipcErrorCode(bench)).toBe("remote_limit_reached");
			const setup = await services
				.call(x.peer, "host.modelSetup.run", { request: MODEL_SETUP_REQUEST }, x)
				.catch((error: unknown) => error);
			expect(ipcErrorCode(setup)).toBe("remote_limit_reached");
			expect(machine.runBenchmark).not.toHaveBeenCalled();
			expect(machine.runModelSetup).not.toHaveBeenCalled();
			expect(used(stored)).toBe(1);
		});

		it("counts a benchmark by its model runs and a model setup as one request, refunding a failed start", async () => {
			const { services, machine, stored, x } = limited({ requestsPerDay: 100 });
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
			machine.runBenchmark.mockResolvedValueOnce({
				success: true,
				summary: { runs: 3, models: [], failures: 0 },
				exitCode: 0,
			});
			await services.call(
				x.peer,
				"host.bench.run",
				{ rtab: "t1", options: { models: ["a/b", "c/d"], profile: "chat", runs: 3, parallel: 1 } },
				x,
			);
			expect(used(stored)).toBe(6);
			// The default fakes report `success: false`: nothing was spent, so nothing stays counted.
			await services.call(x.peer, "host.modelSetup.run", { request: MODEL_SETUP_REQUEST }, x);
			expect(used(stored)).toBe(6);
			machine.runModelSetup.mockResolvedValueOnce({
				success: true,
				plan: { assignments: [], advisor: { enable: false, reason: "" }, sources: [] },
				dropped: [],
			});
			await services.call(x.peer, "host.modelSetup.run", { request: MODEL_SETUP_REQUEST }, x);
			expect(used(stored)).toBe(7);
		});
	});

	it("pushes this machine's reply-language setting to every tab it hosts, leaving the local pool to ipc", async () => {
		const { services, sidecars, local } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		services.syncReplyLanguage();
		expect(sidecars.map(sidecar => sidecar.replyLanguageSyncs)).toEqual([1, 1]);
		expect(local.tab.replyLanguageSyncs).toBe(0);
	});

	it("pushes this machine's profile setting to every tab it hosts, leaving the local pool to ipc", async () => {
		const { services, sidecars, local } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		services.syncUserProfile();
		expect(sidecars.map(sidecar => sidecar.userProfileSyncs)).toEqual([1, 1]);
		expect(local.tab.userProfileSyncs).toBe(0);
	});

	it("pushes this machine's prompt-suggestion switches to every tab it hosts, leaving the local pool to ipc", async () => {
		const { services, sidecars, local } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		services.syncNextPrompt();
		expect(sidecars.map(sidecar => sidecar.nextPromptSyncs)).toEqual([1, 1]);
		expect(local.tab.nextPromptSyncs).toBe(0);
	});

	it("pushes this machine's automatic-title switches to every tab it hosts, leaving the local pool to ipc", async () => {
		const { services, sidecars, local } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		services.syncAutoTitle();
		expect(sidecars.map(sidecar => sidecar.autoTitleSyncs)).toEqual([1, 1]);
		expect(local.tab.autoTitleSyncs).toBe(0);
	});

	it("pushes this machine's judge-assist switch to every tab it hosts, leaving the local pool to ipc", async () => {
		const { services, sidecars, local } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		services.syncJudgeAssist();
		expect(sidecars.map(sidecar => sidecar.judgeAssistSyncs)).toEqual([1, 1]);
		expect(local.tab.judgeAssistSyncs).toBe(0);
	});

	it("pushes this machine's account-rotation setting to every tab it hosts, leaving the local pool to its own fan-out", async () => {
		const { services, sidecars, local } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		services.syncAccountRotation();
		expect(sidecars.map(sidecar => sidecar.accountRotationSyncs)).toEqual([1, 1]);
		expect(local.tab.accountRotationSyncs).toBe(0);
	});

	it("renames a session through this machine's own live tab; a delete closes that tab when idle and refuses only while it runs a turn", async () => {
		// 21 Oct 2026: a device's delete of a session a host window had open, idle, was refused for good ("Session is
		// open on the host"), while this computer's own delete closes another window's idle tab, and a device's idle one.
		const { services, local, deleteSession, renameStoredSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		const window = "/s/window.jsonl";
		local.owned.set(window, { tabId: "local-1", winId: 1 });
		local.tab.setStatus("ready");

		await services.call(x.peer, "sessions.rename", { sessionPath: window, name: " New " }, x);
		expect(local.tab.commands).toEqual([{ type: "set_session_name", name: "New", sessionPath: window }]);
		expect(renameStoredSession).not.toHaveBeenCalled();

		local.running.add(window);
		const refused = await services
			.call(x.peer, "sessions.delete", { sessionPath: window }, x)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(local.closed).toEqual([]);
		expect(deleteSession).not.toHaveBeenCalled();

		local.running.delete(window);
		await services.call(x.peer, "sessions.delete", { sessionPath: window }, x);
		expect(local.closed).toEqual(["local-1"]);
		expect(deleteSession).toHaveBeenCalledWith(window);
	});

	it("falls back to the stored file when no live tab holds the session, closing a sleeping tab", async () => {
		const { services, local, deleteSession, renameStoredSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		local.owned.set("/s/asleep.jsonl", { tabId: "local-1", winId: 1 });

		await services.call(x.peer, "sessions.rename", { sessionPath: "/s/asleep.jsonl", name: "Kept" }, x);
		await services.call(x.peer, "sessions.delete", { sessionPath: "/s/asleep.jsonl" }, x);
		expect(renameStoredSession).toHaveBeenCalledWith("/s/asleep.jsonl", "Kept");
		expect(deleteSession).toHaveBeenCalledWith("/s/asleep.jsonl");
		expect(local.tab.commands).toEqual([]);
		expect(local.closed).toEqual(["local-1"]);
	});

	it("deletes a session the device's own tab held once that tab's omp has exited", async () => {
		const { services, sidecars, deleteSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t", cwd: workDir, fresh: false }, x);
		sidecars[0]?.setStatus("ready");
		sidecars[0]?.emit("session", { sessionId: "s", sessionFile: "/s/x.jsonl" });

		// The device closes its tab first (its sidebar's delete), then deletes the session.
		await services.call(x.peer, "tab.close", { rtab: "t" }, x);
		expect(sidecars[0]?.disposed).toBe(true);
		const deleting = services.call(x.peer, "sessions.delete", { sessionPath: "/s/x.jsonl" }, x);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(deleteSession).not.toHaveBeenCalled();
		sidecars[0]?.exited.resolve();
		await deleting;
		expect(deleteSession).toHaveBeenCalledWith("/s/x.jsonl");
	});

	it("a device's close that arrives while its tab is still opening leaves no tab holding the session", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		// The device closed the tab before the host had finished opening it (tab.open awaits the folder and
		// the session's kind): the close found no tab, and the open then made one nothing ever closed.
		const opening = services
			.call(
				x.peer,
				"tab.open",
				{ rtab: "t", cwd: workDir, fresh: false, sessionPath: "/s/closed-while-opening.jsonl" },
				x,
			)
			.catch((error: unknown) => error);
		await services.call(x.peer, "tab.close", { rtab: "t" }, x);
		expect(ipcErrorCode(await opening)).toBe("unknown_tab");
		expect(sidecars.every(sidecar => sidecar.disposed)).toBe(true);
		expect(services.hostedSessions()).toEqual([]);
		// The same rtab opens again afterwards.
		await services.call(x.peer, "tab.open", { rtab: "t", cwd: workDir, fresh: false }, x);
		expect(sidecars.at(-1)?.disposed).toBe(false);
	});

	it("deletes a session the device's own tabs still hold from an earlier connection or as a duplicate, never one running a turn", async () => {
		const { services, sidecars, deleteSession } = setup();
		const before = new FakeConnection(peer("device-x"));
		await services.call(before.peer, "tab.open", { rtab: "old", cwd: workDir, fresh: false }, before);
		await services.call(before.peer, "tab.start", { rtab: "old" }, before);
		sidecars[0]?.setStatus("ready");
		sidecars[0]?.emit("session", { sessionId: "s", sessionFile: "/s/x.jsonl" });
		sidecars[0]?.emit("events", [{ type: "agent_start" }]);
		services.disconnected(before.peer, before);

		// The relaunched device never showed that tab, so it closes nothing first: a running turn refuses.
		const after = new FakeConnection(peer("device-x"));
		const refused = await services
			.call(after.peer, "sessions.delete", { sessionPath: "/s/x.jsonl" }, after)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(sidecars[0]?.disposed).toBe(false);

		// Idle, the device's own leftover tab is released and the file goes.
		sidecars[0]?.emit("events", [{ type: "agent_end" }]);
		const deleting = services.call(after.peer, "sessions.delete", { sessionPath: "/s/x.jsonl" }, after);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(sidecars[0]?.disposed).toBe(true);
		sidecars[0]?.exited.resolve();
		await deleting;
		expect(deleteSession).toHaveBeenCalledWith("/s/x.jsonl");
	});

	it("deletes only after every one of the device's duplicate omps on the file has exited, in any order", async () => {
		const { services, sidecars, deleteSession } = setup();
		const x = peer("device-x");
		// Two leftovers of an older release on one file (revived markers make them without the open's guard).
		services.reviveTab(x, { tab: "peer:device-x:a", cwd: workDir, kind: "agent", sessionPath: "/s/d.jsonl" });
		services.reviveTab(x, { tab: "peer:device-x:b", cwd: workDir, kind: "agent", sessionPath: "/s/d.jsonl" });
		expect(sidecars).toHaveLength(2);
		const conn = new FakeConnection(x);
		const deleting = services.call(x, "sessions.delete", { sessionPath: "/s/d.jsonl" }, conn);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(sidecars.every(sidecar => sidecar.disposed)).toBe(true);
		sidecars[1]?.exited.resolve();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(deleteSession).not.toHaveBeenCalled();
		sidecars[0]?.exited.resolve();
		await deleting;
		expect(deleteSession).toHaveBeenCalledWith("/s/d.jsonl");
	});

	it("Stop and delete: a device's sessions.stop stops the turn a device's tab or a window here runs, answering once it ended", async () => {
		const { services, sidecars, local, deleteSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(y.peer, "tab.open", { rtab: "t", cwd: workDir, fresh: false }, y);
		await services.call(y.peer, "tab.start", { rtab: "t" }, y);
		const sidecar = sidecars[0];
		sidecar?.setStatus("ready");
		sidecar?.emit("session", { sessionId: "s", sessionFile: "/s/y.jsonl" });
		sidecar?.emit("events", [{ type: "agent_start" }]);

		let ended = false;
		const stopping = services.call(x.peer, "sessions.stop", { sessionPath: "/s/y.jsonl" }, x).then(() => {
			ended = true;
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(sidecar?.commands).toContainEqual({ type: "abort_and_restore_queue" });
		expect(ended).toBe(false);
		sidecar?.emit("events", [{ type: "agent_end" }]);
		await stopping;
		// The delete the user already confirmed now goes through.
		const deleting = services.call(x.peer, "sessions.delete", { sessionPath: "/s/y.jsonl" }, x);
		await new Promise<void>(resolve => setImmediate(resolve));
		sidecar?.exited.resolve();
		await deleting;
		expect(deleteSession).toHaveBeenCalledWith("/s/y.jsonl");

		// A window here runs it: its pool stops that tab.
		local.running.add("/s/w.jsonl");
		await services.call(x.peer, "sessions.stop", { sessionPath: "/s/w.jsonl" }, x);
		expect(local.stopped).toEqual(["/s/w.jsonl"]);
	});

	it("a device's delete closes another device's idle host tab on the session and tells it, and refuses while that tab runs a turn", async () => {
		const { services, sidecars, deleteSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(y.peer, "tab.open", { rtab: "t", cwd: workDir, fresh: false }, y);
		await services.call(y.peer, "tab.start", { rtab: "t" }, y);
		sidecars[0]?.setStatus("ready");
		sidecars[0]?.emit("session", { sessionId: "s", sessionFile: "/s/y.jsonl" });

		sidecars[0]?.emit("events", [{ type: "agent_start" }]);
		const refused = await services
			.call(x.peer, "sessions.delete", { sessionPath: "/s/y.jsonl" }, x)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(sidecars[0]?.disposed).toBe(false);
		expect(deleteSession).not.toHaveBeenCalled();

		sidecars[0]?.emit("events", [{ type: "agent_end" }]);
		const deleting = services.call(x.peer, "sessions.delete", { sessionPath: "/s/y.jsonl" }, x);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(sidecars[0]?.disposed).toBe(true);
		sidecars[0]?.exited.resolve();
		await deleting;
		expect(deleteSession).toHaveBeenCalledWith("/s/y.jsonl");
		// The other device drops its tab and saved layout entry once the file is gone.
		expect(y.tabEvents()).toContainEqual({ rtab: "t", name: "sessionDeleted", arg: "/s/y.jsonl" });
	});

	it("this computer's own delete closes an idle device tab on the session, tells the device, and waits for its omp", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t", cwd: workDir, fresh: false }, x);
		await services.call(x.peer, "tab.start", { rtab: "t" }, x);
		sidecars[0]?.setStatus("ready");
		sidecars[0]?.emit("session", { sessionId: "s", sessionFile: "/s/x.jsonl" });

		// A turn runs: the person here must wait, as for another window's running tab.
		sidecars[0]?.emit("events", [{ type: "agent_start" }]);
		const refused = await services.closeSessionTabs("/s/x.jsonl").catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(sidecars[0]?.disposed).toBe(false);

		sidecars[0]?.emit("events", [{ type: "agent_end" }]);
		let notify: (() => void) | undefined;
		const closing = services.closeSessionTabs("/s/x.jsonl").then(told => {
			notify = told;
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(sidecars[0]?.disposed).toBe(true);
		expect(services.hostedSessions()).toEqual([]);
		expect(notify).toBeUndefined();
		// Closed, not yet deleted: the device's tab ends, but no tombstone until the file is gone.
		expect(x.tabEvents().map(event => event.name)).not.toContain("sessionDeleted");
		expect(x.tabEvents().at(-1)).toMatchObject({ rtab: "t", name: "status", arg: { status: "exited" } });
		sidecars[0]?.exited.resolve();
		await closing;
		// The stored file went: the device drops its tab and saved layout entry, and records the delete.
		notify?.();
		expect(x.tabEvents()).toContainEqual({ rtab: "t", name: "sessionDeleted", arg: "/s/x.jsonl" });
	});

	it("resumes the requested session on start and works out its kind on the host", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		const opened = await services.call(
			x.peer,
			"tab.open",
			{ rtab: "t1", cwd: workDir, fresh: false, sessionPath: "/s/chat.jsonl" },
			x,
		);
		expect(opened).toMatchObject({ kind: "chat", attached: false });
		await services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		expect(sidecars[0]?.started).toEqual([{ resume: "/s/chat.jsonl" }]);
		// tab.start is idempotent once the sidecar left "asleep".
		await services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		expect(sidecars[0]?.started).toHaveLength(1);

		const missing = await services
			.call(x.peer, "tab.open", { rtab: "t2", cwd: join(workDir, "nope"), fresh: true }, x)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(missing)).toBe("file_not_found");
	});

	it("keeps a disconnected device's tabs for the grace period, re-attaches them, then disposes", async () => {
		vi.useFakeTimers();
		const { services, sidecars } = setup(1_000);
		const first = new FakeConnection(peer("device-x"));
		await services.call(first.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, first);
		await services.call(first.peer, "tab.start", { rtab: "t1" }, first);
		sidecars[0]?.setStatus("ready");

		services.disconnected(first.peer, first);
		const eventsWhileAway = first.events.length;
		sidecars[0]?.emit("events", [{ type: "agent_end" }]);
		expect(first.events).toHaveLength(eventsWhileAway);
		vi.advanceTimersByTime(900);

		const second = new FakeConnection(peer("device-x"));
		const reopened = await services.call(second.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, second);
		expect(reopened).toEqual({ cwd: workDir, kind: "agent", attached: true });
		expect(sidecars).toHaveLength(1);
		// The turn and the status are re-sent on attach, the asks its omp holds (none), and whether this computer holds
		// the turn for its connection.
		expect(second.tabEvents()).toEqual([
			{ rtab: "t1", name: "run", arg: { running: false, turn: false } },
			expect.objectContaining({ name: "status", arg: expect.objectContaining({ status: "ready" }) }),
			{ rtab: "t1", name: "signIn", arg: { active: [] } },
			{ rtab: "t1", name: "openAsks", arg: [] },
			{ rtab: "t1", name: "awaitingConnection", arg: false },
		]);
		vi.advanceTimersByTime(5_000);
		expect(sidecars[0]?.disposed).toBe(false);

		services.disconnected(second.peer, second);
		vi.advanceTimersByTime(1_000);
		expect(sidecars[0]?.disposed).toBe(true);
		const gone = await services
			.call(second.peer, "tab.command", { rtab: "t1", command: { type: "get_state" } }, second)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(gone)).toBe("unknown_tab");
	});

	it("a relaunched device's reopen under a new rtab takes over the tab its last connection left on that session", async () => {
		const { services, sidecars } = setup();
		const before = new FakeConnection(peer("device-x"));
		await services.call(before.peer, "tab.open", { rtab: "old", cwd: workDir, fresh: true }, before);
		await services.call(before.peer, "tab.start", { rtab: "old" }, before);
		sidecars[0]?.setStatus("ready");
		sidecars[0]?.emit("session", { sessionId: "s1", sessionFile: "/s/one.jsonl" });
		sidecars[0]?.emit("events", [{ type: "agent_start" }]);
		services.disconnected(before.peer, before);

		const after = new FakeConnection(peer("device-x"));
		const reopened = await services.call(
			after.peer,
			"tab.open",
			{ rtab: "new", cwd: workDir, sessionPath: "/s/one.jsonl" },
			after,
		);
		// The running omp, not a second one on the same session file.
		expect(reopened).toEqual({ cwd: workDir, kind: "agent", attached: true });
		expect(sidecars).toHaveLength(1);
		expect(services.runningPeers()).toEqual(["device-x"]);
		sidecars[0]?.emit("events", [{ type: "agent_end" }]);
		expect(after.tabEvents().map(event => [event.rtab, event.name])).toEqual([
			["new", "run"],
			["new", "status"],
			["new", "signIn"],
			["new", "openAsks"],
			["new", "awaitingConnection"],
			["new", "events"],
		]);
		const old = await services
			.call(after.peer, "tab.command", { rtab: "old", command: { type: "get_state" } }, after)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(old)).toBe("unknown_tab");

		// Another device's open of that path, or this connection's own under a second rtab, is refused:
		// never a second omp on the same file.
		const other = new FakeConnection(peer("device-y"));
		const refusedOther = await services
			.call(other.peer, "tab.open", { rtab: "y1", cwd: workDir, sessionPath: "/s/one.jsonl" }, other)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refusedOther)).toBe("session_open_in_tab");
		const refusedSame = await services
			.call(after.peer, "tab.open", { rtab: "again", cwd: workDir, sessionPath: "/s/one.jsonl" }, after)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refusedSame)).toBe("session_open_in_tab");
		expect(sidecars).toHaveLength(1);
	});

	it("lists the working tabs a device's last connection left, and only those, with the rtabs they had", async () => {
		const { services, sidecars } = setup();
		const open = async (conn: FakeConnection, rtab: string, session?: string) => {
			await services.call(
				conn.peer,
				"tab.open",
				{ rtab, cwd: workDir, fresh: !session, sessionPath: session },
				conn,
			);
			await services.call(conn.peer, "tab.start", { rtab }, conn);
			const sidecar = sidecars[sidecars.length - 1];
			sidecar?.setStatus("ready");
			if (session) sidecar?.emit("session", { sessionId: rtab, sessionFile: session });
			return sidecar;
		};
		const x = new FakeConnection(peer("device-x"));
		const running = await open(x, "running", "/s/running.jsonl");
		running?.emit("events", [{ type: "agent_start" }]);
		const idle = await open(x, "idle", "/s/idle.jsonl");
		const asking = await open(x, "asking", "/s/asking.jsonl");
		asking?.emit("extensionUi", { type: "extension_ui_request", id: "ask-1", method: "confirm", title: "?" });
		const unwritten = await open(x, "unwritten");
		unwritten?.emit("events", [{ type: "agent_start" }]);
		const y = new FakeConnection(peer("device-y"));
		const other = await open(y, "other", "/s/other.jsonl");
		other?.emit("events", [{ type: "agent_start" }]);
		// The relaunched device re-attaches one of its running tabs before it asks.
		services.disconnected(x.peer, x);
		services.disconnected(y.peer, y);
		const back = new FakeConnection(peer("device-x"));
		await services.call(back.peer, "tab.open", { rtab: "held", cwd: workDir, sessionPath: "/s/running.jsonl" }, back);

		const kept = (conn: FakeConnection) => services.call(conn.peer, "tabs.kept", {}, conn);
		expect(await kept(back)).toEqual({
			tabs: [
				{
					rtab: "asking",
					formerRtabs: [],
					sessionPath: "/s/asking.jsonl",
					cwd: workDir,
					kind: "chat",
					state: "asking",
				},
			],
		});

		// The one it took over names the id it had before: an id an agent was given still resolves.
		services.disconnected(back.peer, back);
		const later = new FakeConnection(peer("device-x"));
		expect(await kept(later)).toMatchObject({
			tabs: [
				{ rtab: "asking", state: "asking" },
				{ rtab: "held", formerRtabs: ["running"], sessionPath: "/s/running.jsonl", state: "running" },
			],
		});
		expect(idle?.disposed).toBe(false);
		expect(await kept(new FakeConnection(peer("device-z")))).toEqual({ tabs: [] });
	});

	it("starts one omp for concurrent opens of one session under two rtabs, on one connection or a reconnect", async () => {
		const { services, sidecars } = setup();
		const conn = new FakeConnection(peer("device-x"));
		const opens = await Promise.allSettled([
			services.call(conn.peer, "tab.open", { rtab: "a", cwd: workDir, sessionPath: "/s/one.jsonl" }, conn),
			services.call(conn.peer, "tab.open", { rtab: "b", cwd: workDir, sessionPath: "/s/one.jsonl" }, conn),
		]);
		// Whichever open's folder check finishes first takes the session; the other is refused.
		expect(opens.map(open => open.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(sidecars).toHaveLength(1);

		// The link drops while the device reopens: the new connection's open takes the tab, never a second.
		const later = new FakeConnection(peer("device-x"));
		const raced = await Promise.allSettled([
			services.call(later.peer, "tab.open", { rtab: "c", cwd: workDir, sessionPath: "/s/two.jsonl" }, later),
			services.call(conn.peer, "tab.open", { rtab: "d", cwd: workDir, sessionPath: "/s/two.jsonl" }, conn),
		]);
		expect(raced.filter(open => open.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
		expect(sidecars).toHaveLength(2);
	});

	it("stops the second omp when a host tab moves onto a session another tab holds, keeping the one running a turn", async () => {
		const { services, sidecars } = setup();
		const conn = new FakeConnection(peer("device-x"));
		for (const rtab of ["a", "b"]) {
			await services.call(conn.peer, "tab.open", { rtab, cwd: workDir, fresh: true }, conn);
			await services.call(conn.peer, "tab.start", { rtab }, conn);
		}
		sidecars[0]?.setStatus("ready");
		sidecars[1]?.setStatus("ready");
		sidecars[0]?.emit("session", { sessionId: "s1", sessionFile: "/s/one.jsonl" });
		sidecars[0]?.emit("events", [{ type: "agent_start" }]);
		sidecars[1]?.emit("session", { sessionId: "s1", sessionFile: "/s/one.jsonl" });
		expect(sidecars[1]?.disposed).toBe(true);
		expect(sidecars[0]?.disposed).toBe(false);
		const gone = await services
			.call(conn.peer, "tab.command", { rtab: "b", command: { type: "get_state" } }, conn)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(gone)).toBe("unknown_tab");
		expect(
			conn
				.tabEvents()
				.filter(event => event.rtab === "b")
				.at(-1),
		).toMatchObject({
			name: "status",
			arg: { status: "exited", processAlive: false },
		});
	});

	it("re-sends the asks its omp holds on every re-attach: none after that omp restarted, else the open ones", async () => {
		const { services, sidecars } = setup();
		const first = new FakeConnection(peer("device-x"));
		await services.call(first.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, first);
		await services.call(first.peer, "tab.start", { rtab: "t1" }, first);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		const ask = { type: "extension_ui_request", id: "ask-1", method: "confirm", title: "Deploy?", message: "" };
		sidecar.emit("extensionUi", ask);
		const openAsks = (conn: FakeConnection) => conn.tabEvents().find(event => event.name === "openAsks")?.arg;

		// The link drops and comes back: the ask is still open, whole.
		services.disconnected(first.peer, first);
		const second = new FakeConnection(peer("device-x"));
		await services.call(second.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, second);
		expect(openAsks(second)).toEqual([ask]);

		// While away: one answered, one withdrawn, one raised; a select and fire-and-forget UI around them.
		const approval = {
			type: "extension_ui_request",
			id: "ask-2",
			method: "select",
			title: "Allow tool: bash",
			options: ["Approve", "Deny"],
		};
		sidecar.emit("extensionUi", approval);
		await services.call(
			second.peer,
			"tab.sideChannel",
			{ rtab: "t1", frame: { type: "extension_ui_response", id: "ask-1", confirmed: true } },
			second,
		);
		services.disconnected(second.peer, second);
		sidecar.emit("extensionUi", { type: "extension_ui_request", id: "c", method: "cancel", targetId: "ask-2" });
		const later = { type: "extension_ui_request", id: "ask-3", method: "input", title: "Name?" };
		sidecar.emit("extensionUi", later);
		sidecar.emit("extensionUi", { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "k" });
		const third = new FakeConnection(peer("device-x"));
		await services.call(third.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, third);
		expect(openAsks(third)).toEqual([later]);

		// The omp restarts while the device is away: the asks went with it, and the device learns so.
		services.disconnected(third.peer, third);
		sidecar.setStatus("restarting");
		sidecar.setStatus("ready");
		const fourth = new FakeConnection(peer("device-x"));
		const reopened = await services.call(fourth.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, fourth);
		expect(reopened).toMatchObject({ attached: true });
		expect(fourth.tabEvents().map(event => event.name)).toEqual([
			"run",
			"status",
			"signIn",
			"openAsks",
			"awaitingConnection",
		]);
		expect(openAsks(fourth)).toEqual([]);
	});

	it("re-sends the host tool calls its omp still waits on: one made while the device was away, and every open one to a relaunched device", async () => {
		// The 21 Oct 2026 update restart: a hosted child called `ompdesk_report` 7 s after its device quit, the call
		// reached no connection, nobody ever answered it, and the turn waited on it for good (stock has no timeout).
		const { services, sidecars } = setup();
		const first = new FakeConnection(peer("device-x"));
		await services.call(first.peer, "tab.open", { rtab: "old", cwd: workDir, fresh: true }, first);
		await services.call(first.peer, "tab.start", { rtab: "old" }, first);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		sidecar.emit("session", { sessionId: "s1", sessionFile: "/s/one.jsonl" });
		sidecar.emit("events", [{ type: "agent_start" }]);
		const call = (id: string) => ({ type: "host_tool_call", id, toolCallId: `c-${id}`, toolName: "ompdesk_report" });
		const resent = (conn: FakeConnection) =>
			conn
				.tabEvents()
				.filter(event => event.name === "hostToolCall" || event.name === "hostUriRequest")
				.map(({ arg }) => (typeof arg === "object" && arg !== null && "id" in arg ? arg.id : undefined));

		// The device has this one; the link drops while it runs it.
		sidecar.emit("hostToolCall", call("seen"));
		services.disconnected(first.peer, first);
		// The omp asks while nobody is connected, and withdraws one it gave up on.
		sidecar.emit("hostToolCall", call("away"));
		sidecar.emit("hostUriRequest", { type: "host_uri_request", id: "uri", operation: "read", url: "x://y" });
		sidecar.emit("hostToolCall", call("withdrawn"));
		sidecar.emit("frame", { type: "host_tool_cancel", id: "cancel-1", targetId: "withdrawn" });

		// The same device comes back (a lost link): it gets what it never had, not the call it already runs.
		const second = new FakeConnection(peer("device-x"));
		await services.call(second.peer, "tab.open", { rtab: "old", cwd: workDir, fresh: true }, second);
		expect(resent(second)).toEqual(["away", "uri"]);
		// Never handed to a connection before: provably new to the device, so not marked re-sent.
		expect(second.tabEvents().find(event => event.name === "hostToolCall")?.arg).toEqual(call("away"));
		await services.call(
			second.peer,
			"tab.sideChannel",
			{ rtab: "old", frame: { type: "host_tool_result", id: "away", result: { content: [] } } },
			second,
		);
		services.disconnected(second.peer, second);

		// The device relaunched: its old process took the calls it held with it, so every open one goes again.
		const third = new FakeConnection(peer("device-x"));
		await services.call(third.peer, "tab.open", { rtab: "new", cwd: workDir, sessionPath: "/s/one.jsonl" }, third);
		expect(resent(third)).toEqual(["seen", "uri"]);
		// Handed to the connection that went: the device may have run it, and is told so (agent-control/call-journal.ts).
		expect(third.tabEvents().find(event => event.name === "hostToolCall")).toEqual({
			rtab: "new",
			name: "hostToolCall",
			arg: { ...call("seen"), resent: true },
		});

		// An omp that restarts took its calls with it.
		services.disconnected(third.peer, third);
		sidecar.setStatus("restarting");
		sidecar.setStatus("ready");
		const fourth = new FakeConnection(peer("device-x"));
		await services.call(fourth.peer, "tab.open", { rtab: "new", cwd: workDir, fresh: true }, fourth);
		expect(resent(fourth)).toEqual([]);
	});

	it("tells the device which sign-ins its tab runs: as they start and end, and on every re-attach, link or no link", async () => {
		const { services, sidecars } = setup();
		const first = new FakeConnection(peer("device-x"));
		await services.call(first.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, first);
		await services.call(first.peer, "tab.start", { rtab: "t1" }, first);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		const signIns = (conn: FakeConnection) =>
			conn
				.tabEvents()
				.filter(event => event.name === "signIn")
				.map(event => event.arg);
		const finish = Promise.withResolvers<RpcResponse>();
		sidecar.rpcClient.command = async () => finish.promise;
		const login = services.call(
			first.peer,
			"tab.command",
			{ rtab: "t1", command: { type: "login", providerId: "anthropic" } },
			first,
		);
		// A new tab tells the device no sign-in runs on it: the device's state may date from a tab that is gone.
		await vi.waitFor(() => expect(signIns(first)).toEqual([{ active: [] }, { active: ["anthropic"] }]));

		// The link drops mid-login; the sign-in runs on, and the device is told so when it is back.
		services.disconnected(first.peer, first);
		const second = new FakeConnection(peer("device-x"));
		await services.call(second.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, second);
		expect(signIns(second)).toEqual([{ active: ["anthropic"] }]);
		// `signIn` precedes `openAsks`, which the device reads against it.
		expect(second.tabEvents().map(event => event.name)).toEqual([
			"run",
			"status",
			"signIn",
			"openAsks",
			"awaitingConnection",
		]);

		finish.resolve({ type: "response", command: "login", success: false, error: "denied" });
		await login;
		expect(signIns(second)).toEqual([
			{ active: ["anthropic"] },
			{ active: [], ended: { providerId: "anthropic", error: "denied" } },
		]);

		// A sign-in that connected ends with a null error; a later re-attach finds none running.
		sidecar.rpcClient.command = async () => ({ type: "response", command: "login", success: true });
		await services.call(
			second.peer,
			"tab.command",
			{ rtab: "t1", command: { type: "login", providerId: "p" } },
			second,
		);
		expect(signIns(second).at(-1)).toEqual({ active: [], ended: { providerId: "p", error: null } });
		services.disconnected(second.peer, second);
		const third = new FakeConnection(peer("device-x"));
		await services.call(third.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, third);
		expect(signIns(third)).toEqual([{ active: [] }]);
	});

	it("keeps a hosted turn running when Windows ended the session under its omp", async () => {
		const { services, sidecars } = setup();
		services.attachResume({ sync: vi.fn(), cancelWait: vi.fn() });
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, sessionPath: "/s/one.jsonl" }, x);
		await services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		sidecar.emit("events", [{ type: "agent_start" }]);

		// The next launch continues this turn: its marker's input stays while main lives out its last seconds.
		sidecar.emit("status", { status: "exited", cwd: workDir, sessionEnded: true });
		expect(services.resumeFacts()[0]).toMatchObject({ running: true });

		sidecar.emit("status", { status: "restarting", cwd: workDir });
		expect(services.resumeFacts()[0]).toMatchObject({ running: false });
	});

	it("logs a paired device's Stop on this host with the device and its control, and omp never sees the origin", async () => {
		const lines: Array<Record<string, string | number>> = [];
		setTurnStopLog({ write: details => lines.push(details), sessionOf: () => undefined });
		try {
			const { services, sidecars } = setup();
			const x = new FakeConnection(peer("device-x"));
			await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, sessionPath: "/s/one.jsonl" }, x);
			await services.call(x.peer, "tab.start", { rtab: "t1" }, x);
			sidecars[0]?.setStatus("ready");
			await services.call(
				x.peer,
				"tab.command",
				{ rtab: "t1", command: { type: "abort_and_restore_queue", origin: { surface: "esc" } } },
				x,
			);
			expect(sidecars[0]?.commands).toEqual([{ type: "abort_and_restore_queue" }]);
			expect(lines).toEqual([
				{
					command: "abort_and_restore_queue",
					tab: "peer:device-x:t1",
					by: "desktop-device",
					surface: "esc",
					device: "device-x",
					session: "one.jsonl",
				},
			]);
		} finally {
			setTurnStopLog(null);
		}
	});

	it("gives this computer's resume coordinator the hosted turns: facts, Stop, asks, the wait and its Cancel", async () => {
		const { services, sidecars } = setup();
		const resume = { sync: vi.fn(), cancelWait: vi.fn() };
		services.attachResume(resume);
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, sessionPath: "/s/one.jsonl" }, x);
		await services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		const fact = () => services.resumeFacts()[0];
		expect(fact()).toMatchObject({ tabId: "peer:device-x:t1", peer: "device-x", sessionFile: "/s/one.jsonl" });
		expect(services.tabForSession("/s/one.jsonl", "device-x")).toBe("peer:device-x:t1");
		expect(services.tabForSession("/s/one.jsonl", "device-y")).toBeNull();

		resume.sync.mockClear();
		sidecar.emit("events", [{ type: "agent_start" }]);
		expect(fact()).toMatchObject({ running: true, stopped: false, awaitingUi: false });
		expect(resume.sync).toHaveBeenCalled();

		// An ask the device answers, and one omp withdraws.
		sidecar.emit("extensionUi", { type: "extension_ui_request", id: "ask-1", method: "confirm", title: "?" });
		expect(fact()?.awaitingUi).toBe(true);
		await services.call(
			x.peer,
			"tab.sideChannel",
			{ rtab: "t1", frame: { type: "extension_ui_response", id: "ask-1" } },
			x,
		);
		expect(fact()?.awaitingUi).toBe(false);
		sidecar.emit("extensionUi", {
			type: "extension_ui_request",
			id: "ask-2",
			method: "select",
			title: "?",
			options: [],
		});
		sidecar.emit("extensionUi", { type: "extension_ui_request", id: "c", method: "cancel", targetId: "ask-2" });
		expect(fact()?.awaitingUi).toBe(false);

		// A network failure: the outcome reaches the rules before the device sees the events.
		resume.sync.mockImplementation(() => {
			if (fact()?.lastRun) services.setAwaitingConnection("peer:device-x:t1", true);
		});
		sidecar.emit("events", [
			{
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" }],
			},
		]);
		expect(fact()).toMatchObject({ running: false, awaitingConnection: true, lastRun: { stopReason: "error" } });
		expect(
			x
				.tabEvents()
				.slice(-2)
				.map(event => event.name),
		).toEqual(["awaitingConnection", "events"]);
		resume.sync.mockImplementation(() => {});

		// The device lost this computer and came back: it is told the wait still holds.
		services.disconnected(x.peer, x);
		const back = new FakeConnection(peer("device-x"));
		await services.call(back.peer, "tab.open", { rtab: "t1", cwd: workDir }, back);
		expect(back.tabEvents()).toContainEqual({ rtab: "t1", name: "awaitingConnection", arg: true });
		await services.call(back.peer, "tab.cancelWait", { rtab: "t1" }, back);
		expect(resume.cancelWait).toHaveBeenCalledWith("peer:device-x:t1");
		services.setAwaitingConnection("peer:device-x:t1", false);
		expect(back.tabEvents().at(-1)).toEqual({ rtab: "t1", name: "awaitingConnection", arg: false });

		// The device's Stop: nothing continues the turn after a crash.
		sidecar.emit("events", [{ type: "agent_start" }]);
		await services.call(back.peer, "tab.command", { rtab: "t1", command: { type: "abort" } }, back);
		expect(fact()?.stopped).toBe(true);
	});

	it("revives a marked hosted tab after a relaunch: asleep until resumed, then the device's reopen attaches it", async () => {
		vi.useFakeTimers();
		const { services, sidecars } = setup(1_000);
		const x = peer("device-x");
		const marker = { tab: "peer:device-x:t1", cwd: workDir, kind: "agent" as const, sessionPath: "/s/one.jsonl" };
		expect(services.reviveTab(x, { ...marker, tab: "peer:device-y:t1" })).toBeNull();
		expect(services.reviveTab(x, marker)).toBe("peer:device-x:t1");
		expect(services.reviveTab(x, marker)).toBe("peer:device-x:t1");
		expect(sidecars).toHaveLength(1);
		expect(sidecars[0]?.started).toEqual([]);

		expect(services.startTab("peer:device-x:t1")).toBe(sidecars[0]);
		expect(sidecars[0]?.started).toEqual([{ resume: "/s/one.jsonl" }]);
		sidecars[0]?.setStatus("ready");

		const conn = new FakeConnection(x);
		const reopened = await services.call(x, "tab.open", { rtab: "t1", cwd: workDir }, conn);
		expect(reopened).toEqual({ cwd: workDir, kind: "agent", attached: true });
		vi.advanceTimersByTime(5_000);
		expect(sidecars[0]?.disposed).toBe(false);

		// A device that never comes back: the revived tab closes like a dropped connection's.
		services.reviveTab(x, { ...marker, tab: "peer:device-x:t2", sessionPath: "/s/two.jsonl" });
		vi.advanceTimersByTime(1_000);
		expect(sidecars[1]?.disposed).toBe(true);
	});

	it("lets a revived turn with no device run to its end: the grace closes only an idle tab, and its fact stays meanwhile", async () => {
		vi.useFakeTimers();
		const { services, sidecars } = setup(1_000);
		services.attachResume({ sync: vi.fn(), cancelWait: vi.fn() });
		const x = peer("device-x");
		const fact = (id: string) => services.resumeFacts().find(entry => entry.tabId === id);

		// Continued after a relaunch; the device never comes back.
		const busy = services.reviveTab(x, {
			tab: "peer:device-x:t1",
			cwd: workDir,
			kind: "agent",
			sessionPath: "/s/1.jsonl",
		});
		if (!busy) throw new Error("expected a revived tab");
		services.startTab(busy);
		sidecars[0]?.setStatus("ready");
		sidecars[0]?.emit("events", [{ type: "agent_start" }]);
		vi.advanceTimersByTime(5_000);
		expect(sidecars[0]?.disposed).toBe(false);
		expect(fact(busy)).toMatchObject({ running: true });
		sidecars[0]?.emit("events", [{ type: "agent_end" }]);
		expect(fact(busy)).toMatchObject({ running: false });
		// Idle now: the next grace period closes it.
		vi.advanceTimersByTime(1_000);
		expect(sidecars[0]?.disposed).toBe(true);
		expect(fact(busy)).toBeUndefined();

		// Held for this computer's connection: the turn has not run yet, so the tab waits too.
		const held = services.reviveTab(x, {
			tab: "peer:device-x:t2",
			cwd: workDir,
			kind: "agent",
			sessionPath: "/s/2.jsonl",
		});
		if (!held) throw new Error("expected a revived tab");
		services.setAwaitingConnection(held, true);
		vi.advanceTimersByTime(5_000);
		expect(sidecars[1]?.disposed).toBe(false);
		services.setAwaitingConnection(held, false);
		services.startTab(held);
		sidecars[1]?.setStatus("ready");
		sidecars[1]?.emit("events", [{ type: "agent_start" }]);
		expect(sidecars[1]?.disposed).toBe(false);
		// The device came back after all: its tab stays when the turn ends.
		const conn = new FakeConnection(x);
		await services.call(x, "tab.open", { rtab: "t2", cwd: workDir }, conn);
		sidecars[1]?.emit("events", [{ type: "agent_end" }]);
		vi.advanceTimersByTime(5_000);
		expect(sidecars[1]?.disposed).toBe(false);
	});

	it("pushes one sessions.changed per burst to every connected device, and drops a revoked peer's tabs", async () => {
		vi.useFakeTimers();
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "sessions.list", { scope: "global" }, y);

		services.sessionsChanged();
		services.sessionsChanged();
		vi.advanceTimersByTime(1_000);
		expect(x.events.filter(entry => entry.event === "sessions.changed")).toHaveLength(1);
		expect(y.events.filter(entry => entry.event === "sessions.changed")).toHaveLength(1);

		services.dropPeer("device-x");
		expect(sidecars[0]?.disposed).toBe(true);
	});

	it("serves a saved session's transcript to a device's agent, never one this computer's user hid", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		expect(await services.call(x.peer, "sessions.messages", { sessionPath: "/s/a.jsonl" }, x)).toEqual([
			{ role: "user", content: "read /s/a.jsonl", timestamp: 1 },
		]);
		await expect(
			services.call(x.peer, "sessions.messages", { sessionPath: "/hidden/session.jsonl" }, x),
		).rejects.toThrow("hid that session");
	});

	it("reports which devices have a host tab running a turn, through settle, restart and close", async () => {
		const { services, sidecars } = setup();
		const changes = vi.fn();
		services.onRunningChange(changes);
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		const [xTab, yTab] = sidecars;
		if (!xTab || !yTab) throw new Error("expected two sidecars");
		xTab.setStatus("ready");
		yTab.setStatus("ready");
		expect(services.runningPeers()).toEqual([]);

		xTab.emit("events", [{ type: "agent_start" }]);
		expect(services.runningPeers()).toEqual(["device-x"]);
		expect(changes).toHaveBeenCalledTimes(1);

		// The prompt yielded but background work can still wake it: agent_end is not the end.
		xTab.emit("promptResult", { type: "prompt_result", agentInvoked: true, sessionSettled: false });
		xTab.emit("events", [{ type: "agent_end" }]);
		services.disconnected(x.peer, x);
		expect(services.runningPeers()).toEqual(["device-x"]);
		xTab.emit("sessionSettled", { type: "session_settled" });
		expect(services.runningPeers()).toEqual([]);
		expect(changes).toHaveBeenCalledTimes(2);

		// A restart ends the run; closing a running tab does too.
		yTab.emit("events", [{ type: "agent_start" }]);
		yTab.setStatus("restarting");
		expect(services.runningPeers()).toEqual([]);
		yTab.setStatus("ready");
		yTab.emit("events", [{ type: "agent_start" }]);
		expect(services.runningPeers()).toEqual(["device-y"]);
		await services.call(y.peer, "tab.close", { rtab: "t1" }, y);
		expect(services.runningPeers()).toEqual([]);
		expect(changes).toHaveBeenCalledTimes(6);
	});

	it("moves hosted tabs to a newly updated omp: idle ones now on their session, a busy one when its turn ends", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		const [xTab, yTab] = sidecars;
		if (!xTab || !yTab) throw new Error("expected two sidecars");
		xTab.setStatus("ready");
		yTab.setStatus("ready");
		xTab.emit("session", { sessionId: "sx", sessionFile: "/sessions/x.jsonl" });
		yTab.emit("session", { sessionId: "sy", sessionFile: "/sessions/y.jsonl" });
		yTab.emit("events", [{ type: "agent_start" }]);
		xTab.started.length = 0;
		yTab.started.length = 0;

		services.restartOnNewOmp();
		expect(xTab.started).toEqual([{ resume: "/sessions/x.jsonl" }]);
		expect(yTab.started).toEqual([]);
		yTab.emit("events", [{ type: "agent_end" }]);
		expect(yTab.started).toEqual([]);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(yTab.started).toEqual([{ resume: "/sessions/y.jsonl" }]);
	});

	it("applies an extension update to hosted tabs: idle now, a busy one when its turn ends, restart over reload", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, y);
		const [xTab, yTab] = sidecars;
		if (!xTab || !yTab) throw new Error("expected two sidecars");
		xTab.setStatus("ready");
		yTab.setStatus("ready");
		yTab.emit("session", { sessionId: "sy", sessionFile: "/sessions/y.jsonl" });
		yTab.emit("events", [{ type: "agent_start" }]);
		xTab.started.length = 0;
		yTab.started.length = 0;
		const tick = () => new Promise<void>(resolve => setImmediate(resolve));

		expect(services.workspaceDirs()).toEqual([workDir]);
		expect(services.applyExtensionUpdate({ reload: true, restart: false, reconnect: ["a"] })).toBe(1);
		expect(xTab.reloads).toEqual([{ reload: true, restart: false, reconnect: ["a"] }]);
		expect(yTab.reloads).toEqual([]);
		expect(services.applyExtensionUpdate({ reload: false, restart: true, reconnect: ["b"] })).toBe(1);
		expect(xTab.started).toEqual([{ resume: undefined }]);
		yTab.emit("events", [{ type: "agent_end" }]);
		expect(yTab.started).toEqual([]);
		await tick();
		expect(yTab.started).toEqual([{ resume: "/sessions/y.jsonl" }]);
		expect(yTab.reloads).toEqual([]);
	});

	it("rejects malformed parameters and unknown methods", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		await expect(services.call(x.peer, "tab.open", { rtab: "", fresh: true }, x)).rejects.toThrow(/Invalid tab.open/);
		await expect(services.call(x.peer, "tab.open", { rtab: "t", cwd: "relative", fresh: true }, x)).rejects.toThrow();
		const unknown = await services.call(x.peer, "shell.exec", {}, x).catch((error: unknown) => error);
		expect(ipcErrorCode(unknown)).toBe("unsupported");
	});

	it("preserves tail direction, page size and backward cursor for remote transcript commands", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "tail", cwd: workDir, fresh: true }, x);
		const commands: RpcCommand[] = [
			{ type: "get_transcript_page", fromEnd: true, limit: 200 },
			{ type: "get_transcript_page", cursor: "snapshot-bound-cursor", limit: 200 },
		];
		for (const command of commands) {
			await services.call(x.peer, "tab.command", { rtab: "tail", command }, x);
		}
		expect(sidecars[0]?.commands).toEqual(commands);
	});

	it("accepts every command timeout the GUI itself uses (a sign-in waits 11 minutes)", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		const login = { type: "login", providerId: "anthropic" };
		const timeoutMs = timeoutForCommand(login as RpcCommand);
		expect(timeoutMs).toBe(660_000);
		await expect(
			services.call(x.peer, "tab.command", { rtab: "t1", command: login, timeoutMs }, x),
		).resolves.toMatchObject({ success: true, command: "login" });
		expect(sidecars[0]?.commands).toEqual([login]);
		await expect(
			services.call(
				x.peer,
				"tab.command",
				{ rtab: "t1", command: login, timeoutMs: MAX_RPC_COMMAND_TIMEOUT_MS + 1 },
				x,
			),
		).rejects.toThrow(/Invalid tab.command/);
	});

	it("serves terminals only for the calling device's own tab and refuses a malformed operation", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		const foreign = await services
			.call(y.peer, "terminal.request", { rtab: "t1", operation: { action: "list" } }, y)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(foreign)).toBe("unknown_tab");
		await expect(
			services.call(x.peer, "terminal.request", { rtab: "t1", operation: { action: "write", id: 1 } }, x),
		).rejects.toThrow(/Invalid terminal operation/);
		await expect(services.call(x.peer, "terminal.request", { rtab: "t1" }, x)).rejects.toThrow(
			/Invalid terminal.request/,
		);
	});
});

describe("LocalHostServices for this computer's own windows", () => {
	const SESSION = "/s/x.jsonl";
	const ask = (id: string) => ({ type: "extension_ui_request", id, method: "confirm", title: "Deploy?", message: "" });
	/** Throws synchronously or rejects: the pool awaits either. */
	async function sideChannelError(send: () => Promise<void> | void): Promise<unknown> {
		try {
			await send();
		} catch (error) {
			return error;
		}
		return undefined;
	}

	/** A device's agent opened a session here (`ompdesk_session_open {device}`) and its omp reported the file. */
	async function hosted(graceMs?: number) {
		const context = setup(graceMs);
		const x = new FakeConnection(peer("device-x"));
		await context.services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await context.services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		const sidecar = context.sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		sidecar.emit("session", { sessionId: "s1", sessionFile: SESSION, sessionName: "Fix login" });
		return { ...context, x, sidecar };
	}

	function viewOf(services: LocalHostServices, sessionPath = SESSION): SidecarLike {
		const view = services.viewSession(sessionPath);
		if (!view) throw new Error("expected a view");
		return view;
	}

	it("lists the sessions its hosted tabs run with their live state, and says when that changes", async () => {
		const { services, sidecar, x } = await hosted();
		const changed = vi.fn();
		services.onHostedSessionsChange(changed);
		expect(services.hostedSessions()).toEqual([
			{
				sessionPath: SESSION,
				sessionId: "s1",
				title: "Fix login",
				cwd: workDir,
				kind: "agent",
				status: "ready",
				device: "device-x",
			},
		]);

		sidecar.emit("events", [{ type: "agent_start" }]);
		expect(services.hostedSessions()[0]?.status).toBe("running");
		sidecar.emit("extensionUi", ask("ask-1"));
		expect(services.hostedSessions()[0]?.awaitingInput).toBe(true);
		expect(changed).toHaveBeenCalled();

		changed.mockClear();
		await services.call(x.peer, "tab.close", { rtab: "t1" }, x);
		expect(services.hostedSessions()).toEqual([]);
		expect(changed).toHaveBeenCalled();
	});

	it("tells every device which of its sessions work now, from its windows and the tabs it runs for devices", async () => {
		vi.useFakeTimers();
		let windows: HostLiveSession[] = [{ sessionPath: "/s/window.jsonl", state: "background" }];
		const { services, sidecars } = setup(60_000, { windowLiveSessions: () => windows });
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		const sidecar = sidecars[0];
		if (!sidecar) throw new Error("expected a sidecar");
		sidecar.setStatus("ready");
		sidecar.emit("session", { sessionId: "s1", sessionFile: SESSION, sessionName: "Fix login" });
		// Another device, which runs nothing here, reads the list as its link comes up.
		expect(await services.call(y.peer, "sessions.live", {}, y)).toEqual({
			sessions: [{ sessionPath: "/s/window.jsonl", state: "background" }],
		});
		const pushed = (conn: FakeConnection) =>
			conn.events.filter(entry => entry.event === LIVE_SESSIONS_EVENT).map(entry => entry.data);

		// x's tab starts a turn, then an ask opens in it: one push per burst, to both devices.
		sidecar.emit("events", [{ type: "agent_start" }]);
		sidecar.emit("extensionUi", ask("ask-1"));
		vi.advanceTimersByTime(LIVE_SESSIONS_DEBOUNCE_MS);
		const waiting = {
			sessions: [
				{ sessionPath: "/s/window.jsonl", state: "background" },
				{ sessionPath: SESSION, state: "waiting" },
			],
		};
		expect(pushed(x)).toEqual([waiting]);
		expect(pushed(y)).toEqual([waiting]);

		// A window's turn ends, and a window takes up the same session the device's tab waits on: waiting still wins.
		windows = [{ sessionPath: SESSION, state: "turn" }];
		services.liveSessionsChanged();
		vi.advanceTimersByTime(LIVE_SESSIONS_DEBOUNCE_MS);
		expect(pushed(y).at(-1)).toEqual({ sessions: [{ sessionPath: SESSION, state: "waiting" }] });

		// Nothing changed: nothing is sent again.
		services.liveSessionsChanged();
		vi.advanceTimersByTime(LIVE_SESSIONS_DEBOUNCE_MS);
		expect(pushed(y)).toHaveLength(2);

		windows = [];
		await services.call(x.peer, "tab.close", { rtab: "t1" }, x);
		vi.advanceTimersByTime(LIVE_SESSIONS_DEBOUNCE_MS);
		expect(pushed(y).at(-1)).toEqual({ sessions: [] });
	});

	it("tells devices its own Mobile web address, and every connected device when it changes", async () => {
		let url: string | null = "https://studio.tail1234.ts.net:8443";
		const { services } = setup(60_000, { mobileWebUrl: () => url });
		const x = new FakeConnection(peer("device-x"));
		expect(await services.call(x.peer, "host.mobileWeb.link", {}, x)).toEqual({ url });
		url = null;
		services.mobileWebLinkChanged(url);
		expect(x.events.filter(entry => entry.event === MOBILE_WEB_LINK_EVENT).map(entry => entry.data)).toEqual([
			{ url: null },
		]);
	});

	it("shows a hosted tab in a window here: its stream and commands, never its host tool calls, and leaving stops nothing", async () => {
		const { services, sidecar, x } = await hosted();
		expect(services.viewSession("/s/other.jsonl")).toBeNull();
		const view = viewOf(services);
		expect(view).toMatchObject({ status: "ready", cwd: workDir, kind: "agent", processAlive: true });
		expect(view.device).toBeUndefined();
		const seen: string[] = [];
		for (const name of ["status", "events", "hostToolCall", "hostUriRequest"]) view.on(name, () => seen.push(name));
		sidecar.emit("events", [{ type: "agent_start" }]);
		// The device answers the omp's tool calls and URI reads: a second answer from this computer would race it.
		sidecar.emit("hostToolCall", { id: "ht-1", toolName: "gui_open_url", arguments: { url: "https://x" } });
		sidecar.emit("hostUriRequest", { type: "host_uri_request", id: "u-1", operation: "read", url: "x://y" });
		expect(seen).toEqual(["events"]);

		// One omp: a prompt typed here reaches it, journaled as this computer's own.
		await view.rpcClient?.command({ type: "prompt", message: "hi" });
		expect(sidecar.commands).toEqual([
			{ type: "prompt_origin_set", origin: { deviceId: "host", name: "Host B" }, text: "hi" },
			{ type: "prompt", message: "hi" },
		]);
		// A paired web page viewing this window's tab named its own device first: that origin stands.
		sidecar.commands.length = 0;
		const phone = { deviceId: "phone", name: "Phone" };
		await view.rpcClient?.command({ type: "prompt_origin_set", origin: phone, text: "yo" } as RpcCommand);
		await view.rpcClient?.command({ type: "steer", message: "yo" });
		expect(sidecar.commands).toEqual([
			{ type: "prompt_origin_set", origin: phone, text: "yo" },
			{ type: "steer", message: "yo" },
		]);

		// Leaving takes only the window's listeners: the device's tab and its stream go on.
		const before = x.tabEvents().length;
		view.removeAllListeners();
		view.dispose();
		sidecar.emit("events", [{ type: "agent_end" }]);
		expect(seen).toEqual(["events"]);
		expect(sidecar.disposed).toBe(false);
		expect(x.tabEvents().length).toBe(before + 1);
		expect(services.hostedSessions()).toHaveLength(1);
	});

	it("labels a transcript page for this computer: its own prompts plain, the device's named", async () => {
		const { services, sidecar } = await hosted();
		const view = viewOf(services);
		// The omp labels for the device it serves: the host's prompts carry the host's name, the device's none.
		vi.spyOn(sidecar.rpcClient, "command").mockResolvedValueOnce({
			type: "response",
			command: "get_transcript_page",
			success: true,
			data: {
				messages: [
					{ role: "user", content: "from the device", timestamp: 1 },
					{ role: "user", content: "typed here", timestamp: 2, promptFrom: "Host B" },
					{ role: "assistant", content: [], timestamp: 3 },
				],
			},
		});
		const page = await view.rpcClient?.command({ type: "get_transcript_page" } as RpcCommand);
		expect(page?.data).toEqual({
			messages: [
				{ role: "user", content: "from the device", timestamp: 1, promptFrom: "device-x" },
				{ role: "user", content: "typed here", timestamp: 2 },
				{ role: "assistant", content: [], timestamp: 3 },
			],
		});
	});

	it("hands a window that joins the asks already open", async () => {
		const { services, sidecar } = await hosted();
		sidecar.emit("extensionUi", ask("ask-1"));
		const view = viewOf(services);
		const replayed = vi.fn();
		view.on("openAsks", replayed);
		await Promise.resolve();
		expect(replayed).toHaveBeenCalledWith([ask("ask-1")]);
	});

	it("tells a window that joins mid-turn how the device's turn stands", async () => {
		const { services, sidecar } = await hosted();
		sidecar.emit("events", [{ type: "agent_start" }]);
		const view = services.viewSession(SESSION);
		expect(view?.runReading()).toMatchObject({ running: true, turn: true, elapsedMs: expect.any(Number) });
	});

	it("takes the first answer to an ask from the device or a window here, and refuses the other's", async () => {
		const { services, sidecar, x } = await hosted();
		const view = viewOf(services);
		const ui: unknown[] = [];
		view.on("extensionUi", request => ui.push(request));

		// The window answers first: the device's card closes as answered elsewhere, its late answer is refused.
		sidecar.emit("extensionUi", ask("ask-1"));
		const yes = { type: "extension_ui_response", id: "ask-1", confirmed: true };
		await view.sendSideChannel(yes);
		expect(sidecar.sideFrames).toEqual([yes]);
		expect(x.tabEvents().at(-1)).toEqual({
			rtab: "t1",
			name: "extensionUi",
			arg: { type: "extension_ui_request", id: "answered:ask-1", method: "cancel", targetId: "ask-1" },
		});
		const late = await services
			.call(x.peer, "tab.sideChannel", { rtab: "t1", frame: { ...yes, confirmed: false } }, x)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(late)).toBe("already_answered");
		expect(sidecar.sideFrames).toEqual([yes]);

		// The device answers first: the window's card closes the same way and its answer is refused.
		sidecar.emit("extensionUi", ask("ask-2"));
		const no = { type: "extension_ui_response", id: "ask-2", confirmed: false };
		await services.call(x.peer, "tab.sideChannel", { rtab: "t1", frame: no }, x);
		expect(ui.at(-1)).toEqual({
			type: "extension_ui_request",
			id: "answered:ask-2",
			method: "cancel",
			targetId: "ask-2",
		});
		const refused = await sideChannelError(() => view.sendSideChannel({ ...no, confirmed: true }));
		expect(ipcErrorCode(refused)).toBe("already_answered");
		expect(sidecar.sideFrames).toEqual([yes, no]);
		expect(services.hostedSessions()[0]?.awaitingInput).toBeUndefined();
	});

	it("ends a window's view when the device closes its tab, before that omp goes", async () => {
		const { services, sidecar, x } = await hosted();
		const view = viewOf(services);
		const ended = vi.fn(() => expect(sidecar.disposed).toBe(false));
		view.on(VIEW_ENDED_EVENT, ended);
		await services.call(x.peer, "tab.close", { rtab: "t1" }, x);
		expect(ended).toHaveBeenCalledTimes(1);
		expect(sidecar.disposed).toBe(true);
		expect(services.viewSession(SESSION)).toBeNull();
	});

	it("ends a window's view when the device deletes the session, then deletes the file", async () => {
		const { services, sidecar, x, deleteSession } = await hosted();
		const view = viewOf(services);
		const ended = vi.fn();
		view.on(VIEW_ENDED_EVENT, ended);
		const deleting = services.call(x.peer, "sessions.delete", { sessionPath: SESSION }, x);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(ended).toHaveBeenCalledTimes(1);
		sidecar.exited.resolve();
		await deleting;
		expect(deleteSession).toHaveBeenCalledWith(SESSION);
	});

	it("keeps a tab a window here shows past the device's grace period, and lets it go once the window leaves", async () => {
		vi.useFakeTimers();
		const { services, sidecar, x } = await hosted(1_000);
		const view = viewOf(services);
		services.disconnected(x.peer, x);
		vi.advanceTimersByTime(5_000);
		expect(sidecar.disposed).toBe(false);
		view.removeAllListeners();
		view.dispose();
		vi.advanceTimersByTime(1_000);
		expect(sidecar.disposed).toBe(true);
	});
});

describe("LocalHostServices: a device opening a session a window of this computer runs", () => {
	const SESSION = "/s/local.jsonl";

	async function viewing() {
		const context = setup();
		const view = new FakeHostSidecar(workDir, "agent");
		view.setStatus("ready");
		context.local.views.set(SESSION, view);
		const x = new FakeConnection(peer("device-x"));
		const opened = await context.services.call(
			x.peer,
			"tab.open",
			{ rtab: "t1", cwd: workDir, sessionPath: SESSION },
			x,
		);
		return { ...context, view, x, opened };
	}

	it("attaches the device to that window's omp: no second omp, prompts named after the device", async () => {
		const { services, sidecars, local, view, x, opened } = await viewing();
		expect(opened).toEqual({ cwd: workDir, kind: "agent", attached: true, viewing: true });
		expect(sidecars).toHaveLength(0);
		expect(local.viewed).toEqual([{ origin: { deviceId: "device-x", name: "device-x" }, hostName: "Host B" }]);
		// Attached: the device starts nothing and gets the live status at once.
		expect(x.tabEvents().find(event => event.name === "status")?.arg).toMatchObject({ status: "ready" });
		view.emit("events", [{ type: "agent_start" }]);
		expect(x.tabEvents().at(-1)).toMatchObject({ name: "events" });
		await services.call(x.peer, "tab.command", { rtab: "t1", command: { type: "get_state" } }, x);
		expect(view.commands).toEqual([{ type: "get_state" }]);
		// The window's tab is the computer's own: never listed as a device's, never resumed or restarted as one.
		expect(services.hostedSessions()).toEqual([]);
		expect(services.resumeFacts()).toEqual([]);
		services.restartOnNewOmp();
		expect(view.started).toEqual([]);
	});

	it("a second device views the same window's session too, never refused as open in another tab", async () => {
		const { services, local, x } = await viewing();
		const y = new FakeConnection(peer("device-y"));
		const opened = await services.call(y.peer, "tab.open", { rtab: "u1", cwd: workDir, sessionPath: SESSION }, y);
		expect(opened).toEqual({ cwd: workDir, kind: "agent", attached: true, viewing: true });
		expect(local.viewed.map(entry => entry.origin.deviceId)).toEqual(["device-x", "device-y"]);
		// The same connection asking again under another rtab is still refused: one tab a session per device.
		for (const [conn, rtab] of [
			[x, "t2"],
			[y, "u2"],
		] as const) {
			const refused = await services
				.call(conn.peer, "tab.open", { rtab, cwd: workDir, sessionPath: SESSION }, conn)
				.catch(error => error);
			expect(ipcErrorCode(refused)).toBe("session_open_in_tab");
		}
		// y relaunches (a new connection, a new rtab): its own view is taken over, no third view made.
		const y2 = new FakeConnection(peer("device-y"));
		const again = await services.call(y2.peer, "tab.open", { rtab: "u3", cwd: workDir, sessionPath: SESSION }, y2);
		expect(again).toMatchObject({ attached: true });
		expect(local.viewed).toHaveLength(2);
	});

	it("the device's close only leaves; the window's close ends the device's tab quietly", async () => {
		const first = await viewing();
		await first.services.call(first.x.peer, "tab.close", { rtab: "t1" }, first.x);
		expect(first.view.disposed).toBe(true);

		const { services, view, x } = await viewing();
		view.emit(VIEW_ENDED_EVENT);
		expect(x.tabEvents().at(-1)).toMatchObject({ rtab: "t1", name: "viewEnded" });
		expect(view.disposed).toBe(true);
		const gone = await services
			.call(x.peer, "tab.command", { rtab: "t1", command: { type: "get_state" } }, x)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(gone)).toBe("unknown_tab");
	});

	it("hands the device the asks the window's omp has open when it attaches", async () => {
		const { view, x } = await viewing();
		const ask = { type: "extension_ui_request", id: "ask-1", method: "confirm", title: "?", message: "" };
		view.emit("openAsks", [ask]);
		expect(x.tabEvents().at(-1)).toEqual({ rtab: "t1", name: "openAsks", arg: [ask] });
	});

	it("this computer's delete of the window's session tells the viewing device it is deleted", async () => {
		const { services, view, x } = await viewing();
		// A real view (HostedTabView) has no omp of its own to wait for; the fake's exit stands in for that.
		view.exited.resolve();
		const told = await services.closeSessionTabs(SESSION);
		expect(x.tabEvents().map(event => event.name)).not.toContain("sessionDeleted");
		told();
		expect(x.tabEvents()).toContainEqual({ rtab: "t1", name: "sessionDeleted", arg: SESSION });
		expect(view.disposed).toBe(true);
	});
});

describe("LocalHostServices: Autopilot of a device's tab", () => {
	it("answers get/set_autopilot through this computer's coordinator, counting a start against the device", async () => {
		const { services, sidecars } = setup();
		const stored = new Map<string, PeerInfo>([["device-x", { ...peer("device-x"), limits: { requestsPerDay: 1 } }]]);
		services.attachQuota(
			new PeerQuota(
				{
					get: id => stored.get(id),
					update: (id, patch) => {
						const current = stored.get(id);
						if (!current) return undefined;
						const next = { ...current, ...patch };
						stored.set(id, next);
						return next;
					},
				},
				() => {},
			),
		);
		const x = new FakeConnection(peer("device-x"));
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		const send = (command: Record<string, unknown>) =>
			services.call(x.peer, "tab.command", { rtab: "t1", command }, x) as Promise<RpcResponse>;

		// Before a coordinator is attached the command goes to the omp, as any other.
		await send({ type: "get_autopilot" });
		expect(sidecars[0]?.commands.map(command => command.type)).toEqual(["get_autopilot"]);

		const seen: { tabId: string; sidecar: unknown; viewsWindow: boolean; command: unknown }[] = [];
		services.attachAutopilot(async (target, command) => {
			seen.push({ tabId: target.tabId, sidecar: target.sidecar, viewsWindow: target.viewsWindow, command });
			return { type: "response", command: command.type, success: true, data: { active: true, tabId: "run1" } };
		});
		await expect(send({ type: "set_autopilot", action: "start", preset: "push" })).resolves.toMatchObject({
			success: true,
			data: { tabId: "run1" },
		});
		expect(seen).toEqual([
			{
				tabId: "peer:device-x:t1",
				sidecar: sidecars[0],
				viewsWindow: false,
				command: { type: "set_autopilot", action: "start", preset: "push" },
			},
		]);
		expect(sidecars[0]?.commands).toHaveLength(1);
		expect(stored.get("device-x")?.usage).toMatchObject({ requests: 1 });
		// A read never counts; a second start is past the device's daily limit.
		await expect(send({ type: "get_autopilot" })).resolves.toMatchObject({ success: true });
		expect(ipcErrorCode(await send({ type: "set_autopilot", action: "start" }).catch(error => error))).toBe(
			"remote_limit_reached",
		);
		expect(seen).toHaveLength(2);
	});

	it("names the window's session when the device's tab views a window's tab", async () => {
		const context = setup();
		const view = new FakeHostSidecar(workDir, "agent");
		view.setStatus("ready");
		context.local.views.set("/s/run.jsonl", view);
		const x = new FakeConnection(peer("device-x"));
		await context.services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, sessionPath: "/s/run.jsonl" }, x);
		const targets: { sessionPath?: string; viewsWindow: boolean }[] = [];
		context.services.attachAutopilot(async (target, command) => {
			targets.push({ sessionPath: target.sessionPath, viewsWindow: target.viewsWindow });
			return { type: "response", command: command.type, success: true, data: { active: true, state: "stopping" } };
		});
		await context.services.call(
			x.peer,
			"tab.command",
			{ rtab: "t1", command: { type: "set_autopilot", action: "stop" } },
			x,
		);
		expect(targets).toEqual([{ sessionPath: "/s/run.jsonl", viewsWindow: true }]);
		expect(view.commands).toEqual([]);
	});

	it("charges an Autopilot run a device started here for its reply tokens until it ends, across a relaunch", async () => {
		const file = join(workDir, "autopilot-device-runs.json");
		const stored = new Map<string, PeerInfo>([["device-x", peer("device-x")]]);
		const quota = () =>
			new PeerQuota(
				{
					get: id => stored.get(id),
					update: (id, patch) => {
						const current = stored.get(id);
						if (!current) return undefined;
						const next = { ...current, ...patch };
						stored.set(id, next);
						return next;
					},
				},
				() => {},
			);
		const reply = (tokens: number) => [
			{ type: "message_end", message: { role: "assistant", usage: { totalTokens: tokens } } },
			{ type: "message_end", message: { role: "user" } },
		];
		const first = setup(60_000, { runChargesFile: file }).services;
		first.attachQuota(quota());
		first.chargeRun("/wt/run", "device-x");
		first.runEvents("/wt/run", reply(500) as never);
		first.runEvents("/wt/other", reply(9_000) as never);
		expect(stored.get("device-x")?.usage).toMatchObject({ tokens: 500 });

		// This computer restarted: the run resumes from its layout and is still the device's.
		const second = setup(60_000, { runChargesFile: file }).services;
		second.attachQuota(quota());
		second.runEvents("/wt/run", reply(300) as never);
		expect(stored.get("device-x")?.usage).toMatchObject({ tokens: 800 });
		second.endRun("/wt/run");
		second.runEvents("/wt/run", reply(300) as never);
		expect(stored.get("device-x")?.usage).toMatchObject({ tokens: 800 });
		const third = setup(60_000, { runChargesFile: file }).services;
		third.attachQuota(quota());
		third.runEvents("/wt/run", reply(300) as never);
		expect(stored.get("device-x")?.usage).toMatchObject({ tokens: 800 });
	});

	it("counts a run's reply once while the device views it: through the run, not the device's view", async () => {
		const context = setup();
		const stored = new Map<string, PeerInfo>([["device-x", peer("device-x")]]);
		context.services.attachQuota(
			new PeerQuota(
				{
					get: id => stored.get(id),
					update: (id, patch) => {
						const current = stored.get(id);
						if (!current) return undefined;
						const next = { ...current, ...patch };
						stored.set(id, next);
						return next;
					},
				},
				() => {},
			),
		);
		const view = new FakeHostSidecar(workDir, "agent");
		view.setStatus("ready");
		context.local.views.set("/s/run.jsonl", view);
		const x = new FakeConnection(peer("device-x"));
		await context.services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, sessionPath: "/s/run.jsonl" }, x);
		context.services.chargeRun("/wt/run", "device-x", "/s/run.jsonl");
		const reply = [{ type: "message_end", message: { role: "assistant", usage: { totalTokens: 700 } } }];
		// The window's omp streams one reply: the device's view hears it, and so does the run's own listener.
		view.emit("events", reply);
		context.services.runEvents("/wt/run", reply as never);
		expect(stored.get("device-x")?.usage).toMatchObject({ tokens: 700 });
	});

	it("an Autopilot notice reaches the device that started the run with no view of it, and each viewing device once", async () => {
		const context = setup();
		const view = new FakeHostSidecar(workDir, "agent");
		view.setStatus("ready");
		context.local.views.set("/s/run.jsonl", view);
		// The starter left the run's view: its only tab here is another session.
		const x = new FakeConnection(peer("device-x"));
		await context.services.call(x.peer, "tab.open", { rtab: "x1", cwd: workDir }, x);
		const y = new FakeConnection(peer("device-y"));
		await context.services.call(y.peer, "tab.open", { rtab: "y1", cwd: workDir, sessionPath: "/s/run.jsonl" }, y);
		const z = new FakeConnection(peer("device-z"));
		await context.services.call(z.peer, "tab.open", { rtab: "z1", cwd: workDir }, z);
		context.services.chargeRun("/wt/run", "device-x", "/s/run.jsonl");
		const notice = { kind: "error" as const, title: "Autopilot paused", body: "The repository folder is gone." };
		context.services.autopilotNotice({ root: "/wt/run", sessionPath: "/s/run.jsonl" }, notice);
		const notices = (conn: FakeConnection) =>
			conn.events.filter(entry => entry.event === AUTOPILOT_NOTICE_EVENT).map(entry => entry.data);
		expect(notices(x)).toEqual([{ ...notice, sessionPath: "/s/run.jsonl" }]);
		expect(notices(y)).toEqual([{ ...notice, sessionPath: "/s/run.jsonl" }]);
		expect(notices(z)).toEqual([]);
	});

	it("counts a run's child's reply once while the device views the child: through the run, not the view", async () => {
		const context = setup();
		const stored = new Map<string, PeerInfo>([["device-x", peer("device-x")]]);
		context.services.attachQuota(
			new PeerQuota(
				{
					get: id => stored.get(id),
					update: (id, patch) => {
						const current = stored.get(id);
						if (!current) return undefined;
						const next = { ...current, ...patch };
						stored.set(id, next);
						return next;
					},
				},
				() => {},
			),
		);
		const child = new FakeHostSidecar(workDir, "agent");
		child.setStatus("ready");
		context.local.views.set("/s/child.jsonl", child);
		const x = new FakeConnection(peer("device-x"));
		await context.services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, sessionPath: "/s/child.jsonl" }, x);
		context.services.chargeRun("/wt/run", "device-x", "/s/run.jsonl");
		// The window tab holding the child's session belongs to the run at /wt/run (Autopilot.runRootOf).
		context.services.attachRunLookup(path => (path === "/s/child.jsonl" ? "/wt/run" : undefined));
		const reply = [{ type: "message_end", message: { role: "assistant", usage: { totalTokens: 400 } } }];
		child.emit("events", reply);
		context.services.runEvents("/wt/run", reply as never);
		expect(stored.get("device-x")?.usage).toMatchObject({ tokens: 400 });
	});
});

describe("LocalHostServices host.* calls", () => {
	it("serves this machine's models.yml providers, validating what a device writes", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		await expect(services.call(x.peer, "host.models.list", {}, x)).resolves.toEqual({
			providers: [PROVIDER_VIEW],
			options: fixtureProviderOptions,
		});

		const input: CustomProviderInput = {
			id: "lan",
			api: "openai-completions",
			baseUrl: "http://10.0.0.2:8080/v1",
			apiKey: "sk-test",
			models: [{ id: "m1", contextWindow: 8192, thinking: { mode: "effort", efforts: ["low", "high"] } }],
		};
		await services.call(x.peer, "host.models.upsert", { input: { ...input, extra: "dropped" } }, x);
		expect(machine.upsertProvider).toHaveBeenCalledWith(input);
		for (const bad of [
			{},
			{ input: { ...input, api: 42 } },
			{ input: { ...input, id: "" } },
			{ input: { ...input, models: [{ id: "m1", contextWindow: "big" }] } },
		]) {
			await expect(services.call(x.peer, "host.models.upsert", bad, x)).rejects.toThrow(
				/Invalid host.models.upsert/,
			);
		}
		expect(machine.upsertProvider).toHaveBeenCalledTimes(1);

		await services.call(x.peer, "host.models.delete", { id: "lan" }, x);
		expect(machine.deleteProvider).toHaveBeenCalledWith("lan");
		await expect(services.call(x.peer, "host.models.delete", { id: "" }, x)).rejects.toThrow(
			/Invalid host.models.delete/,
		);
		expect(machine.deleteProvider).toHaveBeenCalledTimes(1);

		// B43: one model's overrides on the host's models.yml; a reset sends null.
		const override = { contextWindow: 64_000, replayReasoning: true };
		await services.call(x.peer, "host.models.override", { provider: "anthropic", modelId: "m", override }, x);
		expect(machine.setModelOverride).toHaveBeenCalledWith("anthropic", "m", override);
		await services.call(x.peer, "host.models.override", { provider: "anthropic", modelId: "m", override: null }, x);
		expect(machine.setModelOverride).toHaveBeenLastCalledWith("anthropic", "m", null);
		const emptyLadder = { thinking: { mode: "effort", efforts: [] } };
		await expect(
			services.call(
				x.peer,
				"host.models.override",
				{ provider: "anthropic", modelId: "m", override: emptyLadder },
				x,
			),
		).rejects.toThrow(/Invalid host.models.override/);
		expect(machine.setModelOverride).toHaveBeenCalledTimes(2);
	});

	it("reads and writes this machine's account-rotation pref, refusing an unknown mode", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		await expect(services.call(x.peer, "host.accountRotation.get", {}, x)).resolves.toEqual({
			mode: "quota",
			evenSupported: true,
		});
		await expect(services.call(x.peer, "host.accountRotation.set", { mode: "even" }, x)).resolves.toEqual({
			mode: "even",
			evenSupported: true,
		});
		expect(machine.setAccountRotation).toHaveBeenCalledWith("even");
		for (const bad of [{}, { mode: "round-robin" }, { mode: 1 }]) {
			await expect(services.call(x.peer, "host.accountRotation.set", bad, x)).rejects.toThrow(
				/Invalid host.accountRotation.set/,
			);
		}
		expect(machine.setAccountRotation).toHaveBeenCalledTimes(1);
	});

	it("serves the host's OMPdesk state and passes only known update actions to its updater", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		await expect(services.call(x.peer, "host.desktop.get", {}, x)).resolves.toEqual(DESKTOP);
		await services.call(x.peer, "host.desktop.update", { action: "install" }, x);
		expect(machine.desktopUpdate).toHaveBeenCalledWith("install");
		for (const bad of [{}, { action: "quit" }]) {
			await expect(services.call(x.peer, "host.desktop.update", bad, x)).rejects.toThrow(
				/Invalid host.desktop.update/,
			);
		}
	});

	it("reads the host's built-in REA preference and validates writes", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		await expect(services.call(x.peer, "host.builtinRea.get", {}, x)).resolves.toEqual({
			enabled: true,
			available: true,
		});
		await expect(services.call(x.peer, "host.builtinRea.set", { enabled: false }, x)).resolves.toEqual({
			enabled: false,
			available: true,
		});
		expect(machine.setBuiltinRea).toHaveBeenCalledWith(false);
		for (const bad of [{}, { enabled: "false" }, { enabled: 1 }]) {
			await expect(services.call(x.peer, "host.builtinRea.set", bad, x)).rejects.toThrow(
				/Invalid host.builtinRea.set/,
			);
		}
		expect(machine.setBuiltinRea).toHaveBeenCalledTimes(1);
	});

	it("reads this machine's stats server", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		await expect(
			services.call(x.peer, "host.stats.fetch", { path: "/api/stats/overview", params: { range: "24h" } }, x),
		).resolves.toEqual({ path: "/api/stats/overview", params: { range: "24h" } });
		await expect(
			services.call(x.peer, "host.stats.fetch", { path: "/api/stats/overview", params: { range: 24 } }, x),
		).rejects.toThrow(/Invalid host.stats.fetch/);
		await expect(services.call(x.peer, "host.stats.fetch", {}, x)).rejects.toThrow(/Invalid host.stats.fetch/);
		expect(machine.fetchStats).toHaveBeenCalledTimes(1);
	});

	it("runs one benchmark per device, in the caller's own tab folder, and stops it when the device drops", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		const project = join(workDir, "project");
		mkdirSync(project);
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: project, fresh: true }, x);
		const options: IpcBenchmarkRunOptions = { models: ["anthropic/x"], profile: "chat", runs: 1, parallel: 1 };

		await services.call(x.peer, "host.bench.run", { rtab: "t1", options }, x);
		expect(machine.runBenchmark).toHaveBeenLastCalledWith("peer:device-x", options, canonicalCwd(project));
		// Y names X's rtab: it is not Y's tab, so Y's run starts in the default workspace.
		await services.call(y.peer, "host.bench.run", { rtab: "t1", options }, y);
		expect(machine.runBenchmark).toHaveBeenLastCalledWith("peer:device-y", options, workDir);
		await expect(
			services.call(x.peer, "host.bench.run", { options: { ...options, profile: "everything" } }, x),
		).rejects.toThrow(/Invalid host.bench.run/);
		expect(machine.runBenchmark).toHaveBeenCalledTimes(2);

		await expect(services.call(x.peer, "host.bench.abort", {}, x)).resolves.toBe(true);
		expect(machine.abortBenchmark).toHaveBeenLastCalledWith("peer:device-x");
		services.disconnected(y.peer, y);
		expect(machine.abortBenchmark).toHaveBeenLastCalledWith("peer:device-y");
		services.dropPeer("device-x");
		expect(machine.abortBenchmark).toHaveBeenLastCalledWith("peer:device-x");
	});

	it("runs one model setup research per device, validates its request, and stops it when the device drops", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		const request: ModelSetupRequest = {
			researchModel: "anthropic/claude-opus-4-1",
			models: [{ selector: "anthropic/claude-opus-4-1", provider: "anthropic" }],
			roles: [{ id: "default", name: "Default" }],
		};
		await services.call(x.peer, "host.modelSetup.run", { request }, x);
		expect(machine.runModelSetup).toHaveBeenLastCalledWith("peer:device-x", request);
		await expect(
			services.call(x.peer, "host.modelSetup.run", { request: { ...request, researchModel: "--help" } }, x),
		).rejects.toThrow(/Invalid host.modelSetup.run/);
		expect(machine.runModelSetup).toHaveBeenCalledTimes(1);
		await services.call(y.peer, "host.modelSetup.status", {}, y);
		expect(machine.modelSetupStatus).toHaveBeenLastCalledWith("peer:device-y");
		await expect(services.call(x.peer, "host.modelSetup.abort", {}, x)).resolves.toBe(true);
		expect(machine.abortModelSetup).toHaveBeenLastCalledWith("peer:device-x");
		services.disconnected(y.peer, y);
		expect(machine.abortModelSetup).toHaveBeenLastCalledWith("peer:device-y");
		services.dropPeer("device-x");
		expect(machine.abortModelSetup).toHaveBeenLastCalledWith("peer:device-x");
	});

	it("updates the host's omp through the machine's updater and pushes its state to every connected device", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await expect(services.call(x.peer, "host.ompUpdate.get", {}, x)).resolves.toMatchObject({ phase: "idle" });
		await expect(services.call(y.peer, "host.ompUpdate.get", {}, y)).resolves.toMatchObject({ phase: "idle" });

		// The device only starts it: the host's own OmpUpdater runs it (no `omp update` of the device's making).
		await expect(services.call(x.peer, "host.ompUpdate.now", {}, x)).resolves.toMatchObject({ phase: "checking" });
		expect(machine.startOmpUpdate).toHaveBeenCalledTimes(1);

		services.ompUpdateChanged({ ...OMP_UPDATE_IDLE, phase: "updating" });
		for (const conn of [x, y]) {
			expect(conn.events.filter(entry => entry.event === OMP_UPDATE_EVENT).map(entry => entry.data)).toEqual([
				{ ...OMP_UPDATE_IDLE, phase: "updating" },
			]);
		}
		// A device that left gets nothing more.
		services.disconnected(y.peer, y);
		services.ompUpdateChanged(OMP_UPDATE_IDLE);
		expect(y.events.filter(entry => entry.event === OMP_UPDATE_EVENT)).toHaveLength(1);
		expect(x.events.filter(entry => entry.event === OMP_UPDATE_EVENT)).toHaveLength(2);
	});

	it("runs a device's schedule requests on this machine's own service and pushes its changes", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		const draft: ScheduleDraft = {
			name: "[agent] nightly",
			prompt: "audit",
			cwd: "/srv/app",
			frequency: { kind: "interval", minutes: 60 },
			model: null,
			autoApprove: false,
			enabled: true,
		};
		await expect(services.call(x.peer, "host.schedules.command", { request: { action: "get" } }, x)).resolves.toEqual(
			SCHEDULES_EMPTY,
		);
		await services.call(x.peer, "host.schedules.command", { request: { action: "save", draft } }, x);
		await services.call(x.peer, "host.schedules.command", { request: { action: "delete", id: "s1" } }, x);
		// Each request names the device it serves: a schedule it saves is its, charged at every run (schedules.test.ts).
		expect(machine.schedules.mock.calls).toEqual([
			[{ action: "get" }, "device-x"],
			[{ action: "save", draft }, "device-x"],
			[{ action: "delete", id: "s1" }, "device-x"],
		]);
		await expect(services.call(y.peer, "host.schedules.log", { runId: "r1" }, y)).resolves.toBe("log of r1");
		// A create answers the id its own save made.
		await expect(services.call(x.peer, "host.schedules.create", { draft }, x)).resolves.toEqual({
			id: "made-1",
			state: SCHEDULES_EMPTY,
		});
		// Made for the device: its runs count against that device's daily model limit here.
		expect(machine.createSchedule).toHaveBeenCalledWith(draft, "device-x");
		await expect(
			services.call(x.peer, "host.schedules.create", { draft: { ...draft, enabled: "yes" } }, x),
		).rejects.toThrow(/Invalid host.schedules.create/);
		expect(machine.createSchedule).toHaveBeenCalledTimes(1);

		// Only Settings › Schedules' own actions with a whole draft reach the service.
		for (const bad of [
			{},
			{ request: { action: "wipe" } },
			{ request: { action: "save", draft: { ...draft, autoApprove: "yes" } } },
			{ request: { action: "save", draft: { ...draft, frequency: { kind: "cron", spec: "* * * * *" } } } },
			{ request: { action: "delete" } },
		]) {
			await expect(services.call(x.peer, "host.schedules.command", bad, x)).rejects.toThrow(
				/Invalid host.schedules.command/,
			);
		}
		await expect(services.call(x.peer, "host.schedules.log", { runId: 3 }, x)).rejects.toThrow(
			/Invalid host.schedules.log/,
		);
		expect(machine.schedules).toHaveBeenCalledTimes(3);

		const changed = { ...SCHEDULES_EMPTY, paused: true };
		services.schedulesChanged(changed);
		for (const conn of [x, y])
			expect(conn.events.filter(entry => entry.event === SCHEDULES_EVENT).map(entry => entry.data)).toEqual([
				changed,
			]);
	});

	it("serves this computer's own project list to a device and pushes its changes to every device", async () => {
		const { services, machine } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		// This computer's real list: what a device adds or removes is the one its own sidebar shows.
		const list = new SidebarProjects({
			read: () => ({ projects: [{ path: "/srv/app", addedAt: 1 }], removed: [] }),
			write: () => {},
			sessions: async () => [],
			defaultWorkspace: () => "/srv/work",
			projectOf: async cwd => cwd,
			exists: async () => true,
			onState: state => services.sidebarProjectsChanged(state),
			now: () => 7,
		});
		machine.sidebarProjects.mockImplementation(request => list.command(request));
		await expect(services.call(x.peer, "host.projects.command", { request: { action: "get" } }, x)).resolves.toEqual({
			projects: [{ path: "/srv/app", addedAt: 1 }],
			removed: [],
			worktrees: {},
		});
		await services.call(y.peer, "host.projects.command", { request: { action: "get" } }, y);
		await services.call(x.peer, "host.projects.command", { request: { action: "add", path: "/srv/new" } }, x);
		await services.call(y.peer, "host.projects.command", { request: { action: "remove", path: "/srv/app" } }, y);
		const latest = { projects: [{ path: "/srv/new", addedAt: 7 }], removed: ["/srv/app"], worktrees: {} };
		expect(list.state()).toEqual(latest);
		for (const conn of [x, y])
			expect(conn.events.filter(entry => entry.event === PROJECTS_EVENT).map(entry => entry.data)).toEqual([
				{
					projects: [
						{ path: "/srv/app", addedAt: 1 },
						{ path: "/srv/new", addedAt: 7 },
					],
					removed: [],
					worktrees: {},
				},
				latest,
			]);
		for (const bad of [{}, { request: { action: "wipe" } }, { request: { action: "remove", path: "" } }])
			await expect(services.call(x.peer, "host.projects.command", bad, x)).rejects.toThrow(
				/Invalid host.projects.command/,
			);
	});

	it("serves a tab's file bytes to its own device only, as base64 that decodes to the same bytes", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		const project = join(workDir, "project");
		mkdirSync(project);
		const bytes = new Uint8Array(70_000);
		for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) % 256;
		bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		writeFileSync(join(project, "pic.png"), bytes);
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: project, fresh: true }, x);

		const reply = await services.call(x.peer, "host.fs.readBinary", { rtab: "t1", path: "pic.png" }, x);
		// The link carries JSON; decode what actually crosses it.
		const decoded = decodeBinaryRead(JSON.parse(JSON.stringify(reply)));
		expect(decoded).toMatchObject({ ok: true, mime: "image/png", size: bytes.length, truncated: false });
		expect(decoded.data).toBeInstanceOf(Uint8Array);
		expect(decoded.data).toEqual(bytes);
		expect(decoded.data.buffer.byteLength).toBe(bytes.length);

		// Y names X's rtab: not Y's tab, so there is no workspace to read from.
		const foreign = decodeBinaryRead(
			await services.call(y.peer, "host.fs.readBinary", { rtab: "t1", path: "pic.png" }, y),
		);
		expect(foreign).toMatchObject({ ok: false, code: "no_workspace" });
		expect(foreign.data).toHaveLength(0);
		// Confinement still applies on the host.
		await expect(
			services.call(x.peer, "host.fs.readBinary", { rtab: "t1", path: "../outside.bin" }, x),
		).resolves.toMatchObject({ ok: false, code: "path_escapes_workspace" });
		await expect(services.call(x.peer, "host.fs.readBinary", { rtab: "t1" }, x)).rejects.toThrow(
			/Invalid host.fs.readBinary/,
		);
	});

	it("caps a remote binary read to fit one link frame", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		const size = FS_BINARY_REMOTE_MAX_BYTES + 1;
		writeFileSync(join(workDir, "movie.mp4"), new Uint8Array(size));

		const params = { cwd: workDir, path: "movie.mp4" };
		const tooLarge = decodeBinaryRead(await services.call(x.peer, "host.fs.readBinary", params, x));
		expect(tooLarge).toMatchObject({ ok: false, code: "file_too_large", size, mime: "video/mp4" });
		expect(tooLarge.data).toHaveLength(0);
		// A bigger maxBytes cannot lift the host's cap.
		const asked = { ...params, maxBytes: 100 * 1024 * 1024 };
		await expect(services.call(x.peer, "host.fs.readBinary", asked, x)).resolves.toMatchObject({
			ok: false,
			code: "file_too_large",
		});
		// The hex view's prefix still works.
		const prefix = decodeBinaryRead(
			await services.call(x.peer, "host.fs.readBinary", { ...params, maxBytes: 4096 }, x),
		);
		expect(prefix).toMatchObject({ ok: true, truncated: true, size });
		expect(prefix.data).toEqual(new Uint8Array(4096));
	});

	it("refuses a malformed readBinary reply on the device side", () => {
		const good = { ok: true, data: "AAEC", mime: "application/octet-stream", size: 3, truncated: false };
		expect(decodeBinaryRead(good).data).toEqual(new Uint8Array([0, 1, 2]));
		expect(decodeBinaryRead({ ...good, ok: false, data: "", code: "from_a_newer_host" })).not.toHaveProperty("code");
		for (const bad of [{ ...good, data: "AA=C" }, { ...good, data: "AAE" }, { ...good, size: -1 }, null]) {
			expect(() => decodeBinaryRead(bad)).toThrow(/\[remote_protocol\]/);
		}
	});
});

describe("LocalHostServices host.git.*: a device's agent working on a session this computer runs", () => {
	/** What `worktree_create` leaves: `repo` with one commit and a child branch checked out beside it. */
	async function repoWithChild(): Promise<WorktreeRef> {
		const repo = join(workDir, "repo");
		await initRepo(repo);
		const worktree = { path: join(workDir, "wt-a"), branch: "omp/agent/a", baseCwd: repo };
		gitSync(repo, "worktree", "add", "-q", "-b", worktree.branch, worktree.path);
		gitSync(worktree.path, "config", "user.email", "agent@example.com");
		gitSync(worktree.path, "config", "user.name", "Agent");
		writeFileSync(join(worktree.path, "child.txt"), "from the child\n");
		gitSync(worktree.path, "add", "child.txt");
		gitSync(worktree.path, "commit", "-q", "-m", "child work");
		return worktree;
	}

	it("answers branch facts and landing exactly as this computer's own git does, then merges and removes", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		const worktree = await repoWithChild();
		expect(await services.call(x.peer, "host.git.facts", { worktree }, x)).toEqual(await branchFacts(worktree));
		const evidence = await services.call(x.peer, "host.git.evidence", { worktree, diffChars: 5000 }, x);
		expect(evidence).toEqual(await branchEvidence(worktree, 5000));
		expect(evidence).toMatchObject({
			diff: expect.stringContaining("+from the child"),
			diffOmitted: 0,
			merge: { kind: "clean" },
		});
		expect(await services.call(x.peer, "host.git.landing", { worktree }, x)).toEqual(await landingFacts(worktree));
		const merged = await services.call(x.peer, "host.git.merge", { worktree, label: "Child" }, x);
		expect(merged).toMatchObject({ merged: true });
		expect(gitSync(worktree.baseCwd, "log", "-1", "--format=%s")).toBe("Merge omp/agent/a into main (Child)");
		expect(existsSync(join(worktree.baseCwd, "child.txt"))).toBe(true);
		expect(await services.call(x.peer, "host.git.removeWorktree", { worktree }, x)).toBe("removed");
		expect(existsSync(worktree.path)).toBe(false);
	});

	it("refuses relative paths, and sends a merge's refusal back with git's reason", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		const worktree = await repoWithChild();
		await expect(
			services.call(x.peer, "host.git.facts", { worktree: { ...worktree, path: "wt-a" } }, x),
		).rejects.toThrow(/Invalid host.git.facts/);
		for (const diffChars of [-1, 200_001, 1.5, "5"])
			await expect(services.call(x.peer, "host.git.evidence", { worktree, diffChars }, x)).rejects.toThrow(
				/Invalid host.git.evidence/,
			);
		await expect(
			services.call(x.peer, "host.git.evidence", { worktree: { ...worktree, path: "wt-a" }, diffChars: 10 }, x),
		).rejects.toThrow(/Invalid host.git.evidence/);
		gitSync(worktree.baseCwd, "checkout", "-q", "--detach");
		await expect(services.call(x.peer, "host.git.merge", { worktree, label: "" }, x)).rejects.toThrow(
			/detached HEAD/,
		);
	});

	it("makes a worktree with no session running here, named by stock's location as worktree_create's is", async () => {
		const root = join(workDir, "wt");
		const asked: unknown[] = [];
		const { services, local } = setup(undefined, {
			worktreeLocation: {
				request: async <T>(method: string, request?: unknown) => {
					asked.push({ method, request });
					return { root, hash: "abc1234" } as T;
				},
			},
		});
		// No omp runs on this computer: the location never comes from a session.
		expect(local.tab.status).toBe("asleep");
		const x = new FakeConnection(peer("device-x"));
		const repo = join(workDir, "repo");
		await initRepo(repo);
		const params = { baseCwd: repo, name: "part-a", branchPrefix: "omp/agent/", baseRef: "HEAD" };
		const made = await services.call(x.peer, "host.git.worktreeCreate", params, x);
		expect(made).toMatchObject({ path: join(root, "gui-part-a-abc1234"), branch: "omp/agent/part-a", baseCwd: repo });
		// Stock's location is keyed by git's own path of the main checkout (the long form of a Windows 8.3 TEMP).
		expect(asked).toEqual([{ method: "git.worktree_location", request: { primaryRoot: realpathSync.native(repo) } }]);
		expect(gitSync(join(root, "gui-part-a-abc1234"), "branch", "--show-current")).toBe("omp/agent/part-a");
		await expect(
			services.call(x.peer, "host.git.worktreeCreate", { ...params, name: "Bad Name!" }, x),
		).rejects.toThrow(/Invalid worktree name/);
	});
});

describe("LocalHostServices host.memory.*: memory shared with the person's other computers", () => {
	it("shares memory pages only with a device still allowed here, and none while memory is off", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		const blocked = new FakeConnection(peer("device-blocked"));
		const decision: MemoryPageCopy = {
			workspace: "default",
			project: "app",
			path: "decisions/sharing.md",
			title: "Sharing",
			kind: "decision",
			tier: "semantic",
			body: "Tailscale identity only.",
			tags: [],
			pinned: false,
			metadata: {},
			updatedAt: "2026-10-19T10:00:00Z",
		};
		let ready = true;
		const store = {
			projects: vi.fn(async () => [{ workspace: "default", project: "app" }]),
			allPages: vi.fn(async () => [
				decision,
				{ workspace: "default", project: "app", path: "sessions/s1.md", updatedAt: "2026-10-19T10:01:00Z" },
			]),
			pageCopy: vi.fn(async () => decision),
			writePageCopy: vi.fn(async () => true),
			conclusions: vi.fn(async () => ({ rows: [], next: 0, more: false, store: "db-1", last: 0 })),
			writeConclusions: vi.fn(async () => []),
		};
		const deps = { store, ready: () => ready, selfId: () => "this-host" };
		const pull = { since: null };
		await expect(services.call(x.peer, "host.memory.pull", pull, x)).rejects.toThrow(/\[unsupported\]/);
		services.attachMemory({
			pull: (id, params) => servePull(deps, id, params),
			push: (id, params) => servePush(deps, id, params),
			conclusionsPull: (id, params) => serveConclusionPull(deps, id, params),
			conclusionsPush: (id, params) => serveConclusionPush(deps, id, params),
			allows: id => id !== "device-blocked",
		});

		const reply = MemoryPullReply.parse(await services.call(x.peer, "host.memory.pull", pull, x));
		expect(reply).toMatchObject({ memory: true, more: false });
		// Durable pages only: the session page stays here.
		expect(reply.pages).toEqual([expect.objectContaining({ path: "decisions/sharing.md", origin: "this-host" })]);
		const sent = reply.pages[0];
		if (!sent) throw new Error("no page");

		store.pageCopy.mockClear();
		const push = { pages: [{ page: { ...sent, body: "changed" }, expect: null }] };
		await expect(services.call(blocked.peer, "host.memory.pull", pull, blocked)).rejects.toThrow(
			/\[remote_blocked\]/,
		);
		await expect(services.call(blocked.peer, "host.memory.push", push, blocked)).rejects.toThrow(
			/\[remote_blocked\]/,
		);
		expect(store.pageCopy).not.toHaveBeenCalled();

		ready = false;
		await expect(services.call(x.peer, "host.memory.pull", pull, x)).resolves.toEqual({
			memory: false,
			pages: [],
			next: null,
			more: false,
		});
		await expect(services.call(x.peer, "host.memory.push", push, x)).resolves.toEqual({ memory: false, results: [] });
		expect(store.pageCopy).not.toHaveBeenCalled();
		expect(store.writePageCopy).not.toHaveBeenCalled();

		// A page a device may not send (a session page) never reaches the store.
		ready = true;
		const session = { pages: [{ page: { ...sent, path: "sessions/s1.md" }, expect: null }] };
		await expect(services.call(x.peer, "host.memory.push", session, x)).rejects.toThrow(/Invalid host.memory.push/);
		expect(store.writePageCopy).not.toHaveBeenCalled();
	});
});

describe("LocalHostServices host.memory.conclusions.*: session conclusions shared with the other computers", () => {
	const wire = {
		workspace: "default",
		project: "app",
		id: "obs-1",
		sessionId: "s-1",
		title: "Sharing plan",
		body: "Done: Tailscale identity only.",
		at: "2026-10-19T10:00:00Z",
		origin: "device-x",
	};

	function attach(services: LocalHostServices, ready: () => boolean) {
		const store = {
			projects: vi.fn(async () => []),
			allPages: vi.fn(async () => []),
			pageCopy: vi.fn(),
			writePageCopy: vi.fn(async () => true),
			conclusions: vi.fn(async (source: "native" | "synced") => ({
				rows:
					source === "native"
						? [
								{
									seq: 4,
									workspace: "default",
									project: "app",
									id: "obs-9",
									sessionId: "s-9",
									title: "T",
									body: "Host answer.",
									at: "2026-10-19T09:00:00Z",
								},
							]
						: [],
				next: source === "native" ? 4 : 0,
				more: false,
				store: "db-1",
				last: source === "native" ? 4 : 0,
			})),
			writeConclusions: vi.fn(async (_project: unknown, _origin: string, items: unknown[]) =>
				items.map(() => "written" as const),
			),
		};
		const deps = { store, ready, selfId: () => "this-host" };
		services.attachMemory({
			pull: (id, params) => servePull(deps, id, params),
			push: (id, params) => servePush(deps, id, params),
			conclusionsPull: (id, params) => serveConclusionPull(deps, id, params),
			conclusionsPush: (id, params) => serveConclusionPush(deps, id, params),
			allows: id => id !== "device-blocked",
		});
		return store;
	}

	it("serves a device still allowed here, refuses a blocked one, and answers memory:false while off", async () => {
		const { services } = setup();
		const x = new FakeConnection(peer("device-x"));
		const blocked = new FakeConnection(peer("device-blocked"));
		const pull = { since: { native: 0, synced: 0 } };
		const push = { conclusions: [{ ...wire, origin: "device-blocked" }] };
		await expect(services.call(x.peer, "host.memory.conclusions.pull", pull, x)).rejects.toThrow(/\[unsupported\]/);
		let ready = true;
		const store = attach(services, () => ready);

		const reply = await services.call(x.peer, "host.memory.conclusions.pull", pull, x);
		expect(MemoryConclusionPullReply.parse(reply)).toEqual({
			memory: true,
			conclusions: [expect.objectContaining({ id: "obs-9", origin: "this-host", body: "Host answer." })],
			next: { native: 4, synced: 0, store: "db-1" },
			more: false,
		});
		await expect(services.call(x.peer, "host.memory.conclusions.push", { conclusions: [wire] }, x)).resolves.toEqual({
			memory: true,
			results: [{ status: "written" }],
		});
		expect(store.writeConclusions).toHaveBeenCalledWith(
			{ workspace: "default", project: "app" },
			"device-x",
			[expect.objectContaining({ id: "obs-1" })],
			undefined,
		);

		store.conclusions.mockClear();
		store.writeConclusions.mockClear();
		await expect(services.call(blocked.peer, "host.memory.conclusions.pull", pull, blocked)).rejects.toThrow(
			/\[remote_blocked\]/,
		);
		await expect(services.call(blocked.peer, "host.memory.conclusions.push", push, blocked)).rejects.toThrow(
			/\[remote_blocked\]/,
		);
		expect(store.conclusions).not.toHaveBeenCalled();
		expect(store.writeConclusions).not.toHaveBeenCalled();

		ready = false;
		await expect(services.call(x.peer, "host.memory.conclusions.pull", pull, x)).resolves.toEqual({
			memory: false,
			conclusions: [],
			next: { native: 0, synced: 0 },
			more: false,
		});
		await expect(services.call(x.peer, "host.memory.conclusions.push", { conclusions: [wire] }, x)).resolves.toEqual({
			memory: false,
			results: [],
		});
		expect(store.conclusions).not.toHaveBeenCalled();
		expect(store.writeConclusions).not.toHaveBeenCalled();

		// A conclusion past the wire's bounds never reaches the store.
		ready = true;
		const long = { conclusions: [{ ...wire, body: "x".repeat(2001) }] };
		await expect(services.call(x.peer, "host.memory.conclusions.push", long, x)).rejects.toThrow(
			/Invalid host.memory.conclusions.push/,
		);
		expect(store.writeConclusions).not.toHaveBeenCalled();
	});
});

describe("LocalHostServices tab events past the link's frame cap", () => {
	const CAP = 20_000;

	/** A device's connection that asked for slim events and progress, and whose link refuses a frame over `CAP`. */
	class CappedConnection extends FakeConnection {
		readonly slim = {
			events: true,
			progress: true,
			autopilot: false,
			ends: false,
			readGroups: false,
			toolResults: false,
			endFields: false,
			autopilotReads: false,
			listReads: false,
			shiftedReads: false,
			settingsReads: false,
			rosterReads: false,
			toolOutputs: false,
			deflate: false,
		};
		override emit(event: string, data: unknown): void {
			if (JSON.stringify(data).length > CAP) throw new FrameTooLargeError(JSON.stringify(data).length);
			super.emit(event, data);
		}
	}

	const progressFrame = (id: string, step: number, bytes: number): SubagentFrame => {
		const progress = {
			index: 0,
			id,
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: "task",
			recentTools: [],
			recentOutput: [`${step}`.repeat(bytes)],
			toolCount: step,
			requests: step,
			tokens: step,
			cost: 0,
			durationMs: step,
		} satisfies AgentProgress;
		return {
			type: "subagent_progress",
			payload: { index: 0, agent: "explore", agentSource: "bundled", task: "task", progress },
		};
	};

	async function connected() {
		const context = setup();
		const x = new CappedConnection(peer("device-x"));
		await context.services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await context.services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		const sidecar = context.sidecars[0];
		if (!sidecar) throw new Error("no sidecar");
		sidecar.setStatus("ready");
		return { ...context, x, sidecar };
	}

	/** What the device's sidecar delivers for the host's `subagentFrame` tab events, in order. */
	function delivered(x: FakeConnection): SubagentFrame[] {
		const decoder = createLinkEventDecoder();
		const out: SubagentFrame[] = [];
		for (const event of x.tabEvents()) {
			if (event.name !== "subagentFrame") continue;
			const wire = JSON.parse(JSON.stringify(event.arg)) as WireSubagentFrame[];
			for (const frame of wire) {
				const decoded = decoder.subagentFrame(frame);
				if (decoded) out.push(decoded);
			}
		}
		return out;
	}

	it("sends a flush of subagent frames that passes the cap as several tab events, in order, and the device rebuilds them", async () => {
		const { x, sidecar } = await connected();
		const raw = Array.from({ length: 40 }, (_, step) => progressFrame("sa-1", step + 1, 1_000));
		for (const frame of raw) sidecar.emit("subagentFrame", frame);
		sidecar.emit("beforeResponse");

		const sent = x.tabEvents().filter(event => event.name === "subagentFrame");
		expect(sent.length).toBeGreaterThan(1);
		expect(delivered(x)).toEqual(JSON.parse(JSON.stringify(raw)));
	});

	it("starts the next snapshot of a subagent over whole after one frame was too large to send", async () => {
		const { x, sidecar } = await connected();
		const huge = progressFrame("sa-1", 1, CAP * 2);
		const next = progressFrame("sa-1", 2, 1_000);
		sidecar.emit("subagentFrame", huge);
		sidecar.emit("beforeResponse");
		sidecar.emit("subagentFrame", next);
		sidecar.emit("beforeResponse");

		expect(delivered(x)).toEqual(JSON.parse(JSON.stringify([next])));
	});
});

describe("LocalHostServices an Autopilot status on the link", () => {
	const status = (cycles: number) => ({
		active: true,
		state: "running",
		cycles: Array.from({ length: cycles }, (_, n) => ({ n, summary: "요약 ".repeat(100) })),
	});
	const update = (cycles: number) => ({ type: "autopilot_update", status: status(cycles) }) as AgentSessionEvent;

	async function connected(slimAutopilot: boolean) {
		const context = setup();
		const x = Object.assign(new FakeConnection(peer("device-x")), {
			slim: {
				events: true,
				progress: true,
				autopilot: slimAutopilot,
				ends: false,
				readGroups: false,
				toolResults: false,
				endFields: false,
				autopilotReads: false,
				listReads: false,
				shiftedReads: false,
				settingsReads: false,
				rosterReads: false,
				toolOutputs: false,
				deflate: false,
			},
		});
		await context.services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await context.services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		const sidecar = context.sidecars[0];
		if (!sidecar) throw new Error("no sidecar");
		sidecar.setStatus("ready");
		for (const cycles of [30, 31]) sidecar.emit("events", [update(cycles)]);
		const sent = x.tabEvents().filter(event => event.name === "events");
		return sent.map(event => JSON.parse(JSON.stringify(event.arg)) as AgentSessionEvent[]);
	}

	it("goes as a delta after the first to a device that asked, which rebuilds both", async () => {
		const sent = await connected(true);
		expect(JSON.stringify(sent[1]).length).toBeLessThan(JSON.stringify(sent[0]).length / 10);
		const decoder = createLinkEventDecoder();
		expect(sent.map(batch => decoder.events(batch))).toEqual(
			JSON.parse(JSON.stringify([[update(30)], [update(31)]])),
		);
	});

	it("goes whole to a device that did not ask", async () => {
		const sent = await connected(false);
		expect(sent).toEqual(JSON.parse(JSON.stringify([[update(30)], [update(31)]])));
	});
});

describe("LocalHostServices a get_autopilot answer on the link", () => {
	const status = (cycles: number) => ({
		active: true,
		state: "running",
		cycles: Array.from({ length: cycles }, (_, n) => ({ n, summary: "요약 ".repeat(100) })),
	});

	/** Three reads, the run one cycle longer before each; the second asked `fresh`, as a device that lacked its copy. */
	async function reads(autopilotReads: boolean) {
		const { services } = setup();
		const x = Object.assign(new FakeConnection(peer("device-x")), {
			slim: {
				events: true,
				progress: true,
				autopilot: true,
				ends: false,
				readGroups: false,
				toolResults: false,
				endFields: false,
				autopilotReads,
				listReads: false,
				shiftedReads: false,
				settingsReads: false,
				rosterReads: false,
				toolOutputs: false,
				deflate: false,
			},
		});
		await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		let cycles = 30;
		services.attachAutopilot(async (_target, command) => ({
			type: "response",
			command: command.type,
			success: true,
			data: status(cycles++),
		}));
		const answers: RpcResponse[] = [];
		for (const fresh of [false, true, false])
			answers.push(
				JSON.parse(
					JSON.stringify(
						await services.call(
							x.peer,
							"tab.command",
							{ rtab: "t1", command: { type: "get_autopilot" }, ...(fresh ? { fresh } : {}) },
							x,
						),
					),
				) as RpcResponse,
			);
		return answers;
	}

	it("goes as a delta of the last answer to a device that reads them, whole when it asks fresh", async () => {
		const answers = await reads(true);
		const size = (answer: RpcResponse | undefined) => JSON.stringify(answer).length;
		expect(size(answers[1])).toBeGreaterThan(size(answers[0]) - 100);
		expect(size(answers[2]) * 10).toBeLessThan(size(answers[0]));
		const decode = createReadDecoder();
		expect(answers.map(answer => decode(answer.success ? answer.data : null))).toEqual([
			status(30),
			status(31),
			status(32),
		]);
	});

	it("goes whole to a device that did not ask", async () => {
		const answers = await reads(false);
		expect(answers.map(answer => (answer.success ? answer.data : null))).toEqual([
			status(30),
			status(31),
			status(32),
		]);
	});

	it("goes as a delta of the copy the device kept when it comes back on a new connection, whole when it reads another way", async () => {
		const { services } = setup();
		const slim = {
			events: true,
			progress: true,
			autopilot: true,
			ends: false,
			readGroups: false,
			toolResults: false,
			endFields: false,
			autopilotReads: true,
			listReads: false,
			shiftedReads: false,
			settingsReads: false,
			rosterReads: false,
			toolOutputs: false,
			deflate: false,
		};
		let cycles = 30;
		services.attachAutopilot(async (_target, command) => ({
			type: "response",
			command: command.type,
			success: true,
			data: status(cycles++),
		}));
		const ask = async (conn: FakeConnection) => {
			await services.call(conn.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, conn);
			const answer = (await services.call(
				conn.peer,
				"tab.command",
				{ rtab: "t1", command: { type: "get_autopilot" } },
				conn,
			)) as RpcResponse;
			return JSON.parse(JSON.stringify(answer)) as RpcResponse;
		};
		const decode = createReadDecoder();
		const first = await ask(Object.assign(new FakeConnection(peer("device-x")), { slim }));
		const again = await ask(Object.assign(new FakeConnection(peer("device-x")), { slim }));
		expect(JSON.stringify(again).length * 10).toBeLessThan(JSON.stringify(first).length);
		expect([first, again].map(answer => decode(answer.success ? answer.data : null))).toEqual([
			status(30),
			status(31),
		]);
		const other = await ask(
			Object.assign(new FakeConnection(peer("device-x")), { slim: { ...slim, rosterReads: true } }),
		);
		expect(decode(other.success ? other.data : null)).toEqual(status(32));
		expect(JSON.stringify(other).length).toBeGreaterThan(JSON.stringify(first).length - 100);
	});
});

describe("LocalHostServices the reads a device repeats on every hydration", () => {
	const commands = (n: number) => ({
		commands: Array.from({ length: n }, (_, i) => ({
			name: `skill:${i}`,
			source: "skill",
			description: "설명 ".repeat(60),
		})),
	});
	const page = (n: number) => ({
		messages: Array.from({ length: n }, (_, i) => ({
			role: "assistant",
			content: [{ type: "text", text: "답 ".repeat(200) }],
			i,
		})),
		totalMessages: n,
		startIndex: 0,
	});

	async function connected(listReads: boolean, shiftedReads = false) {
		const context = setup();
		const x = Object.assign(new FakeConnection(peer("device-x")), {
			slim: {
				events: true,
				progress: true,
				autopilot: true,
				ends: false,
				readGroups: false,
				toolResults: false,
				endFields: false,
				autopilotReads: true,
				listReads,
				shiftedReads,
				settingsReads: listReads,
				rosterReads: listReads,
				toolOutputs: false,
				deflate: false,
			},
		});
		await context.services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		await context.services.call(x.peer, "tab.start", { rtab: "t1" }, x);
		const sidecar = context.sidecars[0];
		if (!sidecar) throw new Error("no sidecar");
		let n = 40;
		sidecar.rpcClient.command = async (command: RpcCommand): Promise<RpcResponse> => ({
			type: "response",
			command: command.type,
			success: true,
			data: command.type === "get_available_commands" ? commands(n) : page(n),
		});
		const ask = async (command: Record<string, unknown>) =>
			JSON.parse(
				JSON.stringify(await context.services.call(x.peer, "tab.command", { rtab: "t1", command }, x)),
			) as RpcResponse;
		return { ...context, x, sidecar, ask, grow: () => n++ };
	}

	const size = (answer: RpcResponse) => JSON.stringify(answer).length;
	const data = (answer: RpcResponse) => (answer.success ? answer.data : null);

	it("sends the command list and the tail page as deltas of the last of their own kind; a page by cursor goes whole", async () => {
		const { ask, grow } = await connected(true);
		const tail = { type: "get_transcript_page", fromEnd: true, limit: 200 };
		const answers = [await ask({ type: "get_available_commands" }), await ask(tail)];
		grow();
		answers.push(await ask({ type: "get_available_commands" }), await ask(tail));
		expect(size(answers[2] as RpcResponse) * 10).toBeLessThan(size(answers[0] as RpcResponse));
		expect(size(answers[3] as RpcResponse) * 10).toBeLessThan(size(answers[1] as RpcResponse));
		const lists = createReadDecoder();
		const pages = createReadDecoder();
		expect([lists(data(answers[0] as RpcResponse)), lists(data(answers[2] as RpcResponse))]).toEqual([
			commands(40),
			commands(41),
		]);
		expect([pages(data(answers[1] as RpcResponse)), pages(data(answers[3] as RpcResponse))]).toEqual([
			page(40),
			page(41),
		]);
		// A page read by cursor is the device's to hold, nothing to compare it with.
		expect(data(await ask({ type: "get_transcript_page", cursor: "c1", limit: 200 }))).toEqual(page(41));
	});

	it("compares a running session's tail page at the offset its window moved by only for a device that reads shifts", async () => {
		// The window keeps 40 messages: each read starts one message later.
		const tail = { type: "get_transcript_page", fromEnd: true, limit: 40 };
		const moving = (from: number) => ({
			messages: Array.from({ length: 40 }, (_, i) => ({ role: "assistant", text: `답 ${from + i} `.repeat(60) })),
			totalMessages: from + 40,
			startIndex: from,
		});
		const second = async (shiftedReads: boolean) => {
			const { sidecar, ask } = await connected(true, shiftedReads);
			let from = 0;
			sidecar.rpcClient.command = async (command: RpcCommand): Promise<RpcResponse> => ({
				type: "response",
				command: command.type,
				success: true,
				data: moving(from++),
			});
			const decode = createReadDecoder();
			const answers = [await ask(tail), await ask(tail)];
			expect(answers.map(answer => decode(data(answer)))).toEqual([moving(0), moving(1)]);
			return size(answers[1] as RpcResponse);
		};
		const shifted = await second(true);
		const indexed = await second(false);
		expect(shifted * 10).toBeLessThan(indexed);
	});

	it("sends Settings' reads as deltas of the last one of the same command and arguments", async () => {
		const { sidecar, ask } = await connected(true);
		let generation = 1;
		const catalog = () => ({
			providers: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Provider ${i} `.repeat(20) })),
			models: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, name: `Model ${i} `.repeat(10) })),
			generation,
		});
		sidecar.rpcClient.command = async (command: RpcCommand): Promise<RpcResponse> => ({
			type: "response",
			command: command.type,
			success: true,
			data: command.type === "get_providers" ? catalog() : { roles: [command.type], paths: command },
		});
		const decode = createReadDecoder();
		const first = await ask({ type: "get_providers" });
		generation = 2;
		const second = await ask({ type: "get_providers" });
		expect(size(second) * 10).toBeLessThan(size(first));
		expect([decode(data(first)), decode(data(second))]).toEqual([{ ...catalog(), generation: 1 }, catalog()]);
		// A forced refresh is its own chain: its first answer goes whole.
		expect(data(await ask({ type: "get_providers", forceRefresh: true }))).toMatchObject({
			"~read": expect.any(String),
			status: catalog(),
		});
	});

	it("sends the subagent roster a running turn polls as deltas of the last one", async () => {
		const { sidecar, ask, x } = await connected(true);
		let tick = 0;
		const roster = () => ({
			subagents: Array.from({ length: 6 }, (_, i) => ({
				id: `a${i}`,
				agent: "task",
				status: "running",
				task: `Title: 일 ${i}\n${"자세한 지시 ".repeat(200)}`,
				progress: { toolCount: tick + i, lastUpdate: 1000 + tick },
			})),
		});
		sidecar.rpcClient.command = async (command: RpcCommand): Promise<RpcResponse> => ({
			type: "response",
			command: command.type,
			success: true,
			data: roster(),
		});
		const decode = createReadDecoder();
		const first = await ask({ type: "get_subagents" });
		tick++;
		const second = await ask({ type: "get_subagents" });
		expect(size(second) * 10).toBeLessThan(size(first));
		decode(data(first));
		expect(decode(data(second))).toEqual(roster());
		x.slim.rosterReads = false;
		expect(data(await ask({ type: "get_subagents" }))).toEqual(roster());
	});

	it("sends Settings' reads whole to a device that reads lists but not settings", async () => {
		const { x, ask } = await connected(true);
		x.slim.settingsReads = false;
		expect(data(await ask({ type: "get_settings_schema" }))).toEqual(page(40));
		expect(data(await ask({ type: "get_settings_schema" }))).toEqual(page(40));
	});

	it("sends both whole to a device that did not ask", async () => {
		const { ask } = await connected(false);
		expect(data(await ask({ type: "get_available_commands" }))).toEqual(commands(40));
		expect(data(await ask({ type: "get_available_commands" }))).toEqual(commands(40));
		expect(data(await ask({ type: "get_transcript_page", fromEnd: true, limit: 200 }))).toEqual(page(40));
	});

	it("sends a commandsUpdate that repeats the list the connection last got no further", async () => {
		const { services, x, sidecar } = await connected(false);
		const updates = () => x.tabEvents().filter(event => event.name === "commandsUpdate");
		sidecar.emit("commandsUpdate", commands(3).commands);
		sidecar.emit("commandsUpdate", commands(3).commands);
		expect(updates()).toHaveLength(1);
		sidecar.emit("commandsUpdate", commands(4).commands);
		expect(updates()).toHaveLength(2);
		// The device comes back on another connection: the list goes again.
		const y = Object.assign(new FakeConnection(peer("device-x")), { slim: x.slim });
		await services.call(y.peer, "tab.open", { rtab: "t1", cwd: workDir }, y);
		sidecar.emit("commandsUpdate", commands(4).commands);
		expect(y.tabEvents().filter(event => event.name === "commandsUpdate")).toHaveLength(1);
	});
});
