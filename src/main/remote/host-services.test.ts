import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../e2e/models-config-fixture";
import type { AccountRotationMode, AccountRotationState } from "../../shared/account-rotation";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type {
	CustomProviderInput,
	CustomProvidersConfig,
	CustomProviderView,
	IpcBenchmarkRunOptions,
	IpcBenchmarkRunResult,
	IpcModelSetupRunResult,
} from "../../shared/ipc-types";
import type { ModelSetupRequest, ModelSetupStatus } from "../../shared/model-setup";
import { MAX_RPC_COMMAND_TIMEOUT_MS, timeoutForCommand } from "../../shared/rpc-client";
import type { RpcCommand, RpcResponse, SidecarStatus } from "../../shared/rpc-types";
import { canonicalCwd } from "../canonical-cwd";
import type { MachineServices } from "../machine-services";
import type { SidecarLike } from "../sidecar-pool";
import { FS_BINARY_REMOTE_MAX_BYTES } from "../workspace-fs";
import { decodeBinaryRead, type TabEventMessage } from "./app-protocol";
import type { HostConnection } from "./host-server";
import { type HostServicesDeps, LocalHostServices } from "./host-services";
import type { PeerInfo } from "./peers-store";

/** A SidecarManager stand-in for the host side. */
class FakeHostSidecar extends EventEmitter {
	status: SidecarStatus = "asleep";
	processAlive = false;
	disposed = false;
	started: Array<{ resume: string | undefined }> = [];
	sideFrames: object[] = [];
	imageSyncs = 0;
	replyLanguageSyncs = 0;
	userProfileSyncs = 0;
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
	syncAccountRotation(): void {
		this.accountRotationSyncs++;
	}
	dispose(): void {
		this.disposed = true;
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
	return { deviceId, name: deviceId, staticPub: "pub", pairedAt: 0 };
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
	const localTabs: HostServicesDeps["localTabs"] = {
		sessionOwner: path => owned.get(path) ?? null,
		sessionOwnerIsLive: path => owned.has(path) && tab.processAlive,
		commandForSession: (_path, command) => tab.rpcClient.command(command),
		commandForIdleSession: (_path, command) => tab.rpcClient.command(command),
		noteSessionFile: (tabId, sessionFile) => {
			for (const [path, owner] of owned) if (owner.tabId === tabId && !sessionFile) owned.delete(path);
		},
		allSidecars: () => [tab as unknown as SidecarLike],
	};
	return { tab, owned, localTabs };
}

/** This machine's models.yml, stats and bench, recording what the host asked of it. */
function fakeMachine() {
	return {
		listProviders: vi.fn(
			async (): Promise<CustomProvidersConfig> => ({ providers: [PROVIDER_VIEW], options: fixtureProviderOptions }),
		),
		upsertProvider: vi.fn(async (_input: CustomProviderInput) => {}),
		deleteProvider: vi.fn(async (_id: string) => {}),
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

function setup(graceMs = 60_000) {
	const sidecars: FakeHostSidecar[] = [];
	const machine = fakeMachine();
	const local = fakeLocalTabs();
	const deleteSession = vi.fn(async (_path: string) => {});
	const renameStoredSession = vi.fn(async (_path: string, _name: string) => {});
	const services = new LocalHostServices({
		createSidecar: (cwd, kind) => {
			const sidecar = new FakeHostSidecar(cwd, kind);
			sidecars.push(sidecar);
			return sidecar as unknown as SidecarLike;
		},
		sessionIndex: {
			list: async () => [],
			searchContent: async () => [],
			kindFor: async () => "chat",
			deleteSession,
			moveSession: async (path: string) => path,
			sessionsDir: join(workDir, "sessions"),
		},
		renameStoredSession,
		defaultWorkspace: () => workDir,
		launchProfiles: { get: () => undefined, set: () => {} },
		machine,
		localTabs: local.localTabs,
		trashItem: async () => {},
		graceMs,
	});
	return { services, sidecars, local, deleteSession, renameStoredSession, machine };
}

describe("LocalHostServices", () => {
	it("scopes rtabs per peer: one device can never reach another device's tab", async () => {
		const { services, sidecars } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));

		const opened = await services.call(x.peer, "tab.open", { rtab: "t1", cwd: workDir, fresh: true }, x);
		expect(opened).toEqual({ cwd: workDir, kind: "agent", attached: false });
		await services.call(x.peer, "tab.start", { rtab: "t1" }, x);

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
		expect(y.tabEvents()).toEqual([]);
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
			{
				rtab: "t1",
				name: "status",
				arg: { status: "ready", statusPayload: {}, processAlive: true, cwd: workDir, kind: "agent" },
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

	it("deletes and renames a session through this machine's own live tab that holds it", async () => {
		const { services, local, deleteSession, renameStoredSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		local.owned.set("/s/local.jsonl", { tabId: "local-1", winId: 1 });
		local.tab.setStatus("ready");

		await services.call(x.peer, "sessions.rename", { sessionPath: "/s/local.jsonl", name: " New " }, x);
		await services.call(x.peer, "sessions.delete", { sessionPath: "/s/local.jsonl" }, x);
		expect(local.tab.commands).toEqual([
			{ type: "set_session_name", name: "New", sessionPath: "/s/local.jsonl" },
			{ type: "drop_session" },
		]);
		expect(renameStoredSession).not.toHaveBeenCalled();
		expect(deleteSession).not.toHaveBeenCalled();
		// The local tab moved on to a fresh session: it no longer claims the file.
		expect(local.owned.has("/s/local.jsonl")).toBe(false);
	});

	it("falls back to the stored file when no live tab holds the session, releasing a sleeping claim", async () => {
		const { services, local, deleteSession, renameStoredSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		local.owned.set("/s/asleep.jsonl", { tabId: "local-1", winId: 1 });

		await services.call(x.peer, "sessions.rename", { sessionPath: "/s/asleep.jsonl", name: "Kept" }, x);
		await services.call(x.peer, "sessions.delete", { sessionPath: "/s/asleep.jsonl" }, x);
		expect(renameStoredSession).toHaveBeenCalledWith("/s/asleep.jsonl", "Kept");
		expect(deleteSession).toHaveBeenCalledWith("/s/asleep.jsonl");
		expect(local.tab.commands).toEqual([]);
		expect(local.owned.has("/s/asleep.jsonl")).toBe(false);
	});

	it("refuses to delete a session another device's live host tab holds", async () => {
		const { services, sidecars, deleteSession } = setup();
		const x = new FakeConnection(peer("device-x"));
		const y = new FakeConnection(peer("device-y"));
		await services.call(y.peer, "tab.open", { rtab: "t", cwd: workDir, fresh: false }, y);
		sidecars[0]?.setStatus("ready");
		sidecars[0]?.emit("session", { sessionId: "s", sessionFile: "/s/y.jsonl" });

		const refused = await services
			.call(x.peer, "sessions.delete", { sessionPath: "/s/y.jsonl" }, x)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(deleteSession).not.toHaveBeenCalled();
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
		// The status is re-sent on attach.
		expect(second.tabEvents()).toEqual([
			expect.objectContaining({ name: "status", arg: expect.objectContaining({ status: "ready" }) }),
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
