/**
 * Decisions, gotchas and procedures that name repo files or code symbols the repo no longer has. The page is checked
 * against the project's main checkout (resolved from its sessions' cwds, the default branch read with read-only git,
 * never the working tree, never a fetch). The check is the core's (`native/ompdesk/crates/core/src/care/freshness.rs`,
 * which runs the git of `crates/core/src/git/freshness.rs` in process with the git rules this file hands it): the names
 * a page holds, the checkout, what git says of each name, which pages retire or are flagged. Every named item is
 * `exists`, `deleted` (git history deleted it), `moved` (history renamed it and the new name exists) or `unknown`
 * (history never held it: an external name, an example, a file of an unmerged branch).
 * A page whose names are all deleted (no moved, no existing, no never-seen path) is retired through the restorable
 * `retirePage`; a page with some deleted or moved names is flagged `stale` once per page version; the rest stays.
 * A pinned page is the owner's: flagged at most. A line that says the name was removed ("deleted `x.ts`") records
 * the removal and does not count as naming it.
 *
 * Production runs it as the care's `fresh` unit (`care.ts`); this file is the typed client of one project's check, for
 * the tests.
 */
import type { AiMemoryPage, AiMemoryPageRef, AiMemoryProjectRef, AiMemorySession } from "../../shared/ai-memory";
import { gitRunner } from "../local/git/exec";
import { coreSide, oneShot } from "./core-asks";

export const FRESHNESS_KINDS = ["decision", "gotcha", "procedure"] as const;

export interface FreshnessClient {
	pages(project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]>;
	page(ref: AiMemoryProjectRef & { path: string }): Promise<AiMemoryPage>;
	sessions(project: AiMemoryProjectRef, limit?: number): Promise<AiMemorySession[]>;
	retirePage(
		ref: AiMemoryProjectRef & {
			path: string;
			at: Date;
			expectedPageId?: string;
			reason: string;
			successor?: undefined;
		},
	): Promise<"retired" | "pinned" | "changed">;
	feedback(ref: AiMemoryProjectRef & { path: string }, signal: "stale"): Promise<void>;
}

export type FreshnessLogDetails = Record<string, string | number | boolean | null>;

export interface FreshnessDeps {
	client: FreshnessClient;
	project: AiMemoryProjectRef;
	log: (message: string, details: FreshnessLogDetails) => void;
	/**
	 * Pages already flagged, `workspace/project/path` to the page id (version) flagged. Changed in place on a real run;
	 * the caller keeps it between runs so one page version is flagged once.
	 */
	flagged: Record<string, string>;
	now?: () => Date;
	dryRun?: boolean;
	maxPages?: number;
	maxChanges?: number;
}

export interface FreshnessChange {
	path: string;
	kind: string;
	action: "retire" | "flag";
	/** The names that are gone (deleted or moved). */
	names: string[];
	pinned: boolean;
}

export interface FreshnessReport {
	dryRun: boolean;
	/** The main checkout the names were looked up in; null when no session's folder is a live checkout. */
	checkout: string | null;
	ref: string | null;
	pages: number;
	checked: number;
	retired: FreshnessChange[];
	flagged: FreshnessChange[];
	errors: number;
}

/** Up to a hundred pages, each a few gits of 20 s at most, one after another. */
const CHECK_TIMEOUT_MS = 1_800_000;

export async function checkFreshness(deps: FreshnessDeps): Promise<FreshnessReport> {
	const answer = await oneShot<{ report: FreshnessReport; flagged: Record<string, string> }>(
		"care.freshness",
		coreSide(deps.client),
		{
			project: deps.project,
			// A git that is not installed is git not knowing: no checkout, nothing checked.
			git: await gitRunner().catch(() => null),
			flagged: deps.flagged,
			dryRun: deps.dryRun === true,
			...(deps.maxPages === undefined ? {} : { maxPages: deps.maxPages }),
			...(deps.maxChanges === undefined ? {} : { maxChanges: deps.maxChanges }),
			...(deps.now ? { now: deps.now().getTime() } : {}),
		},
		{ timeoutMs: CHECK_TIMEOUT_MS, log: deps.log },
	);
	Object.assign(deps.flagged, answer.flagged);
	return answer.report;
}
