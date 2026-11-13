/**
 * ai-memory as OMPdesk's memory: stage the shipped binary, keep its per-user service running and give the omp sessions
 * OMPdesk spawns an app-owned extension root. Memory and learning are always on (the user's decision of 29 Oct 2026):
 * there is no off switch, and only OMPdesk's own build ever runs, as OMPdesk's own service.
 *
 * This is the typed client of the core's memory service (`native/ompdesk/crates/core/src/aimemory/service`), which
 * runs the passes (stage, `setup`, the generated extension root, the service unit, the health poll and its heal, the
 * retries, purge, the terminal omp's wiring, the suppression overlay and the recall file). What stays here is what
 * only main has:
 * - a copy of the state, written from the core's `aimemory.service.state` events alone, for the readers that cannot
 *   wait (`state()`);
 * - what the core asks for (`aimemory.service.ask`): every `ai-memory` command, run by `SetupRunner` under the setup
 *   supervisor (`setup --yes` isolated: the service host outlives OMPdesk and must hold no handle of it), the prefs,
 *   omp's agent dir, Bun, the first tab, the environment, the configs' `disabledExtensions` (main's YAML reader), and
 *   the test seams for the OS service and the macOS signature;
 * - the runtime log (`gui-runtime.jsonl` has one writer) and the reads Settings makes through `AiMemoryClient`.
 *
 * Steps the core queues (a retry, a purge, a terminal change) are sent one after the other, so they queue in the order
 * they were asked here. A core that ended took the service with it; the next core opens it again and, once memory had
 * started, runs the launch pass again (every command of it is idempotent).
 */
import { readFile, rm } from "node:fs/promises";
import { parse } from "yaml";
import { MEMORY_HUB_ENTRY } from "../../../resources/gui-bridge/mcp-hub-contracts";
import {
	AI_MEMORY_BINARIES,
	AI_MEMORY_BUILD_MANIFEST,
	AI_MEMORY_VERSION,
	type AiMemoryDeleted,
	type AiMemoryFeedback,
	type AiMemoryHandoff,
	type AiMemoryLintFinding,
	type AiMemoryObservations,
	type AiMemoryOverview,
	type AiMemoryPage,
	type AiMemoryPageRef,
	type AiMemoryProfile,
	type AiMemoryProject,
	type AiMemoryProjectRef,
	type AiMemorySession,
	type AiMemoryState,
	type AiMemorySweep,
	type AiMemoryWriteInput,
} from "../../shared/ai-memory";
import type { SetupPlatform } from "../../shared/setup";
import { CoreError, core } from "../core/process";
import { StepStalledError, writeStall } from "../serial-chain";
import { SetupRunner } from "../setup/runner";
import { needsShell, spawnArgs, spawnCommand } from "../spawn";
import { AiMemoryClient, DEFAULT_SERVER_URL } from "./client";
import { AI_MEMORY_REQUIREMENT, MAC_STAGE_KEY } from "./staging";

const POLL_MS = 60_000;
const HEALTH_WAIT_MS = 30_000;
/**
 * A failed wiring pass runs again by itself after each of these waits, then stays failed (Settings' Try again). The
 * service manager can refuse a moment (launchd's bootstrap right after a bootout of the draining old server), so one
 * refusal must not leave memory down until the next launch.
 */
const RETRY_DELAYS_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000];
const OUTPUT_TAIL = 16 * 1024;
/** The longest one queued step (stage, wire, a terminal wiring) runs; past it the step is stopped and the next starts. */
export const AI_MEMORY_STEP_MAX_MS = 30 * 60_000;
/** The request kept open on a step or the service: it fails when the core dies, which is how this side learns it. */
const HOLD_MS = 2 ** 31 - 1;
/** The chain's name in a stall's log line and error, as `SerialChain` named it. */
const CHAIN = "ai-memory";

/** The OS service ai-memory's `setup` installs, where main stands in for it (tests, the e2e's pid file). */
export interface ServiceControl {
	inspect(): Promise<{ installed: boolean; ours: boolean }>;
	/** Stop the server and remove the unit (it comes back with the next `setup`). */
	remove(): Promise<void>;
}

/**
 * Test seam (`OMP_GUI_AI_MEMORY_UNIT_PIDFILE`): the fake ai-memory of the e2e specs keeps its "service" as a detached
 * process whose pid is in a file. That file is the unit; the fake is OMPdesk's own by construction.
 */
export function pidFileControl(file: string): ServiceControl {
	return {
		async inspect() {
			const installed = (await readFile(file, "utf8").catch(() => "")).trim() !== "";
			return { installed, ours: installed };
		},
		async remove() {
			const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(pid);
				} catch {
					// already gone
				}
			}
			await rm(file, { force: true });
		},
	};
}

export interface AiMemoryServiceDeps {
	platform: SetupPlatform;
	arch: string;
	/** Packaged app (or a test with a binary): may change the machine. A dev build only reports. */
	automatic: boolean;
	toolsDir: string;
	/** The folder holding the shipped binary (`<resources>/ai-memory-bin`), null when the app has none. */
	bundledDir: string | null;
	/** Run exactly this binary instead of the shipped one (tests, a developer's own build). */
	binaryOverride?: string | null;
	/** Skip ai-memory's user service (`setup --no-service`); the caller then runs the server itself (tests). */
	noService?: boolean;
	home: string;
	/** omp's own agent dir: where the terminal omp's wiring would be (never written unless the user asks). */
	agentDir: () => string;
	/** OMPdesk's own extension root (`<userData>/ai-memory/omp-ext`), loaded with `-e` into the sessions it spawns. */
	rootDir: string;
	/**
	 * The file every omp OMPdesk spawns reads memory's address from (`OMP_GUI_MEMORY`, contract in
	 * resources/gui-bridge/modes/memory-recall-contracts.ts); the core writes it as the state moves. Absent: none.
	 */
	recallFile?: string;
	/** `AI_MEMORY_TERMINAL_PREF`: undefined until the user (or the one-time migration) decided. */
	terminalPref: () => boolean | undefined;
	persistTerminal: (enabled: boolean) => void;
	/** The OS service ai-memory's `setup` installs; absent: launchd on macOS, the logon entry on Windows (the core's). */
	unit?: ServiceControl;
	spawnEnv: () => Promise<NodeJS.ProcessEnv>;
	onState: (state: AiMemoryState) => void;
	/** Wait for something before the first wiring (the first tab boots before ai-memory competes with it). */
	beforeStart?: () => Promise<void>;
	/**
	 * Windows: `setup` runs isolated, which starts it through Bun (`setup/supervisor.ts isolatedLaunch`), and Bun is a
	 * machine-setup item a fresh machine may not have yet. Absent: nothing to wait for (macOS).
	 */
	bunPresent?: () => Promise<boolean>;
	/**
	 * One line of `<userData>/logs/gui-runtime.jsonl` (source `ai-memory`): `launch` once per start, `binary` when the
	 * binary in use is known, `phase` on every change of phase, step or detail, `failed` for each failure (the step it
	 * failed in, the message, the stack of an unexpected error).
	 */
	log?: (message: AiMemoryLogMessage, details: AiMemoryLogDetails) => void;
	/** macOS: the shipped binary's check against `AI_MEMORY_REQUIREMENT`; absent: the core runs codesign. Tests fake it. */
	codeRequirement?: (file: string) => Promise<string | null>;
	runner?: SetupRunner;
	pollMs?: number;
	healthWaitMs?: number;
	/** The waits before a failed wiring pass runs again by itself (`RETRY_DELAYS_MS`). */
	retryDelaysMs?: readonly number[];
	/**
	 * The clock, where a test owns it: the core then keeps no timer and reads no clock, every request says the time
	 * and every timer of the service runs here, so vitest's fake timers drive it. Absent: the core's own.
	 */
	now?: () => number;
}

export type AiMemoryLogMessage = "launch" | "binary" | "phase" | "failed" | "retry";
export type AiMemoryLogDetails = Record<string, string | number | boolean | null>;

/** `aimemory.service.ask`: what the core needs of main. */
type Ask = { ask: number } & (
	| { what: "agentDir" | "terminalPref" | "bunPresent" | "beforeStart" | "spawnEnv" }
	| { what: "persistTerminal"; enabled: boolean }
	| { what: "codeRequirement"; file: string }
	| { what: "unit"; op: "inspect" | "remove" }
	| { what: "disabledLists"; files: string[] }
	| { what: "run"; bin: string; args: string[]; env?: Record<string, string>; isolated: boolean }
);

/** `disabledExtensions` of one config file: null when the file is absent, unreadable or does not set it. */
async function disabledIn(file: string): Promise<string[] | null> {
	let parsed: unknown;
	try {
		parsed = parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || !("disabledExtensions" in parsed)) return null;
	const list = parsed.disabledExtensions;
	return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : null;
}

/** Names a service to the core; one counter for this process. */
let sequence = 0;

export class AiMemoryService {
	readonly #deps: AiMemoryServiceDeps;
	readonly #runner: SetupRunner;
	readonly #client: AiMemoryClient;
	readonly #name = `${process.pid}.${++sequence}`;
	/** The core's last word; replaced whole by each `aimemory.service.state`. */
	#state: AiMemoryState = {
		phase: "starting",
		step: "stage",
		version: null,
		binary: null,
		dataDir: null,
		serverUrl: null,
		webUrl: null,
		wiring: { app: false, terminal: false },
		stats: null,
		detail: null,
		unsupported: null,
	};
	#opened: Promise<void> | null = null;
	#unsubscribe: (() => void)[] = [];
	/** The queued steps' order: each is sent once the core said the one before it is queued. */
	#lane: Promise<unknown> = Promise.resolve();
	/** Main's timers of a service whose clock is main's, by the core's id. */
	readonly #timers = new Map<number, { handle: NodeJS.Timeout; repeat: boolean }>();
	/** The command the runner runs now, and the commands cancelled before they started. */
	#running: number | null = null;
	readonly #cancelled = new Set<number>();
	#started = false;
	#disposed = false;

	constructor(deps: AiMemoryServiceDeps) {
		this.#deps = deps;
		this.#runner = deps.runner ?? new SetupRunner();
		this.#client = new AiMemoryClient({
			url: () => this.#state.serverUrl ?? DEFAULT_SERVER_URL,
			dataDir: () => this.#state.dataDir,
		});
	}

	state(): AiMemoryState {
		return structuredClone(this.#state);
	}

	/**
	 * Detect, then (when on) stage and wire. Resolves when the first pass ended; never rejects: a failure is the
	 * `failed` phase (Settings shows it with Try again) and a `failed` log line.
	 */
	async start(): Promise<void> {
		this.#started = true;
		try {
			await this.#open();
			await this.#call("aimemory.service.start", {}, HOLD_MS);
		} catch (error) {
			if (!this.#disposed) console.error("[ai-memory] couldn't start in ompdesk-core:", error);
		}
	}

	/** Wire again after a failure (or an unreachable server). */
	retry(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		return this.#queued({ op: "retry" });
	}

	/**
	 * The machine setup reports Bun present (called on every such setup state). A wiring pass that stopped for want of
	 * Bun runs again, once; otherwise nothing happens.
	 */
	bunInstalled(): void {
		if (this.#disposed) return;
		void this.#open()
			.then(() => this.#call("aimemory.service.bunInstalled"))
			.catch(() => undefined);
	}

	/** Erase everything ai-memory remembers (wiki, database, raw events); wire it again afterwards. */
	purge(): Promise<void> {
		return this.#queued({ op: "purge" });
	}

	/**
	 * "Also use in the terminal omp": ai-memory's own `setup --agent omp` into omp's real agent dir, or (off) the removal
	 * of exactly that extension and MCP entry. Memory itself (phase, server) is not changed; a failure throws.
	 */
	setTerminal(enabled: boolean): Promise<void> {
		return this.#queued({ op: "terminal", enabled });
	}

	/** Stats and health, at most every few seconds; the Settings page calls it when it opens. */
	async refresh(): Promise<void> {
		if (this.#disposed) return;
		await this.#open();
		await this.#call("aimemory.service.refresh", {}, HOLD_MS).catch(error => {
			throw this.#refusal(error);
		});
	}

	/**
	 * What the omp sessions OMPdesk spawns (in `cwd`) load for memory: `-e <root>` while memory is on and the root is
	 * complete, and a `--config` overlay holding the agent dir's own ai-memory wiring disabled where there is some
	 * (the core's `extension_args`).
	 */
	async extensionArgs(cwd?: string): Promise<string[]> {
		if (this.#disposed) return [];
		try {
			await this.#open();
			return await this.#call<string[]>("aimemory.service.extensionArgs", { cwd: cwd ?? null });
		} catch (error) {
			const refused = this.#refusal(error);
			// A core that cannot answer holds no spawn: the session starts without memory's root.
			if (refused instanceof CoreError) return [];
			throw refused;
		}
	}

	async projects(): Promise<AiMemoryProject[]> {
		return this.#client.projects();
	}

	async search(query: string, project?: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return this.#client.search(query, project);
	}

	async recent(project?: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return project ? this.#client.recent(project) : this.#client.recentEverywhere();
	}

	async handoffs(project?: AiMemoryProjectRef): Promise<AiMemoryHandoff[]> {
		return this.#client.handoffs(project);
	}

	async readPage(ref: AiMemoryProjectRef & { path: string }): Promise<AiMemoryPage> {
		return this.#client.page(ref);
	}

	pages(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> {
		return this.#client.pages(project);
	}

	overview(project: AiMemoryProjectRef): Promise<AiMemoryOverview> {
		return this.#client.overview(project);
	}

	sessions(project: AiMemoryProjectRef): Promise<AiMemorySession[]> {
		return this.#client.sessions(project);
	}

	observations(project: AiMemoryProjectRef, sessionId: string, offset?: number): Promise<AiMemoryObservations> {
		return this.#client.observations(project, sessionId, offset);
	}

	profile(): Promise<AiMemoryProfile> {
		return this.#client.profile();
	}

	lint(project: AiMemoryProjectRef): Promise<AiMemoryLintFinding[]> {
		return this.#client.lint(project);
	}

	sweep(project: AiMemoryProjectRef, dryRun: boolean): Promise<AiMemorySweep> {
		return this.#client.sweep(project, dryRun);
	}

	writePage(input: AiMemoryWriteInput): Promise<void> {
		return this.#client.writePage(input);
	}

	deletePage(ref: AiMemoryProjectRef & { path: string; title?: string }): Promise<AiMemoryDeleted> {
		return this.#client.deletePage(ref);
	}

	restorePage(ref: AiMemoryProjectRef & { path: string }, rev: string): Promise<void> {
		return this.#client.restorePage(ref, rev);
	}

	feedback(ref: AiMemoryProjectRef & { path: string }, signal: AiMemoryFeedback): Promise<void> {
		return this.#client.feedback(ref, signal);
	}

	cancelHandoff(project: AiMemoryProjectRef, id: string): Promise<void> {
		return this.#client.cancelHandoff(project, id);
	}

	/** The /web console's password: the root token (any username works). */
	token(): Promise<string | null> {
		return this.#client.token();
	}

	dispose(): void {
		this.#disposed = true;
		for (const off of this.#unsubscribe) off();
		this.#unsubscribe = [];
		this.#clearTimers();
		this.#runner.cancel();
		if (this.#opened) void this.#call("aimemory.service.close").catch(() => undefined);
	}

	#clearTimer(id: number): void {
		const timer = this.#timers.get(id);
		if (timer?.repeat) clearInterval(timer.handle);
		else clearTimeout(timer?.handle);
		this.#timers.delete(id);
	}

	#clearTimers(): void {
		for (const id of [...this.#timers.keys()]) this.#clearTimer(id);
	}

	/** Opens the service in the core once; a core that cannot take it is asked again by the next call. */
	#open(): Promise<void> {
		this.#opened ??= this.#opening().catch(error => {
			this.#opened = null;
			throw error;
		});
		return this.#opened;
	}

	async #opening(): Promise<void> {
		const host = core();
		const mine =
			<T>(handle: (told: T, generation: number) => void) =>
			(data: unknown, _bin: Uint8Array | null, generation: number) => {
				// A frame of this app's own core, spelled by `aimemory/service/mod.rs`.
				const told = data as T & { service: string };
				if (told.service === this.#name && !this.#disposed) handle(told, generation);
			};
		if (this.#unsubscribe.length === 0) {
			this.#unsubscribe = [
				host.on(
					"aimemory.service.state",
					mine<{ state: AiMemoryState }>(({ state }) => {
						this.#state = state;
						this.#deps.onState(structuredClone(state));
					}),
				),
				host.on(
					"aimemory.service.log",
					mine<{ message: AiMemoryLogMessage; details: AiMemoryLogDetails }>(({ message, details }) =>
						this.#deps.log?.(message, details),
					),
				),
				host.on(
					"aimemory.service.stalled",
					mine(() => writeStall(new StepStalledError(CHAIN, "step", AI_MEMORY_STEP_MAX_MS))),
				),
				host.on(
					"aimemory.service.ask",
					mine<Ask>((ask, generation) => void this.#answer(ask, generation)),
				),
				host.on(
					"aimemory.service.cancel",
					mine<{ ask: number }>(({ ask }) => {
						if (this.#running === ask) this.#runner.cancel();
						else this.#cancelled.add(ask);
					}),
				),
				host.on(
					"aimemory.service.timer",
					mine<{ timer: number; ms: number; repeat: boolean }>(({ timer, ms, repeat }) => {
						const fire = () => {
							if (!repeat) this.#timers.delete(timer);
							void this.#call("aimemory.service.fire", { timer }).catch(() => undefined);
						};
						const handle = repeat ? setInterval(fire, ms) : setTimeout(fire, ms);
						handle.unref();
						this.#timers.set(timer, { handle, repeat });
					}),
				),
				host.on(
					"aimemory.service.clearTimer",
					mine<{ timer: number }>(({ timer }) => this.#clearTimer(timer)),
				),
			];
		}
		const deps = this.#deps;
		await this.#call("aimemory.service.open", {
			deps: {
				platform: deps.platform,
				arch: deps.arch,
				automatic: deps.automatic,
				toolsDir: deps.toolsDir,
				bundledDir: deps.bundledDir,
				binaryOverride: deps.binaryOverride ?? null,
				noService: deps.noService === true,
				home: deps.home,
				rootDir: deps.rootDir,
				recallFile: deps.recallFile ?? null,
				uid: process.getuid?.() ?? 0,
				unitAsks: deps.unit !== undefined,
				codeRequirementAsks: deps.codeRequirement !== undefined,
				bunCheck: deps.bunPresent !== undefined,
				beforeStart: deps.beforeStart !== undefined,
				pollMs: deps.pollMs ?? POLL_MS,
				healthWaitMs: deps.healthWaitMs ?? HEALTH_WAIT_MS,
				retryDelaysMs: deps.retryDelaysMs ?? RETRY_DELAYS_MS,
				stepMaxMs: AI_MEMORY_STEP_MAX_MS,
				manual: deps.now !== undefined,
				builds: {
					binaries: AI_MEMORY_BINARIES,
					manifest: AI_MEMORY_BUILD_MANIFEST,
					version: AI_MEMORY_VERSION,
					macStageKey: MAC_STAGE_KEY,
					requirement: AI_MEMORY_REQUIREMENT,
				},
				hubEntry: MEMORY_HUB_ENTRY,
			},
		});
		void this.#hold();
	}

	/** Keeps a request open on the service; when the core dies under it, opens the service on the next one. */
	async #hold(): Promise<void> {
		const host = core();
		const home = host.pid;
		while (!this.#disposed && host.pid === home) {
			try {
				await host.call("aimemory.service.closed", { service: this.#name }, { timeoutMs: HOLD_MS });
				return;
			} catch (error) {
				if (this.#disposed) return;
				if (error instanceof CoreError && error.code === "timeout") continue;
				break;
			}
		}
		if (this.#disposed) return;
		this.#opened = null;
		this.#running = null;
		this.#clearTimers();
		// The core's commands went with it; memory's service outlives it, so the launch pass finds it as it was.
		if (this.#started) void this.start();
	}

	/**
	 * One request to the core about this service; a test's service says the time with it. A test's clock is fake, so
	 * the request's own timeout (a timer on that clock) would end it at the test's first jump: there it waits as long
	 * as a held request.
	 */
	async #call<T>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs?: number,
		generation?: number,
	): Promise<T> {
		const now = this.#deps.now;
		const sent = { service: this.#name, ...(now ? { now: now() } : {}), ...params };
		const bound = now ? HOLD_MS : timeoutMs;
		const options = {
			...(bound === undefined ? {} : { timeoutMs: bound }),
			...(generation === undefined ? {} : { generation }),
		};
		return (await core().call<T>(method, sent, options)).result;
	}

	/** A queued step: queued in its turn, then waited for. */
	async #queued(request: { op: "retry" | "purge" } | { op: "terminal"; enabled: boolean }): Promise<void> {
		await this.#open();
		const queued = this.#lane.then(() => this.#call<number | null>("aimemory.service.queue", request));
		this.#lane = queued.catch(() => undefined);
		try {
			const step = await queued;
			if (step !== null) await this.#call("aimemory.service.outcome", { step }, HOLD_MS);
		} catch (error) {
			throw this.#refusal(error);
		}
	}

	/** A failure of the core as the service threw it: a stopped step's `StepStalledError`, a step's own words. */
	#refusal(error: unknown): unknown {
		if (!(error instanceof CoreError)) return error;
		if (error.code === "step_stalled") return new StepStalledError(CHAIN, "step", AI_MEMORY_STEP_MAX_MS);
		return error.code.startsWith("memory_") ? new Error(error.message) : error;
	}

	async #answer(ask: Ask, generation: number): Promise<void> {
		let answer: { value: unknown } | { error: { message: string; stack: string | null } };
		try {
			answer = { value: (await this.#asked(ask)) ?? null };
		} catch (error) {
			answer = {
				error: {
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? (error.stack ?? null) : null,
				},
			};
		}
		// A core that went meanwhile asks again; the next core numbers its asks from 1, so it never hears this answer.
		await this.#call("aimemory.service.answer", { ask: ask.ask, ...answer }, undefined, generation).catch(
			() => undefined,
		);
	}

	async #asked(ask: Ask): Promise<unknown> {
		const deps = this.#deps;
		switch (ask.what) {
			case "agentDir":
				return deps.agentDir();
			case "terminalPref":
				return deps.terminalPref();
			case "persistTerminal":
				return deps.persistTerminal(ask.enabled);
			case "bunPresent":
				return (await deps.bunPresent?.()) ?? true;
			case "beforeStart":
				return deps.beforeStart?.();
			case "spawnEnv":
				return deps.spawnEnv();
			case "codeRequirement":
				return deps.codeRequirement?.(ask.file);
			case "unit":
				if (!deps.unit) throw new Error("No service control here");
				return ask.op === "inspect" ? deps.unit.inspect() : deps.unit.remove();
			case "disabledLists":
				return Promise.all(ask.files.map(disabledIn));
			case "run":
				return this.#run(ask);
		}
	}

	/** One `ai-memory` command under the runner, in a neutral working directory (its commands read it as "this project"). */
	async #run(ask: Extract<Ask, { what: "run" }>): Promise<unknown> {
		const spawnEnv = await this.#deps.spawnEnv();
		if (this.#cancelled.delete(ask.ask)) return { ok: false, cancelled: true, output: "" };
		let output = "";
		this.#running = ask.ask;
		try {
			const outcome = await this.#runner.run(
				{
					file: spawnCommand(ask.bin),
					args: spawnArgs(ask.bin, ask.args),
					shell: needsShell(ask.bin),
					...(ask.isolated ? { isolated: true } : {}),
				},
				{ ...spawnEnv, ...ask.env },
				chunk => {
					output = (output + chunk).slice(-OUTPUT_TAIL);
				},
				this.#deps.home,
			);
			if (outcome.kind === "failed" && outcome.reason === "spawn") return { spawn: outcome.detail ?? null };
			return { ok: outcome.kind === "succeeded", cancelled: outcome.kind === "cancelled", output };
		} finally {
			if (this.#running === ask.ask) this.#running = null;
		}
	}
}
