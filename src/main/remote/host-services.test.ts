import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	HostUpdateAction,
	IpcBenchmarkRunOptions,
	IpcBenchmarkRunResult,
	IpcModelSetupRunResult,
	ModelOverrideInput,
} from "../../shared/ipc-types";
import type { ModelSetupRequest, ModelSetupStatus } from "../../shared/model-setup";
import type { OmpUpdateState } from "../../shared/omp-update";
import { MAX_RPC_COMMAND_TIMEOUT_MS, timeoutForCommand } from "../../shared/rpc-client";
import type { RpcCommand, RpcResponse, SidecarStatus } from "../../shared/rpc-types";
import { canonicalCwd } from "../canonical-cwd";
import type { MachineServices } from "../machine-services";
import type { SidecarLike } from "../sidecar-pool";
import { FS_BINARY_REMOTE_MAX_BYTES } from "../workspace-fs";
import { decodeBinaryRead, OMP_UPDATE_EVENT, type TabEventMessage } from "./app-protocol";
import type { HostConnection } from "./host-server";
import { type HostServicesDeps, LocalHostServices } from "./host-services";
import { localDay, PeerQuota } from "./peer-quota";
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
	const origins: PromptOriginEnv[] = [];
	const machine = fakeMachine();
	const local = fakeLocalTabs();
	const deleteSession = vi.fn(async (_path: string) => {});
	const renameStoredSession = vi.fn(async (_path: string, _name: string) => {});
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
	return { services, sidecars, origins, local, deleteSession, renameStoredSession, machine };
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
		expect(y.tabEvents()).toEqual([{ rtab: "t1", name: "awaitingConnection", arg: false }]);
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
			// Every open tells the device whether this computer holds the tab's turn for its connection.
			{ rtab: "t1", name: "awaitingConnection", arg: false },
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
		// The status is re-sent on attach, and whether this computer holds the turn for its connection.
		expect(second.tabEvents()).toEqual([
			expect.objectContaining({ name: "status", arg: expect.objectContaining({ status: "ready" }) }),
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
			["new", "status"],
			["new", "awaitingConnection"],
			["new", "events"],
		]);
		const old = await services
			.call(after.peer, "tab.command", { rtab: "old", command: { type: "get_state" } }, after)
			.catch((error: unknown) => error);
		expect(ipcErrorCode(old)).toBe("unknown_tab");

		// Another device's tab on the same path, or this connection's own, is never taken.
		const other = new FakeConnection(peer("device-y"));
		await services.call(other.peer, "tab.open", { rtab: "y1", cwd: workDir, sessionPath: "/s/one.jsonl" }, other);
		await services.call(after.peer, "tab.open", { rtab: "again", cwd: workDir, sessionPath: "/s/one.jsonl" }, after);
		expect(sidecars).toHaveLength(3);
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
