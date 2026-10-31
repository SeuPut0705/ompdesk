/**
 * What a schedule's trigger says, in the UI language: one summary for every place that lists schedules (Settings ›
 * Schedules, the bot's routines on its work board), so the same trigger reads the same everywhere. English text for
 * agents and logs is `describeFrequency` in `shared/schedules.ts`.
 */
import type { GithubEventKind, ScheduleFrequency, ScheduleRunStatus, SessionEventKind } from "../../shared/schedules";
import type { BadgeVariant } from "../components/common";
import { basename, formatClock, uiLocale } from "./format";
import { translate } from "./i18n";

/** The badge a run's status wears, on every list of runs. */
export const RUN_STATUS_BADGE: Record<ScheduleRunStatus, BadgeVariant> = {
	running: "info",
	succeeded: "success",
	failed: "error",
	stopped: "muted",
	skipped: "warning",
};

/** Short weekday names in the UI language, Sunday first (2026-10-18 is a Sunday). */
export function weekdayNames(): string[] {
	const format = new Intl.DateTimeFormat(uiLocale(), { weekday: "short" });
	return Array.from({ length: 7 }, (_, day) => format.format(new Date(2026, 9, 18 + day)));
}

const GITHUB_KIND_KEY: Record<GithubEventKind, string> = {
	pull_request: "schedules.github.pull_request",
	issue: "schedules.github.issue",
	ci_failure: "schedules.github.ci_failure",
	release: "schedules.github.release",
	push: "schedules.github.push",
};

const SESSION_KIND_KEY: Record<SessionEventKind, string> = {
	done: "schedules.session.done",
	failed: "schedules.session.failed",
	waiting: "schedules.session.waiting",
};

function list(items: string[], type: "conjunction" | "disjunction"): string {
	return new Intl.ListFormat(uiLocale(), { style: "long", type }).format(items);
}

/**
 * "Every 2 h" / "Every day at 09:30" / "Mon, Wed at 09:30" / "Once at 09:30" / "On a webhook call" / "GitHub pull
 * requests in owner/name" / "When files change under src" / "New commits on main" / "When a session finishes a turn".
 */
export function frequencySummary(frequency: ScheduleFrequency): string {
	switch (frequency.kind) {
		case "interval":
			return frequency.minutes % 60 === 0
				? translate("schedules.every.hours", { count: frequency.minutes / 60 })
				: translate("schedules.every.minutes", { count: frequency.minutes });
		case "daily": {
			if (frequency.days.length === 0 || frequency.days.length === 7) {
				return translate("schedules.daily", { time: frequency.time });
			}
			const names = weekdayNames();
			return translate("schedules.weekly", {
				days: frequency.days.map(day => names[day]).join(", "),
				time: frequency.time,
			});
		}
		case "once":
			return translate("schedules.once", { time: formatClock(frequency.at) });
		case "event": {
			const event = frequency.event;
			switch (event.source) {
				case "webhook":
					return translate("schedules.event.webhook");
				case "github":
					return translate("schedules.event.github", {
						events: list(
							event.events.map(kind => translate(GITHUB_KIND_KEY[kind])),
							"conjunction",
						),
						repo: event.repo,
					});
				case "files":
					return translate("schedules.event.files", { path: basename(event.path) || event.path });
				case "git":
					return translate("schedules.event.git", { branch: event.branch });
				case "session": {
					const what = list(
						event.events.map(kind => translate(SESSION_KIND_KEY[kind])),
						"disjunction",
					);
					return event.folder
						? translate("schedules.event.sessionIn", { what, folder: basename(event.folder) || event.folder })
						: translate("schedules.event.session", { what });
				}
				case "email":
					return [
						translate("schedules.event.email", { account: event.account }),
						event.from ? translate("schedules.event.emailFrom", { from: event.from }) : "",
						event.to ? translate("schedules.event.emailTo", { to: event.to }) : "",
						event.subject ? translate("schedules.event.emailSubject", { subject: event.subject }) : "",
					].join("");
			}
		}
	}
}

/**
 * The full place an event trigger watches (the whole path or repository folder the summary shortens); null when the
 * summary says all there is.
 */
export function frequencyPlace(frequency: ScheduleFrequency): string | null {
	if (frequency.kind !== "event") return null;
	const event = frequency.event;
	switch (event.source) {
		case "files":
			return event.path;
		case "git":
			return event.repo;
		case "session":
			return event.folder ?? null;
		default:
			return null;
	}
}
