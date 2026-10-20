/**
 * Decisions, gotchas and procedures that name repo files or code symbols the repo no longer has. The page is checked
 * against the project's main checkout (resolved from its sessions' cwds, the default branch read with read-only git,
 * never the working tree, never a fetch). Every named item is `exists`, `deleted` (git history deleted it), `moved`
 * (history renamed it and the new name exists) or `unknown` (history never held it: an external name, an example,
 * a file of an unmerged branch).
 * A page whose names are all deleted (no moved, no existing, no never-seen path) is retired through the restorable
 * `retirePage`; a page with some deleted or moved names is flagged `stale` once per page version; the rest stays.
 * A pinned page is the owner's: flagged at most. A line that says the name was removed ("deleted `x.ts`") records
 * the removal and does not count as naming it.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import type { AiMemoryPage, AiMemoryPageRef, AiMemoryProjectRef, AiMemorySession } from "../../shared/ai-memory";
import { type ExecResult, gitRaw } from "../local/git/exec";

export const FRESHNESS_KINDS = ["decision", "gotcha", "procedure"] as const;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_CHANGES = 10;
/** `git log -S` walks the whole history (1-2 s here): a run spends at most this many on symbols. */
const PICKAXE_BUDGET = 8;
const MAX_PATHS = 30;
const MAX_SYMBOLS = 12;
const SESSION_WINDOW = 50;
const GIT_TIMEOUT_MS = 20_000;
/** Top-level directories that count as repo paths even when the ref no longer has them (a deleted top-level dir). */
const BASE_ROOTS = ["src", "resources", "scripts", "e2e", "native", "docs", "build", "tests", "test", "packages"];

export type NameStatus = "exists" | "deleted" | "moved" | "unknown";

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

/** Read-only git against one checkout: no locks taken, no working tree touched, no network. */
class RepoReader {
	#pickaxeLeft = PICKAXE_BUDGET;
	readonly #cache = new Map<string, Promise<NameStatus>>();
	constructor(
		readonly checkout: string,
		readonly ref: string,
	) {}

	async #git(args: string[]): Promise<ExecResult | null> {
		try {
			return await gitRaw(this.checkout, args, { timeoutMs: GIT_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: "0" } });
		} catch {
			return null;
		}
	}

	async roots(): Promise<string[]> {
		const out = await this.#git(["ls-tree", "-d", "--name-only", this.ref]);
		return out?.code === 0 ? out.stdout.toString("utf8").split("\n").filter(Boolean) : [];
	}

	pathStatus(path: string): Promise<NameStatus> {
		return this.#memo(`p:${path}`, async () => {
			if (await this.#exists(path)) return "exists";
			const deleted = await this.#git(["log", "--diff-filter=D", "--format=%H", "-1", this.ref, "--", path]);
			const commit = deleted?.code === 0 ? deleted.stdout.toString("utf8").trim() : "";
			if (!commit) return "unknown";
			const shown = await this.#git(["show", "-M", "--name-status", "--format=", commit]);
			for (const line of (shown?.stdout.toString("utf8") ?? "").split("\n")) {
				const [status, from, to] = line.split("\t");
				if (status?.startsWith("R") && from === path && to && (await this.#exists(to))) return "moved";
			}
			return "deleted";
		});
	}

	symbolStatus(symbol: string): Promise<NameStatus> {
		return this.#memo(`s:${symbol}`, async () => {
			const found = await this.#git(["grep", "-w", "-q", "-F", "-e", symbol, this.ref]);
			if (!found || found.code === 0) return "exists";
			if (found.code !== 1 || this.#pickaxeLeft <= 0) return "unknown";
			this.#pickaxeLeft -= 1;
			const past = await this.#git(["log", `-S${symbol}`, "--format=%H", "-1", this.ref]);
			return past?.code === 0 && past.stdout.toString("utf8").trim() ? "deleted" : "unknown";
		});
	}

	async #exists(path: string): Promise<boolean> {
		return (await this.#git(["cat-file", "-e", `${this.ref}:${path}`]))?.code === 0;
	}

	#memo(key: string, compute: () => Promise<NameStatus>): Promise<NameStatus> {
		let hit = this.#cache.get(key);
		if (!hit) {
			hit = compute();
			this.#cache.set(key, hit);
		}
		return hit;
	}
}

async function resolveRef(checkout: string): Promise<string | null> {
	const git = async (args: string[]): Promise<string | null> => {
		try {
			const out = await gitRaw(checkout, args, { timeoutMs: GIT_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: "0" } });
			return out.code === 0 ? out.stdout.toString("utf8").trim() : null;
		} catch {
			return null;
		}
	};
	const origin = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
	for (const candidate of [origin, "main", "master", "HEAD"]) {
		if (candidate && (await git(["rev-parse", "--verify", "-q", `${candidate}^{commit}`]))) return candidate;
	}
	return null;
}

/** The project's main checkout: the newest session folder that still exists, taken to the checkout holding the repo's `.git`. */
export async function mainCheckout(sessions: readonly Pick<AiMemorySession, "cwd">[]): Promise<string | null> {
	const tried = new Set<string>();
	for (const { cwd } of sessions) {
		if (!cwd || !isAbsolute(cwd) || tried.has(cwd) || !existsSync(cwd)) continue;
		tried.add(cwd);
		try {
			const out = await gitRaw(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
				timeoutMs: GIT_TIMEOUT_MS,
				env: { GIT_OPTIONAL_LOCKS: "0" },
			});
			const common = out.code === 0 ? out.stdout.toString("utf8").trim() : "";
			if (common && basename(common) === ".git" && existsSync(dirname(common))) return dirname(common);
		} catch {
			// not a repo, or git is missing: the next folder
		}
	}
	return null;
}

interface Verdict {
	action: "retire" | "flag" | "leave";
	gone: string[];
}

async function judgePage(items: NamedItems, repo: Pick<RepoReader, "pathStatus" | "symbolStatus">): Promise<Verdict> {
	const [paths, symbols] = await Promise.all([
		Promise.all(items.paths.map(async name => [name, await repo.pathStatus(name)] as const)),
		Promise.all(items.symbols.map(async name => [name, await repo.symbolStatus(name)] as const)),
	]);
	const all = [...paths, ...symbols];
	const gone = all.filter(([, status]) => status === "deleted" || status === "moved").map(([name]) => name);
	if (gone.length === 0) return { action: "leave", gone };
	const blocked = all.some(([, status]) => status === "exists" || status === "moved");
	const unseenPath = paths.some(([, status]) => status === "unknown");
	return { action: blocked || unseenPath ? "flag" : "retire", gone };
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
	const checkout = await mainCheckout(await client.sessions(project, SESSION_WINDOW));
	const ref = checkout ? await resolveRef(checkout) : null;
	if (!checkout || !ref) return report;
	report.checkout = checkout;
	report.ref = ref;
	const repo = new RepoReader(checkout, ref);
	const roots = await repo.roots();
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
	for (const candidate of candidates.slice(0, maxPages)) {
		if (report.retired.length + report.flagged.length >= maxChanges) break;
		try {
			const page = await client.page({ ...project, path: candidate.path });
			report.checked += 1;
			const verdict = await judgePage(namedItems(page.markdown, roots), repo);
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
