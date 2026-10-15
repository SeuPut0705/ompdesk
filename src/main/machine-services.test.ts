import { describe, expect, it, vi } from "vitest";
import type { AccountRotationMode } from "../shared/account-rotation";
import { codedError, ipcErrorCode } from "../shared/ipc-error-codes";
import type { CustomProviderInput, IpcBenchmarkRunOptions } from "../shared/ipc-types";
import type { OmpUpdateState } from "../shared/omp-update";
import { BENCHMARK_TIMEOUT_MS } from "./benchmark-runner";
import {
	type AccountRotationDeps,
	type HostRequest,
	LocalMachine,
	type MachineServices,
	machineFor,
	RemoteMachine,
} from "./machine-services";
import type { OmpUpdater } from "./omp-updater";
import { HOST_STATS_TIMEOUT_MS, LINK_SLACK_MS } from "./remote/app-protocol";
import type { Revive } from "./stats-restart-policy";

const statsText = (key: "stats.notRunning" | "stats.notReady") => `local:${key}`;
const OPTIONS: IpcBenchmarkRunOptions = { models: ["anthropic/x"], profile: "chat", runs: 1, parallel: 1 };

type StatsFetch = (path: string, params?: Record<string, string>) => Promise<unknown>;

/** prefs `accountRotation` in memory; `write` records each fan-out. */
function rotationPrefs(stored: unknown = undefined, evenSupported: boolean | null = true) {
	const writes: AccountRotationMode[] = [];
	const deps: AccountRotationDeps = {
		read: () => stored,
		write: mode => {
			stored = mode;
			writes.push(mode);
		},
		evenSupported: async () => evenSupported,
	};
	return { deps, writes };
}

const OMP_UPDATE_STATE: OmpUpdateState = {
	enabled: true,
	scheduled: true,
	phase: "idle",
	installed: "18.8.7",
	latest: "18.9.0",
	checkedAt: 1,
	updatedTo: null,
	failure: null,
};

/** An OmpUpdater whose `updateNow` flips to `checking` at once, like the real one, and stays there until `finish`. */
function fakeUpdater() {
	let state: OmpUpdateState = OMP_UPDATE_STATE;
	let settle = () => {};
	return {
		state: () => state,
		updateNow: vi.fn(() => {
			state = { ...state, phase: "checking" };
			return new Promise<void>(resolve => {
				settle = resolve;
			});
		}),
		finish: () => {
			state = { ...state, phase: "idle" };
			settle();
		},
	};
}

function localMachine(
	port: number,
	revive: Revive = "scheduled",
	fetch: StatsFetch = async () => ({ ok: 1 }),
	accountRotation: AccountRotationDeps = rotationPrefs().deps,
	updater: Pick<OmpUpdater, "state" | "updateNow"> = fakeUpdater(),
) {
	return new LocalMachine({
		stats: { port, fetch },
		statsRestart: () => revive,
		statsText,
		benchmarkOmp: async () => ({ ok: false, error: "omp missing" }),
		benchmarkEnv: async () => ({}),
		accountRotation,
		builtinRea: { read: () => undefined, write: () => {} },
		desktop: {
			version: () => "1.2.3",
			update: {
				status: () => ({ state: "idle" }),
				check: async () => ({ state: "checking" }),
				download: async () => ({ state: "idle" }),
				restartable: () => false,
				restart: () => {},
			},
			appearance: () => ({ themeName: "dark", language: 3 }),
			busy: () => false,
		},
		ompUpdater: () => updater,
	});
}

/** A paired host's answers, recording every call A makes. */
function fakeHost(reply: (method: string, params: unknown) => unknown = () => null) {
	const calls: Array<{ device: string; method: string; params: unknown; timeoutMs: number | undefined }> = [];
	const request: HostRequest = async <T>(device: string, method: string, params: unknown, timeoutMs?: number) => {
		calls.push({ device, method, params, timeoutMs });
		return reply(method, params) as T;
	};
	return { calls, request };
}

describe("machineFor", () => {
	it("serves this computer without a device and the paired host with one", async () => {
		const local: MachineServices = localMachine(0);
		const host = fakeHost(method =>
			method === "host.models.list" ? { providers: [{ id: "host-only" }], options: { apis: ["stock-api"] } } : null,
		);
		expect(machineFor(undefined, local, { request: host.request, statsText })).toBe(local);

		const remote = machineFor("host-b", local, {
			request: host.request,
			statsText,
			tab: { rtab: "tab-1", cwd: "/Users/b/project" },
		});
		expect(remote).toBeInstanceOf(RemoteMachine);
		await expect(remote.listProviders()).resolves.toEqual({
			providers: [{ id: "host-only" }],
			options: { apis: ["stock-api"] },
		});
		const input: CustomProviderInput = { id: "lan", api: "openai-completions", baseUrl: "http://x/v1", models: [] };
		await remote.upsertProvider(input);
		await remote.deleteProvider("lan");
		await remote.fetchStats("/api/stats/overview", { range: "24h" });
		await remote.runBenchmark("window:1", OPTIONS, "/ignored/local/cwd");
		await remote.abortBenchmark("window:1");
		expect(host.calls).toEqual([
			{ device: "host-b", method: "host.models.list", params: {}, timeoutMs: undefined },
			{ device: "host-b", method: "host.models.upsert", params: { input }, timeoutMs: undefined },
			{ device: "host-b", method: "host.models.delete", params: { id: "lan" }, timeoutMs: undefined },
			{
				device: "host-b",
				method: "host.stats.fetch",
				params: { path: "/api/stats/overview", params: { range: "24h" } },
				timeoutMs: HOST_STATS_TIMEOUT_MS,
			},
			// The host roots the run at A's tab there; this computer's cwd never crosses.
			{
				device: "host-b",
				method: "host.bench.run",
				params: { options: OPTIONS, rtab: "tab-1", cwd: "/Users/b/project" },
				timeoutMs: BENCHMARK_TIMEOUT_MS + LINK_SLACK_MS,
			},
			{ device: "host-b", method: "host.bench.abort", params: {}, timeoutMs: undefined },
		]);
	});

	it("words a host's stats down-state in this computer's language and turns link failures into a reply", async () => {
		const down = fakeHost(() => ({ error: "host text", unavailable: false, stopped: true }));
		const remote = new RemoteMachine({ request: down.request, statsText, device: "host-b" });
		await expect(remote.fetchStats("/api/stats/overview")).resolves.toEqual({
			error: "local:stats.notRunning",
			unavailable: false,
			stopped: true,
		});
		expect(down.calls[0]?.params).toEqual({ path: "/api/stats/overview" });

		const offline = new RemoteMachine({
			request: async () => {
				throw codedError("remote_offline", "Host B is offline");
			},
			statsText,
			device: "host-b",
		});
		const reply = (await offline.fetchStats("/api/stats/overview")) as { error: string; unavailable: boolean };
		expect(reply.unavailable).toBe(false);
		expect(ipcErrorCode(reply)).toBe("remote_offline");
	});

	it("reads and writes a paired host's own account-rotation pref and checks the reply", async () => {
		const host = fakeHost((method, params) =>
			method === "host.accountRotation.set" && typeof params === "object" && params !== null && "mode" in params
				? { mode: params.mode, evenSupported: false }
				: { mode: "even", evenSupported: true },
		);
		const remote = new RemoteMachine({ request: host.request, device: "host-b", statsText });
		await expect(remote.accountRotation()).resolves.toEqual({ mode: "even", evenSupported: true });
		await expect(remote.setAccountRotation("quota")).resolves.toEqual({ mode: "quota", evenSupported: false });
		expect(host.calls.map(({ method, params }) => ({ method, params }))).toEqual([
			{ method: "host.accountRotation.get", params: {} },
			{ method: "host.accountRotation.set", params: { mode: "quota" } },
		]);
		const garbled = new RemoteMachine({
			request: fakeHost(() => ({ mode: "fastest" })).request,
			device: "host-b",
			statsText,
		});
		await expect(garbled.accountRotation()).rejects.toThrow();
	});

	it("routes built-in REA to the paired host and validates its reply", async () => {
		const host = fakeHost((method, params) =>
			method === "host.builtinRea.set" && typeof params === "object" && params !== null && "enabled" in params
				? { enabled: params.enabled, available: false, reason: "node-missing" }
				: { enabled: true, available: true, nodeVersion: "v26.0.0" },
		);
		const remote = new RemoteMachine({ request: host.request, device: "host-b", statsText });
		await expect(remote.builtinRea()).resolves.toMatchObject({ enabled: true, available: true });
		await expect(remote.setBuiltinRea(false)).resolves.toMatchObject({ enabled: false, reason: "node-missing" });
		expect(host.calls.map(({ method, params }) => ({ method, params }))).toEqual([
			{ method: "host.builtinRea.get", params: {} },
			{ method: "host.builtinRea.set", params: { enabled: false } },
		]);
		const garbled = new RemoteMachine({
			request: fakeHost(() => ({ enabled: "yes" })).request,
			device: "host-b",
			statsText,
		});
		await expect(garbled.builtinRea()).rejects.toThrow();
	});

	it("reads a paired host's omp update state, starts its update there and checks the replies", async () => {
		const host = fakeHost(method =>
			method === "host.ompUpdate.now"
				? { ...OMP_UPDATE_STATE, phase: "updating" }
				: { ...OMP_UPDATE_STATE, failure: { reason: "install", detail: "exit 1" } },
		);
		const remote = new RemoteMachine({ request: host.request, device: "host-b", statsText });
		await expect(remote.ompUpdate()).resolves.toMatchObject({ failure: { reason: "install", detail: "exit 1" } });
		await expect(remote.startOmpUpdate()).resolves.toMatchObject({ phase: "updating" });
		expect(host.calls.map(({ method, params }) => ({ method, params }))).toEqual([
			{ method: "host.ompUpdate.get", params: {} },
			{ method: "host.ompUpdate.now", params: {} },
		]);
		const garbled = new RemoteMachine({
			request: fakeHost(() => ({ ...OMP_UPDATE_STATE, phase: "installing" })).request,
			device: "host-b",
			statsText,
		});
		await expect(garbled.ompUpdate()).rejects.toThrow();
	});
});

describe("LocalMachine", () => {
	it("asks for a stats server revive while one is possible, and says it stopped once none is", async () => {
		await expect(localMachine(0, "scheduled").fetchStats("/api/stats/overview")).resolves.toEqual({
			error: "local:stats.notReady",
			unavailable: true,
			stopped: false,
		});
		await expect(localMachine(0, "exhausted").fetchStats("/api/stats/overview")).resolves.toEqual({
			error: "local:stats.notRunning",
			unavailable: false,
			stopped: true,
		});
	});

	it("reads a running stats server and reports a failed request as a failure, not a boot", async () => {
		const fetch = vi.fn(async (path: string, params?: Record<string, string>) => ({ path, params }));
		await expect(
			localMachine(4321, "scheduled", fetch).fetchStats("/api/stats/costs", { range: "7d" }),
		).resolves.toEqual({ path: "/api/stats/costs", params: { range: "7d" } });
		const failing = vi.fn(async () => {
			throw codedError("stats_api_error", "Stats API error: 500");
		});
		const reply = await localMachine(4321, "scheduled", failing).fetchStats("/api/stats/costs");
		expect(reply).toMatchObject({ error: expect.stringContaining("Stats API error: 500"), unavailable: false });
		expect(ipcErrorCode(reply)).toBe("stats_api_error");
	});

	it("needs a workspace and a usable omp to benchmark", async () => {
		const machine = localMachine(0);
		await expect(machine.runBenchmark("window:1", OPTIONS, null)).resolves.toEqual({
			success: false,
			error: "No active workspace",
			code: "no_workspace",
		});
		await expect(machine.runBenchmark("window:1", OPTIONS, "/tmp")).resolves.toEqual({
			success: false,
			error: "omp missing",
		});
		await expect(machine.abortBenchmark("window:1")).resolves.toBe(false);
	});

	it("reads the account-rotation pref as quota unless it is a known mode, and stores and pushes a change", async () => {
		for (const stored of [undefined, "round-robin", 3]) {
			await expect(
				localMachine(0, "scheduled", undefined, rotationPrefs(stored).deps).accountRotation(),
			).resolves.toEqual({ mode: "quota", evenSupported: true });
		}
		const prefs = rotationPrefs("quota", null);
		const machine = localMachine(0, "scheduled", undefined, prefs.deps);
		await expect(machine.setAccountRotation("even")).resolves.toEqual({ mode: "even", evenSupported: null });
		expect(prefs.writes).toEqual(["even"]);
		// What a renderer could send over IPC: the type says nothing about it.
		const bad = "round-robin" as AccountRotationMode;
		await expect(machine.setAccountRotation(bad)).rejects.toThrow(/Invalid account rotation/);
		expect(prefs.writes).toEqual(["even"]);
	});

	it("starts the host's own OmpUpdater in the background and answers with its state at that moment", async () => {
		const updater = fakeUpdater();
		const machine = localMachine(0, "scheduled", undefined, rotationPrefs().deps, updater);
		await expect(machine.ompUpdate()).resolves.toMatchObject({ phase: "idle" });
		expect(updater.updateNow).not.toHaveBeenCalled();

		const started = await machine.startOmpUpdate();
		expect(updater.updateNow).toHaveBeenCalledTimes(1);
		expect(started.phase).toBe("checking");
		// The run keeps going after the reply: nothing waits for it.
		updater.finish();
	});

	it("does not reject the device's request when the host's update run fails", async () => {
		const updater = fakeUpdater();
		updater.updateNow.mockRejectedValueOnce(new Error("boom"));
		const machine = localMachine(0, "scheduled", undefined, rotationPrefs().deps, updater);
		await expect(machine.startOmpUpdate()).resolves.toMatchObject({ phase: "idle" });
	});
});
