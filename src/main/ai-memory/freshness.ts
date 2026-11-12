/**
 * Decisions, gotchas and procedures that name repo files or code symbols the repo no longer has. The page is checked
 * against the project's main checkout (resolved from its sessions' cwds, the default branch read with read-only git,
 * never the working tree, never a fetch). The core process runs that git (`native/ompdesk/crates/core/src/git/
 * freshness.rs`): `git.freshnessCheckout` finds the checkout, its ref and the ref's top-level folders, and
 * `git.freshnessVerdict` judges one page. Each verdict answers the check's state (what git said of each name, the
 * `git log -S` runs left), which is handed unread to the next page's verdict, so a name is asked once per check and
 * the pickaxe budget is the check's. Every named item is `exists`, `deleted` (git history deleted it), `moved`
 * (history renamed it and the new name exists) or `unknown` (history never held it: an external name, an example,
 * a file of an unmerged branch).
 * A page whose names are all deleted (no moved, no existing, no never-seen path) is retired through the restorable
 * `retirePage`; a page with some deleted or moved names is flagged `stale` once per page version; the rest stays.
 * A pinned page is the owner's: flagged at most. A line that says the name was removed ("deleted `x.ts`") records
 * the removal and does not count as naming it.
 */
import type { AiMemoryPage, AiMemoryPageRef, AiMemoryProjectRef, AiMemorySession } from "../../shared/ai-memory";
import { coreGit } from "../local/git/exec";

export const FRESHNESS_KINDS = ["decision", "gotcha", "procedure"] as const;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_CHANGES = 10;
const MAX_PATHS = 30;
const MAX_SYMBOLS = 12;
const SESSION_WINDOW = 50;
/** Each git's timeout. */
const GIT_TIMEOUT_MS = 20_000;
/** The checkout's gits past one per session folder: `symbolic-ref`, up to four `rev-parse` and `ls-tree`. */
const CHECKOUT_ROUNDS = 6;
/** Gits a page's paths may run one after another: `cat-file`, `log`, `show`, the new name's `cat-file`. */
const PATH_ROUNDS = 4;
/** A page's symbols: `grep`, then `log -S`. */
const SYMBOL_ROUNDS = 2;
/** Top-level directories that count as repo paths even when the ref no longer has them (a deleted top-level dir). */
const BASE_ROOTS = ["src", "resources", "scripts", "e2e", "native", "docs", "build", "tests", "test", "packages"];

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
	 * Pages already flagged, `workspace/project/path` to the page id (version) flagged. Mutated on a real run;
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

export interface NamedItems {
	paths: string[];
	symbols: string[];
}

const REMOVAL_WORDS =
	/\b(removed|deleted|deletes?|dropped|no longer|gone|retired|replaced|obsolete|deprecated|renamed|moved)\b|삭제|제거|없앴|없어|사라|대체|폐기|이동|이름을 바꿨/i;
const SHELL_REMOVAL = /^(?:\$\s*)?(?:git\s+(?:rm|mv)|rm|mv|rmdir|mkdir|touch)\b/;
const BRAND_WORDS = new Set(["GitHub", "TypeScript", "JavaScript", "OpenAI", "VSCode", "MacBook", "iPhone", "GitLab"]);

function pathPattern(roots: readonly string[]): RegExp {
	const alternation = roots.map(root => root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return new RegExp(`(?<![\\w~.\\/@:<{$*-])(?:\\.\\/)?((?:${alternation})\\/[\\w.@+\\-\\/]*\\w)`, "g");
}

function looksLikeSymbol(token: string): boolean {
	if (token.length < 6 || token.length > 60 || BRAND_WORDS.has(token)) return false;
	if (!/^[A-Za-z_$][\w$]*$/.test(token)) return false;
	return /[a-z][A-Z]/.test(token) || /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(token);
}

/** The repo paths and code symbols a page's markdown names; what the page only says it removed, or runs `rm` on, is not named. */
export function namedItems(markdown: string, roots: readonly string[] = BASE_ROOTS): NamedItems {
	const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
	const pattern = pathPattern([...new Set([...BASE_ROOTS, ...roots])]);
	const paths = new Set<string>();
	const symbols = new Set<string>();
	let fence: string | null = null;
	for (const raw of body.split(/\r?\n/)) {
		const marker = /^\s*(```|~~~)/.exec(raw)?.[1];
		if (marker) {
			fence = fence === null ? marker : fence === marker ? null : fence;
			continue;
		}
		const line = raw.replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
		const prose = line.replaceAll(/`[^`]*`/g, " ").replaceAll(/[\w.@+-]*\/[\w./@+-]*/g, " ");
		if (REMOVAL_WORDS.test(prose) || (fence !== null && SHELL_REMOVAL.test(line.trim()))) continue;
		pattern.lastIndex = 0;
		for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
			const path = match[1] ?? "";
			const after = line[match.index + match[0].length] ?? "";
			if (/[*<{$[]/.test(after) || (after === "/" && !/\.\w+$/.test(path))) continue;
			if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(path) || path.includes("..")) continue;
			paths.add(path);
		}
		if (fence !== null) continue;
		for (const span of line.matchAll(/`([^`\n]{2,80})`/g)) {
			const token = (span[1] ?? "").trim().replace(/\(\)$/, "");
			if (looksLikeSymbol(token)) symbols.add(token);
		}
	}
	return { paths: [...paths].slice(0, MAX_PATHS), symbols: [...symbols].slice(0, MAX_SYMBOLS) };
}

/** `git.freshnessCheckout`: the main checkout, the ref its names are read at, the ref's top-level folders. */
interface CheckoutFacts {
	checkout: string;
	ref: string;
	roots: string[];
}

interface Verdict {
	action: "retire" | "flag" | "leave";
	/** The names that are gone (deleted or moved), paths first. */
	gone: string[];
	/** The check's state after this page: the core's, passed to the next verdict as it came. */
	state: unknown;
}

export async function checkFreshness(deps: FreshnessDeps): Promise<FreshnessReport> {
	const { client, project, log, flagged } = deps;
	const dryRun = deps.dryRun === true;
	const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
	const maxChanges = deps.maxChanges ?? DEFAULT_MAX_CHANGES;
	const report: FreshnessReport = {
		dryRun,
		checkout: null,
		ref: null,
		pages: 0,
		checked: 0,
		retired: [],
		flagged: [],
		errors: 0,
	};
	const cwds = (await client.sessions(project, SESSION_WINDOW)).map(session => session.cwd);
	// A git that fails is git not knowing, and so is a core that cannot answer: no checkout, nothing checked.
	const facts = await coreGit<CheckoutFacts | null>(
		"git.freshnessCheckout",
		{ cwds, timeoutMs: GIT_TIMEOUT_MS },
		0,
		(new Set(cwds).size + CHECKOUT_ROUNDS) * GIT_TIMEOUT_MS,
	).catch(() => null);
	if (!facts) return report;
	report.checkout = facts.checkout;
	report.ref = facts.ref;
	const candidates = (await client.pages(project)).filter(page =>
		(FRESHNESS_KINDS as readonly string[]).includes(page.kind ?? ""),
	);
	report.pages = candidates.length;
	const now = deps.now ?? (() => new Date());
	const flag = async (page: AiMemoryPage, change: FreshnessChange): Promise<void> => {
		const key = `${project.workspace}/${project.project}/${page.path}`;
		if (flagged[key] === page.id) return;
		report.flagged.push(change);
		if (dryRun) return;
		await client.feedback({ ...project, path: page.path }, "stale");
		flagged[key] = page.id;
		log("care-fresh", logDetails(project, change));
	};
	let state: unknown = null;
	for (const candidate of candidates.slice(0, maxPages)) {
		if (report.retired.length + report.flagged.length >= maxChanges) break;
		try {
			const page = await client.page({ ...project, path: candidate.path });
			report.checked += 1;
			const items = namedItems(page.markdown, facts.roots);
			const rounds = items.paths.length > 0 ? PATH_ROUNDS : items.symbols.length > 0 ? SYMBOL_ROUNDS : 0;
			const verdict = await coreGit<Verdict>(
				"git.freshnessVerdict",
				{ checkout: facts.checkout, ref: facts.ref, page: items, state, timeoutMs: GIT_TIMEOUT_MS },
				0,
				rounds * GIT_TIMEOUT_MS,
			).catch(() => null);
			if (!verdict) {
				// Its consumed budget is unknown after a lost answer; do not spend that budget again.
				report.errors += 1;
				break;
			}
			state = verdict.state;
			if (verdict.action === "leave") continue;
			const change: FreshnessChange = {
				path: page.path,
				kind: candidate.kind ?? "",
				action: verdict.action,
				names: verdict.gone,
				pinned: page.pinned,
			};
			if (verdict.action === "retire" && !page.pinned) {
				if (dryRun) {
					report.retired.push(change);
					continue;
				}
				const result = await client.retirePage({
					...project,
					path: page.path,
					at: now(),
					expectedPageId: page.id,
					reason: `names ${verdict.gone.slice(0, 3).join(", ")} which no longer exist`,
				});
				if (result === "retired") {
					report.retired.push(change);
					log("care-fresh", logDetails(project, change));
					continue;
				}
				if (result === "changed") continue;
			}
			await flag(page, { ...change, action: "flag" });
		} catch {
			report.errors += 1;
		}
	}
	return report;
}

function logDetails(project: AiMemoryProjectRef, change: FreshnessChange): FreshnessLogDetails {
	return {
		action: change.action,
		kind: change.kind,
		workspace: project.workspace,
		project: project.project,
		path: change.path,
		names: change.names.slice(0, 5).join(", "),
		pinned: change.pinned,
	};
}
