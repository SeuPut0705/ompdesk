import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import { MEMORY_METHODS, MemoryPullParams, MemoryPushParams } from "../remote/app-protocol";
import { RM_TEMP } from "../test-fake-omp";
import type { MemoryPageCopy } from "./client";
import { type MemoryStore, MemorySync, pageHash, servePull, servePush } from "./sync";

type Stored = MemoryPageCopy & { at: string };

/** A memory server: pages by (workspace, project, path), each write a new `updated_at` from the shared clock. */
class FakeServer {
	readonly pages = new Map<string, Stored>();
	writes: string[] = [];
	ready = true;
	constructor(
		readonly now: () => string,
		readonly normalize: (copy: MemoryPageCopy) => MemoryPageCopy = copy => copy,
		/** False: an ai-memory without OMPdesk's `origin_device` (a person's own newer install) drops the mark. */
		readonly keepsOrigin = true,
	) {}

	/** What a person or an agent writes here: no origin, a page of this computer's own. */
	edit(path: string, body: string, project = "app", extra: Partial<MemoryPageCopy> = {}): void {
		this.#put({ ...page(path, body, project), ...extra }, undefined);
	}

	#put(copy: MemoryPageCopy, origin: string | undefined): void {
		const { origin: _dropped, ...rest } = this.normalize(structuredClone(copy));
		const at = this.now();
		this.pages.set(`${copy.project}/${copy.path}`, {
			...rest,
			...(origin && this.keepsOrigin ? { origin } : {}),
			updatedAt: at,
			at,
		});
	}

	body(path: string, project = "app"): string | undefined {
		return this.pages.get(`${project}/${path}`)?.body;
	}

	readonly store: MemoryStore = {
		projects: async () => {
			const seen = new Map<string, { workspace: string; project: string }>();
			for (const p of this.pages.values()) seen.set(p.project, { workspace: p.workspace, project: p.project });
			return [...seen.values()];
		},
		pages: async ref =>
			[...this.pages.values()]
				.filter(p => p.workspace === ref.workspace && p.project === ref.project)
				.map(p => ({ workspace: p.workspace, project: p.project, path: p.path, updatedAt: p.at })),
		pageCopy: async ref => {
			const stored = this.pages.get(`${ref.project}/${ref.path}`);
			if (!stored) throw new Error("page not found");
			const { at: _at, ...copy } = structuredClone(stored);
			return copy;
		},
		writePageCopy: async (copy, origin) => {
			this.writes.push(copy.path);
			this.#put(copy, origin);
		},
	};
}

function page(path: string, body: string, project = "app"): MemoryPageCopy {
	return {
		workspace: "default",
		project,
		path,
		title: path,
		kind: "decision",
		tier: "semantic",
		body,
		tags: [],
		pinned: false,
		metadata: {},
		updatedAt: null,
	};
}

describe("memory sync between two computers", () => {
	let dir: string;
	let tick: number;
	let mac: FakeServer;
	let win: FakeServer;
	let logs: { message: string; details: Record<string, unknown> }[];
	let sync: MemorySync;
	let hostMethods: Set<string>;
	/** Pages that crossed the link, either way. */
	let crossed: number;
	/** Runs on the host just before it serves a push (a change made there mid-round). */
	let beforePush: (() => void) | undefined;

	const clock = () => new Date(Date.UTC(2026, 9, 19, 0, 0, ++tick)).toISOString();

	function connect(host: FakeServer): MemorySync {
		const hostDeps = { store: host.store, ready: () => host.ready, selfId: () => "win" };
		return new MemorySync({
			store: mac.store,
			ready: () => mac.ready,
			selfId: () => "mac",
			onlineHosts: () => ["win"],
			// The link carries JSON: what crosses is parsed again on the far side.
			request: async <T>(_host: string, method: string, params: unknown): Promise<T> => {
				const wire = JSON.parse(JSON.stringify(params));
				if (!hostMethods.has(method)) throw codedError("unsupported", `Unknown method ${method}`);
				if (method === MEMORY_METHODS.pull) {
					const reply = await servePull(hostDeps, "mac", MemoryPullParams.parse(wire));
					crossed += reply.pages.length;
					return JSON.parse(JSON.stringify(reply)) as T;
				}
				const push = MemoryPushParams.parse(wire);
				crossed += push.pages.length;
				beforePush?.();
				return JSON.parse(JSON.stringify(await servePush(hostDeps, "mac", push))) as T;
			},
			stateFile: join(dir, "sync.json"),
			log: (message, details) => logs.push({ message, details }),
		});
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "memory-sync-"));
		tick = 0;
		mac = new FakeServer(clock);
		win = new FakeServer(clock);
		logs = [];
		hostMethods = new Set(Object.values(MEMORY_METHODS));
		crossed = 0;
		beforePush = undefined;
		sync = connect(win);
	});

	afterEach(async () => {
		sync.dispose();
		await rm(dir, RM_TEMP);
	});

	it("brings the host's decisions here and sends this computer's there, sessions staying put", async () => {
		win.edit("decisions/jev.md", "Pin Jev 1.14.");
		win.edit("sessions/s1.md", "raw session");
		mac.edit("_rules/style.md", "One line per row.", "_global");
		mac.edit("sessions/s2.md", "raw session");

		expect(await sync.sync("win")).toEqual({ pulled: 1, pushed: 1, conflicts: 0 });

		expect(mac.body("decisions/jev.md")).toBe("Pin Jev 1.14.");
		expect(win.body("_rules/style.md", "_global")).toBe("One line per row.");
		expect(mac.body("sessions/s1.md")).toBeUndefined();
		expect(win.body("sessions/s2.md")).toBeUndefined();
		// Each copy names the computer it came from.
		expect(mac.pages.get("app/decisions/jev.md")?.origin).toBe("win");
		expect(win.pages.get("_global/_rules/style.md")?.origin).toBe("mac");
	});

	it("never sends a copy back, and a round with nothing new moves and writes nothing", async () => {
		win.edit("decisions/jev.md", "Pin Jev 1.14.");
		mac.edit("gotchas/eio.md", "bootout before bootstrap");
		await sync.sync("win");
		expect(crossed).toBe(2);
		mac.writes = [];
		win.writes = [];
		crossed = 0;

		expect(await sync.sync("win")).toEqual({ pulled: 0, pushed: 0, conflicts: 0 });
		expect(await sync.sync("win")).toEqual({ pulled: 0, pushed: 0, conflicts: 0 });
		expect(crossed).toBe(0);
		expect(mac.writes).toEqual([]);
		expect(win.writes).toEqual([]);
	});

	it("never overwrites a change the host made after this computer looked", async () => {
		mac.edit("decisions/x.md", "first");
		await sync.sync("win");
		mac.edit("decisions/x.md", "changed here");
		beforePush = () => {
			beforePush = undefined;
			win.edit("decisions/x.md", "changed on the host, after the pull");
		};

		expect(await sync.sync("win")).toMatchObject({ pushed: 0, conflicts: 1 });
		// The host's change came last: it is now on both.
		expect(win.body("decisions/x.md")).toBe("changed on the host, after the pull");
		expect(mac.body("decisions/x.md")).toBe("changed on the host, after the pull");
	});

	it("writes nothing for a page both computers already hold the same", async () => {
		mac.edit("decisions/a.md", "Same words.");
		win.edit("decisions/a.md", "Same words.");

		expect(await sync.sync("win")).toEqual({ pulled: 0, pushed: 0, conflicts: 0 });
		expect(mac.writes).toEqual([]);
		expect(win.writes).toEqual([]);
	});

	it("settles once when the servers store a page differently and keep no origin mark", async () => {
		// Both lowercase entities on write, as ai-memory's write path does, and neither keeps `origin_device`
		// (an ai-memory without OMPdesk's patch): only the agreement pairs stop a copy from going round.
		const lower = (copy: MemoryPageCopy) => ({
			...copy,
			metadata: { ...copy.metadata, entities: copy.metadata.entities?.map(e => e.toLowerCase()) },
		});
		win = new FakeServer(clock, lower, false);
		mac = new FakeServer(clock, lower, false);
		sync.dispose();
		sync = connect(win);
		const raw = (server: FakeServer, path: string) => {
			const stored = server.pages.get(`app/${path}`);
			if (stored) stored.metadata = { entities: ["Tailscale"] };
		};
		mac.edit("decisions/net.md", "Tailscale only.");
		raw(mac, "decisions/net.md");
		win.edit("decisions/jev.md", "Jev, written by an older path.");
		raw(win, "decisions/jev.md");

		expect(await sync.sync("win")).toMatchObject({ pulled: 1, pushed: 1 });
		expect(win.pages.get("app/decisions/net.md")?.metadata.entities).toEqual(["tailscale"]);
		win.writes = [];
		mac.writes = [];
		for (let round = 0; round < 3; round++) await sync.sync("win");
		expect(win.writes).toEqual([]);
		expect(mac.writes).toEqual([]);
	});

	it("an edit of a copy goes back to the computer it came from", async () => {
		win.edit("decisions/jev.md", "Pin Jev 1.14.");
		await sync.sync("win");
		mac.edit("decisions/jev.md", "Pin Jev 1.15 from November.");

		expect(await sync.sync("win")).toMatchObject({ pushed: 1, conflicts: 0 });
		expect(win.body("decisions/jev.md")).toBe("Pin Jev 1.15 from November.");
		expect(win.pages.get("app/decisions/jev.md")?.origin).toBe("mac");

		win.edit("decisions/jev.md", "Pin Jev 1.16.");
		expect(await sync.sync("win")).toMatchObject({ pulled: 1, conflicts: 0 });
		expect(mac.body("decisions/jev.md")).toBe("Pin Jev 1.16.");
	});

	it("when both changed a page, the later change wins on both and is logged", async () => {
		mac.edit("decisions/x.md", "first");
		await sync.sync("win");
		win.edit("decisions/x.md", "changed on the host");
		mac.edit("decisions/x.md", "changed here, later");

		expect(await sync.sync("win")).toMatchObject({ conflicts: 1 });
		await sync.sync("win");
		expect(win.body("decisions/x.md")).toBe("changed here, later");
		expect(mac.body("decisions/x.md")).toBe("changed here, later");
		expect(logs.filter(line => line.message === "conflict")).toEqual([
			expect.objectContaining({
				message: "conflict",
				details: expect.objectContaining({ host: "win", path: "decisions/x.md", winner: "here" }),
			}),
		]);

		mac.edit("decisions/x.md", "here again");
		win.edit("decisions/x.md", "host, last");
		await sync.sync("win");
		expect(mac.body("decisions/x.md")).toBe("host, last");
		expect(win.body("decisions/x.md")).toBe("host, last");
	});

	it("keeps state across a relaunch: nothing is sent again", async () => {
		mac.edit("procedures/release.md", "Tag main, then deploy.");
		await sync.sync("win");
		sync.dispose();
		win.writes = [];
		sync = connect(win);
		await sync.sync("win");
		expect(win.writes).toEqual([]);
	});

	it("reads and writes nothing while memory is off on either side", async () => {
		mac.edit("decisions/a.md", "here");
		win.edit("decisions/b.md", "there");
		win.ready = false;
		expect(await sync.sync("win")).toBeNull();
		win.ready = true;
		mac.ready = false;
		expect(await sync.sync("win")).toBeNull();
		expect(mac.writes).toEqual([]);
		expect(win.writes).toEqual([]);
	});

	it("leaves an older host alone until its link comes up again", async () => {
		hostMethods.clear();
		win.edit("decisions/b.md", "there");
		expect(await sync.sync("win")).toBeNull();
		expect(await sync.sync("win")).toBeNull();
		expect(logs.filter(line => line.message === "unsupported")).toHaveLength(1);

		hostMethods = new Set(Object.values(MEMORY_METHODS));
		sync.hostOnline("win");
		await expect.poll(() => mac.body("decisions/b.md")).toBe("there");
	});

	it("hashes what a page holds, not where it came from or when", () => {
		const a = page("decisions/a.md", "body");
		const copied: MemoryPageCopy = { ...a, origin: "win", updatedAt: "2026-10-19T00:00:00Z", pinned: true };
		expect(pageHash(a)).toBe(pageHash(copied));
		expect(pageHash(a)).not.toBe(pageHash({ ...a, body: "other" }));
		expect(pageHash({ ...a, tags: ["b", "a"] })).toBe(pageHash({ ...a, tags: ["a", "b"] }));
	});
});
