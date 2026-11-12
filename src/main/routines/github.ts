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
 * so what happened during the outage fires once GitHub answers again. The seen ids and the default branch's head are
 * kept across a relaunch (`context.mark`), so what happened while OMPdesk was closed fires once on the first poll
 * after it starts (within what the endpoints still list); the mark is saved before the routine fires.
 * More than 20 events between two polls fire only the newest ones the endpoint lists, and at most
 * `EVENTS_PER_POLL` of a kind fire at once. A `gh` failure (not signed in, offline, 404, rate limit) fires nothing;
 * it is told once per distinct message (`failureReporter`: the runtime log and a failed run in the routine's
 * history) and polling goes on.
 *
 * Each read, its rows and lines and where the trigger stands are the core's (`routines.github`,
 * `native/ompdesk/crates/core/src/routines/github.rs`); this source keeps the poll's timer, the order of the kinds,
 * telling a failure once, and saving the mark before it fires.
 */
import { GITHUB_EVENT_KINDS, GITHUB_POLL_MINUTES, GITHUB_REPO, type GithubEventKind } from "../../shared/schedules";
import { failureReporter, type RoutineSource, type SourceContext } from "./source";

/** One read of one kind: the lines of what is new, where the trigger stands now and what the next launch reads. */
export interface GithubRead {
	/** The core's, handed back with the next read. */
	state: unknown;
	/** Saved as the trigger's mark after a read that did not fail. */
	mark: unknown;
	lines: string[];
	/** gh's or GitHub's failure, in words without a token; `state` still moved as far as the read went. */
	error: string | null;
}

/** Where a read starts: the last read's `state`, or before the first answer the last launch's mark. */
export type GithubFrom = { state: unknown } | { mark: unknown };

/** One read of `kind` in `repo` with the person's own `gh` (`routines.github`). */
export type GithubPort = (repo: string, kind: GithubEventKind, from: GithubFrom) => Promise<GithubRead>;

/** `owner/name` as GitHub spells it, and neither part a dot path (`o/..` would reach another endpoint). */
function usableRepo(repo: string): boolean {
	return GITHUB_REPO.test(repo) && !repo.split("/").some(part => /^\.+$/.test(part));
}

export interface GithubSourceOptions {
	repo: string;
	events: readonly GithubEventKind[];
	read: GithubPort;
	context: SourceContext;
}

export function createGithubSource(options: GithubSourceOptions): RoutineSource {
	return new GithubSource(options);
}

class GithubSource implements RoutineSource {
	readonly #repo: string;
	readonly #events: readonly GithubEventKind[];
	readonly #read: GithubPort;
	readonly #context: SourceContext;
	readonly #report: (key: string, error: unknown | null) => void;
	#from: GithubFrom;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;

	constructor(options: GithubSourceOptions) {
		this.#repo = options.repo;
		this.#events = GITHUB_EVENT_KINDS.filter(kind => options.events.includes(kind));
		this.#read = options.read;
		this.#context = options.context;
		this.#report = failureReporter(message => options.context.warn(`github ${options.repo}: ${message}`));
		this.#from = { mark: options.context.mark };
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
				const read = await this.#read(this.#repo, kind, this.#from);
				if (this.#stopped) return;
				this.#from = { state: read.state };
				if (read.error !== null) throw new Error(read.error);
				this.#report(kind, null);
				this.#context.saveMark(read.mark);
				for (const line of read.lines) this.#context.fire(line);
			} catch (error) {
				if (this.#stopped) return;
				this.#report(kind, error);
			}
		}
		if (this.#stopped) return;
		this.#timer = setTimeout(() => void this.#poll(), GITHUB_POLL_MINUTES * 60_000);
		this.#timer.unref?.();
	}
}
