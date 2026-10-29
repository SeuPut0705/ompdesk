/**
 * Which sessions and groups a sidebar lists, for every viewer of a computer's sessions: that computer's own sidebar (a
 * window, or the phone page it serves) and a paired device's section for it. A viewer only gathers what it knows (the
 * index's rows with what their computer says beside each, its own tabs there, what each folder is) and draws what
 * `sidebarRows` returns; no viewer decides a row itself, so one world reads the same everywhere.
 */

import { agentMessageSender } from "./agent-control";
import type { SessionInfo, SessionKind } from "./ipc-types";
import { isOmpdeskWorktreeFolder, type WorktreeKind } from "./project-origin";
import type { SidebarProject } from "./sidebar-projects";

/** A row: a session the index lists, or one a tab holds before the index lists its file (`liveTabId`). */
export type RowSession = SessionInfo & { liveTabId?: string };

/** A tab of the viewer's on the computer whose sessions these are (or a stand-in for one it runs for a device). */
export interface RowTab {
	id: string;
	sessionPath?: string;
	sessionId?: string;
	cwd: string;
	kind: SessionKind;
	/** What a row made from it reads before the index lists its session. */
	title: string | null;
	status: string;
	/** Last run's strip painted before main answers: nothing runs behind it. */
	ghost?: boolean;
	/** A new session nobody wrote to yet: no session until its first run, though its folder keeps its group. */
	unstarted?: boolean;
	/** The empty start tab: no session and no group. */
	placeholder?: boolean;
	openedBy?: string;
	openedBySession?: string;
	/** When the viewer first saw it: a row made from it sorts by this until the index lists it. */
	seenAt: string;
	device?: string;
}

/** What a folder is, as its computer says. */
export interface FolderFacts {
	/** The project a linked worktree was cut from, live or removed: its sessions are that project's rows. */
	project?: string;
	/** The main checkout the folder is in, as git says (the folder under another spelling, or a parent). */
	root?: string;
	kind?: WorktreeKind;
	gone: boolean;
}

export interface RowOrder {
	pinnedSessions: readonly string[];
	pinnedGroups: readonly string[];
	groupOrder: readonly string[];
	/** The order the person set for a list (a group's key, or `CHATS_ORDER_KEY`). */
	sessionOrder: (list: string) => readonly string[] | undefined;
}

export interface SidebarFacts {
	/**
	 * The index's rows, with what their computer says beside each: `openedBySession` (the opener a record names, `null`
	 * for none known, absent from an older host: then no agent brief is read) and `heldOnHost` (a tab the viewer cannot
	 * see holds it).
	 */
	sessions: readonly SessionInfo[];
	tabs: readonly RowTab[];
	/**
	 * Sessions (file or id) a tab the viewer cannot see holds and uses: a paired device's tab this computer runs,
	 * whatever its state.
	 */
	usedThere: ReadonlySet<string>;
	/** Sessions main recorded closing (`agentClosedChildren`): one no opener row holds folds into its project. */
	closed: ReadonlySet<string>;
	/** The checkout a closed record names for a session: where a removed worktree's one folds. */
	recordedCwd: ReadonlyMap<string, string>;
	projects: readonly SidebarProject[];
	removed: readonly string[];
	folder: (cwd: string) => FolderFacts;
	/** The computer's no-project workspace: a session there is a chat. */
	workspace: string | null;
	titleOf: (session: RowSession) => string;
	hasContent: (session: SessionInfo) => boolean;
	/** An Autopilot run's own session (`child: false`) or one of its children, keyed by run. */
	runOf: (session: RowSession) => { key: string; child: boolean } | null;
	archived: ReadonlySet<string>;
	/** Session files and tab ids another section shows (a child nested under its opener elsewhere). */
	nested: ReadonlySet<string>;
	order: RowOrder;
	query: string;
	nameOf: (group: string) => string;
}

export interface RowGroup {
	/** The group's key and where "new session here" starts: the folder, or a linked worktree's project. */
	cwd: string;
	/** Every folder whose sessions the group holds. */
	members: string[];
	sessions: RowSession[];
	/** Sessions an agent opened that no opener row holds: listed only while they need a look. */
	folded: RowSession[];
	/** In the computer's project list: shown with no session too. */
	listed: boolean;
	/** A new, still empty tab works in it. */
	open: boolean;
	missing: boolean;
}

export interface SidebarRows {
	/** Every row before families, folds and the filter take theirs. */
	sessions: RowSession[];
	/** The index's rows among them. */
	listed: RowSession[];
	/** The rows that are no chat. */
	code: RowSession[];
	/** Every group, filter or not. */
	allGroups: RowGroup[];
	/** The groups the filter shows. */
	groups: RowGroup[];
	chats: RowSession[];
	archived: RowSession[];
	/** An opener's path → the sessions it opened that are listed, oldest first. */
	children: ReadonlyMap<string, readonly RowSession[]>;
	/** An opened session's path → the session that started its chain. */
	rootOf: ReadonlyMap<string, string>;
	/** An Autopilot child's path → its run's folder. */
	runParent: ReadonlyMap<string, string>;
}

/** The key the sidebar orders a device's Chats section under. */
export const CHATS_ORDER_KEY = "\u0000chats";

/**
 * A chat, or a session in that machine's no-project workspace (`~/.omp/work`), is one of its chats (the Chats
 * section); everything else sits under its project.
 */
export function isChatSession(session: { kind?: SessionKind; cwd: string }, workspace: string | null): boolean {
	return session.kind === "chat" || (workspace !== null && session.cwd === workspace);
}

/**
 * Sidebar order of projects and of a list's sessions. Pinned items stay on top. Within each partition an item the
 * user placed (by dragging or Move up/down) keeps its place; items they never placed (new since the last move, or
 * before any) come first, newest first, so a freshly opened project or a new session is always in view.
 */
export function orderByManual<T>(
	items: readonly T[],
	key: (item: T) => string,
	options: { pinned: readonly string[]; manual: readonly string[]; recency: (item: T) => number },
): T[] {
	const manualIndex = new Map(options.manual.map((id, index) => [id, index]));
	const pinned = new Set(options.pinned);
	return items.toSorted((a, b) => {
		const aKey = key(a);
		const bKey = key(b);
		const aPinned = pinned.has(aKey) ? 0 : 1;
		const bPinned = pinned.has(bKey) ? 0 : 1;
		if (aPinned !== bPinned) return aPinned - bPinned;
		const aPlaced = manualIndex.get(aKey);
		const bPlaced = manualIndex.get(bKey);
		if (aPlaced !== undefined && bPlaced !== undefined) return aPlaced - bPlaced;
		if (aPlaced !== undefined) return 1;
		if (bPlaced !== undefined) return -1;
		return options.recency(b) - options.recency(a);
	});
}

/** The tab fields the opener rule reads. */
export interface FamilyTab {
	id: string;
	sessionPath?: string;
	sessionId?: string;
	openedBy?: string;
	openedBySession?: string;
}

/** The session fields the opener rule reads. */
export interface FamilySession {
	path: string;
	id: string;
	liveTabId?: string;
	/** What its row reads: the sender title of an agent's brief names it. */
	title?: string;
	/** The indexed first prompt: an `<ompdesk-agent-message>` brief marks a session an agent opened. */
	firstMessage?: string;
	/** Stock's `created`: an opener is older than what it opened. */
	created?: string;
}

/**
 * The session a legacy child (opened before provenance was kept: no tab link, no closed record) names as its sender in
 * the brief its first message holds: the newest session titled so that existed when the child was made. Null for a
 * person's own prompt, a brief without a sender, or a sender nobody here is titled as.
 */
function briefOpenerOf(child: FamilySession, sessions: readonly FamilySession[]): FamilySession | null {
	const from = (agentMessageSender(child.firstMessage ?? "") ?? "").replaceAll(/\s+/g, " ").trim();
	if (!from) return null;
	const born = Date.parse(child.created ?? "");
	let best: FamilySession | null = null;
	let bestMade = Number.NEGATIVE_INFINITY;
	for (const candidate of sessions) {
		if (candidate.path === child.path || (candidate.title ?? "").replaceAll(/\s+/g, " ").trim() !== from) continue;
		const made = Date.parse(candidate.created ?? "");
		if (made > born) continue;
		const rank = Number.isNaN(made) ? Number.NEGATIVE_INFINITY : made;
		if (!best || rank > bestMade) {
			best = candidate;
			bestMade = rank;
		}
	}
	return best;
}

/**
 * Which session each opened session nests under: child session path → the path of the session that started the chain.
 * A tab names its opener by tab id while both live, and by the opener's session file after a relaunch (every tab id is
 * new then, and the opener needs no tab: its stored session is enough). A session without a tab here is found by what
 * was recorded naming the opener's file (`recordedOpeners`: the closed-children record for one main closed after its
 * work landed, the review list for one another window holds, what a host says of its row), else, for one opened before
 * either was kept, by the sender its first message's agent brief names (a title, which may have changed since). Whatever
 * its folder or worktree, an opened session goes under its opener; one opened by an opened session goes under the first
 * of them, so the family is one level deep. A session whose opener is not in the list (deleted, or in another lane) is
 * not nested, and a cycle nests nothing.
 */
export function openerOfSessions(
	tabs: readonly FamilyTab[],
	sessions: readonly FamilySession[],
	recordedOpeners: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
	const tabOf = (session: FamilySession): FamilyTab | undefined =>
		(session.liveTabId ? tabs.find(tab => tab.id === session.liveTabId) : undefined) ??
		tabs.find(tab => tab.sessionPath !== undefined && tab.sessionPath === session.path) ??
		tabs.find(tab => tab.sessionId !== undefined && tab.sessionId === session.id);
	const sessionOf = new Map<string, FamilySession>();
	for (const session of sessions) {
		const tab = tabOf(session);
		if (tab && !sessionOf.has(tab.id)) sessionOf.set(tab.id, session);
	}
	const known = new Set(sessions.map(session => session.path));
	const direct = new Map<string, string>();
	for (const tab of tabs) {
		const child = sessionOf.get(tab.id);
		if (!child) continue;
		const opener =
			(tab.openedBy ? tabs.find(entry => entry.id === tab.openedBy) : undefined) ??
			(tab.openedBySession ? tabs.find(entry => entry.sessionPath === tab.openedBySession) : undefined);
		const parent = opener && opener.id !== tab.id ? sessionOf.get(opener.id)?.path : undefined;
		const path = parent ?? (tab.openedBySession && known.has(tab.openedBySession) ? tab.openedBySession : undefined);
		if (path && path !== child.path) direct.set(child.path, path);
	}
	for (const session of sessions) {
		if (direct.has(session.path)) continue;
		const opener = recordedOpeners.get(session.path);
		if (opener && opener !== session.path && known.has(opener)) {
			direct.set(session.path, opener);
			continue;
		}
		const sender = briefOpenerOf(session, sessions);
		if (sender) direct.set(session.path, sender.path);
	}
	const roots = new Map<string, string>();
	for (const child of direct.keys()) {
		const seen = new Set([child]);
		let root = direct.get(child);
		while (root && direct.has(root) && !seen.has(root)) {
			seen.add(root);
			root = direct.get(root);
		}
		if (root && !seen.has(root)) roots.set(child, root);
	}
	return roots;
}

/**
 * Tabs on a paired device that a session of this computer opened (`ompdesk_session_open {device}`): child tab id → the
 * opener's session path. The opener is found by tab id while it is open here, else by the session file a relaunch kept
 * when that file is one of this computer's (`localSessions`). Such a child is its opener's, like a local one: it nests
 * under the opener and leaves its device's own list. A tab a session on a paired device opened stays the device's.
 */
export function remoteOpenedChildren(
	tabs: readonly (FamilyTab & { device?: string })[],
	localSessions: ReadonlySet<string>,
): Map<string, string> {
	const children = new Map<string, string>();
	for (const tab of tabs) {
		if (tab.device === undefined) continue;
		const opener =
			(tab.openedBy ? tabs.find(entry => entry.id === tab.openedBy) : undefined) ??
			(tab.openedBySession ? tabs.find(entry => entry.sessionPath === tab.openedBySession) : undefined);
		const path = opener
			? opener.device === undefined
				? opener.sessionPath
				: undefined
			: tab.openedBySession && localSessions.has(tab.openedBySession)
				? tab.openedBySession
				: undefined;
		if (path) children.set(tab.id, path);
	}
	return children;
}

/** Stock's own `created` (the session header's timestamp): fixed for a session's life, unlike `modified`. */
function createdAt(session: SessionInfo): number {
	const timestamp = Date.parse(session.created);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

/** Oldest first; equal times break by path so the order never flickers. */
function byCreated(a: RowSession, b: RowSession): number {
	return createdAt(a) - createdAt(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * The rows of one computer's sessions for one viewer.
 *
 * - A file stock wrote before the first message is no conversation yet, and lists nowhere; an open tab that owns it
 *   keeps its live row. A new tab nobody wrote to (`unstarted`) and the empty start tab have no row.
 * - Who holds a session: any tab of the viewer's (asleep and ghost ones too), and any the computer says it holds
 *   (`heldOnHost`, `usedThere`). Who uses it: those, but never a tab of the viewer's restored asleep or a ghost.
 * - A session another session's agent opened is a row of that opener's family, whatever its folder; one no opener row
 *   holds and nobody holds folds into its project's group, listed there only while it needs a look: one main recorded
 *   closing (`closed`), one an agent's brief opened, or one in an agent's worktree.
 * - A session whose OMPdesk worktree is gone is finished: no row anywhere, neither a project's nor a family's, unless
 *   a tab the person uses holds it; then it is a row of the project the worktree was cut from.
 * - Any other gone folder is still a project (dimmed) with its sessions; a project the person removed takes its
 *   sessions with it, unless any tab holds one.
 */
export function sidebarRows(facts: SidebarFacts): SidebarRows {
	const heldKeys = new Set<string>();
	const usedKeys = new Set<string>();
	for (const tab of facts.tabs) {
		const keys = [tab.sessionPath, tab.sessionId].filter((key): key is string => Boolean(key));
		for (const key of keys) heldKeys.add(key);
		if (tab.ghost === true || tab.status === "asleep") continue;
		usedKeys.add(tab.id);
		for (const key of keys) usedKeys.add(key);
	}
	const heldThere = (session: SessionInfo) =>
		session.heldOnHost === true || facts.usedThere.has(session.path) || facts.usedThere.has(session.id);
	const held = (session: RowSession) =>
		session.liveTabId !== undefined || heldThere(session) || heldKeys.has(session.path) || heldKeys.has(session.id);
	const inUse = (session: RowSession) =>
		heldThere(session) ||
		usedKeys.has(session.path) ||
		usedKeys.has(session.id) ||
		(session.liveTabId !== undefined && usedKeys.has(session.liveTabId));
	const finished = (session: RowSession) =>
		facts.folder(session.cwd).gone && isOmpdeskWorktreeFolder(session.cwd) && !inUse(session);

	const listed: RowSession[] = facts.sessions.filter(
		session =>
			facts.hasContent(session) &&
			!facts.nested.has(session.path) &&
			(!facts.archived.has(session.id) || held(session)),
	);
	const made = new Set(listed.flatMap(session => [session.path, session.id]));
	const live: RowSession[] = [];
	for (const tab of facts.tabs) {
		if (tab.placeholder === true || tab.unstarted === true || facts.nested.has(tab.id)) continue;
		if ((tab.sessionId && made.has(tab.sessionId)) || (tab.sessionPath && made.has(tab.sessionPath))) continue;
		const path = tab.sessionPath || `tab:${tab.id}`;
		made.add(path);
		live.push({
			path,
			id: tab.sessionId || `tab:${tab.id}`,
			title: tab.title,
			cwd: tab.cwd,
			created: tab.seenAt,
			modified: tab.seenAt,
			messageCount: 0,
			size: 0,
			status: "unknown",
			...(tab.kind === "chat" ? { kind: "chat" as const } : {}),
			firstMessage: "",
			...(tab.device === undefined ? {} : { device: tab.device }),
			liveTabId: tab.id,
		});
	}
	const sessions = live.length === 0 ? listed : [...listed, ...live];
	const code = sessions.filter(session => !isChatSession(session, facts.workspace));

	const runs = new Map<string, string>();
	const runChildren: Array<[path: string, run: string]> = [];
	for (const session of code) {
		const run = facts.runOf(session);
		if (run?.child) runChildren.push([session.path, run.key]);
		else if (run) runs.set(run.key, session.cwd);
	}
	const runParent = new Map<string, string>();
	for (const [path, run] of runChildren) {
		const folder = runs.get(run);
		if (folder) runParent.set(path, folder);
	}

	// What a record names, and whether an agent's brief may be read: never when the computer says nothing of a row (an
	// older host), nor for one a paired device's agent opened (its opener is on that device).
	const recorded = new Map<string, string>();
	const briefed = new Set<string>();
	for (const session of code) {
		if (typeof session.openedBySession === "string") recorded.set(session.path, session.openedBySession);
		if (session.openedBySession !== undefined && !session.promptOriginDevice) briefed.add(session.path);
	}
	const rootOf = openerOfSessions(
		facts.tabs,
		code.map(session => ({
			path: session.path,
			id: session.id,
			liveTabId: session.liveTabId,
			title: facts.titleOf(session),
			firstMessage: briefed.has(session.path) ? session.firstMessage : undefined,
			created: session.created,
		})),
		recorded,
	);
	for (const path of runParent.keys()) rootOf.delete(path);

	// git spells a main checkout its own way (macOS /var → /private/var), the sessions keep the folder as typed: a
	// project key that IS a session's folder under another spelling is that folder.
	const spelled = new Map<string, string>();
	for (const session of code) {
		const { project, root } = facts.folder(session.cwd);
		if (project === undefined && root !== undefined && (root === session.cwd || root.endsWith(session.cwd)))
			spelled.set(root, session.cwd);
	}
	const keyOf = (path: string) => spelled.get(path) ?? path;

	const foldedRoot = new Map<string, string>();
	for (const session of code) {
		if (rootOf.has(session.path) || runParent.has(session.path) || held(session)) continue;
		const recordedCwd = facts.recordedCwd.get(session.path);
		const gone = facts.folder(session.cwd).gone && isOmpdeskWorktreeFolder(session.cwd);
		// A discarded worktree's stored sessions go with it, unless a record names the checkout its work went to.
		if (gone && recordedCwd === undefined) continue;
		const at = gone && recordedCwd !== undefined ? recordedCwd : session.cwd;
		const folder = facts.folder(at);
		if (
			facts.closed.has(session.path) ||
			(briefed.has(session.path) && agentMessageSender(session.firstMessage) !== null) ||
			folder.kind === "agent"
		)
			foldedRoot.set(session.path, keyOf(folder.project ?? folder.root ?? at));
	}

	const children = new Map<string, RowSession[]>();
	for (const session of code) {
		const root = rootOf.get(session.path);
		if (root === undefined || finished(session)) continue;
		const siblings = children.get(root);
		if (siblings) siblings.push(session);
		else children.set(root, [session]);
	}
	for (const siblings of children.values()) siblings.sort(byCreated);

	const pinnedSessions = new Set(facts.order.pinnedSessions);
	const inListOrder = (rows: readonly RowSession[], list: string): RowSession[] => {
		const sorted = rows.toSorted((a, b) => {
			const pinned = (pinnedSessions.has(a.path) ? 0 : 1) - (pinnedSessions.has(b.path) ? 0 : 1);
			return pinned || createdAt(b) - createdAt(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		});
		const manual = facts.order.sessionOrder(list);
		if (!manual) return sorted;
		const at = new Map(sorted.map((session, index) => [session.path, index]));
		return orderByManual(sorted, session => session.path, {
			pinned: facts.order.pinnedSessions,
			manual,
			recency: session => -(at.get(session.path) ?? 0),
		});
	};

	const removed = new Set(facts.removed);
	const drafts = new Map<string, { members: string[]; sessions: RowSession[]; folded: RowSession[] }>();
	const draftOf = (key: string, member: string) => {
		let draft = drafts.get(key);
		if (!draft) {
			draft = { members: [], sessions: [], folded: [] };
			drafts.set(key, draft);
		}
		if (!draft.members.includes(member)) draft.members.push(member);
		return draft;
	};
	for (const session of code) {
		if (rootOf.has(session.path) || foldedRoot.has(session.path) || finished(session)) continue;
		// An Autopilot child goes where its run goes; a linked worktree's session is a row of its project.
		const project = facts.folder(runParent.get(session.path) ?? session.cwd).project;
		const key = project === undefined ? session.cwd : keyOf(project);
		if (removed.has(key) && !held(session)) continue;
		draftOf(key, session.cwd).sessions.push(session);
	}
	for (const session of code) {
		const key = foldedRoot.get(session.path);
		if (key !== undefined && !removed.has(key)) draftOf(key, key).folded.push(session);
	}
	const open = new Set<string>();
	for (const tab of facts.tabs) {
		if (tab.unstarted !== true || tab.placeholder === true || facts.nested.has(tab.id)) continue;
		if (isChatSession(tab, facts.workspace)) continue;
		const project = facts.folder(tab.cwd).project;
		const key = project === undefined ? tab.cwd : keyOf(project);
		if (removed.has(key)) continue;
		open.add(key);
		draftOf(key, key);
	}
	const addedAt = new Map<string, number>();
	const missing = new Set<string>();
	for (const project of facts.projects) {
		const key = keyOf(project.path);
		addedAt.set(key, project.addedAt);
		if (project.missing) missing.add(key);
		draftOf(key, key);
	}
	const allGroups = orderByManual(
		[...drafts].map(([key, draft]): RowGroup => {
			// The project's own order; an Autopilot run's children follow its row, newest first.
			const sorted = inListOrder(draft.sessions, key);
			const rows = sorted.filter(session => !runParent.has(session.path));
			const runChildRows = sorted.filter(session => runParent.has(session.path));
			const placed = new Set<string>();
			for (let index = rows.length - 1; index >= 0; index--) {
				const run = rows[index] as RowSession;
				const own = runChildRows.filter(child => runParent.get(child.path) === run.cwd);
				if (own.length === 0 || rows.slice(0, index).some(earlier => earlier.cwd === run.cwd)) continue;
				placed.add(run.cwd);
				rows.splice(index + 1, 0, ...own);
			}
			// A child whose run has no row here still lists, at the end.
			rows.push(...runChildRows.filter(child => !placed.has(runParent.get(child.path) ?? "")));
			return {
				cwd: key,
				members: draft.members,
				sessions: rows,
				folded: draft.folded.toSorted(byCreated),
				listed: addedAt.has(key),
				open: open.has(key),
				missing: missing.has(key),
			};
		}),
		group => group.cwd,
		{
			pinned: facts.order.pinnedGroups,
			manual: facts.order.groupOrder,
			// An empty project sorts by when it entered the list.
			recency: group =>
				Math.max(addedAt.get(group.cwd) ?? 0, ...[...group.sessions, ...group.folded].map(createdAt)),
		},
	);

	const query = facts.query.trim().toLocaleLowerCase();
	const matches = (session: RowSession) =>
		!query ||
		facts.titleOf(session).toLocaleLowerCase().includes(query) ||
		session.cwd.toLocaleLowerCase().includes(query);
	// A session matches when it does or when something it opened does: its family shows with it.
	const familyMatches = (session: RowSession) => matches(session) || (children.get(session.path) ?? []).some(matches);
	const groups = query
		? allGroups.flatMap(group => {
				if (facts.nameOf(group.cwd).toLocaleLowerCase().includes(query)) return [group];
				const shown = {
					...group,
					sessions: group.sessions.filter(familyMatches),
					folded: group.folded.filter(matches),
				};
				return shown.sessions.length + shown.folded.length > 0 ? [shown] : [];
			})
		: allGroups;
	const chats = inListOrder(
		sessions.filter(session => isChatSession(session, facts.workspace) && matches(session)),
		CHATS_ORDER_KEY,
	);
	const archived = facts.sessions
		.filter(
			session => facts.archived.has(session.id) && facts.hasContent(session) && !held(session) && matches(session),
		)
		.toSorted((a, b) => createdAt(b) - createdAt(a));
	return { sessions, listed, code, allGroups, groups, chats, archived, children, rootOf, runParent };
}
