/**
 * This machine's automatic setup. At launch it detects every item; when
 * automatic, it installs the missing required items in order (Bun, Git for
 * Windows on Windows, omp; `omp update` for a too-old omp), then the missing
 * optional ones in the background. Nothing asks first: the renderer only
 * shows the state, and may retry or cancel by item id.
 *
 * Back-off: each item is attempted automatically at most once per launch, and
 * after three automatic attempts that left it missing, at most once a day
 * (`<userData>/setup-state.json`). A retry from the user always runs.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OmpUpdateFailure } from "../../shared/omp-update";
import {
	type GitAslrAction,
	type GitAslrResult,
	isSetupItemId,
	SETUP_ITEMS,
	SETUP_OUTPUT_TAIL,
	type SetupFailure,
	type SetupItemId,
	type SetupItemState,
	type SetupPlatform,
	type SetupState,
	setupItemAutomatic,
	setupItemRequired,
} from "../../shared/setup";
import { isNewer } from "../../shared/version";
import { ompUpdateEnv, parseUpdateCheck } from "../omp-runtime";
import { writeRuntimeLog } from "../runtime-log";
import { needsShell, spawnArgs, spawnCommand } from "../spawn";
import { type FetchText, fetchText, resolveArchiveRelease, resolveTailscaleRelease } from "./archives";
import { type Detection, detectMachine } from "./detect";
import { DownloadError, type DownloadFetch, downloadVerified } from "./download";
import {
	GIT_ASLR_RECORD,
	gitAslrSpawn,
	parseFixOutput,
	parseUndoOutput,
	readGitAslrRecord,
	recordedImages,
	undoInput,
	withFixed,
	withRestored,
	writeGitAslrRecord,
} from "./git-aslr";
import { refreshPath } from "./paths";
import {
	type ArchiveRelease,
	buildPlan,
	manualSteps,
	type PlanContext,
	type PlanDownload,
	type SpawnSpec,
	selectMethod,
	type TailscaleRelease,
	tailscaleMsiArch,
} from "./plans";
import { type RunOutcome, SetupRunner } from "./runner";

/** Automatic attempts before an item waits BACKOFF_MS between automatic attempts. */
const BACKOFF_AFTER = 3;
export const BACKOFF_MS = 24 * 60 * 60 * 1000;
const OUTPUT_EMIT_MS = 100;

interface AttemptRecord {
	failures: number;
	lastAttempt: number;
}

export interface SetupServiceDeps {
	platform: SetupPlatform;
	arch: string;
	systemRoot: string;
	toolsDir: string;
	bunInstall: string;
	/** Back-off ledger (JSON). */
	statePath: string;
	/** Install on its own at launch; false in tests and dev builds (detection still runs). */
	automatic: boolean;
	/** `OMP_GUI_TEST_INSTALLER`: every plan runs `<installer> <item> <method>` instead (e2e). */
	testInstaller: string | null;
	/** Environment for installer processes (login-shell PATH, proxies). */
	spawnEnv: () => Promise<NodeJS.ProcessEnv>;
	onState: (state: SetupState) => void;
	/** omp became usable after an install: restart what failed for lack of it. */
	onOmpReady: () => void;
	/** Resolves when setup's automatic optional installs may start (main: once the first tab is ready). */
	beforeOptional?: () => Promise<void>;
	detect?: (platform: SetupPlatform, bunInstall: string) => Promise<Detection>;
	runner?: SetupRunner;
	fetchText?: FetchText;
	/** Downloads main runs itself (download.ts). */
	fetch?: DownloadFetch;
	/** `OMP_GUI_TEST_DOWNLOAD(_SHA256)`: under the test installer, every plan first downloads this (e2e progress). */
	testDownload?: { url: string; sha256: string } | null;
	refreshPath?: (platform: SetupPlatform, toolsDir: string) => Promise<void>;
	now?: () => number;
}

/** Placeholder release for archive plans under OMP_GUI_TEST_INSTALLER, which never downloads it. */
const TEST_RELEASE = { version: "0.0.0", file: "test", url: "https://example.invalid/test", sha256: "0".repeat(64) };

/** Lines of installer output kept as the reason an omp update failed. */
const UPDATE_DETAIL_LINES = 6;
/** `omp update --check` asks the registry (or the build service) once; stock's own metadata timeout is shorter. */
const UPDATE_CHECK_TIMEOUT_MS = 60_000;

const CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** The last lines of an installer's output without color codes: why `omp update` did not update. */
function updateDetail(output: string): string | undefined {
	const lines = output
		.replace(CSI, "")
		.split(/\r?\n|\r/)
		.map(line => line.trim())
		.filter(Boolean);
	return lines.slice(-UPDATE_DETAIL_LINES).join("\n") || undefined;
}

/**
 * Installer output that says the machine could not reach the internet: curl's
 * "Could not resolve host" / exit-6/7/28 messages, Bun's `ConnectionRefused`
 * and `FailedToOpenSocket`, Node's `ENOTFOUND` family, PowerShell's "remote
 * name could not be resolved". A 5xx from a registry is not in this list: the
 * network works, the server does not.
 */
const OFFLINE_OUTPUT = new RegExp(
	[
		"ENOTFOUND",
		"EAI_AGAIN",
		"ETIMEDOUT",
		"ECONNREFUSED",
		"ECONNRESET",
		"ENETUNREACH",
		"ConnectionRefused",
		"ConnectionClosed",
		"FailedToOpenSocket",
		"getaddrinfo",
		"Could not resolve host",
		"Couldn't resolve host",
		"Temporary failure in name resolution",
		"Network is unreachable",
		"curl: \\((6|7|28)\\)",
		"remote name could not be resolved",
		"Unable to connect to the remote server",
	].join("|"),
	"i",
);

/**
 * How `updateOmp` ended. `skipped`: omp is missing, outdated or broken (the
 * install pipeline owns that), or the app is quitting.
 */
export type OmpUpdateOutcome =
	| { kind: "updated"; version: string }
	| { kind: "failed"; failure: OmpUpdateFailure }
	| { kind: "skipped" };

/** One vendor CLI update for `SetupService.runToolUpdate` (src/main/cli-tools/updater.ts). */
export interface ToolUpdateRequest {
	/** The tool and its update method; the fake installer is called `<installer> cli-<tool> <method> update`. */
	tool: string;
	method: string;
	/** The owner's update command; null with `managed`. */
	spawn: SpawnSpec | null;
	/** Machine setup's own archive of this item again (the copy in the managed tools dir). */
	managed?: "gh" | "node";
	/** Added to the installer environment (BUN_INSTALL, HOMEBREW_NO_AUTO_UPDATE). */
	env: Record<string, string>;
}

/** `skipped`: the app is quitting, or setup cannot run here. */
export type ToolUpdateOutcome =
	| { kind: "succeeded" }
	| { kind: "failed"; detail?: string }
	| { kind: "cancelled" }
	| { kind: "skipped" };

export class SetupService {
	readonly #deps: SetupServiceDeps;
	readonly #runner: SetupRunner;
	readonly #items: Record<SetupItemId, SetupItemState>;
	#detection: Detection | null = null;
	#queue: Promise<void> = Promise.resolve();
	#requiredRunning = false;
	#stopPipeline = false;
	#disposed = false;
	#attemptedThisLaunch = new Set<SetupItemId>();
	#emitTimer: NodeJS.Timeout | null = null;
	/** The download main runs right now, if any; a cancel aborts it. */
	#download: AbortController | null = null;
	/** The item whose install attempt is in the ledger and has not ended yet. */
	#installing: SetupItemId | null = null;

	constructor(deps: SetupServiceDeps) {
		this.#deps = deps;
		this.#runner = deps.runner ?? new SetupRunner();
		this.#items = Object.fromEntries(
			SETUP_ITEMS.map(id => {
				const manual = manualSteps(id, null, deps.platform);
				const item: SetupItemState = {
					id,
					required: setupItemRequired(id, deps.platform),
					phase: "checking",
					presence: null,
					method: null,
					command: null,
					location: null,
					prompt: null,
					progress: null,
					output: "",
					failure: null,
					manualCommands: manual.commands,
					manualUrl: manual.url,
				};
				return [id, item];
			}),
		) as Record<SetupItemId, SetupItemState>;
	}

	state(): SetupState {
		const omp = this.#items.omp.presence;
		return {
			platform: this.#deps.platform,
			automatic: this.#deps.automatic,
			ompReady: omp?.kind === "present",
			requiredRunning: this.#requiredRunning,
			items: SETUP_ITEMS.map(id => ({ ...this.#items[id] })),
		};
	}

	/**
	 * Detect, then (when automatic) install what is missing: required first, optional in the background once
	 * `beforeOptional` lets them (the first tab boots before gh and Node compete with it for the machine).
	 */
	async start(): Promise<void> {
		await this.#enqueue(async () => {
			await this.#detect();
			if (!this.#deps.automatic || this.#deps.platform === "other") return;
			await this.#runRequired(false);
		});
		if (!this.#deps.automatic || this.#deps.platform === "other") return;
		await this.#deps.beforeOptional?.();
		await this.#enqueue(() => this.#runOptionalAfterRequired());
	}

	/** Retry `item` now. A required item retries every missing required item in order. */
	retry(item: unknown): Promise<void> {
		if (!isSetupItemId(item)) return Promise.reject(new Error(`Unknown setup item: ${String(item)}`));
		if (this.#deps.platform === "other") return Promise.reject(new Error("Setup is not available on this platform"));
		const required = this.#items[item].required;
		if (required) this.#markQueued(this.#requiredItems(), true);
		else this.#markQueued([item], true);
		return this.#enqueue(async () => {
			await this.#detect();
			if (required) {
				await this.#runRequired(true);
				await this.#runOptionalAfterRequired();
			} else await this.#runOptional([item], true);
		});
	}

	/**
	 * A connection the user started needs optional `item` (gh for the GitHub sign-in, Node for the built-in
	 * REA server): detect it again and, when it is missing, install it right now — the user's own action, so
	 * like a Retry it skips the back-off and the once-per-launch rule — queued behind any install that runs
	 * now. Resolves with the item's state once that attempt ended. Without automatic setup (dev builds, test
	 * launches without the fake installer) it only detects.
	 */
	installForConnection(item: unknown): Promise<SetupItemState> {
		if (!isSetupItemId(item) || setupItemRequired(item, this.#deps.platform)) {
			return Promise.reject(new Error(`Not an optional setup item: ${String(item)}`));
		}
		const install = this.#deps.automatic && this.#deps.platform !== "other";
		if (install) this.#markQueued([item], true);
		return this.#enqueue(async () => {
			await this.#detect();
			if (install) await this.#runOptional([item], true);
		}).then(() => ({ ...this.#items[item] }));
	}

	/**
	 * Stock `omp update` (the omp item's `omp-update` plan) under the supervisor,
	 * in the background, queued behind any install that runs now. It never asks
	 * and never looks at what omp is doing: running omp processes keep the code
	 * they loaded. `beforeInstall` runs once omp is known to be present, just
	 * before the installer starts (main stops the helpers that read omp's files
	 * from disk). After it, omp is detected again; `target` is the version the
	 * registry announced, and an omp still older than it is a failure.
	 */
	updateOmp(target: string, beforeInstall?: () => Promise<void>): Promise<OmpUpdateOutcome> {
		const { promise, resolve } = Promise.withResolvers<OmpUpdateOutcome>();
		const settled = this.#enqueue(async () => {
			resolve(await this.#updateOmp(target, beforeInstall));
		});
		// A disposed service runs no task: settle as skipped. After a normal finish this resolve is a no-op.
		settled.then(
			() => resolve({ kind: "skipped" }),
			error => resolve({ kind: "failed", failure: { reason: "install", detail: String(error) } }),
		);
		return promise;
	}

	/**
	 * The newest omp for the omp OMPdesk runs: stock `omp update --check`, run on the detected omp in the
	 * environment `updateOmp` gives `omp update` (`ompUpdateEnv`), so the check follows the same registry
	 * (.npmrc, bunfig, `npm_config_registry`), channel (`update.channel`) and install method (Bun, npm,
	 * Homebrew, mise, standalone binary) as the update it leads to, and judges that same install. Rejects
	 * while omp is missing and with stock's own reason when the check fails.
	 */
	async latestOmp(): Promise<string> {
		const omp = this.#detection?.omp;
		if (!omp || this.#items.omp.presence?.kind !== "present") throw new Error("omp is not installed");
		const platform = this.#deps.platform === "win32" ? "win32" : "darwin";
		const env = { ...(await this.#updateEnv(omp)), NO_COLOR: "1", FORCE_COLOR: "0" };
		const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
		execFile(
			spawnCommand(omp, platform),
			spawnArgs(omp, ["update", "--check"], platform),
			{ env, shell: needsShell(omp, platform), timeout: UPDATE_CHECK_TIMEOUT_MS, windowsHide: true },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code, output: code === 0 ? stdout : stderr || stdout || (error?.message ?? "") });
			},
		);
		const { code, output } = await promise;
		const parsed = code === 0 ? parseUpdateCheck(output) : null;
		if (!parsed) throw new Error(updateDetail(output) ?? `omp update --check exited with code ${code}`);
		return parsed.latestVersion;
	}

	/** The newest release of machine setup's verified archive for gh or Node (`runToolUpdate`'s `managed` update installs it). */
	async latestManaged(item: "gh" | "node"): Promise<string> {
		const release = await resolveArchiveRelease(item, this.#deps.arch, this.#deps.fetchText ?? fetchText);
		return release.version;
	}

	/**
	 * One vendor CLI's update (src/main/cli-tools/): its owner's command, or machine setup's own verified
	 * archive again for the gh or Node copy in the managed tools dir, under the supervisor, queued behind any
	 * install. It never touches the setup items' state; This computer's Cancel and quitting stop it.
	 */
	runToolUpdate(request: ToolUpdateRequest): Promise<ToolUpdateOutcome> {
		const { promise, resolve } = Promise.withResolvers<ToolUpdateOutcome>();
		const settled = this.#enqueue(async () => {
			resolve(await this.#runToolUpdate(request));
		});
		// A disposed service runs no task: settle as skipped. After a normal finish this resolve is a no-op.
		settled.then(
			() => resolve({ kind: "skipped" }),
			error => resolve({ kind: "failed", detail: String(error) }),
		);
		return promise;
	}

	async #runToolUpdate(request: ToolUpdateRequest): Promise<ToolUpdateOutcome> {
		if (this.#disposed || this.#deps.platform === "other") return { kind: "skipped" };
		const installer = this.#deps.testInstaller;
		let spawn: SpawnSpec;
		let download: PlanDownload | null = null;
		if (installer) {
			const platform = this.#deps.platform === "win32" ? "win32" : "darwin";
			spawn = {
				file: spawnCommand(installer, platform),
				args: spawnArgs(installer, [`cli-${request.tool}`, request.method, "update"], platform),
				shell: needsShell(installer, platform),
			};
			download = this.#testDownload();
		} else if (request.spawn) {
			spawn = request.spawn;
		} else if (request.managed) {
			if (!this.#detection) await this.#detect();
			const detection = this.#detection;
			let release: ArchiveRelease;
			try {
				release = await resolveArchiveRelease(request.managed, this.#deps.arch, this.#deps.fetchText ?? fetchText);
			} catch (error) {
				return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
			}
			const plan = detection ? buildPlan(request.managed, "archive", this.#planContext(detection), release) : null;
			if (!plan) return { kind: "failed", detail: `no archive plan for ${request.managed}` };
			spawn = plan.spawn;
			download = plan.download;
		} else return { kind: "skipped" };
		let output = "";
		try {
			if (download) {
				const controller = new AbortController();
				this.#download = controller;
				try {
					await downloadVerified({
						...download,
						signal: controller.signal,
						onProgress: () => {},
						...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
					});
				} catch (error) {
					if (controller.signal.aborted) return { kind: "cancelled" };
					return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
				} finally {
					this.#download = null;
				}
			}
			const env = { ...(await this.#installEnv()), ...request.env };
			const outcome = await this.#runner.run(spawn, env, chunk => {
				output = (output + chunk).slice(-SETUP_OUTPUT_TAIL);
			});
			if (outcome.kind === "cancelled") return { kind: "cancelled" };
			if (outcome.kind === "failed") {
				const exit = outcome.exitCode === null ? undefined : `exit ${outcome.exitCode}`;
				const detail = [exit, updateDetail(output) ?? outcome.detail].filter(Boolean).join(" — ");
				return { kind: "failed", ...(detail ? { detail } : {}) };
			}
			return { kind: "succeeded" };
		} finally {
			if (download) await rm(download.file, { force: true });
		}
	}

	/** Cancel the running install (its download or its process) and the rest of its pipeline. */
	cancel(): boolean {
		if (this.#download) {
			this.#stopPipeline = true;
			this.#download.abort();
			return true;
		}
		if (!this.#runner.running) return false;
		this.#stopPipeline = true;
		return this.#runner.cancel();
	}

	/**
	 * The Git item's Mandatory ASLR override (git-aslr.ts), only ever on the user's click: one elevated step for
	 * the MSYS executables of the Git setup detected, then a fresh detection that shows the probe's new result.
	 * Fix adds what it changed (with each image's prior state) to `git-aslr.json`; Undo puts back only those and
	 * drops them from it. Without a record Undo is refused (the UI does not offer it).
	 */
	gitAslr(action: GitAslrAction): Promise<GitAslrResult> {
		const { promise, resolve } = Promise.withResolvers<GitAslrResult>();
		void this.#enqueue(async () => {
			const git = this.#items.git.presence;
			const root = git?.kind === "present" ? git.path : null;
			if (this.#deps.platform !== "win32" || !root) {
				resolve({ ok: false, detail: "Git for Windows was not found" });
				return;
			}
			const dir = dirname(this.#deps.statePath);
			const recordFile = join(dir, GIT_ASLR_RECORD);
			const files = { input: join(dir, "git-aslr-in.json"), output: join(dir, "git-aslr-out.json") };
			const recorded = recordedImages(await readGitAslrRecord(recordFile), root);
			if (action === "undo") {
				if (recorded.length === 0) {
					resolve({ ok: false, detail: "No record of what Fix changed, so there is nothing to undo exactly" });
					return;
				}
				await writeFile(files.input, undoInput(recorded), { mode: 0o600 });
			}
			await rm(files.output, { force: true });
			let output = "";
			const outcome = await this.#runner.run(
				gitAslrSpawn(this.#deps.systemRoot, root, action, files),
				await this.#deps.spawnEnv(),
				chunk => {
					output = (output + chunk).slice(-SETUP_OUTPUT_TAIL);
				},
			);
			// Read even after a failure: the step writes its output after every image it changed.
			const written = await readFile(files.output, "utf8").catch(() => "");
			await Promise.all([rm(files.output, { force: true }), rm(files.input, { force: true })]);
			const fixed = action === "fix" ? parseFixOutput(written) : [];
			const restored = action === "undo" ? parseUndoOutput(written) : [];
			const record = await readGitAslrRecord(recordFile);
			await writeGitAslrRecord(
				recordFile,
				action === "fix" ? withFixed(record, root, fixed) : withRestored(record, root, restored),
			);
			const images = action === "fix" ? fixed.map(image => image.path) : restored;
			writeRuntimeLog({
				source: "setup",
				message: `Git Mandatory ASLR override ${action}: ${outcome.kind}`,
				details: {
					level: outcome.kind === "succeeded" ? "info" : "warn",
					root,
					action,
					outcome: outcome.kind,
					images,
					output: updateDetail(output) ?? null,
				},
			});
			await this.#detect();
			resolve(
				outcome.kind === "succeeded"
					? { ok: true, images: images.length }
					: {
							ok: false,
							detail: updateDetail(output) ?? (outcome.kind === "failed" ? (outcome.detail ?? "") : ""),
						},
			);
		}).catch(error => resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
		return promise;
	}

	/** App quit: stop the running download or installer tree and start nothing new. */
	dispose(): void {
		this.#disposed = true;
		this.#uncountRunning();
		this.#stopPipeline = true;
		this.#download?.abort();
		this.#runner.cancel();
		clearTimeout(this.#emitTimer ?? undefined);
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(async () => {
			if (this.#disposed) return;
			this.#stopPipeline = false;
			await task();
		});
		this.#queue = next.catch(() => undefined);
		return next;
	}

	#requiredItems(): SetupItemId[] {
		return SETUP_ITEMS.filter(id => this.#items[id].required);
	}

	/** The optional items setup installs on its own at launch; Tailscale waits for a click. */
	#optionalItems(): SetupItemId[] {
		return SETUP_ITEMS.filter(id => !this.#items[id].required && setupItemAutomatic(id));
	}

	#markQueued(items: SetupItemId[], manual: boolean): void {
		for (const id of items) {
			const item = this.#items[id];
			if (item.presence?.kind === "present" || item.phase === "running") continue;
			if (!manual && !this.#mayAttempt(id)) continue;
			item.phase = "queued";
		}
		if (items.some(id => this.#items[id].required)) this.#requiredRunning = true;
		this.#emit();
	}

	async #detect(): Promise<void> {
		const detection = await (this.#deps.detect ?? detectMachine)(this.#deps.platform, this.#deps.bunInstall);
		const git = detection.presence.git;
		if (git.kind === "present" && git.gitAslrOverride && git.path) {
			const record = await readGitAslrRecord(join(dirname(this.#deps.statePath), GIT_ASLR_RECORD));
			if (recordedImages(record, git.path).length > 0) detection.presence.git = { ...git, gitAslrUndoable: true };
		}
		this.#detection = detection;
		for (const id of SETUP_ITEMS) {
			const item = this.#items[id];
			const presence = detection.presence[id];
			item.presence = presence;
			const manual = manualSteps(id, presence, this.#deps.platform);
			item.manualCommands = manual.commands;
			item.manualUrl = manual.url;
			if (presence.kind === "present") {
				// An Xcode-tools request (or a Settings retry) that finished meanwhile.
				if (item.phase !== "running") {
					item.phase = "present";
					item.failure = null;
				}
				this.#clearAttempts(id);
			} else if (item.phase === "checking") {
				item.phase = setupItemAutomatic(id) && this.#deps.automatic && !this.#mayAttempt(id) ? "backoff" : "idle";
			}
		}
		this.#emit();
	}

	async #updateOmp(target: string, beforeInstall?: () => Promise<void>): Promise<OmpUpdateOutcome> {
		await this.#detect();
		const item = this.#items.omp;
		const detection = this.#detection;
		const unsupported = this.#deps.platform === "other";
		if (
			!detection ||
			unsupported ||
			this.#disposed ||
			item.presence?.kind !== "present" ||
			item.phase === "running"
		) {
			return { kind: "skipped" };
		}
		const plan = buildPlan("omp", "omp-update", this.#planContext(detection));
		if (!plan || !detection.omp) return { kind: "skipped" };
		const env = await this.#updateEnv(detection.omp);
		await beforeInstall?.().catch(() => undefined);
		item.method = "omp-update";
		item.command = plan.command;
		item.location = plan.location;
		item.prompt = null;
		item.output = "";
		item.failure = null;
		item.phase = "running";
		item.progress = { step: 1, steps: 1, startedAt: (this.#deps.now ?? Date.now)(), download: null };
		this.#emit();
		let outcome: RunOutcome;
		try {
			outcome = await this.#runner.run(this.#spec(plan.spawn, "omp", "omp-update"), env, chunk => {
				item.output = (item.output + chunk).slice(-SETUP_OUTPUT_TAIL);
				this.#emitSoon();
			});
		} finally {
			item.progress = null;
			item.phase = "checking";
		}
		await (this.#deps.refreshPath ?? refreshPath)(this.#deps.platform, this.#deps.toolsDir);
		await this.#detect();
		const reason = updateDetail(item.output);
		const detail = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" — ") || undefined;
		if (outcome.kind === "cancelled") return { kind: "failed", failure: { reason: "cancelled" } };
		if (outcome.kind === "failed") {
			const exit = outcome.exitCode === null ? undefined : `exit ${outcome.exitCode}`;
			return { kind: "failed", failure: { reason: "install", detail: detail(exit, reason) } };
		}
		const presence = item.presence;
		if (presence?.kind !== "present")
			return { kind: "failed", failure: { reason: "unusable", detail: detail(reason) } };
		if (presence.version && !isNewer(target, presence.version)) {
			return { kind: "updated", version: presence.version };
		}
		return { kind: "failed", failure: { reason: "not-updated", detail: detail(reason) } };
	}

	async #runRequired(manual: boolean): Promise<void> {
		const wasReady = this.#items.omp.presence?.kind === "present";
		const items = this.#requiredItems();
		try {
			await this.#installEach(items, manual);
		} finally {
			this.#requiredRunning = false;
			for (const id of items) if (this.#items[id].phase === "queued") this.#items[id].phase = "idle";
			this.#emit();
		}
		if (!wasReady && this.#items.omp.presence?.kind === "present" && !this.#disposed) this.#deps.onOmpReady();
	}

	/**
	 * Optional items install in the background once omp works; while it does not,
	 * the setup screen is all the user has, and a retry there must not wait behind
	 * a long `brew install`.
	 */
	async #runOptionalAfterRequired(): Promise<void> {
		if (!this.#deps.automatic || this.#items.omp.presence?.kind !== "present") return;
		await this.#runOptional(this.#optionalItems(), false);
	}

	async #runOptional(items: SetupItemId[], manual: boolean): Promise<void> {
		try {
			await this.#installEach(items, manual);
		} finally {
			for (const id of items) if (this.#items[id].phase === "queued") this.#items[id].phase = "idle";
			this.#emit();
		}
	}

	/** Queue `items`, then install them in order; each running one knows its place among the queued ones. */
	async #installEach(items: SetupItemId[], manual: boolean): Promise<void> {
		this.#markQueued(items, manual);
		const run = items.filter(id => this.#items[id].phase === "queued");
		for (const id of items) {
			if (this.#stopPipeline || this.#disposed) break;
			await this.#ensure(id, manual, { step: run.indexOf(id) + 1, steps: run.length });
		}
	}

	/** Install `id` if it is missing and allowed to run now. */
	async #ensure(id: SetupItemId, manual: boolean, place: { step: number; steps: number }): Promise<void> {
		const item = this.#items[id];
		const detection = this.#detection;
		if (!detection || !item.presence || item.presence.kind === "present") return;
		if (!manual && !this.#mayAttempt(id)) {
			item.phase = "backoff";
			this.#emit();
			return;
		}
		const ctx = this.#planContext(detection);
		const method = selectMethod(id, item.presence, ctx);
		if (!method) {
			item.phase = "unavailable";
			item.method = null;
			this.#emit();
			return;
		}
		item.method = method;
		let release: ArchiveRelease | undefined;
		if (method === "archive" && (id === "gh" || id === "node")) {
			if (this.#deps.testInstaller) release = { item: id, ...TEST_RELEASE };
			else {
				try {
					release = await resolveArchiveRelease(id, this.#deps.arch, this.#deps.fetchText ?? fetchText);
				} catch (error) {
					this.#fail(id, { reason: "download", detail: error instanceof Error ? error.message : String(error) });
					return;
				}
			}
		}
		let tailscale: TailscaleRelease | undefined;
		if (method === "tailscale-zip" || method === "tailscale-msi") {
			if (this.#deps.testInstaller) {
				tailscale = { ...TEST_RELEASE, file: method === "tailscale-zip" ? "test.zip" : "test.msi" };
			} else {
				try {
					const platform = method === "tailscale-zip" ? "darwin" : "win32";
					tailscale = await resolveTailscaleRelease(
						platform,
						tailscaleMsiArch(this.#deps.arch),
						this.#deps.fetchText ?? fetchText,
					);
				} catch (error) {
					this.#fail(id, { reason: "download", detail: error instanceof Error ? error.message : String(error) });
					return;
				}
			}
		}
		const plan = buildPlan(id, method, ctx, release, tailscale);
		if (!plan) {
			// Only omp has a prerequisite (Bun).
			this.#fail(id, { reason: "prerequisite", detail: "bun" });
			return;
		}
		item.command = plan.command;
		item.location = plan.location;
		item.prompt = plan.prompt;
		item.output = "";
		item.failure = null;
		item.phase = "running";
		const download = this.#deps.testInstaller ? this.#testDownload() : plan.download;
		item.progress = {
			...place,
			startedAt: (this.#deps.now ?? Date.now)(),
			download: download ? { received: 0, total: null } : null,
		};
		// Tailscale is only ever installed on the user's click: no once-per-launch rule, no back-off ledger.
		if (setupItemAutomatic(id)) {
			this.#attemptedThisLaunch.add(id);
			this.#recordAttempt(id);
		}
		this.#installing = id;
		this.#emit();
		try {
			if (download && !(await this.#fetch(id, download))) return;
			const outcome = await this.#runner.run(this.#spec(plan.spawn, id, method), await this.#installEnv(), chunk => {
				item.output = (item.output + chunk).slice(-SETUP_OUTPUT_TAIL);
				this.#emitSoon();
			});
			item.progress = null;
			await this.#settle(id, outcome);
		} finally {
			this.#installing = null;
			item.progress = null;
			if (download) await rm(download.file, { force: true });
		}
	}

	/** The test download every plan runs first under the test installer, if one is set. */
	#testDownload(): PlanDownload | null {
		const test = this.#deps.testDownload;
		return test ? { ...test, file: join(this.#deps.toolsDir, ".downloads", "test-download") } : null;
	}

	/** Download the plan's file in main with byte progress; false when it failed or was cancelled (already reported). */
	async #fetch(id: SetupItemId, download: PlanDownload): Promise<boolean> {
		const item = this.#items[id];
		const controller = new AbortController();
		this.#download = controller;
		try {
			await downloadVerified({
				...download,
				signal: controller.signal,
				onProgress: value => {
					if (item.progress) item.progress = { ...item.progress, download: { ...value } };
					this.#emitSoon();
				},
				...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
			});
		} catch (error) {
			item.progress = null;
			if (controller.signal.aborted) {
				this.#uncountRunning();
				item.phase = "cancelled";
				item.failure = null;
				this.#emit();
			} else {
				this.#fail(id, {
					reason: error instanceof DownloadError ? error.reason : "download",
					detail: error instanceof Error ? error.message : String(error),
				});
			}
			return false;
		} finally {
			this.#download = null;
		}
		if (item.progress) item.progress = { ...item.progress, download: null };
		this.#emit();
		return true;
	}

	async #settle(id: SetupItemId, outcome: RunOutcome): Promise<void> {
		const item = this.#items[id];
		if (outcome.kind === "cancelled") {
			this.#uncountRunning();
			item.phase = "cancelled";
			item.failure = null;
			this.#emit();
			return;
		}
		if (outcome.kind === "failed") {
			const checksum = /SHA-256 mismatch|: FAILED/.test(item.output);
			const offline = outcome.reason === "exit" && OFFLINE_OUTPUT.test(item.output);
			this.#fail(id, {
				reason: checksum ? "checksum" : offline ? "network" : outcome.reason,
				exitCode: outcome.exitCode,
				...(outcome.detail ? { detail: outcome.detail } : {}),
			});
			return;
		}
		await (this.#deps.refreshPath ?? refreshPath)(this.#deps.platform, this.#deps.toolsDir);
		item.phase = "checking";
		await this.#detect();
		if (item.presence?.kind === "present") return;
		if (item.method === "xcode-select") {
			// macOS took over with its own dialog; the next check (launch or retry) sees the result.
			item.phase = "requested";
			this.#emit();
			return;
		}
		this.#fail(id, { reason: "not-detected" });
	}

	#fail(id: SetupItemId, failure: SetupFailure): void {
		const item = this.#items[id];
		item.phase = "failed";
		item.failure = failure;
		this.#emit();
	}

	#spec(spawn: SpawnSpec, id: SetupItemId, method: string): SpawnSpec {
		const installer = this.#deps.testInstaller;
		if (!installer) return spawn;
		const platform = this.#deps.platform === "win32" ? "win32" : "darwin";
		return {
			file: spawnCommand(installer, platform),
			args: spawnArgs(installer, [id, method], platform),
			shell: needsShell(installer, platform),
		};
	}

	async #installEnv(): Promise<NodeJS.ProcessEnv> {
		const env: NodeJS.ProcessEnv = { ...(await this.#deps.spawnEnv()), BUN_INSTALL: this.#deps.bunInstall };
		if (this.#deps.platform === "win32") {
			// Installers run Windows PowerShell through the supervisor. A PSModulePath inherited from PowerShell 7 (OMPdesk
			// started from pwsh) lists PS7's modules first; Windows PowerShell then resolves Microsoft.PowerShell.Utility to a
			// version it cannot load, and Get-FileHash and friends are "not recognized". Without it, it builds its own default.
			for (const key of Object.keys(env)) if (key.toUpperCase() === "PSMODULEPATH") Reflect.deleteProperty(env, key);
		}
		return env;
	}

	/** `omp update` and its `--check` for `omp` (the detected one): its own folder first on PATH, its own Bun root. */
	async #updateEnv(omp: string): Promise<NodeJS.ProcessEnv> {
		const env = await this.#installEnv();
		// Windows' environment names it `Path` and ignores case: read it under any spelling and leave one key, since
		// beside a second spelling Node hands the child only the first in sort order.
		const win = this.#deps.platform === "win32";
		const keys = Object.keys(env).filter(key => (win ? key.toUpperCase() === "PATH" : key === "PATH"));
		const base = env.PATH ?? keys.map(key => env[key]).find(Boolean) ?? "";
		for (const key of keys) Reflect.deleteProperty(env, key);
		return { ...env, ...ompUpdateEnv(omp, base) };
	}

	#planContext(detection: Detection): PlanContext {
		return {
			platform: this.#deps.platform,
			arch: this.#deps.arch,
			bunInstall: this.#deps.bunInstall,
			toolsDir: this.#deps.toolsDir,
			bun: detection.bun,
			omp: detection.omp,
			brew: detection.brew,
			winget: detection.winget,
			systemRoot: this.#deps.systemRoot,
		};
	}

	#readLedger(): Partial<Record<SetupItemId, AttemptRecord>> {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#deps.statePath, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return {};
			const ledger: Partial<Record<SetupItemId, AttemptRecord>> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (!isSetupItemId(key) || typeof value !== "object" || value === null) continue;
				const failures = "failures" in value ? value.failures : undefined;
				const lastAttempt = "lastAttempt" in value ? value.lastAttempt : undefined;
				if (typeof failures === "number" && typeof lastAttempt === "number")
					ledger[key] = { failures, lastAttempt };
			}
			return ledger;
		} catch {
			return {};
		}
	}

	#writeLedger(ledger: Partial<Record<SetupItemId, AttemptRecord>>): void {
		try {
			writeFileSync(this.#deps.statePath, `${JSON.stringify(ledger, null, "\t")}\n`);
		} catch {
			// Best effort: without the ledger every launch simply tries again.
		}
	}

	/** Whether an automatic attempt may run now (once per launch; daily after BACKOFF_AFTER misses). */
	#mayAttempt(id: SetupItemId): boolean {
		if (this.#attemptedThisLaunch.has(id)) return false;
		const record = this.#readLedger()[id];
		if (!record || record.failures < BACKOFF_AFTER) return true;
		return (this.#deps.now ?? Date.now)() - record.lastAttempt >= BACKOFF_MS;
	}

	/** Counted when it starts: an attempt that leaves the item missing (or the app, by a crash) is a miss until detection says otherwise. */
	#recordAttempt(id: SetupItemId): void {
		const ledger = this.#readLedger();
		ledger[id] = { failures: (ledger[id]?.failures ?? 0) + 1, lastAttempt: (this.#deps.now ?? Date.now)() };
		this.#writeLedger(ledger);
	}

	/**
	 * Takes the running attempt back out of the ledger. A stop the user asked for (Cancel, or quitting the app
	 * mid-install) says nothing about the machine, so it must not move the item toward the daily back-off:
	 * three quits during a slow download would otherwise leave "Paused after failed attempts" on a first launch.
	 * A crash or kill runs no code, so it still counts.
	 */
	#uncountRunning(): void {
		const id = this.#installing;
		if (!id) return;
		this.#installing = null;
		const ledger = this.#readLedger();
		const record = ledger[id];
		if (!record) return;
		if (record.failures <= 1) delete ledger[id];
		else ledger[id] = { failures: record.failures - 1, lastAttempt: record.lastAttempt };
		this.#writeLedger(ledger);
	}

	#clearAttempts(id: SetupItemId): void {
		const ledger = this.#readLedger();
		if (!ledger[id]) return;
		delete ledger[id];
		this.#writeLedger(ledger);
	}

	#emit(): void {
		clearTimeout(this.#emitTimer ?? undefined);
		this.#emitTimer = null;
		this.#deps.onState(this.state());
	}

	#emitSoon(): void {
		this.#emitTimer ??= setTimeout(() => this.#emit(), OUTPUT_EMIT_MS);
	}
}
