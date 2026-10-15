/**
 * Machine-scoped services behind Settings, Usage and Stats: the agent's
 * models.yml custom providers, the omp-stats dashboard, `omp bench`, the
 * model setup research run and the account-rotation pref. Each computer
 * serves its own. `LocalMachine` is this computer's — for its own windows
 * (ipc.ts) and for the devices paired with it (host-services.ts `host.*`
 * calls) — and `RemoteMachine` asks a paired host for its own. ipc.ts picks
 * one per call with `machineFor(device)`, `device` being the paired host the
 * caller's focused tab runs on (absent = this computer).
 */
import {
	type AccountRotationMode,
	type AccountRotationState,
	isAccountRotationMode,
	parseAccountRotationPref,
} from "../shared/account-rotation";
import type { BuiltinReaState } from "../shared/builtin-mcp";
import { codedError, type IpcErrorCode, ipcErrorCode } from "../shared/ipc-error-codes";
import type {
	CustomProviderInput,
	CustomProvidersConfig,
	HostDesktopState,
	HostUpdateAction,
	IpcBenchmarkRunOptions,
	IpcBenchmarkRunResult,
	IpcModelSetupRunResult,
	ModelOverrideInput,
	UpdateStatus,
} from "../shared/ipc-types";
import { MODEL_SETUP_TIMEOUT_MS, type ModelSetupRequest, type ModelSetupStatus } from "../shared/model-setup";
import { BENCHMARK_TIMEOUT_MS, BenchmarkRunner } from "./benchmark-runner";
import { builtinReaState } from "./builtin-mcp";
import { ModelSetupRunner } from "./model-setup-runner";
import { deleteModelsProvider, listModelsProviders, setModelOverride, upsertModelsProvider } from "./models-config";
import { modelsConfigMetadata } from "./models-config-stock";
import type { OmpResolution } from "./omp-runtime";
import {
	AccountRotationStateSchema,
	BuiltinReaStateSchema,
	HOST_STATS_TIMEOUT_MS,
	HostDesktopStateSchema,
	LINK_SLACK_MS,
	ModelSetupStatusSchema,
} from "./remote/app-protocol";
import type { StatsClient } from "./stats-client";
import type { Revive } from "./stats-restart-policy";

export interface MachineServices {
	listProviders(): Promise<CustomProvidersConfig>;
	upsertProvider(input: CustomProviderInput): Promise<void>;
	deleteProvider(id: string): Promise<void>;
	/** Write (or with `null`, remove) one model's models.yml `modelOverrides` entry (B43). */
	setModelOverride(provider: string, modelId: string, override: ModelOverrideInput | null): Promise<void>;
	/** A stats API read; failures resolve as `{error, unavailable, stopped?}` (never reject). */
	fetchStats(path: string, params?: Record<string, string>): Promise<unknown>;
	/**
	 * One `omp bench` per `caller` (a window here, a paired device on a host)
	 * at a time. `cwd` null: no workspace on that machine.
	 */
	runBenchmark(caller: string, options: IpcBenchmarkRunOptions, cwd: string | null): Promise<IpcBenchmarkRunResult>;
	abortBenchmark(caller: string): Promise<boolean>;
	/** One model setup research run per `caller`; the request is validated where it runs. */
	runModelSetup(caller: string, request: ModelSetupRequest): Promise<IpcModelSetupRunResult>;
	/** Whether `caller`'s research runs, since when, and its latest tool call (polled for progress). */
	modelSetupStatus(caller: string): Promise<ModelSetupStatus>;
	abortModelSetup(caller: string): Promise<boolean>;
	/** prefs `accountRotation` of this machine, and whether its omp can rotate evenly. */
	accountRotation(): Promise<AccountRotationState>;
	/** Store the mode; every session this machine runs follows from its next prompt. */
	setAccountRotation(mode: AccountRotationMode): Promise<AccountRotationState>;
	builtinRea(): Promise<BuiltinReaState>;
	setBuiltinRea(enabled: boolean): Promise<BuiltinReaState>;
	/** OMPdesk on that machine: version, updater state, theme and UI language. */
	desktop(): Promise<HostDesktopState>;
	/** Drive that machine's updater; `install` restarts it into the downloaded update. */
	desktopUpdate(action: HostUpdateAction): Promise<HostDesktopState>;
}

/** The stats server's down-state texts, in this computer's UI language. */
export type StatsText = (key: "stats.notRunning" | "stats.notReady") => string;

/** A stats reply saying the server is not answering; `stopped` = no revive left. */
export interface StatsUnavailable {
	error: string;
	unavailable: boolean;
	stopped: boolean;
}

function statsUnavailable(stopped: boolean, text: StatsText): StatsUnavailable {
	return {
		error: text(stopped ? "stats.notRunning" : "stats.notReady"),
		unavailable: !stopped,
		// Dead for good (no revive left): the renderer shows a calm page-level state, not this text.
		stopped,
	};
}

function isStatsUnavailable(value: unknown): value is { unavailable: boolean; stopped?: boolean } {
	if (typeof value !== "object" || value === null) return false;
	const reply = value as { unavailable?: unknown; stopped?: unknown };
	return reply.unavailable === true || reply.stopped === true;
}

function failure(error: unknown): { error: string; unavailable: false; code?: IpcErrorCode } {
	const code = ipcErrorCode(error);
	return {
		error: error instanceof Error ? error.message : String(error),
		unavailable: false,
		...(code ? { code } : {}),
	};
}

export interface LocalMachineDeps {
	stats: Pick<StatsClient, "port" | "fetch">;
	/** Demand-driven revive for the bundled stats server (no server → "exhausted"). */
	statsRestart: () => Revive;
	statsText: StatsText;
	/** The system omp `omp bench` and the model setup research run. */
	benchmarkOmp: () => Promise<OmpResolution>;
	benchmarkEnv: () => Promise<NodeJS.ProcessEnv>;
	accountRotation: AccountRotationDeps;
	builtinRea: { read(): unknown; write(enabled: boolean): void };
	desktop: DesktopDeps;
}

export interface AccountRotationDeps {
	/** The stored prefs `accountRotation`, unparsed. */
	read(): unknown;
	/** Store the pref and push it to every live omp this machine runs (its own tabs and the ones it hosts). */
	write(mode: AccountRotationMode): void;
	/** The gui-bridge `accountRotation` probe for this machine's omp; null before one has answered. */
	evenSupported(): Promise<boolean | null>;
}

/** This computer's OMPdesk, for paired devices (updater.ts, prefs). */
export interface DesktopDeps {
	version(): string;
	update: {
		status(): UpdateStatus;
		check(): Promise<UpdateStatus>;
		download(): Promise<UpdateStatus>;
		restartable(): boolean;
		restart(): void;
	};
	/** prefs `themeName` and `language`, unparsed. */
	appearance(): { themeName: unknown; language: unknown };
	/** Something would stop if OMPdesk quit now: a turn on this computer's tabs or a device's. */
	busy(): boolean;
}

/** A host's check or download (the updater's own release lookup or transfer start). */
export const DESKTOP_UPDATE_TIMEOUT_MS = 90_000;
/** The reply to an install leaves before the host starts quitting. */
const INSTALL_DELAY_MS = 500;

export class LocalMachine implements MachineServices {
	readonly #deps: LocalMachineDeps;
	readonly #benchmarks = new Map<string, BenchmarkRunner>();
	readonly #modelSetups = new Map<string, ModelSetupRunner>();

	constructor(deps: LocalMachineDeps) {
		this.#deps = deps;
	}

	async listProviders(): Promise<CustomProvidersConfig> {
		const [providers, options] = await Promise.all([listModelsProviders(), modelsConfigMetadata()]);
		return { providers, options };
	}

	async upsertProvider(input: CustomProviderInput): Promise<void> {
		await upsertModelsProvider(input);
	}

	async setModelOverride(provider: string, modelId: string, override: ModelOverrideInput | null): Promise<void> {
		await setModelOverride(provider, modelId, override);
	}

	async deleteProvider(id: string): Promise<void> {
		await deleteModelsProvider(id);
	}

	async fetchStats(path: string, params?: Record<string, string>): Promise<unknown> {
		if (typeof path !== "string") throw codedError("invalid_stats_path", "Invalid stats path");
		if (!this.#deps.stats.port) {
			// Nothing is listening: ask for it and let the caller keep waiting — but
			// only while a revive is actually possible, so a permanently dead stats
			// server ends in an error instead of an endless "loading".
			return statsUnavailable(this.#deps.statsRestart() === "exhausted", this.#deps.statsText);
		}
		try {
			return await this.#deps.stats.fetch(path, params);
		} catch (err) {
			// A request that reached the server and failed is a failure, not a
			// booting server: the dashboard must show it, not retry for a budget.
			return failure(err);
		}
	}

	async runBenchmark(
		caller: string,
		options: IpcBenchmarkRunOptions,
		cwd: string | null,
	): Promise<IpcBenchmarkRunResult> {
		if (!cwd) return { success: false, error: "No active workspace", code: "no_workspace" };
		const resolution = await this.#deps.benchmarkOmp();
		if (!resolution.ok) return { success: false, error: resolution.error };
		const runner = this.#benchmarks.get(caller) ?? new BenchmarkRunner();
		this.#benchmarks.set(caller, runner);
		try {
			return await runner.run(resolution.runtime.bin, cwd, options, await this.#deps.benchmarkEnv());
		} finally {
			if (!runner.running && this.#benchmarks.get(caller) === runner) this.#benchmarks.delete(caller);
		}
	}

	async abortBenchmark(caller: string): Promise<boolean> {
		const runner = this.#benchmarks.get(caller);
		if (!runner) return false;
		const aborted = runner.abort();
		if (!runner.running) this.#benchmarks.delete(caller);
		return aborted;
	}

	async runModelSetup(caller: string, request: ModelSetupRequest): Promise<IpcModelSetupRunResult> {
		const resolution = await this.#deps.benchmarkOmp();
		if (!resolution.ok) return { success: false, error: resolution.error };
		const runner = this.#modelSetups.get(caller) ?? new ModelSetupRunner();
		this.#modelSetups.set(caller, runner);
		try {
			return await runner.run(resolution.runtime.bin, request, await this.#deps.benchmarkEnv());
		} finally {
			if (!runner.running && this.#modelSetups.get(caller) === runner) this.#modelSetups.delete(caller);
		}
	}

	async modelSetupStatus(caller: string): Promise<ModelSetupStatus> {
		return this.#modelSetups.get(caller)?.status() ?? { running: false };
	}

	async abortModelSetup(caller: string): Promise<boolean> {
		const runner = this.#modelSetups.get(caller);
		if (!runner) return false;
		const aborted = runner.abort();
		if (!runner.running) this.#modelSetups.delete(caller);
		return aborted;
	}

	async accountRotation(): Promise<AccountRotationState> {
		const { read, evenSupported } = this.#deps.accountRotation;
		return { mode: parseAccountRotationPref(read()), evenSupported: await evenSupported() };
	}

	async setAccountRotation(mode: AccountRotationMode): Promise<AccountRotationState> {
		if (!isAccountRotationMode(mode)) throw codedError("invalid_preference_key", "Invalid account rotation");
		this.#deps.accountRotation.write(mode);
		return this.accountRotation();
	}

	async builtinRea(): Promise<BuiltinReaState> {
		return builtinReaState(this.#deps.builtinRea.read());
	}

	async setBuiltinRea(enabled: boolean): Promise<BuiltinReaState> {
		if (typeof enabled !== "boolean") throw codedError("invalid_preference_key", "Invalid built-in REA preference");
		this.#deps.builtinRea.write(enabled);
		return this.builtinRea();
	}

	async desktop(): Promise<HostDesktopState> {
		const { version, update, appearance } = this.#deps.desktop;
		const { themeName, language } = appearance();
		return {
			version: version(),
			update: update.status(),
			appearance: {
				themeName: typeof themeName === "string" ? themeName : null,
				language: typeof language === "string" ? language : null,
			},
		};
	}

	/**
	 * A paired device drives this computer's updater. Install restarts OMPdesk
	 * here without a dialog nobody at the device could answer, so it refuses
	 * while anything runs (this computer's tabs or any device's) and when the
	 * update needs someone at this computer (the macOS manual DMG).
	 */
	async desktopUpdate(action: HostUpdateAction): Promise<HostDesktopState> {
		const { update, busy } = this.#deps.desktop;
		if (action === "check") await update.check();
		else if (action === "download") await update.download();
		else if (action === "install") {
			if (!update.restartable())
				throw codedError("update_not_ready", "No update is ready to install on this computer");
			if (busy()) throw codedError("host_busy", "Work is running on this computer");
			// Answer first: the restart closes the device's link.
			setTimeout(update.restart, INSTALL_DELAY_MS);
		} else throw codedError("invalid_preference_key", "Invalid update action");
		return this.desktop();
	}
}

/** One host-level call on a paired host (RemoteDevices.request). */
export type HostRequest = <T>(device: string, method: string, params: unknown, timeoutMs?: number) => Promise<T>;

export interface RemoteMachineOptions {
	request: HostRequest;
	device: string;
	statsText: StatsText;
	/** The caller's tab on that host: its cwd roots a benchmark there. */
	tab?: { rtab: string; cwd: string };
}

/**
 * A paired host's machine services. The host validates every call and scopes
 * the benchmark to this device; a stats down-state is re-worded in this
 * computer's language.
 */
export class RemoteMachine implements MachineServices {
	readonly #options: RemoteMachineOptions;

	constructor(options: RemoteMachineOptions) {
		this.#options = options;
	}

	#request<T>(method: string, params: object, timeoutMs?: number): Promise<T> {
		return this.#options.request<T>(this.#options.device, method, params, timeoutMs);
	}

	listProviders(): Promise<CustomProvidersConfig> {
		return this.#request("host.models.list", {});
	}

	async upsertProvider(input: CustomProviderInput): Promise<void> {
		await this.#request("host.models.upsert", { input });
	}

	async deleteProvider(id: string): Promise<void> {
		await this.#request("host.models.delete", { id });
	}

	async setModelOverride(provider: string, modelId: string, override: ModelOverrideInput | null): Promise<void> {
		await this.#request("host.models.override", { provider, modelId, override });
	}

	async fetchStats(path: string, params?: Record<string, string>): Promise<unknown> {
		try {
			const reply = await this.#request<unknown>(
				"host.stats.fetch",
				params ? { path, params } : { path },
				HOST_STATS_TIMEOUT_MS,
			);
			return isStatsUnavailable(reply) ? statsUnavailable(reply.stopped === true, this.#options.statsText) : reply;
		} catch (err) {
			return failure(err);
		}
	}

	runBenchmark(_caller: string, options: IpcBenchmarkRunOptions): Promise<IpcBenchmarkRunResult> {
		const { tab } = this.#options;
		return this.#request(
			"host.bench.run",
			tab ? { options, rtab: tab.rtab, cwd: tab.cwd } : { options },
			BENCHMARK_TIMEOUT_MS + LINK_SLACK_MS,
		);
	}

	abortBenchmark(): Promise<boolean> {
		return this.#request("host.bench.abort", {});
	}

	runModelSetup(_caller: string, request: ModelSetupRequest): Promise<IpcModelSetupRunResult> {
		return this.#request("host.modelSetup.run", { request }, MODEL_SETUP_TIMEOUT_MS + LINK_SLACK_MS);
	}

	async modelSetupStatus(): Promise<ModelSetupStatus> {
		return ModelSetupStatusSchema.parse(await this.#request<unknown>("host.modelSetup.status", {}));
	}

	abortModelSetup(): Promise<boolean> {
		return this.#request("host.modelSetup.abort", {});
	}

	async accountRotation(): Promise<AccountRotationState> {
		return AccountRotationStateSchema.parse(await this.#request<unknown>("host.accountRotation.get", {}));
	}

	async setAccountRotation(mode: AccountRotationMode): Promise<AccountRotationState> {
		return AccountRotationStateSchema.parse(await this.#request<unknown>("host.accountRotation.set", { mode }));
	}

	async builtinRea(): Promise<BuiltinReaState> {
		return BuiltinReaStateSchema.parse(await this.#request<unknown>("host.builtinRea.get", {}));
	}

	async setBuiltinRea(enabled: boolean): Promise<BuiltinReaState> {
		return BuiltinReaStateSchema.parse(await this.#request<unknown>("host.builtinRea.set", { enabled }));
	}

	async desktop(): Promise<HostDesktopState> {
		return HostDesktopStateSchema.parse(await this.#request<unknown>("host.desktop.get", {}));
	}

	async desktopUpdate(action: HostUpdateAction): Promise<HostDesktopState> {
		// A check or download answers once the host's updater has; give it the link's slack on top.
		return HostDesktopStateSchema.parse(
			await this.#request<unknown>("host.desktop.update", { action }, DESKTOP_UPDATE_TIMEOUT_MS + LINK_SLACK_MS),
		);
	}
}

/** The machine a call acts on: this computer, or the paired host `device` names. */
export function machineFor(
	device: string | undefined,
	local: MachineServices,
	remote: Omit<RemoteMachineOptions, "device">,
): MachineServices {
	return device ? new RemoteMachine({ ...remote, device }) : local;
}
