/**
 * Keeps the marketplaces, plugins, skills and MCP servers of this computer's omp current (contract:
 * src/shared/extension-update.ts, design in the stock helper's `extensions.*` methods). The schedule is the
 * tool CLIs' (`CliUpdater`): at launch after machine setup's first pass and every 4 h, a longer wait per row
 * after failures in a row (`nextCheckDelay`), deferred rows retried at the next check, everything one row at
 * a time through a serial queue. Each pass reads the inventory (local files only), classifies it
 * (classify.ts), then works through marketplaces → plugins → skills → MCP servers: the first so plugin
 * checks see fresh catalogs, the plugin, skill and marketplace work is stock's own, run in the stock helper's
 * `extensions` worker; an MCP server's global binary is updated by the package manager that owns it, run as
 * `SetupService.runToolUpdate` under the setup supervisor. A pinned version (a plugin or skill pin, an MCP
 * package `pkg@1.2.3`) is checked and shown, never changed, not even by "Update now". The user's MCP config
 * is never written. What changed is handed to the live tabs once per pass as one `ExtensionApplyPlan`
 * (a reload, a restart, or a reconnect of named servers); the tabs apply it between turns.
 */
import type {
	HelperInventory,
	PluginCheckResult,
	PluginSelector,
	PluginUpgradeResult,
	SkillCheckResult,
	SkillSelector,
	SkillUpdateResult,
} from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import { EXTENSION_HELPER_METHODS } from "../../../resources/gui-bridge/stock-helper/extensions-contracts";
import type {
	ExtensionFailure,
	ExtensionResult,
	ExtensionRow,
	ExtensionSkipReason,
	ExtensionUpdateState,
} from "../../shared/extension-update";
import { isNewer } from "../../shared/version";
import { type CliPlatform, findBrew, type InstallContext, probeOutput } from "../cli-tools/detect";
import type { CliCommand, PlanTools } from "../cli-tools/plans";
import { runCheckProcess } from "../cli-tools/updater";
import { EMPTY_APPLY_PLAN, type ExtensionApplyPlan, mergeApplyPlans, planIsEmpty } from "../extension-reload";
import { ompNeedsShell, ompSpawnArgs, ompSpawnCommand, parseOmpVersion } from "../omp-runtime";
import { CHECK_INTERVAL_MS, nextCheckDelay } from "../omp-updater";
import type { SpawnSpec } from "../setup/plans";
import type { ToolUpdateOutcome, ToolUpdateRequest } from "../setup/service";
import { classifyInventory, type ExtensionSeed, type SeedRow, type SeedTarget } from "./classify";
import { classifyMcpServer } from "./mcp";
import { detectMcpBinary, type McpBinary, type OwnerDeps } from "./mcp-owner";
import {
	mcpOwnerCheck,
	mcpOwnerUpdate,
	parseMcpOwnerLatest,
	parseRunnerLatest,
	type RunnerPackage,
	runnerCheck,
} from "./mcp-plans";
import { deferForRunning, runningServer, scansProcesses } from "./running";

/** Inventory, check and refresh: local files or one registry round trip. */
const CHECK_TIMEOUT_MS = 120_000;
/** An upgrade or update runs `bun install`/`npm install` and may take minutes. */
const UPGRADE_TIMEOUT_MS = 600_000;

export interface ExtensionUpdaterDeps {
	/** This launch checks on a timer: a packaged app, or a test launch that opts in. */
	scheduled: boolean;
	/** The pref `extensionAutoUpdate` (default on). */
	enabled: () => boolean;
	platform: CliPlatform;
	toolsDir: string;
	/** A stock helper request (`stockHelperRequest(method, params, { timeoutMs })`); throws with the helper's message. */
	helper: <T>(method: string, params: unknown, timeoutMs: number) => Promise<T>;
	/** The workspaces of this computer's open local tabs: where project-scoped plugins and skills live. */
	cwds: () => string[];
	/** The built-in REA's root (`resources/omp-builtin`): a server whose config is under it is the built-in. */
	reaRoot: string | null;
	/** The built-in REA is on in this app. */
	reaEnabled: () => boolean;
	/** The spawn environment (login-shell PATH, proxies); its PATH is where an MCP command is looked up. */
	env: () => Promise<NodeJS.ProcessEnv>;
	/** `OMP_GUI_TEST_INSTALLER`: an MCP server's checks run `<installer> cli-mcp-<name> <method> check`. */
	testInstaller: string | null;
	/** omp is being installed or checked for an update (or the stock helper is stopped for it): a pass waits. */
	blocked: () => boolean;
	runUpdate: (request: ToolUpdateRequest) => Promise<ToolUpdateOutcome>;
	/** Command lines of the running processes (`ps`); macOS only. */
	processes: () => Promise<string>;
	/** What changed, once per pass: the live tabs reload, restart or reconnect (between turns). */
	apply: (plan: ExtensionApplyPlan) => void;
	onState: (state: ExtensionUpdateState) => void;
	now?: () => number;
	/** Test seams. */
	detectBinary?: (command: string, deps: OwnerDeps) => Promise<McpBinary | null>;
	runCheck?: (command: CliCommand, env: NodeJS.ProcessEnv) => Promise<string>;
}

interface RowRecord {
	row: ExtensionRow;
	target: SeedTarget;
	/** What classification says (a skip the check cannot lift). */
	seedSkip: ExtensionSkipReason | null;
	/** What the last check found out: a plugin or skill the user pinned, or a catalog without versions. */
	derivedSkip: "pinned" | "unversioned" | null;
	failures: number;
	/** No scheduled check before this (ms since the epoch). */
	nextAt: number;
}

interface Environment {
	env: NodeJS.ProcessEnv;
	tools: PlanTools;
	owner: OwnerDeps;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const noPlan = (): ExtensionApplyPlan => ({ ...EMPTY_APPLY_PLAN, reconnect: [] });

export class ExtensionUpdater {
	readonly #deps: ExtensionUpdaterDeps;
	/** In display order (kinds, then name): `#refresh` rebuilds it from the classification. */
	#records = new Map<string, RowRecord>();
	#timer: NodeJS.Timeout | null = null;
	#running: Promise<void> | null = null;
	#started = false;
	#disposed = false;

	constructor(deps: ExtensionUpdaterDeps) {
		this.#deps = deps;
	}

	state(): ExtensionUpdateState {
		return {
			enabled: this.#deps.enabled(),
			scheduled: this.#deps.scheduled,
			rows: [...this.#records.values()].map(record => ({ ...record.row })),
		};
	}

	/** Machine setup finished its first pass: list everything, and when this launch schedules, check now and on the timer. */
	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		if (this.#deps.scheduled) void this.#cycle();
		else void this.#queue(() => this.#refresh().then(() => undefined));
	}

	/** The pref changed: turning it on checks right away. */
	prefChanged(): void {
		this.#emit();
		if (this.#started && this.#deps.scheduled && this.#deps.enabled()) void this.#queue(() => this.#pass(null, true));
	}

	/** Settings › Update now: check (and update) the row `key`, or every row, whatever the pref and back-off say. */
	updateNow(key?: string): Promise<void> {
		return this.#queue(() => this.#pass(key ?? null, false));
	}

	/** List what is installed again without checking or updating (Settings opened, a plugin installed meanwhile). */
	rescan(): Promise<void> {
		return this.#queue(() => this.#refresh().then(() => undefined));
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
			await this.#queue(() =>
				this.#deps.enabled() ? this.#pass(null, true) : this.#refresh().then(() => undefined),
			);
		} catch {
			// A throw from a dependency must not end the schedule.
		} finally {
			if (!this.#disposed) this.#timer = setTimeout(() => void this.#cycle(), CHECK_INTERVAL_MS);
		}
	}

	#now(): number {
		return (this.#deps.now ?? Date.now)();
	}

	#emit(): void {
		if (!this.#disposed) this.#deps.onState(this.state());
	}

	#set(record: RowRecord, patch: Partial<ExtensionRow>): void {
		record.row = { ...record.row, ...patch };
		this.#emit();
	}

	/** The row's skip: classification's, else what the last check found. */
	#setDerived(record: RowRecord, derived: RowRecord["derivedSkip"]): void {
		record.derivedSkip = derived;
		this.#set(record, { skip: record.seedSkip ?? derived });
	}

	#finish(record: RowRecord, last: ExtensionResult): void {
		const failed = last.kind === "failed" && last.failure.reason !== "cancelled";
		record.failures = failed ? record.failures + 1 : 0;
		record.nextAt = failed ? this.#now() + nextCheckDelay(record.failures) : 0;
		this.#set(record, { phase: "idle", last });
	}

	#fail(record: RowRecord, failure: ExtensionFailure): void {
		this.#finish(record, { kind: "failed", failure });
	}

	async #environment(): Promise<Environment> {
		const env = await this.#deps.env();
		const pathEnv = env.PATH ?? "";
		const ctx: InstallContext = {
			platform: this.#deps.platform,
			toolsDir: this.#deps.toolsDir,
			brew: findBrew(pathEnv, this.#deps.platform),
		};
		return {
			env,
			tools: { platform: this.#deps.platform, pathEnv },
			owner: {
				pathEnv,
				ctx,
				probe: (bin, args) => probeOutput(bin, args, env, this.#deps.platform),
			},
		};
	}

	/**
	 * Read the inventory again and rebuild the rows, keeping each row's state across scans. Null when the
	 * inventory cannot be read (omp missing, the helper stopped): the rows stay as they were.
	 */
	async #refresh(): Promise<Environment | null> {
		if (this.#deps.blocked()) return null;
		let environment: Environment;
		let inventory: HelperInventory;
		try {
			environment = await this.#environment();
			inventory = await this.#deps.helper<HelperInventory>(
				EXTENSION_HELPER_METHODS.inventory,
				{ cwds: this.#deps.cwds() },
				CHECK_TIMEOUT_MS,
			);
		} catch {
			return null;
		}
		const detect = this.#deps.detectBinary ?? detectMcpBinary;
		const ownerDeps = environment.owner;
		const binaries = new Map<string, McpBinary | null>();
		await Promise.all(
			inventory.mcpServers.map(async server => {
				const cls = classifyMcpServer(server, { reaRoot: this.#deps.reaRoot });
				if (cls.kind === "direct")
					binaries.set(server.name, await detect(cls.command, ownerDeps).catch(() => null));
			}),
		);
		const seeds = classifyInventory(inventory, {
			reaRoot: this.#deps.reaRoot,
			reaEnabled: this.#deps.reaEnabled(),
			binaries,
		});
		const next = new Map<string, RowRecord>();
		for (const seed of seeds) next.set(seed.row.key, this.#merge(this.#records.get(seed.row.key), seed));
		this.#records = next;
		this.#emit();
		return environment;
	}

	#merge(existing: RowRecord | undefined, seed: ExtensionSeed): RowRecord {
		if (!existing) {
			return {
				row: { ...seed.row, latest: null, phase: "idle", checkedAt: null, last: null },
				target: seed.target,
				seedSkip: seed.row.skip,
				derivedSkip: null,
				failures: 0,
				nextAt: 0,
			};
		}
		// A plugin the check found pinned stays pinned until the next check says otherwise.
		const fresh: SeedRow = { ...seed.row, skip: seed.row.skip ?? existing.derivedSkip };
		return { ...existing, row: { ...existing.row, ...fresh }, target: seed.target, seedSkip: seed.row.skip };
	}

	#deferForOmp(record: RowRecord): void {
		this.#set(record, { last: { kind: "deferred", latest: record.row.latest, why: "omp-busy" } });
	}

	async #pass(only: string | null, scheduled: boolean): Promise<void> {
		// While omp is being installed the stock helper is stopped: a request would start it again, so ask nothing.
		if (this.#deps.blocked()) {
			const at = this.#now();
			for (const record of this.#records.values()) {
				if (only && record.row.key !== only) continue;
				if (record.target.kind === "none" || (scheduled && at < record.nextAt)) continue;
				this.#deferForOmp(record);
			}
			return;
		}
		const environment = await this.#refresh();
		if (!environment) return;
		const now = this.#now();
		let plan = noPlan();
		for (const record of [...this.#records.values()]) {
			if (this.#disposed) return;
			if (only && record.row.key !== only) continue;
			if (record.target.kind === "none") continue;
			if (scheduled && now < record.nextAt) continue;
			if (this.#deps.blocked()) {
				// omp is being installed: wait without a back-off, the next pass tries again.
				this.#deferForOmp(record);
				continue;
			}
			plan = mergeApplyPlans(plan, await this.#work(record, environment));
		}
		if (!planIsEmpty(plan) && !this.#disposed) {
			try {
				this.#deps.apply(plan);
			} catch {
				// A tab that cannot apply it loads the new files at its next start.
			}
		}
	}

	async #work(record: RowRecord, environment: Environment): Promise<ExtensionApplyPlan> {
		const target = record.target;
		switch (target.kind) {
			case "marketplace":
				await this.#marketplace(record, target.name);
				return noPlan();
			case "plugin":
				return this.#plugin(record, target.selector);
			case "skill":
				return this.#skill(record, target.selector);
			case "runner":
				await this.#runner(record, target.runner, environment);
				return noPlan();
			case "binary":
				return this.#binary(record, target.command, environment);
			case "none":
				return noPlan();
		}
	}

	async #marketplace(record: RowRecord, name: string): Promise<void> {
		this.#set(record, { phase: "checking" });
		try {
			await this.#deps.helper(EXTENSION_HELPER_METHODS.marketplaceRefresh, { name }, CHECK_TIMEOUT_MS);
		} catch (error) {
			this.#fail(record, { reason: "check", detail: message(error) });
			return;
		}
		this.#set(record, { checkedAt: this.#now() });
		this.#finish(record, { kind: "refreshed" });
	}

	/** A row that is skipped after its check (pinned, no versions): the newer version is shown, nothing changes. */
	#settle(record: RowRecord, latest: string | null): void {
		const newer = record.row.skip === "pinned" && latest !== null && isNewer(latest, record.row.installed);
		this.#finish(record, newer && latest ? { kind: "available", latest } : { kind: "current" });
	}

	async #plugin(record: RowRecord, selector: PluginSelector): Promise<ExtensionApplyPlan> {
		this.#set(record, { phase: "checking" });
		let check: PluginCheckResult;
		try {
			check = await this.#deps.helper<PluginCheckResult>(
				EXTENSION_HELPER_METHODS.pluginCheck,
				selector,
				CHECK_TIMEOUT_MS,
			);
		} catch (error) {
			this.#fail(record, { reason: "check", detail: message(error) });
			return noPlan();
		}
		this.#set(record, {
			installed: check.installed ?? record.row.installed,
			latest: check.latest,
			checkedAt: this.#now(),
		});
		this.#setDerived(record, check.pinned ? "pinned" : check.unversioned ? "unversioned" : null);
		// Pinned and unversioned rows never reach an upgrade call.
		if (record.row.skip) {
			this.#settle(record, check.latest);
			return noPlan();
		}
		const installed = record.row.installed;
		// A git plugin has no latest to read: stock's upgrade re-resolves its ref and says whether anything moved.
		// Every other channel upgrades only to a version strictly newer than the installed one.
		const wanted = check.latest === null ? selector.channel === "git" : isNewer(check.latest, installed);
		if (!wanted) {
			this.#finish(record, { kind: "current" });
			return noPlan();
		}
		this.#set(record, { phase: "updating" });
		let upgraded: PluginUpgradeResult;
		try {
			upgraded = await this.#deps.helper<PluginUpgradeResult>(
				EXTENSION_HELPER_METHODS.pluginUpgrade,
				selector,
				UPGRADE_TIMEOUT_MS,
			);
		} catch (error) {
			this.#fail(record, { reason: "install", detail: message(error) });
			return noPlan();
		}
		if (!upgraded.changed) {
			this.#finish(record, { kind: "current" });
			return noPlan();
		}
		const to = upgraded.to ?? check.latest ?? installed ?? "";
		this.#set(record, { installed: upgraded.to ?? record.row.installed });
		this.#finish(record, { kind: "updated", from: upgraded.from ?? installed, to });
		// Extensions, tools and hooks bind at session creation: a plugin that ships them restarts the tab.
		return upgraded.activation === "restart-required"
			? { reload: false, restart: true, reconnect: [] }
			: { reload: true, restart: false, reconnect: [] };
	}

	async #skill(record: RowRecord, selector: SkillSelector): Promise<ExtensionApplyPlan> {
		this.#set(record, { phase: "checking" });
		let check: SkillCheckResult;
		try {
			check = await this.#deps.helper<SkillCheckResult>(
				EXTENSION_HELPER_METHODS.skillCheck,
				selector,
				CHECK_TIMEOUT_MS,
			);
		} catch (error) {
			this.#fail(record, { reason: "check", detail: message(error) });
			return noPlan();
		}
		this.#set(record, {
			installed: check.installed ?? record.row.installed,
			latest: check.latest ?? check.within,
			checkedAt: this.#now(),
		});
		this.#setDerived(record, check.pinned ? "pinned" : null);
		if (record.row.skip) {
			this.#settle(record, check.latest ?? check.within);
			return noPlan();
		}
		// What an update installs is what the recorded range resolves to, not the registry's newest.
		const installed = record.row.installed;
		if (check.within === null || !isNewer(check.within, installed)) {
			this.#finish(record, { kind: "current" });
			return noPlan();
		}
		this.#set(record, { phase: "updating" });
		let updated: SkillUpdateResult;
		try {
			updated = await this.#deps.helper<SkillUpdateResult>(
				EXTENSION_HELPER_METHODS.skillUpdate,
				selector,
				UPGRADE_TIMEOUT_MS,
			);
		} catch (error) {
			this.#fail(record, { reason: "install", detail: message(error) });
			return noPlan();
		}
		if (updated.blocked) {
			// The new version ships scripts: stock asks a human, OMPdesk never approves for them.
			this.#fail(record, { reason: "needs-approval", detail: updated.version });
			return noPlan();
		}
		if (!updated.changed) {
			this.#finish(record, { kind: "current" });
			return noPlan();
		}
		const to = updated.to ?? check.within;
		this.#set(record, { installed: to });
		this.#finish(record, { kind: "updated", from: updated.from ?? installed, to });
		return { reload: true, restart: false, reconnect: [] };
	}

	#installerCheck(installer: string, record: RowRecord): CliCommand {
		const platform = this.#deps.platform;
		const spawn: SpawnSpec = {
			file: ompSpawnCommand(installer, platform),
			args: ompSpawnArgs(installer, [`cli-mcp-${record.row.name}`, record.row.method ?? "self", "check"], platform),
			shell: ompNeedsShell(installer, platform),
		};
		return { spawn, env: {} };
	}

	async #run(command: CliCommand, environment: Environment): Promise<string> {
		return (this.#deps.runCheck ?? runCheckProcess)(command, environment.env);
	}

	/** A pinned runner package (`npx pkg@1.2.3`): look up the newest version, change nothing. */
	async #runner(record: RowRecord, runner: RunnerPackage, environment: Environment): Promise<void> {
		this.#set(record, { phase: "checking" });
		let latest: string | null = null;
		try {
			const installer = this.#deps.testInstaller;
			const check = installer ? this.#installerCheck(installer, record) : runnerCheck(runner, environment.tools);
			if (check) {
				const output = await this.#run(check, environment);
				latest = installer ? parseOmpVersion(output) : parseRunnerLatest(runner, output);
			}
		} catch (error) {
			this.#fail(record, { reason: "check", detail: message(error) });
			return;
		}
		this.#set(record, { latest, checkedAt: this.#now() });
		// A range or a tag has no installed version to compare: only an exact pin can be "behind".
		const behind = latest !== null && record.row.installed !== null && isNewer(latest, record.row.installed);
		this.#finish(record, behind && latest ? { kind: "available", latest } : { kind: "current" });
	}

	/** A direct MCP command's binary: ask its owner, update through the setup supervisor, read the version again. */
	async #binary(record: RowRecord, command: string, environment: Environment): Promise<ExtensionApplyPlan> {
		const target = record.target;
		if (target.kind !== "binary" || record.row.skip) return noPlan();
		const { binary, owner } = target;
		const installer = this.#deps.testInstaller;
		this.#set(record, { phase: "checking" });
		let latest: string | null;
		try {
			if (installer) {
				latest =
					parseOmpVersion(await this.#run(this.#installerCheck(installer, record), environment)) ??
					binary.installed;
			} else {
				const check = mcpOwnerCheck(owner, environment.tools);
				latest = check ? parseMcpOwnerLatest(owner, await this.#run(check, environment), binary.installed) : null;
			}
		} catch (error) {
			this.#fail(record, { reason: "check", detail: message(error) });
			return noPlan();
		}
		this.#set(record, { latest, checkedAt: this.#now() });
		const installed = binary.installed;
		if (latest && installed && !isNewer(latest, installed)) {
			this.#finish(record, { kind: "current" });
			return noPlan();
		}
		if (scansProcesses(this.#deps.platform) && deferForRunning(owner.method, binary.script)) {
			const commands = await this.#deps.processes().catch(() => "");
			if (runningServer(commands, { command }, binary)) {
				this.#finish(record, { kind: "deferred", latest, why: "running" });
				return noPlan();
			}
		}
		const update = mcpOwnerUpdate(owner, latest, environment.tools);
		if (!update && !installer) {
			this.#fail(record, { reason: "install", detail: `no ${owner.method} to run the update with` });
			return noPlan();
		}
		this.#set(record, { phase: "updating" });
		const outcome = await this.#deps.runUpdate({
			tool: `mcp-${record.row.name}`,
			method: owner.method,
			spawn: update?.spawn ?? null,
			env: update?.env ?? {},
		});
		if (outcome.kind === "skipped") {
			this.#set(record, { phase: "idle" });
			return noPlan();
		}
		if (outcome.kind === "cancelled") {
			this.#fail(record, { reason: "cancelled" });
			return noPlan();
		}
		if (outcome.kind === "failed") {
			this.#fail(record, { reason: "install", ...(outcome.detail ? { detail: outcome.detail } : {}) });
			return noPlan();
		}
		const after = await (this.#deps.detectBinary ?? detectMcpBinary)(command, environment.owner).catch(() => null);
		const now = after?.installed ?? null;
		if (after) {
			record.target = after.owner ? { kind: "binary", command, binary: after, owner: after.owner } : record.target;
			this.#set(record, { installed: now });
		}
		const moved = now !== null && (installed === null || isNewer(now, installed));
		if (moved && now && (!latest || !isNewer(latest, now))) {
			this.#finish(record, { kind: "updated", from: installed, to: now });
			return { reload: false, restart: false, reconnect: [record.row.name] };
		}
		// The owner's own upgrade (uv tool, pipx) checks by itself: a clean run that changed nothing means it was current.
		if (!latest && !moved) {
			this.#finish(record, { kind: "current" });
			return noPlan();
		}
		this.#fail(record, { reason: "not-updated" });
		return noPlan();
	}
}
