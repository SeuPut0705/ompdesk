/**
 * The git trigger of a routine: every `SCHEDULE_TICK_MS` it reads where `refs/heads/<branch>` of a local repository
 * points, and when the branch moved to new commits it fires the routine with `git log --oneline old..new` (at most
 * ten lines). The first read only records the baseline, and so does the first read of a branch that did not exist
 * before (a branch made later is not "new commits"); a branch moved backwards (a reset) fires nothing.
 *
 * The baseline is kept across a relaunch (`context.mark`, `{head}`): a branch that moved while OMPdesk was closed
 * fires once with those commits on the first read after it starts. The mark is saved before the routine fires.
 *
 * The loop guard: commits made while the routine's own run goes are its own work. Nothing fires while it runs, and
 * when it ends the branch as it stands is the new baseline (`runEnded`), so a routine that commits to the branch it
 * watches never starts itself. Commits by anyone else during that run are taken with them: known and deliberate.
 */
import { SCHEDULE_TICK_MS } from "../schedules";
import { describeCommits, failureReporter, type RoutineSource, type SourceContext } from "./source";

/** The two git reads a git trigger makes; `repo` is the repository's folder. */
export interface GitPort {
	/** The commit `refs/heads/<branch>` names; null when the branch does not exist; rejects when git cannot read the repository. */
	head(repo: string, branch: string): Promise<string | null>;
	/** The commits in `from..to`: how many, and `git log --oneline` of the newest ten. */
	commits(repo: string, from: string, to: string): Promise<{ total: number; lines: string[] }>;
}

export interface GitSourceOptions {
	repo: string;
	branch: string;
	git: GitPort;
	context: SourceContext;
	/** How often the branch is read (default `SCHEDULE_TICK_MS`). */
	intervalMs?: number;
}

export function createGitSource(options: GitSourceOptions): RoutineSource {
	return new GitSource(options);
}

class GitSource implements RoutineSource {
	readonly #repo: string;
	readonly #branch: string;
	readonly #git: GitPort;
	readonly #context: SourceContext;
	readonly #report: (key: string, error: unknown | null) => void;
	readonly #timer: ReturnType<typeof setInterval>;
	/** The commit last seen: undefined before the first read, null while the branch did not exist. */
	#baseline: string | null | undefined;
	/** The next read only takes the branch as the baseline: the routine's own run went since the last one. */
	#rebase = false;
	#busy = false;
	/** A read was asked for while one was going. */
	#again = false;
	#stopped = false;

	constructor(options: GitSourceOptions) {
		this.#repo = options.repo;
		this.#branch = options.branch;
		this.#git = options.git;
		this.#context = options.context;
		this.#report = failureReporter(message =>
			options.context.warn(`git ${options.repo} ${options.branch}: ${message}`),
		);
		const mark = options.context.mark as { head?: unknown } | undefined;
		if (mark && (typeof mark.head === "string" || mark.head === null)) this.#baseline = mark.head;
		this.#timer = setInterval(() => void this.#poll(), options.intervalMs ?? SCHEDULE_TICK_MS);
		this.#timer.unref?.();
		void this.#poll();
	}

	stop(): void {
		this.#stopped = true;
		clearInterval(this.#timer);
	}

	runEnded(): void {
		this.#rebase = true;
		if (this.#busy) this.#again = true;
		else void this.#poll();
	}

	async #poll(): Promise<void> {
		if (this.#busy || this.#stopped) return;
		this.#busy = true;
		try {
			await this.#read();
		} catch (error) {
			if (!this.#stopped) this.#report("read", error);
		} finally {
			this.#busy = false;
			if (this.#again && !this.#stopped) {
				this.#again = false;
				void this.#poll();
			}
		}
	}

	async #read(): Promise<void> {
		if (this.#context.running()) {
			this.#rebase = true;
			return;
		}
		const head = await this.#git.head(this.#repo, this.#branch);
		if (this.#stopped) return;
		if (this.#context.running()) {
			this.#rebase = true;
			return;
		}
		this.#report("read", null);
		if (head === null) {
			this.#report("branch", new Error("the branch does not exist"));
			if (this.#baseline === undefined) {
				this.#baseline = null;
				this.#context.saveMark({ head: null });
			}
			return;
		}
		this.#report("branch", null);
		const before = this.#baseline;
		this.#baseline = head;
		if (before !== head) this.#context.saveMark({ head });
		if (this.#rebase) {
			this.#rebase = false;
			return;
		}
		if (!before || before === head) return;
		const { total, lines } = await this.#git.commits(this.#repo, before, head);
		if (this.#stopped || total === 0 || this.#context.running()) return;
		this.#context.fire(describeCommits(this.#branch, total, lines));
	}
}
