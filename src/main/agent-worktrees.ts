/**
 * Agent-managed worktrees under `~/.omp/wt/` (B58 auto-clean): stock
 * `omp worktree list --json` lists them and `omp worktree clear --json`
 * removes the orphaned ones (crashed task isolations, PR checkouts whose repo
 * or branch is gone). Stock decides what counts as orphaned and does the
 * removal; OMPdesk never passes `--all`, so a live checkout or a sandbox a
 * running omp still owns is never touched.
 *
 * With prefs `worktreeAutoClean` on, main runs that clear once shortly after
 * launch, then every six hours while the app stays open.
 */
import type { RpcAgentWorktree, RpcAgentWorktreeClear } from "../shared/rpc-types";
import { LocalCommandError, type OmpRuntime } from "./local/types";

const LIST_TIMEOUT_MS = 60_000;
const CLEAR_TIMEOUT_MS = 5 * 60_000;
/** Plain output, so a warning line never lands inside the JSON. */
const PLAIN_ENV = { NO_COLOR: "1", FORCE_COLOR: "0" };
const KINDS: Record<string, RpcAgentWorktree["kind"]> = {
	"pr-checkout": "pr-checkout",
	"task-isolation": "task-isolation",
	empty: "empty",
	stray: "stray",
};

export const AUTO_CLEAN_FIRST_DELAY_MS = 60_000;
export const AUTO_CLEAN_INTERVAL_MS = 6 * 60 * 60_000;

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Stock's `WorktreeEntry[]`; rows of another shape are dropped, non-JSON output is `null`. */
export function parseAgentWorktrees(stdout: string): RpcAgentWorktree[] | null {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(data)) return null;
	const entries: RpcAgentWorktree[] = [];
	for (const row of data) {
		if (typeof row !== "object" || row === null || !("path" in row) || !("kind" in row)) continue;
		const kind = typeof row.kind === "string" ? KINDS[row.kind] : undefined;
		if (typeof row.path !== "string" || !kind) continue;
		const parentRepo = "parentRepo" in row ? optionalString(row.parentRepo) : undefined;
		const branch = "branch" in row ? optionalString(row.branch) : undefined;
		const orphanReason = "orphanReason" in row ? optionalString(row.orphanReason) : undefined;
		entries.push({
			path: row.path,
			kind,
			...(parentRepo ? { parentRepo } : {}),
			...(branch ? { branch } : {}),
			...(orphanReason ? { orphanReason } : {}),
		});
	}
	return entries;
}

/**
 * Stock's clear report: `{removed, failed, results}` after a removal, or
 * `{removed: 0, kept}` when nothing was orphaned.
 */
export function parseAgentWorktreeClear(stdout: string): RpcAgentWorktreeClear | null {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null || !("removed" in data) || typeof data.removed !== "number") {
		return null;
	}
	const results: RpcAgentWorktreeClear["results"] = [];
	const rawResults = "results" in data && Array.isArray(data.results) ? data.results : [];
	for (const row of rawResults) {
		if (typeof row !== "object" || row === null || !("path" in row) || !("ok" in row)) continue;
		if (typeof row.path !== "string" || typeof row.ok !== "boolean") continue;
		const error = "error" in row ? optionalString(row.error) : undefined;
		results.push({ path: row.path, ok: row.ok, ...(error ? { error } : {}) });
	}
	const failed = "failed" in data && typeof data.failed === "number" ? data.failed : 0;
	return { removed: data.removed, failed, results };
}

/** Run one `omp worktree …--json` and parse it; a failure carries omp's last output lines. */
async function runWorktreeCli<T>(
	omp: OmpRuntime,
	action: "list" | "clear",
	timeoutMs: number,
	parse: (stdout: string) => T | null,
	cwd?: string,
): Promise<T> {
	const result = await omp.run(["worktree", action, "--json"], { cwd, timeoutMs, env: PLAIN_ENV });
	const parsed = result.code === 0 ? parse(result.stdout) : null;
	if (parsed) return parsed;
	const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-6).join("\n");
	throw new LocalCommandError(
		detail || `omp worktree ${action} exited with code ${result.code}`,
		"worktree_cli_failed",
	);
}

/** `omp worktree list --json`. */
export function listAgentWorktrees(omp: OmpRuntime, cwd?: string): Promise<RpcAgentWorktree[]> {
	return runWorktreeCli(omp, "list", LIST_TIMEOUT_MS, parseAgentWorktrees, cwd);
}

/** `omp worktree clear --json`: stock removes the orphaned entries only. */
export function clearAgentWorktrees(omp: OmpRuntime, cwd?: string): Promise<RpcAgentWorktreeClear> {
	return runWorktreeCli(omp, "clear", CLEAR_TIMEOUT_MS, parseAgentWorktreeClear, cwd);
}

export interface AgentWorktreeAutoCleanDeps {
	/** prefs `worktreeAutoClean` === true. */
	enabled: () => boolean;
	omp: () => Promise<OmpRuntime | null>;
	log: (message: string) => void;
}

/**
 * Runs stock's clear while the pref is on: once {@link AUTO_CLEAN_FIRST_DELAY_MS}
 * after launch (or right after the pref is switched on), then every
 * {@link AUTO_CLEAN_INTERVAL_MS}. One run at a time; a failed run is logged and
 * the next one still comes.
 */
export class AgentWorktreeAutoClean {
	#deps: AgentWorktreeAutoCleanDeps;
	#timer: NodeJS.Timeout | undefined;
	#running: Promise<void> | null = null;

	constructor(deps: AgentWorktreeAutoCleanDeps) {
		this.#deps = deps;
	}

	start(): void {
		this.#schedule(AUTO_CLEAN_FIRST_DELAY_MS);
	}

	/** The pref changed: on → clean now and resume the interval; off → stop. */
	prefChanged(): void {
		this.#schedule(0);
	}

	stop(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** One clear now (tests and the timer); resolves when it ends. */
	runOnce(): Promise<void> {
		if (this.#running) return this.#running;
		const run = this.#clean().finally(() => {
			this.#running = null;
		});
		this.#running = run;
		return run;
	}

	#schedule(ms: number): void {
		this.stop();
		if (!this.#deps.enabled()) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.runOnce().then(() => {
				if (this.#timer === undefined) this.#schedule(AUTO_CLEAN_INTERVAL_MS);
			});
		}, ms);
	}

	async #clean(): Promise<void> {
		if (!this.#deps.enabled()) return;
		try {
			const omp = await this.#deps.omp();
			if (!omp) return;
			const report = await clearAgentWorktrees(omp);
			if (report.removed > 0 || report.failed > 0) {
				this.#deps.log(`worktree auto-clean: ${report.removed} removed, ${report.failed} failed`);
			}
		} catch (err) {
			this.#deps.log(`worktree auto-clean failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
