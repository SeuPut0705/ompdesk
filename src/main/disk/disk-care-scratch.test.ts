import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionProcesses } from "../session-processes";
import { SessionScratch } from "../session-scratch";
import { DAY_MS, diskCareWorld, exists, SLOW, write } from "./disk-care-fixture";
import { ScratchCare } from "./scratch";

// The sessions' scratch folders (session-scratch.ts, scratch.ts): when one goes, and what of it stays.
const w = diskCareWorld();

const TAG = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const MONTH_MS = 30 * DAY_MS;

interface Scratch {
	store: SessionScratch;
	care: ScratchCare;
	/** Tags a tab holds. */
	held: Set<string>;
	/** Running processes; null when they cannot be listed. */
	processes: Array<{ tag?: string }> | null;
	/** What the session index lists. */
	stored: string[];
}

/** A scratch store and its care in the test's world, as of `now` (a month from now: every folder idle). */
async function scratch(now = Date.now() + MONTH_MS): Promise<Scratch> {
	await fs.mkdir(w.userData, { recursive: true });
	const store = new SessionScratch(path.join(w.userData, "session-scratch.json"), path.join(w.root, "scratch"), {
		log: () => {},
	});
	const world: Scratch = {
		store,
		held: new Set(),
		processes: [],
		stored: [],
		care: new ScratchCare({
			store,
			heldTags: () => world.held,
			processes: async () => world.processes,
			sessionFiles: async () => world.stored,
			log: (message, details) => w.logs.push([message, details]),
			now: () => now,
		}),
	};
	return world;
}

/** A stored session whose one reply says `reply`. */
async function session(name: string, reply = "Done."): Promise<string> {
	const file = path.join(w.root, "sessions", "-repo", `${name}.jsonl`);
	const entries = [
		{ type: "session", version: 3, id: name },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
	];
	await write(path.dirname(file), path.basename(file), `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

/** The folder of a tab that was on `sessions`, with a screenshot, test output and a throwaway checkout in it. */
async function folder(s: Scratch, tag: string, ...sessions: string[]): Promise<string> {
	const dir = s.store.open(tag, sessions[0]);
	if (!dir) throw new Error("no scratch folder");
	for (const other of sessions.slice(1)) s.store.session(tag, other);
	await write(dir, "shots/after.png", "png\n");
	await write(dir, "shots/unused.png", "png\n");
	await write(dir, "test-results/out.log", "log\n");
	await write(dir, "checkout/src/a.ts", "export {};\n");
	return dir;
}

const logged = (message: string) => w.logs.filter(([name]) => name === message).map(([, details]) => details);

describe("disk care: session scratch folders", () => {
	it(
		"removes a session's folder whole when the session is deleted",
		async () => {
			const s = await scratch(Date.now());
			const deleted = await session("deleted");
			const dir = await folder(s, TAG, deleted);
			const other = await folder(s, OTHER, await session("other"));
			await s.care.sessionDeleted(deleted);
			expect(await exists(dir)).toBe(false);
			expect(await exists(path.join(other, "shots/after.png"))).toBe(true);
			expect(s.store.records().map(record => record.tag)).toEqual([OTHER]);
			expect(logged("scratch")).toMatchObject([{ path: dir, reason: "its session was deleted" }]);
		},
		SLOW,
	);

	it(
		"keeps the folder of a tab that started a second session until both sessions are deleted",
		async () => {
			const s = await scratch(Date.now());
			const first = await session("first");
			const second = await session("second");
			const processes = new SessionProcesses(path.join(w.userData, "session-processes.json"), {
				frozen: () => false,
				log: () => {},
				end: async () => ({ ended: [], left: [], kept: [], own: [] }),
				newTag: () => TAG,
				scratch: s.store,
			});
			const care = new ScratchCare({
				store: s.store,
				heldTags: () => processes.held(),
				processes: async () => [],
				sessionFiles: async () => [],
				log: () => {},
			});
			const tab = processes.open({ cwd: w.repo, sessionPath: first });
			const dir = path.join(w.root, "scratch", TAG);
			expect(tab.scratch).toBe(dir);
			await write(dir, "shots/first.png", "png\n");
			// Stock `new_session` in the same tab: the same tag, so the same folder, now serving two sessions.
			tab.update({ sessionPath: second });
			expect(s.store.records()).toMatchObject([{ tag: TAG, sessions: [first, second] }]);

			// While the tab holds the tag nothing goes, whatever is deleted.
			await care.sessionDeleted(first);
			expect(await exists(path.join(dir, "shots/first.png"))).toBe(true);
			await tab.close();
			await processes.settled();
			expect(await exists(path.join(dir, "shots/first.png"))).toBe(true);
			await care.sessionDeleted(second);
			expect(await exists(dir)).toBe(false);
			expect(s.store.records()).toEqual([]);
		},
		SLOW,
	);

	it(
		"removes an idle folder no tab or process holds, except the files its session's replies show",
		async () => {
			const s = await scratch();
			const dir = path.join(w.root, "scratch", TAG);
			const shown = await session(
				"shown",
				`Here it is:\n![After: the page](${path.join(dir, "shots", "after.png")})`,
			);
			await folder(s, TAG, shown);
			const state = await w.care(undefined, { scratch: s.care }).run("user");
			expect(await fs.readFile(path.join(dir, "shots/after.png"), "utf8")).toBe("png\n");
			for (const gone of ["shots/unused.png", "test-results", "checkout"])
				expect(await exists(path.join(dir, gone)), gone).toBe(false);
			expect(state.lastRun?.actions.map(action => action.kind)).toEqual(["scratch"]);
			expect(logged("scratch")).toMatchObject([{ path: dir, reason: "idle", shownInReplies: 1 }]);
			expect(state.usage?.parts.find(part => part.id === "scratch")?.path).toBe(path.join(w.root, "scratch"));

			// The picture a reply shows goes only with its session.
			await s.care.sessionDeleted(shown);
			expect(await exists(dir)).toBe(false);
		},
		SLOW,
	);

	it(
		"keeps a folder whole while its tab is open, a process carries its tag, processes cannot be listed, or it changed lately",
		async () => {
			const s = await scratch();
			const dir = await folder(s, TAG, await session("held"));
			const run = async (care = s.care) => (await w.care(undefined, { scratch: care }).run("user")).lastRun;
			const whole = async () =>
				(await exists(path.join(dir, "test-results/out.log"))) &&
				(await exists(path.join(dir, "checkout/src/a.ts")));

			s.held = new Set([TAG]);
			expect((await run())?.kept).toBe(0);
			expect(await whole()).toBe(true);

			s.held = new Set();
			s.processes = [{ tag: OTHER }, {}, { tag: TAG }];
			expect((await run())?.kept).toBe(1);
			s.processes = null;
			expect((await run())?.kept).toBe(1);
			expect(await whole()).toBe(true);
			expect(logged("kept")).toEqual([
				{ path: dir, reason: "a process of its session runs" },
				{ path: dir, reason: "process check unavailable" },
			]);

			// A day after its last file: not idle yet, and no line for it.
			const soon = await scratch(Date.now() + DAY_MS);
			expect((await run(soon.care))?.kept).toBe(0);
			expect(await whole()).toBe(true);
			expect(logged("scratch")).toEqual([]);
		},
		SLOW,
	);

	it(
		"keeps a folder whole when its session cannot be read or is not known, and never touches what is no scratch folder",
		async () => {
			const s = await scratch();
			const unreadable = await session("unreadable");
			const dir = await folder(s, TAG, unreadable);
			await fs.writeFile(unreadable, "this is no session file\n");
			// Folders this app has no record of: one with files, one empty; and an entry that is no tag.
			const root = path.join(w.root, "scratch");
			const unknown = path.join(root, "f".repeat(32));
			await write(unknown, "left.png", "png\n");
			const empty = path.join(root, "e".repeat(32));
			await fs.mkdir(empty);
			await write(root, "notes/mine.md", "mine\n");

			const state = await w.care(undefined, { scratch: s.care }).run("user");
			expect(await exists(path.join(dir, "shots/unused.png"))).toBe(true);
			expect(await exists(path.join(unknown, "left.png"))).toBe(true);
			expect(await exists(empty)).toBe(false);
			expect(await fs.readFile(path.join(root, "notes/mine.md"), "utf8")).toBe("mine\n");
			expect(state.lastRun?.kept).toBe(2);
			expect(logged("kept").map(details => String(details.reason))).toEqual([
				"its session file unreadable.jsonl cannot be read",
				"its sessions are not known",
			]);
		},
		SLOW,
	);

	it(
		"follows a session moved to another folder, and takes a folder whose sessions are gone without waiting",
		async () => {
			// Not idle: a folder with no session left waits for nothing.
			const s = await scratch(Date.now());
			const dir = path.join(w.root, "scratch", TAG);
			const before = await session("moved", `![After](${dir}/shots/after.png)`);
			await folder(s, TAG, before);
			const after = path.join(w.root, "sessions", "-elsewhere", "moved.jsonl");
			await fs.mkdir(path.dirname(after), { recursive: true });
			await fs.rename(before, after);
			s.stored = [after];
			const gone = await folder(s, OTHER, path.join(w.root, "sessions", "-repo", "removed-outside.jsonl"));

			await w.care(Date.now(), { scratch: s.care }).run("user");
			expect(await exists(gone)).toBe(false);
			// The moved session still exists, so its folder waits for its idle days.
			expect(await exists(path.join(dir, "shots/unused.png"))).toBe(true);

			const later = await scratch();
			later.stored = [after];
			await w.care(undefined, { scratch: later.care }).run("user");
			expect(await exists(path.join(dir, "shots/after.png"))).toBe(true);
			expect(await exists(path.join(dir, "shots/unused.png"))).toBe(false);
		},
		SLOW,
	);
});
