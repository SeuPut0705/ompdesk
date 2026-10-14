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
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	isSetupItemId,
	SETUP_ITEMS,
	SETUP_OUTPUT_TAIL,
	type SetupFailure,
	type SetupItemId,
	type SetupItemState,
	type SetupPlatform,
	type SetupState,
	setupItemRequired,
} from "../../shared/setup";
import { ompNeedsShell, ompSpawnArgs, ompSpawnCommand } from "../omp-runtime";
import { type FetchText, fetchText, resolveArchiveRelease } from "./archives";
import { type Detection, detectMachine } from "./detect";
import { DownloadError, type DownloadFetch, downloadVerified } from "./download";
import { refreshPath } from "./paths";
import {
	type ArchiveRelease,
	buildPlan,
	manualSteps,
	type PlanContext,
	type PlanDownload,
	type SpawnSpec,
	selectMethod,
} from "./plans";
import { type RunOutcome, SetupRunner } from "./runner";

/** Automatic attempts before an item waits BACKOFF_MS between automatic attempts. */
export const BACKOFF_AFTER = 3;
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

	/** Detect, then (when automatic) install what is missing: required first, optional in the background. */
	start(): Promise<void> {
		return this.#enqueue(async () => {
			await this.#detect();
			if (!this.#deps.automatic || this.#deps.platform === "other") return;
			await this.#runRequired(false);
			await this.#runOptionalAfterRequired();
		});
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

	/** App quit: stop the running download or installer tree and start nothing new. */
	dispose(): void {
		this.#disposed = true;
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

	#optionalItems(): SetupItemId[] {
		return SETUP_ITEMS.filter(id => !this.#items[id].required);
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
				item.phase = this.#deps.automatic && !this.#mayAttempt(id) ? "backoff" : "idle";
			}
		}
		this.#emit();
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
		const plan = buildPlan(id, method, ctx, release);
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
		this.#attemptedThisLaunch.add(id);
		this.#recordAttempt(id);
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
			item.phase = "cancelled";
			item.failure = null;
			this.#emit();
			return;
		}
		if (outcome.kind === "failed") {
			const checksum = /SHA-256 mismatch|: FAILED/.test(item.output);
			this.#fail(id, {
				reason: checksum ? "checksum" : outcome.reason,
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
			file: ompSpawnCommand(installer, platform),
			args: ompSpawnArgs(installer, [id, method], platform),
			shell: ompNeedsShell(installer, platform),
		};
	}

	async #installEnv(): Promise<NodeJS.ProcessEnv> {
		return { ...(await this.#deps.spawnEnv()), BUN_INSTALL: this.#deps.bunInstall };
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

	/** Counted when it starts: an attempt that leaves the item missing (or the app) is a miss until detection says otherwise. */
	#recordAttempt(id: SetupItemId): void {
		const ledger = this.#readLedger();
		ledger[id] = { failures: (ledger[id]?.failures ?? 0) + 1, lastAttempt: (this.#deps.now ?? Date.now)() };
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
