import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcSessionsChanged, SessionInfo } from "../../shared/ipc-types";
import type { VersionedSessionList } from "../../shared/session-list-delta";
import { resetSnapshotsForTest, snapshots } from "../lib/snapshot-cache";
import { READ_RETRY_MS, resetSessionListFeeds, sessionListFeed } from "./session-list";

class Memory {
	readonly map = new Map<string, string>();
	get length() {
		return this.map.size;
	}
	key(i: number) {
		return [...this.map.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}

const row = (path: string, title = path): SessionInfo =>
	({ path, title, modified: 1, size: 1 }) as unknown as SessionInfo;

function install(list: () => Promise<SessionInfo[]>, remove: (path: string) => Promise<void> = async () => {}) {
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		omp: {
			sessions: { list, listShared: async () => ({ version: "e.1", sessions: await list() }), delete: remove },
			events: { onSessionsChanged: () => () => {} },
		},
	});
}

beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new Memory() });
	resetSnapshotsForTest();
	resetSessionListFeeds();
});
afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(globalThis, "localStorage");
	resetSnapshotsForTest();
	resetSessionListFeeds();
});

describe("session list snapshot", () => {
	it("paints the last list at once (no loading state) and replaces it in place when the read answers", async () => {
		snapshots().write("sessions", "local", "global", [row("/a"), row("/b")]);
		let answer: (rows: SessionInfo[]) => void = () => {};
		install(() => new Promise(resolve => (answer = resolve)));
		const feed = sessionListFeed("global");
		expect(feed.store.getState()).toMatchObject({ isLoading: false, error: null });
		expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/a", "/b"]);
		const release = feed.retain();
		// Retaining reads again but never turns the shown rows back into a wait.
		expect(feed.store.getState().isLoading).toBe(false);
		const kept = feed.store.getState().sessions[0];
		answer([row("/a"), row("/c")]);
		await vi.waitFor(() => expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/a", "/c"]));
		expect(feed.store.getState().sessions[0]).toBe(kept);
		release();
	});

	it("takes a host row whose listing changed though its file did not: a tab there closed, its opener or verdict came", async () => {
		const held = { ...row("/child"), heldOnHost: true as const };
		snapshots().write("sessions", "device:dev-1", "global", [held, row("/boss")]);
		const read = Promise.withResolvers<SessionInfo[]>();
		install(() => read.promise);
		const feed = sessionListFeed("global", "dev-1");
		const release = feed.retain();
		// Same journal (modified, size, title): the host's tab let go of it, and it now knows the opener and the verdict.
		read.resolve([
			{ ...row("/child"), openedBySession: "/boss", childProblem: "unmerged" },
			{ ...row("/boss"), openedBySession: null },
		]);
		await vi.waitFor(() => expect(feed.store.getState().sessions[0]?.heldOnHost).toBeUndefined());
		expect(feed.store.getState().sessions.map(s => [s.openedBySession, s.childProblem])).toEqual([
			["/boss", "unmerged"],
			[null, undefined],
		]);
		release();
	});

	it("a host's last-known rows are replaced once a read answers, though the first reads failed", async () => {
		vi.useFakeTimers();
		try {
			// Rows from before sessions were deleted on the host; the link has just come up and the host does not answer yet.
			snapshots().write("sessions", "device:dev-1", "global", [row("/gone"), row("/kept")]);
			let fail = true;
			install(async () => {
				if (fail) throw new Error("remote_offline");
				return [row("/kept")];
			});
			const feed = sessionListFeed("global", "dev-1");
			const release = feed.retain();
			await vi.advanceTimersByTimeAsync(0);
			expect(feed.store.getState().error).toBe("remote_offline");
			await vi.advanceTimersByTimeAsync(READ_RETRY_MS);
			fail = false;
			await vi.advanceTimersByTimeAsync(READ_RETRY_MS * 2);
			expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/kept"]);
			expect(feed.store.getState().live).toBe(true);
			release();
		} finally {
			vi.useRealTimers();
		}
	});

	it("is loading only when nothing is known, and a host's list is never another host's", () => {
		snapshots().write("sessions", "device:dev-1", "global", [row("/host")]);
		install(() => new Promise(() => {}));
		expect(sessionListFeed("global").store.getState().sessions).toEqual([]);
		expect(sessionListFeed("global").store.getState().isLoading).toBe(true);
		expect(
			sessionListFeed("global", "dev-1")
				.store.getState()
				.sessions.map(s => s.path),
		).toEqual(["/host"]);
		expect(sessionListFeed("global", "dev-2").store.getState().sessions).toEqual([]);
	});

	it("reads again only when its own machine's list changed, not another's", async () => {
		vi.useFakeTimers();
		const listeners: Array<(change: { device?: string }) => void> = [];
		const reads: Array<string | undefined> = [];
		vi.stubGlobal("window", {
			setTimeout,
			clearTimeout,
			omp: {
				sessions: {
					listShared: async (device?: string) => {
						reads.push(device);
						return { version: "e.1", sessions: [] };
					},
				},
				events: {
					onSessionsChanged: (listener: (change: { device?: string }) => void) => {
						listeners.push(listener);
						return () => {};
					},
				},
			},
		});
		const releaseLocal = sessionListFeed("global").retain();
		const releaseHost = sessionListFeed("global", "dev-studio").retain();
		await vi.runAllTimersAsync();
		reads.length = 0;
		const changed = async (change: { device?: string }) => {
			for (const listener of listeners) listener(change);
			await vi.runAllTimersAsync();
		};

		// This computer's journals move while the host's do not: only this computer's list is read again.
		await changed({});
		expect(reads).toEqual([undefined]);
		reads.length = 0;
		await changed({ device: "dev-studio" });
		expect(reads).toEqual(["dev-studio"]);
		reads.length = 0;
		await changed({ device: "dev-other" });
		expect(reads).toEqual([]);
		releaseLocal();
		releaseHost();
		vi.useRealTimers();
	});

	it("keeps its rows when the last holder lets go", () => {
		snapshots().write("sessions", "local", "global", [row("/a")]);
		install(() => new Promise(() => {}));
		const feed = sessionListFeed("global");
		const release = feed.retain();
		release();
		expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/a"]);
		expect(feed.store.getState().isLoading).toBe(false);
	});

	it("writes the list it read back to the snapshot, bounded", async () => {
		vi.useFakeTimers();
		try {
			const rows = Array.from({ length: 400 }, (_, i) => row(`/s${i}`));
			install(() => Promise.resolve(rows));
			const feed = sessionListFeed("global");
			const release = feed.retain();
			await vi.advanceTimersByTimeAsync(2000);
			const saved = snapshots().read<SessionInfo[]>("sessions", "local", "global")?.value;
			expect(saved).toHaveLength(150);
			release();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a delete drops the row from every list of the device and from each one's last-known copy, held or not", async () => {
		snapshots().write("sessions", "local", "global", [row("/a"), row("/gone")]);
		snapshots().write("sessions", "local", "local", [row("/gone"), row("/b")]);
		const remove = vi.fn(async () => {});
		install(async () => [row("/a"), row("/b")], remove);
		const global = sessionListFeed("global");
		await global.deleteSession("/gone");
		expect(remove).toHaveBeenCalledWith("/gone");
		expect(global.store.getState().sessions.map(s => s.path)).not.toContain("/gone");
		// The local list nobody showed paints without it on its next mount (a relaunch, a phone reload).
		expect(
			snapshots()
				.read<SessionInfo[]>("sessions", "local", "local")
				?.value?.map(s => s.path),
		).toEqual(["/b"]);
		expect(
			snapshots()
				.read<SessionInfo[]>("sessions", "local", "global")
				?.value?.map(s => s.path),
		).toEqual(["/a"]);
		expect(
			sessionListFeed("local")
				.store.getState()
				.sessions.map(s => s.path),
		).toEqual(["/b"]);
	});

	it("a session deleted on another device leaves the local list's copy once the global list is read (a phone reload)", async () => {
		snapshots().write("sessions", "local", "local", [row("/gone"), row("/b")]);
		install(async () => [row("/a"), row("/b")]);
		const release = sessionListFeed("global").retain();
		await vi.waitFor(() =>
			expect(
				snapshots()
					.read<SessionInfo[]>("sessions", "local", "local")
					?.value?.map(s => s.path),
			).toEqual(["/b"]),
		);
		release();
		resetSessionListFeeds();
		expect(
			sessionListFeed("local")
				.store.getState()
				.sessions.map(s => s.path),
		).toEqual(["/b"]);
	});
});

describe("the numbered global list", () => {
	const at = (path: string, title = path): SessionInfo =>
		({ path, title, modified: "2026-10-30T10:00:00.000Z", size: 1 }) as unknown as SessionInfo;

	/** A window whose main answers `listShared` with what `answer` holds when the read lands. */
	function numbered(first: VersionedSessionList) {
		vi.useFakeTimers();
		const listeners: Array<(change: IpcSessionsChanged) => void> = [];
		const pending: Array<() => void> = [];
		const state = { answer: first, reads: 0, hold: false };
		vi.stubGlobal("window", {
			setTimeout,
			clearTimeout,
			omp: {
				sessions: {
					listShared: () => {
						state.reads++;
						if (!state.hold) return Promise.resolve(state.answer);
						const read = Promise.withResolvers<VersionedSessionList>();
						pending.push(() => read.resolve(state.answer));
						return read.promise;
					},
				},
				events: {
					onSessionsChanged: (listener: (change: IpcSessionsChanged) => void) => {
						listeners.push(listener);
						return () => {};
					},
				},
			},
		});
		const push = async (change: IpcSessionsChanged) => {
			for (const listener of listeners) listener(change);
			await vi.runAllTimersAsync();
		};
		const land = async () => {
			for (const answer of pending.splice(0)) answer();
			await vi.runAllTimersAsync();
		};
		return { state, push, land };
	}
	afterEach(() => vi.useRealTimers());

	it("applies a pushed change of the version it holds and reads nothing", async () => {
		const { state, push } = numbered({ version: "e.1", sessions: [at("/a"), at("/b")] });
		const feed = sessionListFeed("global");
		const release = feed.retain();
		await vi.runAllTimersAsync();
		expect(state.reads).toBe(1);
		const kept = feed.store.getState().sessions[0];

		await push({ list: { base: "e.1", version: "e.2", set: [at("/b", "Renamed")], remove: [] } });
		expect(feed.store.getState().sessions.map(s => [s.path, s.title])).toEqual([
			["/a", "/a"],
			["/b", "Renamed"],
		]);
		// A row the change left alone keeps its object: nothing that shows it renders again.
		expect(feed.store.getState().sessions[0]).toBe(kept);
		await push({ list: { base: "e.2", version: "e.3", set: [], remove: ["/a"] } });
		expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/b"]);
		// The version it already holds (a read that answered with it) changes nothing either.
		await push({ list: { base: "e.2", version: "e.3", set: [], remove: ["/b"] } });
		expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/b"]);
		expect(state.reads).toBe(1);
		release();
	});

	it("reads the whole list once when it missed a change, then applies the next one", async () => {
		const { state, push } = numbered({ version: "e.1", sessions: [at("/a")] });
		const feed = sessionListFeed("global");
		const release = feed.retain();
		await vi.runAllTimersAsync();

		// e.2 never came (released meanwhile, a dropped link): e.3 does not apply to e.1.
		state.answer = { version: "e.3", sessions: [at("/a"), at("/c")] };
		await push({ list: { base: "e.2", version: "e.3", set: [at("/c")], remove: [] } });
		expect(state.reads).toBe(2);
		expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/a", "/c"]);
		await push({ list: { base: "e.3", version: "e.4", set: [at("/d")], remove: [] } });
		expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/a", "/c", "/d"]);
		expect(state.reads).toBe(2);
		release();
	});

	it("reads again after a read under way answered an older version than a change named meanwhile", async () => {
		const { state, push, land } = numbered({ version: "e.1", sessions: [at("/a")] });
		state.hold = true;
		const feed = sessionListFeed("global");
		const release = feed.retain();
		await push({ list: { base: "e.1", version: "e.2", set: [at("/b")], remove: [] } });
		expect(state.reads).toBe(1);
		// Main took the list before e.2 and sent it after: the read is behind the change, so it is read once more.
		await land();
		state.answer = { version: "e.2", sessions: [at("/a"), at("/b")] };
		await land();
		expect(state.reads).toBe(2);
		expect(feed.store.getState().sessions.map(s => s.path)).toEqual(["/a", "/b"]);

		// A read that already holds what a change under way named is not read again.
		await push({ list: { base: "e.2", version: "e.3", set: [at("/c")], remove: [] } });
		expect(state.reads).toBe(2);
		release();
	});
});
