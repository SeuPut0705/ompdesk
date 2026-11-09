/**
 * The invariants of `sidebarRows` over every combination of the facts a viewer gathers: folder (a project, a removed
 * project, a gone folder that is a project, an OMPdesk worktree live, an agent's, gone), holder (none, a tab in use, a
 * tab restored asleep, a ghost, a tab the computer says holds it, at work in a window the viewer cannot see, a paired
 * device's tab this computer runs that stayed asleep), opener (a person's prompt, an agent's brief, a closed record
 * naming a listed opener, one naming a deleted one, a review list naming a chat) and chat.
 * Random worlds of those sessions are drawn with a fixed seed, so a failure names a world that reproduces.
 */
import { describe, expect, it } from "vitest";
import { wrapAgentMessage } from "./agent-control";
import type { SessionInfo } from "./ipc-types";
import {
	botFamily,
	CHATS_ORDER_KEY,
	familyRows,
	holdRows,
	type RowSession,
	type RowTab,
	remoteOpenedChildren,
	rowsWaiting,
	type SidebarFacts,
	type SidebarRows,
	sidebarRows,
} from "./sidebar-rows";

const APP = "/u/code/app";
const FOLDERS = {
	app: APP,
	old: "/u/code/old",
	scr: "/tmp/scratch-3",
	wtl: "/u/.omp/wt/gui-live-1111111",
	wta: "/u/.omp/wt/gui-agent-3333333",
	wtg: "/u/.omp/wt/gui-gone-2222222",
	chat: "/u/.omp/work",
} as const;
type Folder = keyof typeof FOLDERS;
const HOLDERS = ["none", "used", "asleep", "ghost", "there", "working", "hosted"] as const;
type Holder = (typeof HOLDERS)[number];
// review: only a review list names its opener (a chat's tab), which is no row here.
const ORIGINS = ["person", "brief", "record", "lost", "review"] as const;
type Origin = (typeof ORIGINS)[number];
const BOSS = "/s/boss.jsonl";

interface Cell {
	folder: Folder;
	holder: Holder;
	origin: Origin;
	path: string;
}

const ALL: Cell[] = (Object.keys(FOLDERS) as Folder[]).flatMap(folder =>
	HOLDERS.flatMap(holder =>
		ORIGINS.map(origin => ({ folder, holder, origin, path: `/s/${folder}.${holder}.${origin}` })),
	),
);

function world(cells: readonly Cell[], order: "as-is" | "reversed" = "as-is"): SidebarFacts {
	const brief = wrapAgentMessage("Fix it", "Boss");
	const info = (cell: Cell, index: number): SessionInfo => ({
		path: cell.path,
		id: cell.path,
		title: cell.path,
		cwd: FOLDERS[cell.folder],
		created: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
		modified: "2026-10-01T00:00:00Z",
		messageCount: 3,
		size: 1,
		status: "complete",
		firstMessage: cell.origin === "brief" || cell.origin === "record" || cell.origin === "lost" ? brief : "hello",
		openedBySession:
			cell.origin === "record"
				? BOSS
				: cell.origin === "lost"
					? "/s/deleted.jsonl"
					: cell.origin === "review"
						? "/s/chat-boss.jsonl"
						: null,
		...(cell.holder === "there" ? { heldOnHost: true as const } : {}),
	});
	const boss: SessionInfo = {
		...info({ folder: "app", holder: "none", origin: "person", path: BOSS }, -1),
		title: "Boss",
	};
	const sessions = [boss, ...cells.map(info)];
	// A paired device's tab this computer runs is a stand-in tab in whatever state it is (here asleep since a relaunch)
	// and a session used there.
	const tabs: RowTab[] = cells
		.filter(
			cell =>
				cell.holder === "used" || cell.holder === "asleep" || cell.holder === "ghost" || cell.holder === "hosted",
		)
		.map(cell => ({
			id: cell.holder === "hosted" ? `hosted:${cell.path}` : `t:${cell.path}`,
			sessionPath: cell.path,
			sessionId: cell.path,
			cwd: FOLDERS[cell.folder],
			kind: "agent",
			title: null,
			status: cell.holder === "asleep" || cell.holder === "hosted" ? "asleep" : "ready",
			...(cell.holder === "ghost" ? { ghost: true } : {}),
			seenAt: "2026-10-01T00:00:00Z",
		}));
	return {
		sessions: order === "reversed" ? sessions.toReversed() : sessions,
		tabs: order === "reversed" ? tabs.toReversed() : tabs,
		usedThere: new Set(
			cells.filter(cell => cell.holder === "working" || cell.holder === "hosted").map(cell => cell.path),
		),
		closed: new Set(cells.filter(cell => cell.origin === "record" || cell.origin === "lost").map(cell => cell.path)),
		projects: [
			{ path: APP, addedAt: 3 },
			{ path: FOLDERS.scr, addedAt: 2, missing: true },
		],
		removed: [FOLDERS.old],
		folder: cwd => ({
			...(cwd === FOLDERS.wtl || cwd === FOLDERS.wta || cwd === FOLDERS.wtg ? { project: APP } : {}),
			...(cwd === FOLDERS.wta ? { kind: "agent" as const } : cwd === FOLDERS.wtl ? { kind: "other" as const } : {}),
			gone: cwd === FOLDERS.scr || cwd === FOLDERS.wtg,
		}),
		workspace: FOLDERS.chat,
		titleOf: session => session.title ?? "",
		hasContent: session => session.messageCount > 0,
		runOf: () => null,
		archived: new Set(),
		nested: new Set(),
		order: { pinnedSessions: [], pinnedGroups: [], groupOrder: [], sessionOrder: () => undefined },
		query: "",
		nameOf: key => key,
	};
}

/** Where each session shows: `group:<key>`, `folded:<key>`, `child`, `chat`; absent when it is no row. */
function placements(rows: SidebarRows): Map<string, string[]> {
	const at = new Map<string, string[]>();
	const put = (session: RowSession, where: string) => at.set(session.path, [...(at.get(session.path) ?? []), where]);
	for (const group of rows.groups) {
		for (const session of group.sessions) put(session, `group:${group.cwd}`);
		for (const session of group.folded) put(session, `folded:${group.cwd}`);
	}
	for (const children of rows.children.values()) for (const session of children) put(session, "child");
	for (const session of rows.chats) put(session, "chat");
	return at;
}

/** A small seeded generator: the same seed draws the same worlds on every run. */
function draw(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORLDS: Cell[][] = [
	ALL,
	...Array.from({ length: 200 }, (_, index) => {
		const random = draw(index + 1);
		return ALL.filter(() => random() < 0.15);
	}),
];

const finishedFolder = (cell: Cell) => cell.folder === "wtg";
// A paired device's tab this computer runs is in use whatever its state, asleep since a relaunch included.
const usedBy = (holder: Holder) =>
	holder === "used" || holder === "there" || holder === "working" || holder === "hosted";
const heldBy = (holder: Holder) => holder !== "none";

describe("sidebarRows over every combination of folder, holder and opener", () => {
	it.each(WORLDS.map((cells, index) => [index, cells] as const))("world %i keeps every invariant", (_index, cells) => {
		const rows = sidebarRows(world(cells));
		const at = placements(rows);
		for (const cell of cells) {
			const where = at.get(cell.path) ?? [];
			const rule = `${cell.path} shows at [${where.join(", ")}]`;
			// A session is at most one row, but one nested under an opener in another project is a row of its own
			// project too (the opener BOSS is APP's; a linked worktree of APP is APP's).
			const ownProject = cell.folder === "scr" || cell.folder === "old" ? FOLDERS[cell.folder] : APP;
			if (rows.rootOf.get(cell.path) === BOSS && ownProject !== APP)
				// A removed project's session is no row of it: its opener's row lists it.
				expect(
					where.filter(place => place !== "child"),
					rule,
				).toEqual(cell.folder === "old" ? [] : [`group:${ownProject}`]);
			else expect(where.length, rule).toBeLessThanOrEqual(1);
			// A chat is its Chats section's row whoever holds it: never nested, folded or in a project.
			if (cell.folder === "chat") {
				expect(where, rule).toEqual(["chat"]);
				continue;
			}
			// A finished worktree's session is no row anywhere (a project's, a family's or a loose child) unless a tab the
			// person uses holds it.
			if (finishedFolder(cell) && !usedBy(cell.holder)) expect(where, rule).toEqual([]);
			// A session a tab the person uses holds always has a place; a loose child keeps its own (listed while held).
			if (usedBy(cell.holder)) expect(where.length, rule).toBeGreaterThan(0);
			if (where.some(place => place.startsWith("folded:")))
				expect(rows.held.has(cell.path), rule).toBe(heldBy(cell.holder));
			// A removed project's session leaves with it unless a tab holds it.
			if (cell.folder === "old" && !heldBy(cell.holder))
				expect(
					where.filter(place => place.startsWith("group:")),
					rule,
				).toEqual([]);
			// Who holds a session never moves it: wherever it shows with no holder, it shows with any.
			if (cell.holder !== "none" && !(finishedFolder(cell) || (cell.folder === "old" && !where.includes("child")))) {
				const free = placements(sidebarRows(world([{ ...cell, holder: "none" }]))).get(cell.path) ?? [];
				if (free.length > 0) expect(where, rule).toEqual(free);
			}
			// A linked worktree's session is a row of the project it was cut from, never a group of its own.
			if (cell.folder === "wtl" || cell.folder === "wta" || cell.folder === "wtg")
				expect(
					where.filter(place => place.startsWith("group:") && place !== `group:${APP}`),
					rule,
				).toEqual([]);
			// A gone folder that is no OMPdesk worktree is still a project: its sessions stay with it (a brief or a record
			// folds one into it as a loose child, which is still its project's).
			if (cell.folder === "scr")
				expect(
					where.filter(place => !place.endsWith(FOLDERS.scr) && place !== "child"),
					rule,
				).toEqual([]);
			if (cell.folder === "scr" && (cell.origin === "person" || cell.origin === "review"))
				expect(where, rule).toEqual([`group:${FOLDERS.scr}`]);
			// Only a closed record, an agent's brief or an agent's worktree folds a session: a review list naming an opener
			// that is no row here does not.
			if (cell.origin === "review" && cell.folder !== "wta")
				expect(
					where.some(place => place.startsWith("folded:")),
					rule,
				).toBe(false);
		}
		// No gone OMPdesk worktree and no removed project is a group of its own unless a held session keeps it.
		expect(rows.groups.map(group => group.cwd)).not.toContain(FOLDERS.wtg);
		const old = rows.groups.find(group => group.cwd === FOLDERS.old);
		if (old) expect(old.sessions.length).toBeGreaterThan(0);
		// A project of the list is a group with or without sessions; a gone one reads missing.
		expect(rows.groups.find(group => group.cwd === APP)?.listed).toBe(true);
		expect(rows.groups.find(group => group.cwd === FOLDERS.scr)?.missing).toBe(true);
	});

	it.each(WORLDS.slice(0, 40).map((cells, index) => [index, cells] as const))(
		"world %i draws the same rows whatever order its facts arrive in",
		(_index, cells) => {
			const shape = (rows: SidebarRows) => ({
				groups: rows.groups.map(group => [
					group.cwd,
					group.sessions.map(row => row.path),
					group.folded.map(row => row.path),
				]),
				chats: rows.chats.map(row => row.path),
				children: [...rows.children].map(([root, children]) => [root, children.map(row => row.path)]).sort(),
			});
			expect(shape(sidebarRows(world(cells, "reversed")))).toEqual(shape(sidebarRows(world(cells))));
		},
	);

	// The owner's report, 9 Nov 2026: selecting a session reshuffled the list. A click opens a tab on the session or
	// wakes the one that holds it; neither may move any row, the clicked one included, in a list the person ordered by
	// hand or not, archived rows included.
	it.each(
		WORLDS.slice(0, 60).flatMap((cells, index) => [
			[index, "newest first", cells] as const,
			[index, "by hand", cells] as const,
		]),
	)("world %i (%s) moves no row when a session is selected", (index, order, cells) => {
		const shape = (rows: SidebarRows) => ({
			groups: rows.groups.map(group => [
				group.cwd,
				group.sessions.map(row => row.path),
				group.folded.map(row => row.path),
			]),
			chats: rows.chats.map(row => row.path),
			children: [...rows.children].map(([root, children]) => [root, children.map(row => row.path)]).sort(),
			archived: rows.archived.map(row => row.path),
		});
		const plain = world(cells);
		const archived = new Set(cells.filter((_cell, at) => (at + index) % 5 === 0).map(cell => cell.path));
		const drawn = sidebarRows({ ...plain, archived });
		// A hand order: each list's rows reversed, with its newest row left out (new since the person last moved one).
		const byHand = new Map([
			...drawn.groups.map(
				group =>
					[
						group.cwd,
						group.sessions
							.map(row => row.path)
							.slice(1)
							.toReversed(),
					] as const,
			),
			[
				CHATS_ORDER_KEY,
				drawn.chats
					.map(row => row.path)
					.slice(1)
					.toReversed(),
			] as const,
		]);
		const facts: SidebarFacts = {
			...plain,
			archived,
			order: { ...plain.order, sessionOrder: list => (order === "by hand" ? byHand.get(list) : undefined) },
		};
		const before = sidebarRows(facts);
		for (const path of [...placements(before).keys(), ...before.archived.map(row => row.path)]) {
			const cell = cells.find(entry => entry.path === path);
			const held = facts.tabs.find(tab => tab.sessionPath === path && !tab.id.startsWith("hosted:"));
			const tabs: RowTab[] = held
				? facts.tabs.map(tab => (tab === held ? { ...tab, status: "ready", ghost: undefined } : tab))
				: [
						...facts.tabs,
						{
							id: `click:${path}`,
							sessionPath: path,
							sessionId: path,
							cwd: cell ? FOLDERS[cell.folder] : APP,
							kind: "agent",
							title: null,
							status: "starting",
							seenAt: "2026-11-09T00:00:00Z",
						},
					];
			expect(shape(sidebarRows({ ...facts, tabs })), `select ${path}`).toEqual(shape(before));
		}
	});

	it("never lets a tab restored asleep or a ghost list a finished worktree's session no tab in use holds", () => {
		for (const origin of ORIGINS) {
			const alone = placements(sidebarRows(world([{ folder: "wtg", holder: "none", origin, path: "/s/x" }])));
			for (const holder of ["asleep", "ghost"] as const)
				expect(
					placements(sidebarRows(world([{ folder: "wtg", holder, origin, path: "/s/x" }]))).get("/s/x"),
				).toEqual(alone.get("/s/x"));
		}
	});

	// The orphan case the family guard alone missed: a session an agent opened in an OMPdesk worktree that is gone, whose
	// opener is deleted (no listed row, by record or by brief), no tab in use holding it. It was folded into the checkout
	// its closed record named and, failed or unmerged, came back as a loose child of the project.
	it("lists no loose child of a finished worktree whose opener is gone, whatever its record names", () => {
		for (const origin of ["record", "lost", "brief"] as const) {
			const facts = world([{ folder: "wtg", holder: "none", origin, path: "/s/orphan" }]);
			const rows = sidebarRows({ ...facts, sessions: facts.sessions.filter(session => session.path !== BOSS) });
			expect(rows.rootOf.has("/s/orphan"), origin).toBe(false);
			expect(placements(rows).get("/s/orphan"), origin).toBeUndefined();
		}
	});
});

describe("remoteOpenedChildren: a session opened on a paired device nests where a local one would", () => {
	const BOT = "/s/bot.jsonl";
	const PAST = "/s/bot-before.jsonl";
	const KID = "/s/kid.jsonl";
	const CHILD = "/s/child.jsonl";
	const listed = (path: string, minute: number, openedBySession: string | null): SessionInfo => ({
		path,
		id: path,
		title: path,
		cwd: APP,
		created: new Date(Date.UTC(2026, 9, 2) + minute * 60_000).toISOString(),
		modified: "2026-10-02T00:00:00Z",
		messageCount: 3,
		size: 1,
		status: "complete",
		firstMessage: "hello",
		openedBySession,
	});
	const remote = (id: string, opener: Pick<RowTab, "openedBy" | "openedBySession">): RowTab => ({
		id,
		sessionPath: `C:\\s\\${id}.jsonl`,
		sessionId: id,
		cwd: "C:\\work",
		kind: "agent",
		title: null,
		status: "ready",
		seenAt: "2026-10-02T00:00:00Z",
		device: "dev-win",
		...opener,
	});
	/**
	 * This computer's rows as its sidebar builds them: the bot's files are no list's rows (its ended conversation
	 * included), its family is nested out, and what each session opened is recorded. KID was opened by the bot's ended
	 * conversation, CHILD by the plain session BOSS.
	 */
	function computer(tabs: RowTab[]) {
		const base = world([]);
		const sessions = [...base.sessions, listed(KID, 1, PAST), listed(CHILD, 2, BOSS)];
		const facts: SidebarFacts = { ...base, sessions, tabs };
		const recordedOpeners = new Map([
			[KID, PAST],
			[CHILD, BOSS],
		]);
		const bot = botFamily({
			bot: BOT,
			ended: new Set([PAST]),
			channels: new Set(),
			tabs,
			sessions: sidebarRows(facts).sessions,
			recordedOpeners,
			workspace: base.workspace,
		});
		const rows = sidebarRows({ ...facts, nested: bot.keys, openedElsewhere: bot.placed });
		return { rows, bot, nest: (id: string) => remoteOpenedChildren(tabs, rows, bot).get(id) };
	}

	it("puts what the bot's ended conversation opened under the bot once that conversation's tab is gone", () => {
		const { nest } = computer([remote("r1", { openedBySession: PAST })]);
		expect(nest("r1")).toBe(BOT);
	});

	it("puts what a session of the bot's family opened under the bot, its tab open or not", () => {
		const kidTab: RowTab = {
			id: "t-kid",
			sessionPath: KID,
			sessionId: KID,
			cwd: APP,
			kind: "agent",
			title: null,
			status: "ready",
			seenAt: "2026-10-02T00:00:00Z",
		};
		expect(computer([remote("r1", { openedBySession: KID })]).nest("r1")).toBe(BOT);
		expect(computer([kidTab, remote("r1", { openedBy: "t-kid", openedBySession: KID })]).nest("r1")).toBe(BOT);
	});

	it("puts what the bot's current conversation opened under the bot", () => {
		const botTab: RowTab = {
			id: "t-bot",
			sessionPath: BOT,
			sessionId: BOT,
			cwd: "/u/.omp/work",
			kind: "chat",
			title: null,
			status: "ready",
			seenAt: "2026-10-02T00:00:00Z",
		};
		expect(computer([botTab, remote("r1", { openedBy: "t-bot" })]).nest("r1")).toBe(BOT);
		expect(computer([remote("r1", { openedBySession: BOT })]).nest("r1")).toBe(BOT);
	});

	it("puts what an opened session opened under the session that started its chain, as a local child", () => {
		const { rows, nest } = computer([remote("r1", { openedBySession: CHILD })]);
		expect(rows.rootOf.get(CHILD)).toBe(BOSS);
		expect(nest("r1")).toBe(BOSS);
	});

	it("leaves to its device a tab whose opener is no session of this computer", () => {
		const { nest } = computer([remote("r1", { openedBySession: "/s/elsewhere.jsonl" }), remote("r2", {})]);
		expect(nest("r1")).toBeUndefined();
		expect(nest("r2")).toBeUndefined();
	});
});

// The owner's report, 8 Nov 2026: a session opened from project yuyu-mos in folder seuoffice showed only under its
// opener; seuoffice listed nothing. A session's project is its own folder's; nesting under an opener is one more place.
describe("a session opened in another project is a row of its own project too", () => {
	const OTHER = "/u/code/other";
	const KID = "/s/kid.jsonl";
	const opened = (cwd: string, tab: boolean): SidebarFacts => {
		const base = world([]);
		const kid: SessionInfo = {
			path: KID,
			id: KID,
			title: "kid",
			cwd,
			created: "2026-10-02T00:00:00Z",
			modified: "2026-10-02T00:00:00Z",
			messageCount: 3,
			size: 1,
			status: "complete",
			firstMessage: wrapAgentMessage("Set it up", "Boss"),
			openedBySession: tab ? null : BOSS,
		};
		const tabs: RowTab[] = tab
			? [
					{ id: "t-boss", sessionPath: BOSS, cwd: APP, kind: "agent", title: null, status: "ready", seenAt: "x" },
					{
						id: "t-kid",
						sessionPath: KID,
						cwd,
						kind: "agent",
						title: null,
						status: "ready",
						openedBy: "t-boss",
						seenAt: "x",
					},
				]
			: [];
		return { ...base, sessions: [...base.sessions, kid], tabs };
	};

	it("lists it under its opener and in its own folder's project, held by a tab or not", () => {
		for (const tab of [true, false]) {
			const rows = sidebarRows(opened(OTHER, tab));
			expect(rows.rootOf.get(KID), `tab ${tab}`).toBe(BOSS);
			expect(placements(rows).get(KID), `tab ${tab}`).toEqual([`group:${OTHER}`, "child"]);
			// The same row object in both places: one session, not a copy.
			const inGroup = rows.groups.find(group => group.cwd === OTHER)?.sessions.find(row => row.path === KID);
			expect(rows.children.get(BOSS)?.includes(inGroup as RowSession)).toBe(true);
		}
	});

	it("keeps one in its opener's project, a worktree of it included, only under the opener", () => {
		for (const cwd of [APP, FOLDERS.wtl, FOLDERS.wta])
			for (const tab of [true, false]) expect(placements(sidebarRows(opened(cwd, tab))).get(KID)).toEqual(["child"]);
	});

	it("lists what the bot opened in its own project as a plain row, its side chats nowhere", () => {
		const BOT = "/s/bot.jsonl";
		const SIDE = "/s/side.jsonl";
		const base = opened(OTHER, false);
		const side: SessionInfo = { ...(base.sessions.at(-1) as SessionInfo), path: SIDE, id: SIDE, cwd: FOLDERS.chat };
		const facts: SidebarFacts = {
			...base,
			sessions: [
				...base.sessions.map(session =>
					session.path === KID
						? { ...session, openedBySession: BOT, firstMessage: wrapAgentMessage("Go", "Bot") }
						: session,
				),
				side,
			],
		};
		const { rows, bot } = familyRows(facts, { bot: BOT, ended: new Set(), channels: new Set([SIDE]), tabs: [] }, []);
		expect(bot?.sessions.map(session => session.path).sort()).toEqual([KID, SIDE]);
		expect(placements(rows).get(KID)).toEqual([`group:${OTHER}`]);
		expect(placements(rows).get(SIDE)).toBeUndefined();
	});
});

describe("a session whose folder is gone", () => {
	it("stays a row of its project and is marked folder-missing; one in a live folder is not", () => {
		const rows = sidebarRows(
			world([
				{ folder: "scr", holder: "none", origin: "person", path: "/s/in-gone" },
				{ folder: "app", holder: "none", origin: "person", path: "/s/in-live" },
			]),
		);
		expect(placements(rows).get("/s/in-gone")).toEqual([`group:${FOLDERS.scr}`]);
		expect(rows.folderMissing.has("/s/in-gone")).toBe(true);
		expect(rows.folderMissing.has("/s/in-live")).toBe(false);
		expect(rows.folderMissing.has(BOSS)).toBe(false);
	});

	it("marks no finished OMPdesk worktree session, which is no row at all, but marks one a tab in use holds", () => {
		const none = sidebarRows(world([{ folder: "wtg", holder: "none", origin: "person", path: "/s/fin" }]));
		expect(placements(none).get("/s/fin")).toBeUndefined();
		expect(none.folderMissing.has("/s/fin")).toBe(false);
		const used = sidebarRows(world([{ folder: "wtg", holder: "used", origin: "person", path: "/s/fin" }]));
		expect(used.folderMissing.has("/s/fin")).toBe(true);
	});
});

/** Every row a sidebar draws itself, top to bottom: each project's key and rows, then Chats and Archived. */
function drawn(rows: SidebarRows): string[] {
	return [
		...rows.groups.flatMap(group => [`group:${group.cwd}`, ...group.sessions.map(session => session.path)]),
		...rows.chats.map(session => `chat:${session.path}`),
		...rows.archived.map(session => `archived:${session.path}`),
	];
}

// The owner's report (9 Nov 2026): a session another omp started took the top of its project while the pointer rested
// on the row below, and the click selected the newcomer. While the person aims at the list, nothing moves.
describe("holdRows: what the person aims at keeps its place", () => {
	it.each(WORLDS.slice(0, 60).map((cells, index) => [index, cells, WORLDS[index + 1] ?? ALL] as const))(
		"world %i drawn over the next one moves no row, says what each row says now and leaves an empty place",
		(_index, before, after) => {
			const shown = sidebarRows(world(before));
			const now = sidebarRows(world(after, "reversed"));
			const held = holdRows(shown, now);
			// Every row keeps its place; a project that left goes whole.
			const kept = {
				...shown,
				groups: shown.groups.filter(group => now.groups.some(item => item.cwd === group.cwd)),
			};
			expect(drawn(held)).toEqual(drawn(kept));
			// A row still in its list says what it says now; one that left its list is an empty place.
			const lists = [
				...held.groups.map(
					group => [group.sessions, now.groups.find(item => item.cwd === group.cwd)?.sessions] as const,
				),
				[held.chats, now.chats] as const,
				[held.archived, now.archived] as const,
			];
			for (const [rows, fresh] of lists) {
				const byPath = new Map(fresh?.map(session => [session.path, session]));
				for (const session of rows) {
					const found = byPath.get(session.path);
					if (found) expect(session).toBe(found);
					else expect(session.departed).toBe(true);
				}
			}
			const paths = (rows: SidebarRows) =>
				drawn(rows).flatMap(key => (key.startsWith("group:") ? [] : [key.replace(/^\w+:/, "")]));
			expect(rowsWaiting(held, now)).toBe(paths(now).filter(path => !paths(held).includes(path)).length);
			// Held again over the same change, nothing more moves.
			expect(drawn(holdRows(held, now))).toEqual(drawn(held));
		},
	);

	it("keeps a newer session out of the top of its project, and a deleted one's place empty, until the aim ends", () => {
		const cells: Cell[] = [
			{ folder: "app", holder: "none", origin: "person", path: "/s/alpha" },
			{ folder: "app", holder: "none", origin: "person", path: "/s/bravo" },
		];
		const shown = sidebarRows(world(cells));
		const now = sidebarRows(
			world([cells[1] as Cell, { folder: "app", holder: "working", origin: "person", path: "/s/zulu" }]),
		);
		const app = (rows: SidebarRows) =>
			rows.groups
				.find(group => group.cwd === APP)
				?.sessions.map(row => `${row.path}${row.departed ? " (empty)" : ""}`);
		expect(app(now)).toEqual(["/s/zulu", "/s/bravo", BOSS]);
		const held = holdRows(shown, now);
		expect(app(held)).toEqual(app(shown)?.map(row => (row === "/s/alpha" ? "/s/alpha (empty)" : row)));
		expect(rowsWaiting(held, now)).toBe(1);
	});
});
