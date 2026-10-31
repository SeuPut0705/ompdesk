/**
 * The GitHub trigger of a routine: every `GITHUB_POLL_MINUTES` it asks GitHub, with the person's own `gh` (their
 * login, their proxy and PATH; OMPdesk keeps no token of its own), what happened in one repository and fires the
 * routine once per new event of the kinds it follows:
 *
 * - `pull_request`: pull requests opened (`repos/<repo>/pulls`, newest 20),
 * - `issue`: issues opened, pull requests left out (`repos/<repo>/issues`, newest 20),
 * - `ci_failure`: workflow runs that concluded `failure` (`repos/<repo>/actions/runs?status=failure`, newest 20),
 * - `release`: releases published, drafts left out (`repos/<repo>/releases`, newest 10),
 * - `push`: commits new on the default branch (`repos/<repo>/commits`, newest 20).
 *
 * The first answer of each kind only records what already exists (a new routine never runs on its creation); a kind
 * whose first answer failed takes its baseline from its first good one, and a kind that failed later keeps its baseline,
 * so what happened during the outage fires once GitHub answers again. Nothing is kept across a relaunch: a relaunch
 * records the baseline again, so an event that happened while OMPdesk was closed fires nothing (as a timed
 * schedule's missed start).
 * More than 20 events between two polls fire only the newest ones the endpoint lists, and at most
 * `EVENTS_PER_POLL` of a kind fire at once. A `gh` failure (not signed in, offline, 404, rate limit) fires nothing;
 * it is told to the runtime log once per distinct message (`failureReporter`) and polling goes on.
 */
import { GITHUB_EVENT_KINDS, GITHUB_POLL_MINUTES, GITHUB_REPO, type GithubEventKind } from "../../shared/schedules";
import { clip, describeCommits, failureReporter, type RoutineSource, type SourceContext } from "./source";

/** `gh api <endpoint>` as parsed JSON; rejects with a readable message when it cannot answer. */
export type GhApi = (endpoint: string) => Promise<unknown>;

const EVENTS_PER_POLL = 10;
/** Ids remembered per kind: the endpoints list at most 20, a rerun or an edit may bring an old id back. */
const SEEN_MAX = 200;
const TITLE_CHARS = 120;

interface Person {
	login?: string;
}
interface PullRow {
	number: number;
	title?: string;
	user?: Person | null;
	html_url?: string;
	pull_request?: unknown;
}
interface RunRow {
	id: number;
	name?: string | null;
	display_title?: string | null;
	head_branch?: string | null;
	conclusion?: string | null;
	html_url?: string;
}
interface ReleaseRow {
	id: number;
	tag_name?: string;
	name?: string | null;
	draft?: boolean;
	author?: Person | null;
	html_url?: string;
}
interface CommitRow {
	sha: string;
	commit?: { message?: string };
}

const who = (person: Person | null | undefined): string => person?.login || "someone";

/** What one kind reads and says; `id` is what tells a new row from one already seen. */
interface RowKind<Row> {
	endpoint: (repo: string) => string;
	rows: (json: unknown) => Row[];
	id: (row: Row) => string | number;
	describe: (row: Row) => string;
}

function array(json: unknown): unknown[] {
	if (!Array.isArray(json)) throw new Error("GitHub's answer was not a list");
	return json;
}

const PULL_REQUESTS: RowKind<PullRow> = {
	endpoint: repo => `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=20`,
	rows: json => array(json) as PullRow[],
	id: row => row.number,
	describe: row =>
		`PR #${row.number} "${clip(row.title ?? "", TITLE_CHARS)}" opened by ${who(row.user)}: ${row.html_url ?? ""}`,
};

const ISSUES: RowKind<PullRow> = {
	endpoint: repo => `repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=20`,
	rows: json => (array(json) as PullRow[]).filter(row => row.pull_request === undefined),
	id: row => row.number,
	describe: row =>
		`Issue #${row.number} "${clip(row.title ?? "", TITLE_CHARS)}" opened by ${who(row.user)}: ${row.html_url ?? ""}`,
};

const CI_FAILURES: RowKind<RunRow> = {
	endpoint: repo => `repos/${repo}/actions/runs?status=failure&per_page=20`,
	rows: json => {
		const runs = (json as { workflow_runs?: unknown } | null)?.workflow_runs;
		return (array(runs) as RunRow[]).filter(row => row.conclusion === undefined || row.conclusion === "failure");
	},
	id: row => row.id,
	describe: row => {
		const title = clip(row.display_title ?? "", TITLE_CHARS);
		return `CI failure: workflow "${clip(row.name ?? "", 80)}" on ${row.head_branch || "an unknown branch"}${title ? ` ("${title}")` : ""}: ${row.html_url ?? ""}`;
	},
};

const RELEASES: RowKind<ReleaseRow> = {
	endpoint: repo => `repos/${repo}/releases?per_page=10`,
	rows: json => (array(json) as ReleaseRow[]).filter(row => row.draft !== true),
	id: row => row.id,
	describe: row => {
		const tag = row.tag_name ?? "";
		const name = clip(row.name ?? "", TITLE_CHARS);
		return `Release ${tag}${name && name !== tag ? ` "${name}"` : ""} published by ${who(row.author)}: ${row.html_url ?? ""}`;
	},
};

/** A kind's rows as the source reads them: each one's id and the line that tells it. */
interface Reader {
	endpoint: (repo: string) => string;
	read: (json: unknown) => { id: string | number; line: string }[];
}

function reader<Row>(kind: RowKind<Row>): Reader {
	return {
		endpoint: kind.endpoint,
		read: json => kind.rows(json).map(row => ({ id: kind.id(row), line: kind.describe(row) })),
	};
}

/** The kinds read by row; `push` is read by commit order, not by id, and has its own method. */
const READERS: Record<Exclude<GithubEventKind, "push">, Reader> = {
	pull_request: reader(PULL_REQUESTS),
	issue: reader(ISSUES),
	ci_failure: reader(CI_FAILURES),
	release: reader(RELEASES),
};

/** `owner/name` as GitHub spells it, and neither part a dot path (`o/..` would reach another endpoint). */
function usableRepo(repo: string): boolean {
	return GITHUB_REPO.test(repo) && !repo.split("/").some(part => /^\.+$/.test(part));
}

export interface GithubSourceOptions {
	repo: string;
	events: readonly GithubEventKind[];
	api: GhApi;
	context: SourceContext;
}

export function createGithubSource(options: GithubSourceOptions): RoutineSource {
	return new GithubSource(options);
}

class GithubSource implements RoutineSource {
	readonly #repo: string;
	readonly #events: readonly GithubEventKind[];
	readonly #api: GhApi;
	readonly #context: SourceContext;
	readonly #report: (key: string, error: unknown | null) => void;
	/** Ids seen per row kind; a kind is absent until its baseline is taken. */
	readonly #seen = new Map<string, Set<string | number>>();
	/** The default branch's newest commit as last seen, and the branch it was read on; absent until the baseline. */
	#head: { branch: string; sha: string } | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;

	constructor(options: GithubSourceOptions) {
		this.#repo = options.repo;
		this.#events = GITHUB_EVENT_KINDS.filter(kind => options.events.includes(kind));
		this.#api = options.api;
		this.#context = options.context;
		this.#report = failureReporter(message => options.context.warn(`github ${options.repo}: ${message}`));
		if (!usableRepo(options.repo)) {
			options.context.warn(`github ${options.repo}: not an owner/name repository`);
			this.#stopped = true;
			return;
		}
		void this.#poll();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
	}

	async #poll(): Promise<void> {
		for (const kind of this.#events) {
			if (this.#stopped) return;
			try {
				const details = kind === "push" ? await this.#readPush() : await this.#readRows(kind);
				this.#report(kind, null);
				if (this.#stopped) return;
				for (const detail of details) this.#context.fire(detail);
			} catch (error) {
				if (this.#stopped) return;
				this.#report(kind, error);
			}
		}
		if (this.#stopped) return;
		this.#timer = setTimeout(() => void this.#poll(), GITHUB_POLL_MINUTES * 60_000);
		this.#timer.unref?.();
	}

	/** The lines of the rows of `kind` not seen before, oldest first; none (and a baseline taken) on its first answer. */
	async #readRows(kind: Exclude<GithubEventKind, "push">): Promise<string[]> {
		const spec = READERS[kind];
		const rows = spec.read(await this.#api(spec.endpoint(this.#repo)));
		if (this.#stopped) return [];
		const seen = this.#seen.get(kind);
		if (!seen) {
			this.#seen.set(kind, new Set(rows.map(row => row.id)));
			return [];
		}
		const fresh = rows.filter(row => !seen.has(row.id));
		for (const row of rows) seen.add(row.id);
		while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string | number);
		return fresh
			.slice(0, EVENTS_PER_POLL)
			.reverse()
			.map(row => row.line);
	}

	/** One line for the new commits of the default branch, or none (first answer, a new default branch, no news). */
	async #readPush(): Promise<string[]> {
		const info = (await this.#api(`repos/${this.#repo}`)) as { default_branch?: string } | null;
		const branch = info?.default_branch;
		if (!branch) throw new Error("GitHub named no default branch");
		const commits = array(
			await this.#api(`repos/${this.#repo}/commits?sha=${encodeURIComponent(branch)}&per_page=20`),
		) as CommitRow[];
		if (this.#stopped) return [];
		const newest = commits[0]?.sha;
		if (!newest) return [];
		const before = this.#head;
		this.#head = { branch, sha: newest };
		if (!before || before.branch !== branch) return [];
		const at = commits.findIndex(commit => commit.sha === before.sha);
		const fresh = at === -1 ? commits : commits.slice(0, at);
		if (fresh.length === 0) return [];
		const lines = fresh.map(commit => `${commit.sha.slice(0, 7)} ${commit.commit?.message?.split("\n")[0] ?? ""}`);
		return [describeCommits(`${branch} (${this.#repo})`, fresh.length, lines)];
	}
}
