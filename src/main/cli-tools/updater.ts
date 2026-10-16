/**
 * Keeps the vendor CLIs of connected accounts current (contract: src/shared/cli-update.ts). At launch (after
 * machine setup's first pass) and every 4 h, with a longer wait per tool after failures in a row (omp's
 * schedule, `nextCheckDelay`), it lists the providers with a stored credential (stock's own credential store,
 * through the stock helper), finds each relevant tool that is installed, asks its owner for the newest
 * version and, when that is newer, runs the owner's update under the setup supervisor
 * (`SetupService.runToolUpdate`, queued behind any install), then detects the tool again. A tool that is not
 * installed is never installed here; a system, app-bundled or admin-owned copy is listed with the reason it
 * is left alone. On macOS an update that would replace a running Node CLI's package dir waits for the next
 * check instead (plans.ts `waitsForIdle`); on Windows a file a running tool holds simply fails the update,
 * which is recorded and retried later. Each computer runs its own; a paired host keeps its own tools.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLI_TOOLS,
	type CliToolId,
	type CliToolState,
	type CliUpdateFailure,
	type CliUpdateResult,
	type CliUpdateState,
	isCliToolId,
} from "../../shared/cli-update";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { isNewer } from "../../shared/version";
import { parseOmpVersion } from "../omp-runtime";
import { CHECK_INTERVAL_MS, nextCheckDelay } from "../omp-updater";
import type { SpawnSpec } from "../setup/plans";
import type { ToolUpdateOutcome, ToolUpdateRequest } from "../setup/service";
import { needsShell, spawnArgs, spawnCommand } from "../spawn";
import { relevantTools } from "./catalog";
import {
	type CliDetection,
	type CliPlatform,
	type DetectDeps,
	detectCliTool,
	findBrew,
	type InstallContext,
} from "./detect";
import { type CliCommand, checkCommand, parseLatest, runningIn, updateCommand, waitsForIdle } from "./plans";

const CHECK_TIMEOUT_MS = 120_000;

export interface CliUpdaterDeps {
	/** This launch checks on a timer: a packaged app, or a test launch that opts in. */
	scheduled: boolean;
	/** The pref `cliAutoUpdate` (default on). */
	enabled: () => boolean;
	platform: CliPlatform;
	toolsDir: string;
	/** Stock provider ids with a stored credential; a failure lists none (machine-setup tools still count). */
	connectedProviders: () => Promise<string[]>;
	/** The spawn environment (login-shell PATH, proxies); its PATH is where tools are looked up. */
	env: () => Promise<NodeJS.ProcessEnv>;
	/** `OMP_GUI_TEST_INSTALLER`: checks run `<installer> cli-<tool> <method> check` (it prints the newest version). */
	testInstaller: string | null;
	/** The newest release of machine setup's archive for gh or Node. */
	managedLatest: (item: "gh" | "node") => Promise<string>;
	runUpdate: (request: ToolUpdateRequest) => Promise<ToolUpdateOutcome>;
	/** Command lines of the running processes (`ps`); macOS only. */
	processes: () => Promise<string>;
	onState: (state: CliUpdateState) => void;
	now?: () => number;
	/** Test seams. */
	detect?: (id: CliToolId, deps: DetectDeps) => Promise<CliDetection | null>;
	runCheck?: (command: CliCommand, env: NodeJS.ProcessEnv) => Promise<string>;
}

interface ToolRecord {
	state: CliToolState;
	detection: CliDetection;
	failures: number;
	/** No scheduled check before this (ms since the epoch). */
	nextAt: number;
}

/** stdout of a short read-only check, or throws with its own reason. */
export async function runCheckProcess(command: CliCommand, env: NodeJS.ProcessEnv): Promise<string> {
	const cwd = command.packageDir ? await mkdtemp(join(tmpdir(), "ompdesk-cli-check-")) : undefined;
	try {
		if (cwd) await writeFile(join(cwd, "package.json"), "{}\n");
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		execFile(
			command.spawn.file,
			command.spawn.args,
			{
				env: { ...env, ...command.env },
				cwd,
				shell: command.spawn.shell,
				timeout: CHECK_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				// `brew outdated` exits 1 when it lists something; its JSON is the answer either way.
				if (error && !stdout.trim())
					reject(new Error((stderr || error.message).trim().split(/\r?\n/).at(-1) ?? error.message));
				else resolve(stdout);
			},
		);
		return await promise;
	} finally {
		if (cwd) await rm(cwd, { recursive: true, force: true });
	}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class CliUpdater {
	readonly #deps: CliUpdaterDeps;
	readonly #tools = new Map<CliToolId, ToolRecord>();
	#timer: NodeJS.Timeout | null = null;
	#running: Promise<void> | null = null;
	#started = false;
	#disposed = false;

	constructor(deps: CliUpdaterDeps) {
		this.#deps = deps;
	}

	state(): CliUpdateState {
		return {
			enabled: this.#deps.enabled(),
			scheduled: this.#deps.scheduled,
			tools: CLI_TOOLS.flatMap(id => {
				const record = this.#tools.get(id);
				return record ? [{ ...record.state }] : [];
			}),
		};
	}

	/** Machine setup finished its first pass: list the tools, and when this launch schedules, check now and on the timer. */
	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		if (this.#deps.scheduled) void this.#cycle();
		else void this.#queue(() => this.#refresh());
	}

	/** The pref changed: turning it on checks right away. */
	prefChanged(): void {
		this.#emit();
		if (this.#started && this.#deps.scheduled && this.#deps.enabled()) void this.#queue(() => this.#pass(null, true));
	}

	/** Settings › Update now: check (and update) `id`, or every listed tool, whatever the pref and back-off say. */
	updateNow(id?: CliToolId): Promise<void> {
		return this.#queue(() => this.#pass(id ?? null, false));
	}

	/** List the relevant installed tools again without checking or updating (a provider connected, a tool installed). */
	rescan(): Promise<void> {
		return this.#queue(() => this.#refresh());
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
	}

	#queue(work: () => Promise<unknown>): Promise<void> {
		const next = (this.#running ?? Promise.resolve()).then(async () => {
			if (!this.#disposed) await work();
		});
		const settled = next.catch(() => undefined);
		this.#running = settled;
		void settled.then(() => {
			if (this.#running === settled) this.#running = null;
		});
		return next;
	}

	async #cycle(): Promise<void> {
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
		try {
			await this.#queue(() => (this.#deps.enabled() ? this.#pass(null, true) : this.#refresh()));
		} catch {
			// A throw from a dependency must not end the schedule.
		} finally {
			if (!this.#disposed) this.#timer = setTimeout(() => void this.#cycle(), CHECK_INTERVAL_MS);
		}
	}

	#emit(): void {
		if (!this.#disposed) this.#deps.onState(this.state());
	}

	#set(record: ToolRecord, patch: Partial<CliToolState>): void {
		record.state = { ...record.state, ...patch };
		this.#emit();
	}

	async #detectDeps(): Promise<DetectDeps> {
		const env = await this.#deps.env();
		const pathEnv = env.PATH ?? "";
		const ctx: InstallContext = {
			platform: this.#deps.platform,
			toolsDir: this.#deps.toolsDir,
			brew: findBrew(pathEnv, this.#deps.platform),
		};
		return { pathEnv, env, ctx };
	}

	/** List the relevant installed tools again (a provider connected or left, a tool installed or removed). */
	async #refresh(): Promise<DetectDeps> {
		const deps = await this.#detectDeps();
		const providers = await this.#deps.connectedProviders().catch(() => []);
		const relevant = relevantTools(providers, CLI_TOOLS);
		const detect = this.#deps.detect ?? detectCliTool;
		const found = await Promise.all(
			[...relevant].map(async ([id, using]) => [id, using, await detect(id, deps).catch(() => null)] as const),
		);
		for (const id of CLI_TOOLS) if (!relevant.has(id)) this.#tools.delete(id);
		for (const [id, using, detection] of found) {
			if (!detection) {
				this.#tools.delete(id);
				continue;
			}
			const record = this.#tools.get(id);
			const fields = {
				providers: using,
				installed: detection.installed,
				path: detection.real,
				method: detection.owner?.method ?? null,
				skip: detection.skip,
			};
			if (record) {
				record.detection = detection;
				record.state = { ...record.state, ...fields };
			} else {
				this.#tools.set(id, {
					detection,
					failures: 0,
					nextAt: 0,
					state: { id, ...fields, phase: "idle", latest: null, checkedAt: null, last: null },
				});
			}
		}
		this.#emit();
		return deps;
	}

	async #pass(only: CliToolId | null, scheduled: boolean): Promise<void> {
		const deps = await this.#refresh();
		const now = (this.#deps.now ?? Date.now)();
		for (const id of CLI_TOOLS) {
			if (this.#disposed) return;
			if (only && id !== only) continue;
			const record = this.#tools.get(id);
			if (!record || record.detection.skip || !record.detection.owner) continue;
			if (scheduled && now < record.nextAt) continue;
			await this.#check(record, deps);
		}
	}

	#finish(record: ToolRecord, last: CliUpdateResult): void {
		const now = (this.#deps.now ?? Date.now)();
		const failed = last.kind === "failed" && last.failure.reason !== "cancelled";
		record.failures = failed ? record.failures + 1 : 0;
		record.nextAt = failed ? now + nextCheckDelay(record.failures) : 0;
		this.#set(record, { phase: "idle", last });
	}

	#fail(record: ToolRecord, failure: CliUpdateFailure): void {
		this.#finish(record, { kind: "failed", failure });
	}

	async #check(record: ToolRecord, deps: DetectDeps): Promise<void> {
		const { detection } = record;
		const owner = detection.owner;
		if (!owner) return;
		const installer = this.#deps.testInstaller;
		this.#set(record, { phase: "checking" });
		let latest: string | null;
		try {
			if (installer) {
				const output = await (this.#deps.runCheck ?? runCheckProcess)(
					this.#installerCheck(installer, record),
					deps.env,
				);
				latest = parseOmpVersion(output) ?? detection.installed;
			} else if (owner.method === "managed") {
				latest = parseOmpVersion(await this.#deps.managedLatest(owner.item));
			} else {
				const check = checkCommand(detection, owner, { platform: deps.ctx.platform, pathEnv: deps.pathEnv });
				latest = check
					? parseLatest(
							owner,
							await (this.#deps.runCheck ?? runCheckProcess)(check, deps.env),
							detection.installed,
						)
					: null;
			}
		} catch (error) {
			this.#fail(record, { reason: "check", detail: message(error) });
			return;
		}
		this.#set(record, { latest, checkedAt: (this.#deps.now ?? Date.now)() });
		const installed = detection.installed;
		if (latest && installed && !isNewer(latest, installed)) {
			this.#finish(record, { kind: "current" });
			return;
		}
		if (this.#deps.platform === "darwin" && waitsForIdle(detection, owner)) {
			const commands = await this.#deps.processes().catch(() => "");
			if (runningIn(commands, detection, owner)) {
				this.#finish(record, { kind: "deferred", latest: latest ?? "" });
				return;
			}
		}
		let request: ToolUpdateRequest;
		if (owner.method === "managed") {
			request = { tool: detection.id, method: owner.method, spawn: null, managed: owner.item, env: {} };
		} else {
			const update = updateCommand(detection, owner, latest, { platform: deps.ctx.platform, pathEnv: deps.pathEnv });
			if (!update && !installer) {
				this.#fail(record, { reason: "install", detail: `no ${owner.method} to run the update with` });
				return;
			}
			request = { tool: detection.id, method: owner.method, spawn: update?.spawn ?? null, env: update?.env ?? {} };
		}
		this.#set(record, { phase: "updating" });
		const outcome = await this.#deps.runUpdate(request);
		if (outcome.kind === "skipped") {
			this.#set(record, { phase: "idle" });
			return;
		}
		if (outcome.kind === "cancelled") {
			this.#fail(record, { reason: "cancelled" });
			return;
		}
		if (outcome.kind === "failed") {
			this.#fail(record, { reason: "install", ...(outcome.detail ? { detail: outcome.detail } : {}) });
			return;
		}
		const after = await (this.#deps.detect ?? detectCliTool)(detection.id, deps).catch(() => null);
		const now = after?.installed ?? null;
		if (after) {
			record.detection = after;
			this.#set(record, { installed: now, path: after.real });
		}
		const moved = now !== null && isNewer(now, installed);
		if (moved && (!latest || !isNewer(latest, now))) {
			this.#finish(record, { kind: "updated", from: installed, to: now });
			return;
		}
		// The tool's own updater checks by itself: a clean run that changed nothing means it was current.
		if (!latest && !moved) {
			this.#finish(record, { kind: "current" });
			return;
		}
		this.#fail(record, { reason: "not-updated" });
	}

	#installerCheck(installer: string, record: ToolRecord): CliCommand {
		const platform = this.#deps.platform;
		const method = record.detection.owner?.method ?? "self";
		const spawn: SpawnSpec = {
			file: spawnCommand(installer, platform),
			args: spawnArgs(installer, [`cli-${record.state.id}`, method, "check"], platform),
			shell: needsShell(installer, platform),
		};
		return { spawn, env: {} };
	}
}

/** `ps` command lines of every process (macOS), for the in-use check. */
export function psCommands(): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	execFile("/bin/ps", ["-axww", "-o", "command="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
		resolve(error ? "" : stdout),
	);
	return promise;
}

/** IPC: a snapshot and "Update now" by tool id (or all). No handler takes a version, a command or a path. */
export interface CliUpdateIpcTarget {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export function registerCliUpdateIpc(
	ipc: CliUpdateIpcTarget,
	updater: Pick<CliUpdater, "state" | "updateNow" | "rescan">,
): void {
	ipc.handle(IPC_COMMANDS.CLI_UPDATE_GET_STATE, () => {
		// Settings opened: look for tools a provider connection or an install added since; the answer arrives as a push.
		void updater.rescan().catch(() => undefined);
		return updater.state();
	});
	ipc.handle(IPC_COMMANDS.CLI_UPDATE_NOW, (_event, id) => {
		if (id !== undefined && id !== null && !isCliToolId(id)) throw new Error(`Unknown tool: ${String(id)}`);
		// Runs in the background; progress arrives as CLI_UPDATE_STATE pushes.
		void updater.updateNow(id ?? undefined).catch(() => undefined);
	});
}
