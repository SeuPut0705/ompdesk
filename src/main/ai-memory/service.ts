/**
 * ai-memory as OMPdesk's memory: stage the shipped binary, wire omp with ai-memory's own installer, keep its
 * per-user service running, and take it all back on "off".
 *
 * Why ai-memory's own service rather than a child OMPdesk supervises: the omp CLI outside OMPdesk (a terminal, an
 * editor, a script) is wired the same way and keeps capturing and getting handoffs while OMPdesk is closed; ai-memory
 * documents that service as the local single-user setup (launchd LaunchAgent on macOS, a logon entry on Windows,
 * `ai-memory setup`). OMPdesk therefore supervises nothing long-lived: it runs short, idempotent `ai-memory`
 * commands, polls `/healthz`, and re-runs `setup` when the service or the wiring went missing.
 *
 * What runs, always with the binary from `binary.ts`:
 *   on    `setup --yes --agent omp`   data dir + token, the user service, the MCP entry, the generated omp
 *                                     extension and the skills, then ai-memory's own self-check
 *   off   `uninstall --apply --yes`   hooks, MCP entry, skills and the service; the data stays
 *   purge `uninstall --apply --yes`, then the wiki/db/raw folders are deleted (server stopped), then `on` again when
 *         memory is on
 * Defaults stay ai-memory's: no LLM or cloud embedding provider (zero-LLM path; its small local embedding model is
 * fetched once), the single-user cross-project profile.
 */
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	AI_MEMORY_VERSION,
	type AiMemoryHandoff,
	type AiMemoryPage,
	type AiMemoryPageRef,
	type AiMemoryProject,
	type AiMemoryProjectRef,
	type AiMemoryState,
	type AiMemoryStep,
} from "../../shared/ai-memory";
import type { SetupPlatform } from "../../shared/setup";
import { SetupRunner } from "../setup/runner";
import {
	type AiMemoryPlatform,
	type ExternalInstall,
	newerExternal,
	type PinnedAsset,
	pinnedAsset,
	probeVersion,
	pruneStaged,
	stageBinary,
	stagedBinaryPath,
} from "./binary";
import { AiMemoryClient, DEFAULT_SERVER_URL, serverUrlFromConfig } from "./client";
import { withoutLocalEmbeddings } from "./config";

const POLL_MS = 60_000;
const HEALTH_WAIT_MS = 30_000;
const HEALTH_STEP_MS = 500;
/** Re-run `setup` after this many polls in a row that found the server down, at most once in REWIRE_COOLDOWN_MS. */
const REWIRE_AFTER_POLLS = 2;
const REWIRE_COOLDOWN_MS = 10 * 60_000;
const OUTPUT_TAIL = 16 * 1024;
/** The folders `ai-memory reset` wipes; everything else in the data directory (config, token, models) stays. */
const DATA_FOLDERS = ["wiki", "db", "raw"] as const;
const STATS_MAX_AGE_MS = 5_000;

/** The files ai-memory's omp installer writes under omp's agent dir. */
export const EXTENSION_FILE = join("extensions", "ai-memory-omp.ts");
export const MCP_FILE = "mcp.json";

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
	agentDir: () => string;
	/** The Settings switch: only a stored `false` is off. */
	enabled: () => boolean;
	persistEnabled: (enabled: boolean) => void;
	spawnEnv: () => Promise<NodeJS.ProcessEnv>;
	onState: (state: AiMemoryState) => void;
	/** Wait for something before the first wiring (the first tab boots before ai-memory competes with it). */
	beforeStart?: () => Promise<void>;
	runner?: SetupRunner;
	client?: AiMemoryClient;
	externalProbe?: (bin: string) => Promise<string | null>;
	pollMs?: number;
	healthWaitMs?: number;
	now?: () => number;
}

interface Resolved {
	bin: string;
	version: string | null;
	source: "bundled" | "external";
	/** The staged copy's folder is pruned of older versions once wiring points at it. */
	staged: boolean;
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

export class AiMemoryService {
	readonly #deps: AiMemoryServiceDeps;
	readonly #runner: SetupRunner;
	readonly #client: AiMemoryClient;
	#state: AiMemoryState;
	#queue: Promise<void> = Promise.resolve();
	#disposed = false;
	#timer: NodeJS.Timeout | null = null;
	#resolved: Resolved | null = null;
	#downPolls = 0;
	#lastRewire = 0;
	#statsAt = 0;

	constructor(deps: AiMemoryServiceDeps) {
		this.#deps = deps;
		this.#runner = deps.runner ?? new SetupRunner();
		this.#state = {
			enabled: deps.enabled(),
			phase: "off",
			step: null,
			source: "bundled",
			version: null,
			binary: null,
			dataDir: null,
			serverUrl: null,
			webUrl: null,
			wiring: { extension: false, mcp: false },
			stats: null,
			detail: null,
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
			(!!this.#deps.binaryOverride || pinnedAsset(this.#deps.platform, this.#deps.arch) !== null)
		);
	}

	/** Detect, then (when on) stage and wire. Resolves when the first pass ended. */
	async start(): Promise<void> {
		this.#patch({ enabled: this.#deps.enabled(), wiring: await this.#wiring() });
		if (!this.#platformOk) {
			this.#patch({ phase: "unsupported", detail: "ai-memory has no build for this platform." });
			return;
		}
		if (!this.#deps.automatic) {
			this.#patch({
				phase: this.#state.enabled ? "unsupported" : "off",
				detail: this.#state.enabled
					? "An unpackaged build does not change this machine. Set OMP_GUI_AI_MEMORY_BIN to run ai-memory."
					: null,
			});
			return;
		}
		if (!this.#state.enabled) {
			this.#patch({ phase: "off", detail: null });
			return;
		}
		this.#patch({ phase: "starting", step: "stage" });
		await this.#deps.beforeStart?.();
		await this.#enqueue(() => this.#enable());
	}

	/** The Settings switch. Persists first, then wires or unwires; progress arrives through `onState`. */
	setEnabled(enabled: boolean): Promise<void> {
		this.#deps.persistEnabled(enabled);
		this.#patch({ enabled });
		if (!this.#platformOk || !this.#deps.automatic) return Promise.resolve();
		this.#patch({ phase: "starting", step: enabled ? "stage" : "unwire", detail: null });
		return this.#enqueue(() => (enabled ? this.#enable() : this.#disable(false)));
	}

	/** Wire again after a failure (or an unreachable server). */
	retry(): Promise<void> {
		if (!this.#state.enabled || !this.#platformOk || !this.#deps.automatic) return Promise.resolve();
		this.#patch({ phase: "starting", step: "stage", detail: null });
		return this.#enqueue(() => this.#enable());
	}

	/** Erase everything ai-memory remembers (wiki, database, raw events, token); wire it again when memory is on. */
	purge(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (!this.#platformOk || !this.#deps.automatic) {
			reject(new Error("ai-memory is not managed by this build."));
			return promise;
		}
		this.#patch({ phase: "starting", step: "purge", detail: null });
		this.#enqueue(async () => {
			try {
				await this.#disable(true);
				if (this.#state.enabled) await this.#enable();
				resolve();
			} catch (error) {
				if (this.#state.enabled) await this.#enable().catch(() => undefined);
				reject(error);
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

	/** The /web console's password: the root token (any username works). */
	token(): Promise<string | null> {
		return this.#client.token();
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
		this.#runner.cancel();
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(async () => {
			if (!this.#disposed) await task();
		});
		this.#queue = next.catch(() => undefined);
		return next;
	}

	#patch(patch: Partial<AiMemoryState>): void {
		this.#state = { ...this.#state, ...patch };
		const { serverUrl } = this.#state;
		if (serverUrl && !patch.webUrl) this.#state.webUrl = `${serverUrl}/web`;
		this.#deps.onState(this.state());
	}

	#step(step: AiMemoryStep): void {
		this.#patch({ phase: "starting", step });
	}

	#fail(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		this.#patch({ phase: "failed", step: null, detail });
		this.#stopPolling();
	}

	/** What is on disk for omp now: the generated extension and the MCP entry. */
	async #wiring(): Promise<AiMemoryState["wiring"]> {
		const dir = this.#deps.agentDir();
		const extension = await stat(join(dir, EXTENSION_FILE)).then(
			info => info.isFile(),
			() => false,
		);
		let mcp = false;
		try {
			const config = JSON.parse(await readFile(join(dir, MCP_FILE), "utf8")) as {
				mcpServers?: Record<string, unknown>;
			};
			mcp = !!config.mcpServers && "ai-memory" in config.mcpServers;
		} catch {
			mcp = false;
		}
		return { extension, mcp };
	}

	async #resolve(): Promise<Resolved> {
		const { platform, arch, toolsDir, bundledDir, binaryOverride, home } = this.#deps;
		const env = await this.#deps.spawnEnv();
		if (binaryOverride) {
			return {
				bin: binaryOverride,
				version: await probeVersion(binaryOverride, env),
				source: "bundled",
				staged: false,
			};
		}
		if (platform === "other") throw new StepError("ai-memory has no build for this platform.");
		const asset = pinnedAsset(platform, arch);
		if (!asset) throw new StepError("ai-memory has no build for this platform.");
		if (!bundledDir) throw new StepError("The app carries no ai-memory binary. Reinstall OMPdesk.");
		const platformKey: AiMemoryPlatform = platform;
		const staged = stagedBinaryPath(toolsDir, asset);
		let external: ExternalInstall | null = null;
		try {
			external = await newerExternal({
				platform: platformKey,
				home,
				env,
				exclude: [staged],
				...(this.#deps.externalProbe ? { probe: this.#deps.externalProbe } : {}),
			});
		} catch {
			external = null;
		}
		if (external) return { bin: external.bin, version: external.version, source: "external", staged: false };
		const bin = await this.#stage(asset, join(bundledDir, asset.binary));
		return { bin, version: AI_MEMORY_VERSION, source: "bundled", staged: true };
	}

	async #stage(asset: PinnedAsset, source: string): Promise<string> {
		try {
			return await stageBinary({ source, asset, toolsDir: this.#deps.toolsDir });
		} catch (error) {
			throw new StepError(error instanceof Error ? error.message : String(error));
		}
	}

	async #run(bin: string, args: string[]): Promise<{ ok: boolean; cancelled: boolean; output: string }> {
		let output = "";
		// Its own commands read the working directory as "this project" (setup's doctor, `status`): a neutral one.
		const outcome = await this.#runner.run(
			{ file: bin, args, shell: false },
			await this.#deps.spawnEnv(),
			chunk => {
				output = (output + chunk).slice(-OUTPUT_TAIL);
			},
			this.#deps.home,
		);
		if (outcome.kind === "failed" && outcome.reason === "spawn") {
			throw new StepError(`ai-memory could not start: ${outcome.detail ?? bin}`);
		}
		return { ok: outcome.kind === "succeeded", cancelled: outcome.kind === "cancelled", output };
	}

	async #enable(): Promise<void> {
		try {
			this.#step("stage");
			const resolved = await this.#resolve();
			this.#resolved = resolved;
			this.#patch({ source: resolved.source, version: resolved.version, binary: resolved.bin });
			this.#step("wire");
			// The plan tells the data directory (platform default or AI_MEMORY_DATA_DIR) without touching anything.
			const plan = await this.#run(resolved.bin, ["setup", "--plan", "--json", "--agent", "omp"]);
			if (plan.cancelled) return;
			const facts = parsePlan(plan.output);
			if (facts?.dataDir) this.#patch({ dataDir: facts.dataDir });
			// A fresh data dir: ai-memory's own `init` writes the config (and token) first, and the one setting OMPdesk
			// changes goes in before the service starts, so the embedding model is never fetched. An existing config
			// (a user's, or an earlier OMPdesk run) is left exactly as it is.
			if (facts?.fresh && facts.configPath) {
				const init = await this.#run(resolved.bin, ["init"]);
				if (init.cancelled) return;
				if (!init.ok) throw new StepError(`init failed: ${tail(init.output) || "no output"}`);
				const current = await readFile(facts.configPath, "utf8").catch(() => null);
				const next = current === null ? null : withoutLocalEmbeddings(current);
				if (next !== null) await writeFile(facts.configPath, next);
			}
			const args = ["setup", "--yes", "--agent", "omp", ...(this.#deps.noService ? ["--no-service"] : [])];
			const setup = await this.#run(resolved.bin, args);
			if (setup.cancelled) return;
			const problems = parseProblems(setup.output);
			// Right after the service starts, setup's own self-check can ask before the server listens; the poll below
			// is the real test. Any other problem is a failure.
			const fatal = problems.filter(problem => !problem.startsWith("self-check"));
			if (!setup.ok && (fatal.length > 0 || problems.length === 0)) {
				throw new StepError(`setup failed: ${fatal.join("; ") || tail(setup.output) || "no output"}`);
			}
			const toml = facts?.configPath ? await readFile(facts.configPath, "utf8").catch(() => null) : null;
			this.#patch({ serverUrl: serverUrlFromConfig(toml) });
			const wiring = await this.#wiring();
			this.#patch({ wiring });
			if (!wiring.extension || !wiring.mcp) {
				throw new StepError(
					`setup finished but omp's ${wiring.extension ? "MCP entry" : "extension"} is not in ${this.#deps.agentDir()}`,
				);
			}
			this.#step("check");
			const up = await this.#waitHealthy();
			this.#patch({
				phase: up ? "ready" : "unreachable",
				step: null,
				detail: up ? null : "The server does not answer yet.",
			});
			this.#downPolls = 0;
			if (up) await this.#readStats();
			this.#startPolling();
			if (resolved.staged) void pruneStaged(this.#deps.toolsDir);
		} catch (error) {
			this.#fail(error);
		}
	}

	/**
	 * Off (or purge): ai-memory's own uninstall (hooks, MCP entry, skills, the service); throws when it fails.
	 * A purge then wipes the data folders itself. `uninstall --purge-data` would do that too, but it refuses while any
	 * process named `ai-memory` runs, and every live omp session has one (its `mcp-bridge`, a stdio relay that holds
	 * no database): with sessions open it could never run. Only the server owns the database, and it is stopped.
	 */
	async #disable(purge: boolean): Promise<void> {
		this.#stopPolling();
		try {
			this.#step(purge ? "purge" : "unwire");
			const resolved = this.#resolved ?? (await this.#resolve());
			this.#resolved = resolved;
			const result = await this.#run(resolved.bin, ["uninstall", "--apply", "--yes"]);
			if (result.cancelled) return;
			if (!result.ok) {
				throw new StepError(
					`${purge ? "Purge" : "Turning memory off"} failed: ${tail(result.output) || "no output"}`,
				);
			}
			if (purge) await this.#wipeData();
			this.#patch({
				phase: "off",
				step: null,
				detail: null,
				wiring: await this.#wiring(),
				stats: null,
			});
		} catch (error) {
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
			throw new StepError("ai-memory's data directory is not known, so nothing was deleted.");
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

	/** Health, stats and the wiring files; heals by running `setup` again when the server stays down or a file went. */
	async #check(heal: boolean): Promise<void> {
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
		const missing = !wiring.extension || !wiring.mcp;
		const now = (this.#deps.now ?? Date.now)();
		if (heal && (broken || missing) && now - this.#lastRewire >= REWIRE_COOLDOWN_MS) {
			this.#lastRewire = now;
			this.#patch({ phase: "starting", step: "wire" });
			await this.#enqueue(() => this.#enable());
		}
	}

	#startPolling(): void {
		if (this.#timer || this.#disposed) return;
		this.#timer = setInterval(() => void this.#check(true).catch(() => undefined), this.#deps.pollMs ?? POLL_MS);
		this.#timer.unref();
	}

	#stopPolling(): void {
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
	}
}
