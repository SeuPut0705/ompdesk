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
import { type RowSession, type RowTab, type SidebarFacts, type SidebarRows, sidebarRows } from "./sidebar-rows";

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
			// A session is at most one row.
			expect(where.length, rule).toBeLessThanOrEqual(1);
			// A chat is its Chats section's row whoever holds it: never nested, folded or in a project.
			if (cell.folder === "chat") {
				expect(where, rule).toEqual(["chat"]);
				continue;
			}
			// A finished worktree's session is no row anywhere (a project's, a family's or a loose child) unless a tab the
			// person uses holds it.
			if (finishedFolder(cell) && !usedBy(cell.holder)) expect(where, rule).toEqual([]);
			// A session a tab the person uses holds is always a row: never hidden, never folded away.
			if (usedBy(cell.holder)) {
				expect(where.length, rule).toBe(1);
				expect(where[0]?.startsWith("folded:"), rule).toBe(false);
			}
			// A removed project's session leaves with it unless a tab holds it.
			if (cell.folder === "old" && !heldBy(cell.holder))
				expect(
					where.filter(place => place.startsWith("group:")),
					rule,
				).toEqual([]);
			// A held session never folds into its project's loose children.
			if (heldBy(cell.holder))
				expect(
					where.some(place => place.startsWith("folded:")),
					rule,
				).toBe(false);
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
