import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../shared/ipc-types";
import { resetSnapshotsForTest, snapshots } from "../lib/snapshot-cache";
import { resetSessionListFeeds, sessionListFeed } from "./session-list";

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
		omp: { sessions: { list, delete: remove }, events: { onSessionsChanged: () => () => {} } },
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
					list: async (_scope: string, device?: string) => {
						reads.push(device);
						return [];
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
