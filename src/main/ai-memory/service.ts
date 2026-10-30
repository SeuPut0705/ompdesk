/**
 * ai-memory as OMPdesk's memory: stage the shipped binary, keep its per-user service running and give the omp sessions
 * OMPdesk spawns an app-owned extension root. Memory and learning are always on (the user's decision of 29 Oct 2026):
 * there is no off switch, and only OMPdesk's own build ever runs, as OMPdesk's own service.
 *
 * Why ai-memory's own service rather than a child OMPdesk supervises: ai-memory documents it as the local single-user
 * setup (launchd LaunchAgent on macOS, a logon entry on Windows, `ai-memory setup`), and a terminal omp the user
 * connected keeps capturing while OMPdesk is closed. OMPdesk therefore supervises nothing long-lived: it runs short,
 * idempotent `ai-memory` commands, polls `/healthz`, and re-runs `setup` when the service or the root went missing.
 *
 * What runs, always with the binary from `binary.ts`, in a neutral working directory:
 *   on    `setup --yes --agent omp`   the data dir + token and the user service. `setup` cannot install the service
 *                                     without wiring an agent, so omp's agent dir is pointed at a scratch folder
 *                                     (`PI_CODING_AGENT_DIR`), which is deleted again, together with the shared skills
 *                                     it newly created: nothing is written to `~/.omp/agent`.
 *         `install-hooks|install-mcp|install-skills` generate the extension root (`root.ts`), which sessions load with `-e`
 *   service  a unit that runs someone else's binary is replaced by OMPdesk's own (`#takeOverService`); a server no unit
 *         explains (Docker, a foreground `serve`) fails the pass with a message. `uninstall --apply` is never run: it
 *         removes every agent's wiring.
 *   terminal  "Also use in the terminal omp": ai-memory's own `setup --agent omp` into the real agent dir; the reverse
 *         removes just that extension and MCP entry (`terminal.ts`).
 *   purge the server is stopped (when it is OMPdesk's), the wiki/db/raw folders are deleted, then on again
 * Defaults stay ai-memory's: no LLM or cloud embedding provider (zero-LLM path; a fresh config opts out of the local
 * embedding model, see `config.ts`), the single-user cross-project profile.
 */
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { MemoryEnv } from "../../../resources/gui-bridge/modes/memory-recall-contracts";
import {
	AI_MEMORY_BINARIES,
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
	type AiMemoryStep,
	type AiMemorySweep,
	type AiMemoryWriteInput,
} from "../../shared/ai-memory";
import type { SetupPlatform } from "../../shared/setup";
import { SerialChain, stepStalled, throwIfStepStalled } from "../serial-chain";
import { SetupRunner } from "../setup/runner";
import { needsShell, spawnArgs, spawnCommand } from "../spawn";
import {
	AI_MEMORY_REQUIREMENT,
	type BuiltAsset,
	codeRequirementProblem,
	probeVersion,
	pruneStaged,
	readBuiltAsset,
	stageBinary,
	stagingRoot,
} from "./binary";
import { AiMemoryClient, DEFAULT_SERVER_URL, serverUrlFromConfig } from "./client";
import { withoutLocalEmbeddings } from "./config";
import { generateRoot, rootComplete } from "./root";
import { suppressionOverlay, TERMINAL_EXTENSION_ID, TERMINAL_MCP_ID } from "./suppress";
import {
	legacyOwned,
	listSharedSkills,
	readTerminalWiring,
	removeNewSharedSkills,
	removeTerminalWiring,
} from "./terminal";
import { launchdControl, logonControl, type ServiceControl } from "./unit";

const POLL_MS = 60_000;
const HEALTH_WAIT_MS = 30_000;
const HEALTH_STEP_MS = 500;
/** Re-run `setup` after this many polls in a row that found the server down, at most once in REWIRE_COOLDOWN_MS. */
const REWIRE_AFTER_POLLS = 2;
const REWIRE_COOLDOWN_MS = 10 * 60_000;
/**
 * A failed wiring pass runs again by itself after each of these waits, then stays failed (Settings' Try again). The
 * service manager can refuse a moment (launchd's bootstrap right after a bootout of the draining old server), so one
 * refusal must not leave memory down until the next launch.
 */
const RETRY_DELAYS_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000];
const OUTPUT_TAIL = 16 * 1024;
/** The folders `ai-memory reset` wipes; everything else in the data directory (config, token, models) stays. */
const DATA_FOLDERS = ["wiki", "db", "raw"] as const;
const STATS_MAX_AGE_MS = 5_000;

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
	/** `AI_MEMORY_TERMINAL_PREF`: undefined until the user (or the one-time migration) decided. */
	terminalPref: () => boolean | undefined;
	persistTerminal: (enabled: boolean) => void;
	/** The OS service ai-memory's `setup` installs; absent: launchd on macOS, the logon entry on Windows. */
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
	/** macOS: the shipped binary's check against `AI_MEMORY_REQUIREMENT` (`codeRequirementProblem`); tests fake it. */
	codeRequirement?: (file: string) => Promise<string | null>;
	runner?: SetupRunner;
	client?: AiMemoryClient;
	pollMs?: number;
	healthWaitMs?: number;
	/** The waits before a failed wiring pass runs again by itself (`RETRY_DELAYS_MS`). */
	retryDelaysMs?: readonly number[];
	now?: () => number;
}

export type AiMemoryLogMessage = "launch" | "binary" | "phase" | "failed" | "retry";
export type AiMemoryLogDetails = Record<string, string | number | boolean | null>;

interface Resolved {
	bin: string;
	version: string | null;
	/** The staged copy's folder is pruned of older builds once wiring points at it; null when nothing was staged. */
	staged: BuiltAsset | null;
}

/** `problem:` lines of `setup`'s summary. */
export function parseProblems(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.startsWith("problem:"))
		.map(line => line.slice("problem:".length).trim());
}

/** `setup --plan --json`'s document (a log line may precede it). */
export function parsePlan(
	output: string,
): { dataDir: string | null; configPath: string | null; fresh: boolean } | null {
	const start = output.search(/^\{/m);
	const end = output.lastIndexOf("}");
	if (start < 0 || end < start) return null;
	try {
		const plan = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
		return {
			dataDir: typeof plan.data_dir === "string" ? plan.data_dir : null,
			configPath: typeof plan.config_path === "string" ? plan.config_path : null,
			fresh: plan.fresh === true,
		};
	} catch {
		return null;
	}
}

/** The last meaningful lines of a command's output, without log prefixes and color codes. */
function tail(output: string, lines = 4): string {
	const esc = String.fromCharCode(27);
	return output
		.replace(new RegExp(`${esc}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "")
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line && !/\bINFO\b/.test(line))
		.slice(-lines)
		.join(" ¶ ");
}

/** A step failed; `message` is what Settings shows. */
class StepError extends Error {}

/** The user's cancel (the runner stopped a command): not a failure. */
/** The longest one queued step (stage, wire, a terminal wiring) runs; past it the step is stopped and the next starts. */
export const AI_MEMORY_STEP_MAX_MS = 30 * 60_000;

class Cancelled extends Error {}

export class AiMemoryService {
	readonly #deps: AiMemoryServiceDeps;
	readonly #runner: SetupRunner;
	readonly #client: AiMemoryClient;
	#state: AiMemoryState;
	/** One step at a time; a step past `AI_MEMORY_STEP_MAX_MS` is stopped (its child ends) and the next runs. */
	#queue = new SerialChain({
		name: "ai-memory",
		maxStepMs: AI_MEMORY_STEP_MAX_MS,
		onStall: () => this.#runner.cancel(),
	});
	#disposed = false;
	#timer: NodeJS.Timeout | null = null;
	#resolved: Resolved | null = null;
	#downPolls = 0;
	#lastRewire = 0;
	/** The health check running now (`#check`), joined by any call while it runs. */
	#checking: Promise<void> | null = null;
	#statsAt = 0;
	/** A wiring pass found no Bun: the setup's Bun arriving (`bunInstalled`) runs it again, once. */
	#awaitingBun = false;
	#retryTimer: NodeJS.Timeout | null = null;
	/** Automatic re-runs since the last pass that wired; bounded by `retryDelaysMs`. */
	#retries = 0;

	constructor(deps: AiMemoryServiceDeps) {
		this.#deps = deps;
		this.#runner = deps.runner ?? new SetupRunner();
		this.#state = {
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
		this.#client =
			deps.client ??
			new AiMemoryClient({
				url: () => this.#state.serverUrl ?? DEFAULT_SERVER_URL,
				dataDir: () => this.#state.dataDir,
			});
	}

	state(): AiMemoryState {
		return structuredClone(this.#state);
	}

	get #platformOk(): boolean {
		return (
			this.#deps.platform !== "other" &&
			(!!this.#deps.binaryOverride || !!AI_MEMORY_BINARIES[`${this.#deps.platform}-${this.#deps.arch}`])
		);
	}

	/**
	 * Detect, then (when on) stage and wire. Resolves when the first pass ended; never rejects: a failure is the
	 * `failed` phase (Settings shows it with Try again) and a `failed` log line.
	 */
	async start(): Promise<void> {
		const { platform, arch, automatic, bundledDir, binaryOverride } = this.#deps;
		this.#deps.log?.("launch", { automatic, platform, arch, bundledDir, override: binaryOverride ?? null });
		try {
			this.#patch({ wiring: await this.#wiring() });
			if (!this.#platformOk) {
				this.#patch({
					phase: "unsupported",
					unsupported: "platform",
					detail: "ai-memory has no build for this platform.",
				});
				return;
			}
			if (!automatic) {
				this.#patch({
					phase: "unsupported",
					unsupported: "paused",
					detail:
						"This launch does not set ai-memory up (safe mode, or an unpackaged build: set OMP_GUI_AI_MEMORY_BIN).",
				});
				return;
			}
			this.#patch({ phase: "starting", step: "stage" });
			await this.#deps.beforeStart?.();
			await this.#enqueue(() => this.#enable());
		} catch (error) {
			this.#fail(error);
		}
	}

	/** Wire again after a failure (or an unreachable server). */
	retry(): Promise<void> {
		if (!this.#platformOk || !this.#deps.automatic) return Promise.resolve();
		this.#cancelRetry();
		this.#patch({ phase: "starting", step: "stage", detail: null });
		return this.#enqueue(() => this.#enable());
	}

	/**
	 * The machine setup reports Bun present (called on every such setup state). A wiring pass that stopped for want of
	 * Bun runs again, once; otherwise nothing happens.
	 */
	bunInstalled(): void {
		if (!this.#awaitingBun) return;
		this.#awaitingBun = false;
		// A stopped step already failed its own caller and is in the chain-stall log; nobody waits on this one.
		void this.retry().catch(() => undefined);
	}

	/** Erase everything ai-memory remembers (wiki, database, raw events, token); wire it again afterwards. */
	purge(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (!this.#platformOk || !this.#deps.automatic) {
			reject(new Error("ai-memory is not managed by this build."));
			return promise;
		}
		this.#patch({ phase: "starting", step: "purge", detail: null });
		this.#enqueue(async () => {
			try {
				await this.#purgeData();
				throwIfStepStalled();
				await this.#enable();
				resolve();
			} catch (error) {
				throwIfStepStalled();
				await this.#enable().catch(() => undefined);
				reject(error);
			}
		}).catch(reject);
		return promise;
	}

	/**
	 * "Also use in the terminal omp": ai-memory's own `setup --agent omp` into omp's real agent dir, or (off) the removal
	 * of exactly that extension and MCP entry. Memory itself (phase, server) is not changed; a failure throws.
	 */
	setTerminal(enabled: boolean): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (!this.#platformOk || !this.#deps.automatic) {
			reject(new Error("ai-memory is not managed by this build."));
			return promise;
		}
		this.#enqueue(async () => {
			const { phase, detail } = this.#state;
			this.#patch({ phase: "starting", step: "terminal", detail: null });
			try {
				if (enabled) {
					const resolved = this.#resolved ?? (await this.#resolve());
					this.#resolved = resolved;
					await this.#setup(resolved.bin, { terminal: true });
					this.#deps.persistTerminal(true);
				} else {
					await removeTerminalWiring(this.#deps.agentDir());
					this.#deps.persistTerminal(false);
				}
				this.#patch({ phase, step: null, detail, wiring: await this.#wiring() });
				resolve();
			} catch (error) {
				this.#patch({ phase, step: null, detail, wiring: await this.#wiring() });
				reject(error instanceof Cancelled ? new Error("Cancelled") : error);
			}
		}).catch(reject);
		return promise;
	}

	/** Stats and health, at most every few seconds; the Settings page and the panel call it when they open. */
	async refresh(): Promise<void> {
		if (this.#disposed || this.#state.phase === "starting") return;
		const now = (this.#deps.now ?? Date.now)();
		if (now - this.#statsAt < STATS_MAX_AGE_MS) return;
		this.#statsAt = now;
		if (this.#state.phase === "ready" || this.#state.phase === "unreachable") await this.#check(false);
		else this.#patch({ wiring: await this.#wiring() });
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
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
		this.#cancelRetry();
		this.#runner.cancel();
	}

	#cancelRetry(): void {
		clearTimeout(this.#retryTimer ?? undefined);
		this.#retryTimer = null;
	}

	/** After a failed wiring pass: run it again by itself, a bounded number of times. */
	#scheduleRetry(): void {
		const delays = this.#deps.retryDelaysMs ?? RETRY_DELAYS_MS;
		if (this.#disposed || this.#awaitingBun || this.#retryTimer || this.#retries >= delays.length) return;
		const inMs = delays[this.#retries] ?? 0;
		this.#retries += 1;
		this.#deps.log?.("retry", { attempt: this.#retries, of: delays.length, inMs, detail: this.#state.detail });
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			if (this.#disposed || this.#state.phase !== "failed") return;
			this.#patch({ phase: "starting", step: "stage", detail: null });
			void this.#enqueue(() => this.#enable()).catch(() => undefined);
		}, inMs);
		this.#retryTimer.unref();
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		return this.#queue.run(async () => {
			if (!this.#disposed) await task();
		});
	}

	#patch(patch: Partial<AiMemoryState>): void {
		const before = this.#state;
		this.#state = { ...this.#state, ...patch };
		const { serverUrl } = this.#state;
		if (serverUrl && !patch.webUrl) this.#state.webUrl = `${serverUrl}/web`;
		const { phase, step, detail } = this.#state;
		if (phase !== before.phase || step !== before.step || detail !== before.detail) {
			this.#deps.log?.("phase", { phase, step, detail, from: before.phase, fromStep: before.step });
		}
		this.#deps.onState(this.state());
	}

	#step(step: AiMemoryStep): void {
		this.#patch({ phase: "starting", step });
	}

	#fail(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		this.#deps.log?.("failed", {
			step: this.#state.step,
			detail,
			stack: error instanceof Error && !(error instanceof StepError) ? (error.stack ?? null) : null,
		});
		this.#patch({ phase: "failed", step: null, detail });
		this.#stopPolling();
	}

	/** What is on disk now: OMPdesk's own root, and the terminal omp's wiring when the user connected it. */
	async #wiring(): Promise<AiMemoryState["wiring"]> {
		const [app, terminal] = await Promise.all([
			rootComplete(this.#deps.rootDir),
			readTerminalWiring(this.#deps.agentDir()),
		]);
		return { app, terminal: this.#deps.terminalPref() === true && (terminal.extension || terminal.mcp) };
	}

	/**
	 * What the omp sessions OMPdesk spawns (in `cwd`) load for memory: `-e <root>` while memory is on and the root is
	 * complete, so a session captures exactly once and has one memory MCP server, both OMPdesk's own build, whatever
	 * omp's agent dir holds. omp loads the agent dir's ai-memory extension and `ai-memory` MCP entry into every process
	 * it starts, so:
	 * - the terminal omp the user connected (pref `true`) already loads ours from there (`setup` refreshes it at every
	 *   launch): no `-e`, the root is left out;
	 * - wiring there the user made with their own ai-memory is not ours and not adopted: the root loads and a `--config`
	 *   overlay holds that extension and that MCP entry disabled for this spawn (`suppress.ts`); the agent dir is
	 *   untouched. The root's own MCP server is named `ompdesk-memory` (root.ts), so the entry's name cannot take it over.
	 */
	async extensionArgs(cwd?: string): Promise<string[]> {
		if (!this.#deps.automatic || !this.#platformOk) return [];
		if (!(await rootComplete(this.#deps.rootDir))) return [];
		const agentDir = this.#deps.agentDir();
		const wiring = await readTerminalWiring(agentDir);
		if (this.#deps.terminalPref() === true && wiring.extension) return [];
		const ids = [...(wiring.extension ? [TERMINAL_EXTENSION_ID] : []), ...(wiring.mcp ? [TERMINAL_MCP_ID] : [])];
		if (ids.length === 0) return ["-e", this.#deps.rootDir];
		try {
			const overlay = await suppressionOverlay({
				agentDir,
				cwd,
				dir: join(dirname(this.#deps.rootDir), "omp-overlays"),
				ids,
			});
			return ["-e", this.#deps.rootDir, "--config", overlay];
		} catch (error) {
			// Without the overlay both copies would run; the agent dir's alone is one capture and one server.
			this.#deps.log?.("failed", {
				step: "suppress-terminal-wiring",
				detail: error instanceof Error ? error.message : String(error),
				stack: null,
			});
			return [];
		}
	}

	/**
	 * Where a spawned omp reads memory itself (the bridge's memory recall, via recall-state.ts): the server's URL and the
	 * data dir its token is in, while memory is on and its setup pass has found the data dir; null otherwise.
	 */
	recallEnv(): MemoryEnv | null {
		if (!this.#deps.automatic || !this.#platformOk) return null;
		const { dataDir, serverUrl } = this.#state;
		return dataDir ? { url: serverUrl ?? DEFAULT_SERVER_URL, dataDir } : null;
	}

	get #unit(): ServiceControl {
		const { unit, platform, home, toolsDir } = this.#deps;
		if (unit) return unit;
		const owned = () => [stagingRoot(toolsDir), ...(this.#resolved ? [this.#resolved.bin] : [])];
		if (platform === "win32") return logonControl({ owned, dataDir: () => this.#state.dataDir });
		return launchdControl({ home, owned, uid: process.getuid?.() ?? 0 });
	}

	async #resolve(): Promise<Resolved> {
		const { platform, arch, bundledDir, binaryOverride } = this.#deps;
		const env = await this.#deps.spawnEnv();
		if (binaryOverride) {
			return { bin: binaryOverride, version: await probeVersion(binaryOverride, env), staged: null };
		}
		if (platform === "other") throw new StepError("ai-memory has no build for this platform.");
		if (!bundledDir) throw new StepError("The app carries no ai-memory binary. Reinstall OMPdesk.");
		let asset: BuiltAsset | null;
		try {
			asset = await readBuiltAsset(bundledDir, platform, arch);
		} catch (error) {
			throw new StepError(error instanceof Error ? error.message : String(error));
		}
		if (!asset) throw new StepError("ai-memory has no build for this platform.");
		const bin = await this.#stage(asset, join(bundledDir, asset.binary));
		return { bin, version: AI_MEMORY_VERSION, staged: asset };
	}

	async #stage(asset: BuiltAsset, source: string): Promise<string> {
		try {
			return await stageBinary({
				source,
				asset,
				toolsDir: this.#deps.toolsDir,
				// A packaged macOS release re-signed the shipped file with OMPdesk's certificate (binary.ts).
				...(this.#deps.platform === "darwin"
					? {
							requirement:
								this.#deps.codeRequirement ?? (file => codeRequirementProblem(file, AI_MEMORY_REQUIREMENT)),
						}
					: {}),
			});
		} catch (error) {
			throw new StepError(error instanceof Error ? error.message : String(error));
		}
	}

	async #run(
		bin: string,
		args: string[],
		options: { env?: NodeJS.ProcessEnv; isolated?: boolean } = {},
	): Promise<{ ok: boolean; cancelled: boolean; output: string }> {
		let output = "";
		const spawnEnv = await this.#deps.spawnEnv();
		throwIfStepStalled();
		// Its own commands read the working directory as "this project" (setup's doctor, `status`): a neutral one.
		const outcome = await this.#runner.run(
			{
				file: spawnCommand(bin),
				args: spawnArgs(bin, args),
				shell: needsShell(bin),
				...(options.isolated ? { isolated: true } : {}),
			},
			{ ...spawnEnv, ...options.env },
			chunk => {
				output = (output + chunk).slice(-OUTPUT_TAIL);
			},
			this.#deps.home,
		);
		throwIfStepStalled();
		if (outcome.kind === "failed" && outcome.reason === "spawn") {
			throw new StepError(`ai-memory could not start: ${outcome.detail ?? bin}`);
		}
		return { ok: outcome.kind === "succeeded", cancelled: outcome.kind === "cancelled", output };
	}

	/** Paths whose binaries OMPdesk runs: a unit or an MCP entry running one was written by OMPdesk. */
	#ownedPaths(): string[] {
		return [stagingRoot(this.#deps.toolsDir), ...(this.#resolved ? [this.#resolved.bin] : [])];
	}

	/**
	 * Only OMPdesk's own build serves: `setup` repoints a unit that already runs OMPdesk's, so a unit running someone
	 * else's binary is removed first (its server stops), and a server that answers with no unit at all (Docker, a
	 * foreground `ai-memory serve`) cannot be stopped by OMPdesk, so the pass fails and says so. Tests that run the
	 * server themselves (`noService`) have no unit to take over.
	 */
	async #takeOverService(serverWasUp: boolean): Promise<void> {
		if (this.#deps.noService) return;
		const unit = await this.#unit.inspect();
		if (unit.installed && !unit.ours) await this.#removeUnit();
		else if (unit.installed || !serverWasUp) return;
		if (await this.#client.healthy()) {
			throw new StepError(
				"A memory server that OMPdesk did not start answers on this computer (Docker, a foreground `ai-memory serve`). Stop it and try again: OMPdesk runs only its own.",
			);
		}
	}

	/**
	 * `setup` installs the service only together with an agent's wiring. For OMPdesk's server the agent dir is a
	 * scratch folder (deleted afterwards, with the shared skills `setup` newly created); a terminal omp the user
	 * connected is wired into its real agent dir by the very same command. It runs isolated (`SpawnSpec.isolated`):
	 * the service host it may start outlives OMPdesk by design, and must not hold any handle of OMPdesk's.
	 */
	async #setup(bin: string, options: { terminal: boolean }): Promise<void> {
		const args = ["setup", "--yes", "--agent", "omp", ...(this.#deps.noService ? ["--no-service"] : [])];
		const { home } = this.#deps;
		const scratch = `${this.#deps.rootDir}.setup`;
		const skillsBefore = options.terminal ? null : await listSharedSkills(home);
		let result: { ok: boolean; cancelled: boolean; output: string };
		try {
			result = await this.#run(bin, args, {
				isolated: true,
				...(options.terminal ? {} : { env: { PI_CODING_AGENT_DIR: scratch } }),
			});
		} finally {
			if (!options.terminal) {
				await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
				if (skillsBefore) await removeNewSharedSkills(home, skillsBefore).catch(() => undefined);
			}
		}
		if (result.cancelled) throw new Cancelled();
		const problems = parseProblems(result.output);
		// Right after the service starts, setup's own self-check can ask before the server listens; the poll below
		// is the real test. Any other problem is a failure.
		const fatal = problems.filter(problem => !problem.startsWith("self-check"));
		if (!result.ok && (fatal.length > 0 || problems.length === 0)) {
			throw new StepError(`setup failed: ${fatal.join("; ") || tail(result.output) || "no output"}`);
		}
	}

	async #enable(): Promise<void> {
		try {
			this.#awaitingBun = false;
			const bunPresent = this.#deps.bunPresent ? await this.#deps.bunPresent() : true;
			throwIfStepStalled();
			if (!bunPresent) {
				this.#awaitingBun = true;
				throw new StepError("Waiting for Bun: memory sets itself up as soon as the setup has installed it.");
			}
			this.#step("stage");
			const resolved = await this.#resolve();
			throwIfStepStalled();
			this.#resolved = resolved;
			this.#patch({ version: resolved.version, binary: resolved.bin });
			this.#deps.log?.("binary", { version: resolved.version, bin: resolved.bin });
			this.#step("wire");
			// The plan tells the data directory (platform default or AI_MEMORY_DATA_DIR) without touching anything.
			const plan = await this.#run(resolved.bin, ["setup", "--plan", "--json", "--agent", "omp"]);
			if (plan.cancelled) return;
			const facts = parsePlan(plan.output);
			if (facts?.dataDir) this.#patch({ dataDir: facts.dataDir });
			// Whether a server of someone else's already runs on this data dir (read before `init` can write a config).
			const before = facts?.configPath ? await readFile(facts.configPath, "utf8").catch(() => null) : null;
			throwIfStepStalled();
			if (before !== null) this.#patch({ serverUrl: serverUrlFromConfig(before) });
			const serverWasUp = before !== null && (await this.#client.healthy());
			throwIfStepStalled();
			// A fresh data dir: ai-memory's own `init` writes the config (and token) first, and the one setting OMPdesk
			// changes goes in before the service starts, so the embedding model is never fetched. An existing config
			// (a user's, or an earlier OMPdesk run) is left exactly as it is.
			if (facts?.fresh && facts.configPath) {
				const init = await this.#run(resolved.bin, ["init"]);
				if (init.cancelled) return;
				if (!init.ok) throw new StepError(`init failed: ${tail(init.output) || "no output"}`);
				const current = await readFile(facts.configPath, "utf8").catch(() => null);
				throwIfStepStalled();
				const next = current === null ? null : withoutLocalEmbeddings(current);
				if (next !== null) await writeFile(facts.configPath, next);
			}
			await this.#takeOverService(serverWasUp);
			throwIfStepStalled();

			// An earlier build wired omp globally (extension + MCP entry running OMPdesk's staged binary): move that to
			// the app-owned root, once. Wiring the person made themselves is never adopted as the terminal's: it stays
			// untouched and is not read as "terminal omp connected" (only the button sets `aiMemoryTerminal` true).
			const agentDir = this.#deps.agentDir();
			let terminal = await readTerminalWiring(agentDir);
			throwIfStepStalled();
			if (this.#deps.terminalPref() === undefined) {
				if (legacyOwned(terminal, this.#ownedPaths())) {
					await removeTerminalWiring(agentDir);
					terminal = await readTerminalWiring(agentDir);
					throwIfStepStalled();
				}
				this.#deps.persistTerminal(false);
			}
			// Keep a connected terminal omp pointed at the binary in use (an app update stages a new version).
			const terminalWired = this.#deps.terminalPref() === true && (terminal.extension || terminal.mcp);
			try {
				await this.#setup(resolved.bin, { terminal: terminalWired });
			} catch (error) {
				throwIfStepStalled();
				if (error instanceof Cancelled) return;
				// The extension root belongs to the binary in use, not to the service: an update whose service step failed
				// still gets the new extension (`promptTitle`, the child-session rules), or it stays stale for the whole run.
				await this.#generateRoot(resolved.bin).catch((rootError: unknown) =>
					this.#deps.log?.("failed", {
						step: "root",
						detail: rootError instanceof Error ? rootError.message : String(rootError),
						stack: null,
					}),
				);
				const failedWiring = await this.#wiring();
				throwIfStepStalled();
				this.#patch({ wiring: failedWiring });
				throw error;
			}
			const toml = facts?.configPath ? await readFile(facts.configPath, "utf8").catch(() => null) : null;
			throwIfStepStalled();
			this.#patch({ serverUrl: serverUrlFromConfig(toml) });
			const generated = await this.#generateRoot(resolved.bin);
			throwIfStepStalled();
			if (!generated) return;
			const wiring = await this.#wiring();
			throwIfStepStalled();
			this.#patch({ wiring });
			if (!wiring.app) throw new StepError(`ai-memory's extension root is not complete in ${this.#deps.rootDir}`);
			this.#step("check");
			const up = await this.#waitHealthy();
			throwIfStepStalled();
			this.#patch({
				phase: up ? "ready" : "unreachable",
				step: null,
				detail: up ? null : "The server does not answer yet.",
			});
			this.#downPolls = 0;
			this.#retries = 0;
			if (up) await this.#readStats();
			throwIfStepStalled();
			this.#startPolling();
			if (resolved.staged) void pruneStaged(this.#deps.toolsDir, resolved.staged);
		} catch (error) {
			// A stopped step ends here without a word: the next step owns the state now.
			if (stepStalled()) throw error;
			this.#fail(error);
			this.#scheduleRetry();
		}
	}

	/** The extension root, from ai-memory's own generators; false when a command was cancelled. */
	async #generateRoot(bin: string): Promise<boolean> {
		try {
			return await generateRoot(this.#deps.rootDir, args => this.#run(bin, args), tail);
		} catch (error) {
			throw error instanceof StepError
				? error
				: new StepError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Remove ai-memory's unit (its server goes with it) and wait for the server to stop answering. */
	async #removeUnit(): Promise<void> {
		await this.#unit.remove();
		const deadline = (this.#deps.now ?? Date.now)() + (this.#deps.healthWaitMs ?? HEALTH_WAIT_MS);
		while (await this.#client.healthy()) {
			if ((this.#deps.now ?? Date.now)() >= deadline) return;
			await sleep(HEALTH_STEP_MS);
		}
	}

	/**
	 * Delete all memory: the server is stopped first and then the data folders are wiped by OMPdesk itself
	 * (`uninstall --purge-data` would refuse while any `ai-memory` process runs). The caller wires memory again. Throws
	 * when a step fails.
	 */
	async #purgeData(): Promise<void> {
		this.#stopPolling();
		try {
			this.#step("purge");
			const unit = await this.#unit.inspect();
			throwIfStepStalled();
			if (unit.installed) await this.#removeUnit();
			throwIfStepStalled();
			await this.#wipeData();
			throwIfStepStalled();
			this.#patch({ step: null, detail: null, stats: null });
		} catch (error) {
			if (stepStalled()) throw error;
			this.#fail(error);
			throw error;
		}
	}

	/** Empty `wiki/`, `db/` and `raw/` of the data directory (what `ai-memory reset` wipes); the config and token stay. */
	async #wipeData(): Promise<void> {
		const dir = this.#state.dataDir;
		if (
			!dir ||
			!(await stat(join(dir, "config.toml")).then(
				info => info.isFile(),
				() => false,
			))
		) {
			throw new StepError("The data folder is not known, so nothing was deleted.");
		}
		// The server must be gone: a second server (Docker, a foreground `serve`) would still hold the database.
		await sleep(HEALTH_STEP_MS);
		if (await this.#client.healthy()) {
			throw new StepError("An ai-memory server still answers, so nothing was deleted. Stop it first.");
		}
		for (const name of DATA_FOLDERS) await rm(join(dir, name), { recursive: true, force: true });
	}

	async #waitHealthy(): Promise<boolean> {
		const deadline = (this.#deps.now ?? Date.now)() + (this.#deps.healthWaitMs ?? HEALTH_WAIT_MS);
		for (;;) {
			if (await this.#client.healthy()) return true;
			if (this.#disposed || (this.#deps.now ?? Date.now)() >= deadline) return false;
			await sleep(HEALTH_STEP_MS);
		}
	}

	async #readStats(): Promise<void> {
		const status = await this.#client.status();
		if (!status) return;
		this.#patch({
			version: status.version ?? this.#state.version,
			stats: {
				pages: status.pages,
				sessions: status.sessions,
				observations: status.observations,
				diskBytes: status.diskBytes,
			},
		});
	}

	/**
	 * Health, stats and the wiring files; heals by running `setup` again when the server stays down or a file went.
	 * One check at a time: a check that started while another was reading would apply what it read after the newer
	 * one, so a root seen gone could read back as present and ready with no heal (seen on Windows, where a poll's
	 * file reads outlast the poll interval). A call while one runs joins it.
	 */
	#check(heal: boolean): Promise<void> {
		this.#checking ??= this.#runCheck(heal).finally(() => {
			this.#checking = null;
		});
		return this.#checking;
	}

	async #runCheck(heal: boolean): Promise<void> {
		const [up, wiring] = await Promise.all([this.#client.healthy(), this.#wiring()]);
		if (this.#state.phase === "starting") return;
		this.#patch({ wiring });
		if (up) {
			this.#downPolls = 0;
			this.#patch({ phase: "ready", detail: null });
			await this.#readStats();
		} else {
			this.#downPolls += 1;
			this.#patch({ phase: "unreachable", stats: null, detail: "The server does not answer." });
		}
		const broken = !up && this.#downPolls >= REWIRE_AFTER_POLLS;
		const missing = !wiring.app;
		const now = (this.#deps.now ?? Date.now)();
		if (heal && (broken || missing) && now - this.#lastRewire >= REWIRE_COOLDOWN_MS) {
			this.#lastRewire = now;
			this.#patch({ phase: "starting", step: "wire" });
			await this.#enqueue(() => this.#enable());
		}
	}

	#startPolling(): void {
		if (this.#timer || this.#disposed) return;
		this.#timer = setInterval(
			() =>
				void this.#check(true).catch((error: unknown) =>
					this.#deps.log?.("failed", {
						step: "poll",
						detail: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? (error.stack ?? null) : null,
					}),
				),
			this.#deps.pollMs ?? POLL_MS,
		);
		this.#timer.unref();
	}

	#stopPolling(): void {
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
	}
}
