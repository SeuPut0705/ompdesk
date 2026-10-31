/**
 * The session trigger of a routine: a session of this computer finished a turn (`done`), failed one (`failed`) or
 * waits for the person's answer (`waiting`), told by the tab pool's activity (`SidecarPool.observeTabs`). With a
 * `folder`, only sessions whose own folder contains it (at path segments: `/x/y` matches `/x/y` and `/x/y/app`).
 *
 * Whose sessions never fire it, because they would loop or are not the person's to follow: the bot's own session
 * (pref `bot`, while the bot is on), every session the bot opened (the sidebar's family rule, `openerOfSessions`:
 * what the bot's children opened included), the session a wake-up routine delivers into (`Schedule.wakeSession`)
 * and what it opened, any tab without a session yet, and a tab that runs on a paired host. A turn the person
 * stopped (stop reason `aborted`) is neither done nor failed.
 */
import type { SessionEventKind } from "../../shared/schedules";
import { type FamilySession, type FamilyTab, openerOfSessions } from "../../shared/sidebar-rows";
import type { TabActivity } from "../sidecar-pool";
import { clip, type RoutineSource, type SourceContext } from "./source";

/** What a session routine reads of a live tab (`SidecarPool.resumeFacts` and `tabFacts`). */
export interface SessionTab {
	tabId: string;
	/** The session file the tab holds; absent for a tab that has no session yet. */
	sessionFile?: string;
	cwd: string;
	title: string;
	/** Set for a tab that runs on a paired host. */
	device?: string;
	openedBy?: string;
	openedBySession?: string;
}

/** The pool as session routines see it. */
export interface SessionPorts {
	observeTabs(observer: (activity: TabActivity) => void): () => void;
	tabs(): SessionTab[];
	/** The bot's session file while the bot is on, else null. */
	botPath(): string | null;
}

export interface SessionSourceOptions {
	events: readonly SessionEventKind[];
	folder?: string;
	/** The session file the routine wakes, when it is a wake-up. */
	wakeSession?: string;
	sessions: SessionPorts;
	context: SourceContext;
}

const TEXT_CHARS = 200;

export function createSessionSource(options: SessionSourceOptions): RoutineSource {
	const { sessions, context } = options;
	/** What was last told per tab (cleared when its next turn starts): one idle never fires twice. */
	const told = new Map<string, string>();
	const unobserve = sessions.observeTabs(activity => {
		if (activity.type === "busy") {
			told.delete(activity.tabId);
			return;
		}
		const kind = kindOf(activity);
		if (!kind || !options.events.includes(kind)) return;
		const key = activity.type === "ask" ? `ask:${activity.requestId}` : kind;
		if (told.get(activity.tabId) === key) return;
		const tab = sessions.tabs().find(item => item.tabId === activity.tabId);
		if (!tab?.sessionFile || tab.device !== undefined) return;
		if (options.folder !== undefined && !folderHolds(tab.cwd, options.folder)) return;
		if (isExcluded(tab, sessions, options.wakeSession)) return;
		told.set(activity.tabId, key);
		context.fire(describe(kind, tab, activity));
	});
	return { stop: unobserve };
}

function kindOf(activity: TabActivity): SessionEventKind | null {
	if (activity.type === "ask") return "waiting";
	if (activity.type !== "idle" || !activity.outcome) return null;
	if (activity.outcome.stopReason === "error") return "failed";
	return activity.outcome.stopReason === "aborted" ? null : "done";
}

function describe(kind: SessionEventKind, tab: SessionTab, activity: TabActivity): string {
	const named = `Session "${clip(tab.title, 120) || "Untitled"}" in ${tab.cwd}`;
	if (kind === "waiting") {
		const text = activity.type === "ask" ? clip(activity.text, TEXT_CHARS) : "";
		return `${named} is waiting for an answer${text ? `: ${text}` : ""}`;
	}
	if (kind === "failed") {
		const error = activity.type === "idle" ? clip(activity.outcome?.errorMessage ?? "", TEXT_CHARS) : "";
		return `${named} failed its turn${error ? `: ${error}` : ""}`;
	}
	return `${named} finished its turn`;
}

/** `folder` is one of `cwd`'s path segments or runs of them, compared without case, `/` and a trailing slash. */
function folderHolds(cwd: string, folder: string): boolean {
	const segments = (path: string) =>
		path
			.replaceAll("\\", "/")
			.replace(/^\/+|\/+$/g, "")
			.toLowerCase();
	const needle = segments(folder);
	return needle !== "" && `/${segments(cwd)}/`.includes(`/${needle}/`);
}

/** The bot, the sessions it opened and the wake-up's own session (with what it opened) never fire a routine. */
function isExcluded(tab: SessionTab, sessions: SessionPorts, wakeSession: string | undefined): boolean {
	const file = tab.sessionFile;
	if (!file) return true;
	const roots = [sessions.botPath(), wakeSession ?? null].filter((path): path is string => path !== null);
	if (roots.length === 0) return false;
	if (roots.includes(file)) return true;
	const live = sessions.tabs().filter(item => item.sessionFile !== undefined && item.device === undefined);
	const tabs: FamilyTab[] = live.map(item => ({
		id: item.tabId,
		...(item.sessionFile === undefined ? {} : { sessionPath: item.sessionFile }),
		...(item.openedBy === undefined ? {} : { openedBy: item.openedBy }),
		...(item.openedBySession === undefined ? {} : { openedBySession: item.openedBySession }),
	}));
	const known: FamilySession[] = live.map(item => ({
		path: item.sessionFile ?? "",
		id: item.sessionFile ?? "",
		liveTabId: item.tabId,
	}));
	for (const root of roots) if (!known.some(session => session.path === root)) known.push({ path: root, id: root });
	const families = openerOfSessions(tabs, known);
	const root = families.get(file);
	return root !== undefined && roots.includes(root);
}
