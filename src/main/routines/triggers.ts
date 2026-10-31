/**
 * Routine triggers: keeps one live source (GitHub, files, git, sessions) per enabled event schedule and fires
 * `ScheduleService.fire` when it sees something. `sync()` is told on every schedules state change (the service's
 * `onState`) and starts the sources a schedule now needs, stops those of schedules that were deleted, turned off or
 * edited (an edited trigger starts again with a new baseline) and all of them while everything is paused, so nothing
 * leaks and what happens while a routine is off or paused is never run later. `dispose()` stops them all.
 *
 * A webhook trigger has no source here: `POST /hooks/<id>` is answered by the web server (src/main/web/server.ts),
 * which asks `ScheduleService.webhook`.
 *
 * The sources never start a run themselves; the service's own loop guard (`ROUTINE_CHAIN_LIMIT`) stands behind the
 * source-specific ones (files and git ignore the routine's own work, sessions never see the bot's family).
 * Nothing is kept across a relaunch: every source records its baseline again, so nothing that happened while OMPdesk
 * was closed fires.
 */
import type { Schedule, ScheduleEvent, SchedulesState } from "../../shared/schedules";
import type { ScheduleService } from "../schedules";
import { createFilesSource, type WatchPath } from "./files";
import { createGitSource, type GitPort } from "./git";
import { createGithubSource, type GhApi } from "./github";
import { createSessionSource, type SessionPorts } from "./sessions";
import { ROUTINE_QUIET_MS, type RoutineSource, type SourceContext } from "./source";

export interface RoutineTriggerDeps {
	service: Pick<ScheduleService, "state" | "fire">;
	/** One runtime-log line from a source (a failure told once, a path that does not exist). */
	log: (message: string) => void;
	github: GhApi;
	watch: WatchPath;
	git: GitPort;
	sessions: SessionPorts;
	/** How long after its run a routine's changes still count as its own (default `ROUTINE_QUIET_MS`). */
	quietMs?: number;
}

interface Live {
	/** What the source was made from: another key means another source. */
	key: string;
	source: RoutineSource;
}

export class RoutineTriggers {
	readonly #deps: RoutineTriggerDeps;
	readonly #live = new Map<string, Live>();
	/** Schedules with a run going, as of the last sync. */
	#running = new Set<string>();
	/** When each routine's last run ended, while that is within the quiet window. */
	readonly #endedAt = new Map<string, number>();
	#syncing = false;
	#again = false;
	#disposed = false;

	constructor(deps: RoutineTriggerDeps) {
		this.#deps = deps;
	}

	/** The schedules changed: start, keep and stop sources to match. Safe to call from inside a source's `fire`. */
	sync(): void {
		if (this.#disposed) return;
		if (this.#syncing) {
			this.#again = true;
			return;
		}
		this.#syncing = true;
		try {
			do {
				this.#again = false;
				this.#apply(this.#deps.service.state());
			} while (this.#again && !this.#disposed);
		} finally {
			this.#syncing = false;
		}
	}

	dispose(): void {
		this.#disposed = true;
		for (const { source } of this.#live.values()) this.#stop(source);
		this.#live.clear();
		this.#endedAt.clear();
	}

	#apply(state: SchedulesState): void {
		const now = Date.now();
		const running = new Set(state.runs.filter(run => run.status === "running").map(run => run.scheduleId));
		const ended = [...this.#running].filter(id => !running.has(id));
		this.#running = running;
		const quietMs = this.#deps.quietMs ?? ROUTINE_QUIET_MS;
		for (const id of ended) this.#endedAt.set(id, now);
		for (const [id, at] of this.#endedAt) if (now - at >= quietMs) this.#endedAt.delete(id);

		const wanted = new Map<string, { schedule: Schedule; event: ScheduleEvent }>();
		if (!state.paused) {
			for (const schedule of state.schedules) {
				if (
					schedule.enabled &&
					schedule.frequency.kind === "event" &&
					schedule.frequency.event.source !== "webhook"
				)
					wanted.set(schedule.id, { schedule, event: schedule.frequency.event });
			}
		}
		for (const [id, live] of this.#live) {
			const want = wanted.get(id);
			if (want && live.key === keyOf(want.schedule, want.event)) continue;
			this.#stop(live.source);
			this.#live.delete(id);
		}
		for (const [id, { schedule, event }] of wanted) {
			if (this.#live.has(id)) continue;
			try {
				this.#live.set(id, { key: keyOf(schedule, event), source: this.#start(schedule, event) });
			} catch (error) {
				this.#deps.log(
					`${schedule.name}: could not start its trigger: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const id of ended) {
			try {
				this.#live.get(id)?.source.runEnded?.();
			} catch (error) {
				this.#deps.log(
					`a trigger could not follow its routine's run: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	#start(schedule: Schedule, event: ScheduleEvent): RoutineSource {
		const { id } = schedule;
		const context: SourceContext = {
			fire: detail => this.#deps.service.fire(id, detail),
			running: () => this.#running.has(id),
			quiet: () =>
				this.#running.has(id) ||
				Date.now() < (this.#endedAt.get(id) ?? Number.NEGATIVE_INFINITY) + (this.#deps.quietMs ?? ROUTINE_QUIET_MS),
			warn: message => this.#deps.log(`${schedule.name}: ${message}`),
		};
		switch (event.source) {
			case "github":
				return createGithubSource({ repo: event.repo, events: event.events, api: this.#deps.github, context });
			case "files":
				return createFilesSource({ path: event.path, watch: this.#deps.watch, context });
			case "git":
				return createGitSource({ repo: event.repo, branch: event.branch, git: this.#deps.git, context });
			case "session":
				return createSessionSource({
					events: event.events,
					...(event.folder === undefined ? {} : { folder: event.folder }),
					...(schedule.wakeSession === undefined ? {} : { wakeSession: schedule.wakeSession }),
					sessions: this.#deps.sessions,
					context,
				});
			case "webhook":
				throw new Error("a webhook is answered by the web server");
		}
	}

	#stop(source: RoutineSource): void {
		try {
			source.stop();
		} catch (error) {
			this.#deps.log(`a trigger did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function keyOf(schedule: Schedule, event: ScheduleEvent): string {
	return JSON.stringify([event, schedule.wakeSession ?? null]);
}
