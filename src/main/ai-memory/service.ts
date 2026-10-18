/**
 * ai-memory as OMPdesk's memory: stage the shipped binary, keep its per-user service running, give the omp sessions
 * OMPdesk spawns an app-owned extension root, and take back only OMPdesk's part on "off".
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
 *   off   OMPdesk stops loading the root and deletes it. The server stops only when OMPdesk started its service
 *         (`unit.ts`: the unit runs a binary OMPdesk staged) and nothing else uses it (`uninstall`'s dry run lists no
 *         other agent's wiring). `uninstall --apply` is never run: it removes every agent's wiring.
 *   terminal  "Also use in the terminal omp": ai-memory's own `setup --agent omp` into the real agent dir; the reverse
 *         removes just that extension and MCP entry (`terminal.ts`).
 *   purge the server is stopped (when it is OMPdesk's), the wiki/db/raw folders are deleted, then on again
 * Defaults stay ai-memory's: no LLM or cloud embedding provider (zero-LLM path; a fresh config opts out of the local
 * embedding model, see `config.ts`), the single-user cross-project profile.
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
import { needsShell, spawnArgs, spawnCommand } from "../spawn";
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
	stagingRoot,
} from "./binary";
import { AiMemoryClient, DEFAULT_SERVER_URL, serverUrlFromConfig } from "./client";
import { withoutLocalEmbeddings } from "./config";
import { generateRoot, removeRoot, rootComplete } from "./root";
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
	/** The Settings switch: only a stored `false` is off. */
	enabled: () => boolean;
	persistEnabled: (enabled: boolean) => void;
	/** `AI_MEMORY_TERMINAL_PREF`: undefined until the user (or the one-time migration) decided. */
	terminalPref: () => boolean | undefined;
	persistTerminal: (enabled: boolean) => void;
	/** `AI_MEMORY_SERVICE_OWNED_PREF`. */
	serviceOwnedPref: () => boolean | undefined;
	persistServiceOwned: (owned: boolean) => void;
	/** The OS service ai-memory's `setup` installs; absent: launchd on macOS, the logon entry on Windows. */
	unit?: ServiceControl;
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

/**
 * Lines of `uninstall`'s dry run that name no other client: the managed skills (shared by every agent) and ai-memory's
 * own service (launchd unit, systemd unit, the Windows logon entry), which is the very thing OMPdesk may stop.
 */
const NOT_A_CLIENT = /\(managed Agent Skill\)|logon entry|\bservice\b|launchd|systemd|HKCU|CurrentVersion\\Run/i;

/** A step failed; `message` is what Settings shows. */
class StepError extends Error {}

/** The user's cancel (the runner stopped a command): not a failure. */
class Cancelled extends Error {}

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
			wiring: { app: false, terminal: false },
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
				else await this.#restoreService();
				resolve();
			} catch (error) {
				if (this.#state.enabled) await this.#enable().catch(() => undefined);
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
		if (enabled && !this.#state.enabled) {
			reject(new Error("Turn memory on first."));
			return promise;
		}
		this.#enqueue(async () => {
			const { phase, detail } = this.#state;
			this.#patch({ phase: "starting", step: "terminal", detail: null });
			try {
				if (enabled) {
					const resolved = this.#resolved ?? (await this.#resolve());
					this.#resolved = resolved;
					await this.#setup(resolved.bin, { terminal: true, service: this.#deps.serviceOwnedPref() !== false });
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

	/** After a purge with memory off: a server other clients use comes back (OMPdesk stopped it to empty the data). */
	async #restoreService(): Promise<void> {
		const bin = this.#resolved?.bin;
		if (!bin || this.#deps.serviceOwnedPref() === false || !(await this.#othersUseServer(bin))) return;
		const terminal =
			this.#deps.terminalPref() === true && (await readTerminalWiring(this.#deps.agentDir())).extension;
		await this.#setup(bin, { terminal, service: true });
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

	/** What is on disk now: OMPdesk's own root, and ai-memory's wiring of the terminal omp. */
	async #wiring(): Promise<AiMemoryState["wiring"]> {
		const [app, terminal] = await Promise.all([
			rootComplete(this.#deps.rootDir),
			readTerminalWiring(this.#deps.agentDir()),
		]);
		return { app, terminal: terminal.extension || terminal.mcp };
	}

	/**
	 * What the omp sessions OMPdesk spawns load for memory: `-e <root>` while memory is on and the root is complete.
	 * A terminal omp wired by ai-memory already loads the same extension from omp's agent dir, so the root is left out
	 * then: a session never captures twice.
	 */
	async extensionArgs(): Promise<string[]> {
		if (!this.#deps.automatic || !this.#platformOk || !this.#deps.enabled()) return [];
		if (!(await rootComplete(this.#deps.rootDir))) return [];
		if ((await readTerminalWiring(this.#deps.agentDir())).extension) return [];
		return ["-e", this.#deps.rootDir];
	}

	get #unit(): ServiceControl {
		const { unit, platform, home, toolsDir } = this.#deps;
		if (unit) return unit;
		const owned = () => [stagingRoot(toolsDir), ...(this.#resolved ? [this.#resolved.bin] : [])];
		if (platform === "win32") return logonControl({ owned, dataDir: () => this.#state.dataDir });
		return launchdControl({ home, owned, uid: process.getuid?.() ?? 0 });
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

	async #run(
		bin: string,
		args: string[],
		extraEnv: NodeJS.ProcessEnv = {},
	): Promise<{ ok: boolean; cancelled: boolean; output: string }> {
		let output = "";
		// Its own commands read the working directory as "this project" (setup's doctor, `status`): a neutral one.
		const outcome = await this.#runner.run(
			{ file: spawnCommand(bin), args: spawnArgs(bin, args), shell: needsShell(bin) },
			{ ...(await this.#deps.spawnEnv()), ...extraEnv },
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

	/** Paths whose binaries OMPdesk runs: a unit or an MCP entry running one was written by OMPdesk. */
	#ownedPaths(): string[] {
		return [stagingRoot(this.#deps.toolsDir), ...(this.#resolved ? [this.#resolved.bin] : [])];
	}

	/**
	 * Whether OMPdesk started ai-memory's service and may stop it again. A service that was there before (a unit running
	 * someone else's binary, or a server that answered with no unit of ours) is theirs, and then `setup` runs with
	 * `--no-service` so it is never repointed. The answer is stored: it stays false once a service of someone else's was seen.
	 */
	async #serviceOwned(serverWasUp: boolean): Promise<boolean> {
		const unit = await this.#unit.inspect();
		const stored = this.#deps.serviceOwnedPref();
		const owned = unit.installed ? unit.ours && stored !== false : !serverWasUp;
		if (owned !== stored) this.#deps.persistServiceOwned(owned);
		return owned;
	}

	/**
	 * `setup` installs the service only together with an agent's wiring. For OMPdesk's server the agent dir is a
	 * scratch folder (deleted afterwards, with the shared skills `setup` newly created); a terminal omp the user
	 * connected is wired into its real agent dir by the very same command.
	 */
	async #setup(bin: string, options: { terminal: boolean; service: boolean }): Promise<void> {
		const args = [
			"setup",
			"--yes",
			"--agent",
			"omp",
			...(options.service && !this.#deps.noService ? [] : ["--no-service"]),
		];
		const { home } = this.#deps;
		const scratch = `${this.#deps.rootDir}.setup`;
		const skillsBefore = options.terminal ? null : await listSharedSkills(home);
		let result: { ok: boolean; cancelled: boolean; output: string };
		try {
			result = await this.#run(bin, args, options.terminal ? {} : { PI_CODING_AGENT_DIR: scratch });
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
			// Whether a server of someone else's already runs on this data dir (read before `init` can write a config).
			const before = facts?.configPath ? await readFile(facts.configPath, "utf8").catch(() => null) : null;
			if (before !== null) this.#patch({ serverUrl: serverUrlFromConfig(before) });
			const serverWasUp = before !== null && (await this.#client.healthy());
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
			const owned = await this.#serviceOwned(serverWasUp);

			// An earlier build wired omp globally (extension + MCP entry running OMPdesk's staged binary): move that to
			// the app-owned root, once. What the user connected themselves (their own `ai-memory setup`, or the button)
			// stays.
			const agentDir = this.#deps.agentDir();
			let terminal = await readTerminalWiring(agentDir);
			if (this.#deps.terminalPref() === undefined) {
				if (legacyOwned(terminal, this.#ownedPaths())) {
					await removeTerminalWiring(agentDir);
					terminal = await readTerminalWiring(agentDir);
				}
				this.#deps.persistTerminal(false);
			}
			// Keep a connected terminal omp pointed at the binary in use (an app update stages a new version).
			const terminalWired = this.#deps.terminalPref() === true && (terminal.extension || terminal.mcp);
			try {
				await this.#setup(resolved.bin, { terminal: terminalWired, service: owned });
			} catch (error) {
				if (error instanceof Cancelled) return;
				throw error;
			}
			const toml = facts?.configPath ? await readFile(facts.configPath, "utf8").catch(() => null) : null;
			this.#patch({ serverUrl: serverUrlFromConfig(toml) });
			const generated = await this.#generateRoot(resolved.bin);
			if (!generated) return;
			const wiring = await this.#wiring();
			this.#patch({ wiring });
			if (!wiring.app) throw new StepError(`ai-memory's extension root is not complete in ${this.#deps.rootDir}`);
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

	/**
	 * Whether another client uses the server besides OMPdesk's own sessions: the terminal omp, or any other agent
	 * ai-memory wired (`uninstall` without `--apply` only lists what it would remove and changes nothing; the shared
	 * skills are not a client). Unknown counts as in use: the server is then left running.
	 */
	async #othersUseServer(bin: string): Promise<boolean> {
		if ((await readTerminalWiring(this.#deps.agentDir())).extension) return true;
		const listing = await this.#run(bin, ["uninstall"]);
		if (!listing.ok) return true;
		return listing.output
			.split(/\r?\n/)
			.some(line => /^\s*would (delete|remove)\b/.test(line) && !NOT_A_CLIENT.test(line));
	}

	/** Stop OMPdesk's own service (never one it did not start) and wait for the server to go. */
	async #stopService(): Promise<void> {
		const unit = await this.#unit.inspect();
		if (!unit.installed || !unit.ours) return;
		await this.#unit.remove();
		const deadline = (this.#deps.now ?? Date.now)() + (this.#deps.healthWaitMs ?? HEALTH_WAIT_MS);
		while (await this.#client.healthy()) {
			if ((this.#deps.now ?? Date.now)() >= deadline) return;
			await sleep(HEALTH_STEP_MS);
		}
	}

	/**
	 * Off (or purge): OMPdesk stops loading ai-memory and deletes its extension root; its own service is stopped when
	 * nothing else uses it. Other agents' configs and the terminal omp's wiring are never touched. A purge stops the
	 * server first and then wipes the data folders itself (`uninstall --purge-data` would refuse while any `ai-memory`
	 * process runs, and every live omp session has one: its `mcp-bridge`, a stdio relay that holds no database).
	 * Throws when a step fails.
	 */
	async #disable(purge: boolean): Promise<void> {
		this.#stopPolling();
		try {
			this.#step(purge ? "purge" : "unwire");
			const resolved = this.#resolved ?? (await this.#resolve());
			this.#resolved = resolved;
			const owned = this.#deps.serviceOwnedPref() !== false;
			if (purge) {
				if (owned) await this.#stopService();
				await this.#wipeData();
			} else {
				await removeRoot(this.#deps.rootDir);
				if (owned && !(await this.#othersUseServer(resolved.bin))) await this.#stopService();
			}
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
		this.#timer = setInterval(() => void this.#check(true).catch(() => undefined), this.#deps.pollMs ?? POLL_MS);
		this.#timer.unref();
	}

	#stopPolling(): void {
		clearInterval(this.#timer ?? undefined);
		this.#timer = null;
	}
}
