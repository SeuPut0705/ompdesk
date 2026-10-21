import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import {
	MEMORY_METHODS,
	MemoryConclusionPullParams,
	MemoryConclusionPushParams,
	MemoryPullParams,
	MemoryPushParams,
} from "../remote/app-protocol";
import { RM_TEMP } from "../test-fake-omp";
import type { MemoryConclusionCopy, MemoryPageCopy } from "./client";
import {
	type MemoryStore,
	MemorySync,
	pageHash,
	serveConclusionPull,
	serveConclusionPush,
	servePull,
	servePush,
} from "./sync";

type Stored = MemoryPageCopy & { at: string };
type StoredConclusion = Omit<MemoryConclusionCopy, "seq">;

/** A secret shaped like the vendor tokens the redactor knows (`ghp_…`). */
const TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4"}`;
const QUIET = { pulled: 0, pushed: 0, conflicts: 0, conclusions: { pulled: 0, pushed: 0 } };

/** A memory server: pages by (workspace, project, path), each write a new `updated_at` from the shared clock. */
class FakeServer {
	readonly pages = new Map<string, Stored>();
	/** Project name → the repository identity this server claimed it by (a checkout captured into it). */
	readonly identities = new Map<string, string>();
	writes: string[] = [];
	ready = true;
	/** Paths whose next read fails once (the server answering 500, a timeout). */
	readonly failOnce = new Set<string>();
	/** Runs once at the start of the next copy write, before its precondition is checked (a change racing it). */
	beforeWrite: (() => void) | undefined;
	/** Conclusions this server captured itself (a Stop observation with a body): `seq` is the position. */
	readonly native: StoredConclusion[] = [];
	/** Conclusions it holds from other computers, each naming its origin; unique per (project, origin, id). */
	readonly synced: StoredConclusion[] = [];
	/** Every `writeConclusions` call that reached this server, whether it wrote or not. */
	conclusionCalls: { project: string; origin: string; ids: string[] }[] = [];
	conclusionReads = 0;
	/** Ids whose next write throws once (the server answering 500); the whole call writes nothing. */
	readonly failConclusionOnce = new Set<string>();
	/** An ai-memory without the conclusion routes (a plain 404). */
	noConclusionRoutes = false;
	/** The id of this server's database: a fresh database (delete all memory) names a new one and restarts its seqs. */
	database = "db-1";
	#version = 0;
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

	/** Delete all memory, or a restored backup: another database, its conclusion streams empty again. */
	replaceStore(id: string): void {
		this.database = id;
		this.native.length = 0;
		this.synced.length = 0;
	}

	/** What omp's Stop excerpt leaves in this server: a conclusion of its own, with no origin. */
	capture(id: string, body: string, project = "app", title = `Session ${id}`): void {
		this.native.push({
			workspace: "default",
			project,
			id,
			sessionId: `s-${id}`,
			title,
			body,
			at: this.now(),
		});
	}

	#put(copy: MemoryPageCopy, origin: string | undefined): void {
		const { origin: _dropped, id: _id, ...rest } = this.normalize(structuredClone(copy));
		const at = this.now();
		this.pages.set(`${copy.project}/${copy.path}`, {
			...rest,
			...(origin && this.keepsOrigin ? { origin } : {}),
			id: `v${++this.#version}`,
			updatedAt: at,
			at,
		});
	}

	body(path: string, project = "app"): string | undefined {
		return this.pages.get(`${project}/${path}`)?.body;
	}

	/** What the memory upkeep's supersede does (`AiMemoryClient.retirePage`): the page again, expired now. */
	retire(path: string, project = "app"): void {
		const stored = this.pages.get(`${project}/${path}`);
		if (!stored) throw new Error("no page to retire");
		const { at: _at, origin: _origin, id: _id, ...copy } = stored;
		this.#put(
			{
				...copy,
				body: `${copy.body}\n\n_Superseded by [[decisions/new.md]]._`,
				tags: [...copy.tags, "superseded"],
				expiresAt: this.now(),
			},
			undefined,
		);
	}

	/** What a reader lists (the page list, recall): an expired page is hidden, an exact read still answers. */
	listed(project = "app"): string[] {
		return [...this.pages.values()]
			.filter(p => p.project === project && !p.expiresAt)
			.map(p => p.path)
			.sort();
	}

	readonly store: MemoryStore = {
		projects: async () => {
			const seen = new Map<string, { workspace: string; project: string; identity?: string }>();
			const add = (project: string) => {
				const identity = this.identities.get(project);
				seen.set(project, { workspace: "default", project, ...(identity ? { identity } : {}) });
			};
			for (const p of this.pages.values()) add(p.project);
			for (const project of this.identities.keys()) add(project);
			return [...seen.values()];
		},
		allPages: async ref =>
			[...this.pages.values()]
				.filter(p => p.workspace === ref.workspace && p.project === ref.project)
				.map(p => ({ workspace: p.workspace, project: p.project, path: p.path, updatedAt: p.at })),
		pageCopy: async ref => {
			if (this.failOnce.delete(ref.path)) throw new Error("Memory answered 500");
			const stored = this.pages.get(`${ref.project}/${ref.path}`);
			if (!stored) throw new Error("page not found");
			const { at: _at, ...copy } = structuredClone(stored);
			return copy;
		},
		// As the server's write path: only over the version named, or only where nothing is (`null`).
		writePageCopy: async (copy, origin, expected) => {
			const race = this.beforeWrite;
			this.beforeWrite = undefined;
			race?.();
			const current = this.pages.get(`${copy.project}/${copy.path}`)?.id ?? null;
			if (expected !== undefined && expected !== current) return false;
			this.writes.push(copy.path);
			this.#put(copy, origin);
			return true;
		},
		conclusions: async (source, after, limit) => {
			if (this.noConclusionRoutes) throw new Error("Memory answered 404");
			this.conclusionReads++;
			const all = (source === "native" ? this.native : this.synced).map((row, index) => ({
				...row,
				seq: index + 1,
			}));
			const rows = all.filter(row => row.seq > after);
			const page = rows.slice(0, limit);
			return {
				rows: structuredClone(page),
				next: page.at(-1)?.seq ?? after,
				more: rows.length > page.length,
				store: this.database,
				last: all.length,
			};
		},
		writeConclusions: async (project, origin, items) => {
			if (this.noConclusionRoutes) throw new Error("Memory answered 404");
			this.conclusionCalls.push({ project: project.project, origin, ids: items.map(item => item.id) });
			for (const item of items) {
				if (this.failConclusionOnce.delete(item.id)) throw new Error("Memory answered 500");
			}
			return items.map(item => {
				if (!item.body.trim()) return "skipped";
				const held = this.synced.some(
					row => row.project === project.project && row.origin === origin && row.id === item.id,
				);
				if (held) return "same";
				this.synced.push({
					...structuredClone(item),
					workspace: project.workspace,
					project: project.project,
					origin,
				});
				return "written";
			});
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
	/** Conclusions that crossed the link, either way. */
	let conclusionsCrossed: number;
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
				if (method === MEMORY_METHODS.conclusionsPull) {
					const reply = await serveConclusionPull(hostDeps, "mac", MemoryConclusionPullParams.parse(wire));
					conclusionsCrossed += reply.conclusions.length;
					return JSON.parse(JSON.stringify(reply)) as T;
				}
				if (method === MEMORY_METHODS.conclusionsPush) {
					const push = MemoryConclusionPushParams.parse(wire);
					conclusionsCrossed += push.conclusions.length;
					return JSON.parse(JSON.stringify(await serveConclusionPush(hostDeps, "mac", push))) as T;
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
		conclusionsCrossed = 0;
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

		expect(await sync.sync("win")).toEqual({
			pulled: 1,
			pushed: 1,
			conflicts: 0,
			conclusions: { pulled: 0, pushed: 0 },
		});

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

		expect(await sync.sync("win")).toEqual(QUIET);
		expect(await sync.sync("win")).toEqual(QUIET);
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

	it("a page the host could not read once still arrives, though nothing changed it since", async () => {
		win.edit("decisions/a.md", "first");
		win.edit("decisions/b.md", "second");
		win.failOnce.add("decisions/b.md");

		expect(await sync.sync("win")).toBeNull();
		expect(logs).toContainEqual(
			expect.objectContaining({ message: "failed", details: expect.objectContaining({ step: "pull" }) }),
		);
		// The batch failed as a whole and the cursor stayed: nothing here yet, both on the next round.
		expect(mac.writes).toEqual([]);

		expect(await sync.sync("win")).toMatchObject({ pulled: 2 });
		expect(mac.body("decisions/a.md")).toBe("first");
		expect(mac.body("decisions/b.md")).toBe("second");
	});

	it("a page this computer could not read once is still sent, though nothing changed it since", async () => {
		mac.edit("decisions/a.md", "first");
		mac.edit("decisions/b.md", "second");
		mac.failOnce.add("decisions/a.md");

		expect(await sync.sync("win")).toMatchObject({ pushed: 1 });
		expect(win.body("decisions/a.md")).toBeUndefined();
		expect(win.body("decisions/b.md")).toBe("second");

		expect(await sync.sync("win")).toMatchObject({ pushed: 1 });
		expect(win.body("decisions/a.md")).toBe("first");
		crossed = 0;
		expect(await sync.sync("win")).toEqual(QUIET);
		expect(crossed).toBe(0);
	});

	it("a page retired on one computer leaves the other's listing too, both ways, and stays retired", async () => {
		mac.edit("decisions/jev-auto.md", "Jev updates itself.");
		win.edit("decisions/net-auto.md", "Any network.");
		await sync.sync("win");
		expect(mac.listed()).toEqual(["decisions/jev-auto.md", "decisions/net-auto.md"]);

		win.retire("decisions/jev-auto.md");
		mac.retire("decisions/net-auto.md");
		await sync.sync("win");
		expect(mac.listed()).toEqual([]);
		expect(win.listed()).toEqual([]);
		expect(mac.pages.get("app/decisions/jev-auto.md")?.tags).toContain("superseded");
		expect(win.pages.get("app/decisions/net-auto.md")?.expiresAt).toBeTruthy();

		mac.writes = [];
		win.writes = [];
		for (let round = 0; round < 3; round++) await sync.sync("win");
		expect(mac.writes).toEqual([]);
		expect(win.writes).toEqual([]);
		expect(win.listed()).toEqual([]);
	});

	it("a retire on the host between its check of a push and the write is never overwritten", async () => {
		mac.edit("decisions/jev-auto.md", "Jev updates itself.");
		await sync.sync("win");
		mac.edit("decisions/jev-auto.md", "Jev updates itself, edited.");
		// The host has read its page and judged the push; the retire lands before the write.
		win.beforeWrite = () => win.retire("decisions/jev-auto.md");

		await sync.sync("win");
		await sync.sync("win");
		expect(win.listed()).toEqual([]);
		expect(mac.listed()).toEqual([]);
		expect(win.body("decisions/jev-auto.md")).toContain("Superseded");
	});

	it("a retire here between the check of a pulled page and the write is never overwritten", async () => {
		win.edit("decisions/jev-auto.md", "Jev updates itself.");
		await sync.sync("win");
		win.edit("decisions/jev-auto.md", "Jev updates itself, edited on the host.");
		// This computer has read its copy and judged the host's change; the retire lands before the write.
		mac.beforeWrite = () => mac.retire("decisions/jev-auto.md");

		await sync.sync("win");
		await sync.sync("win");
		expect(mac.listed()).toEqual([]);
		expect(win.listed()).toEqual([]);
		expect(mac.body("decisions/jev-auto.md")).toContain("Superseded");
	});

	it("a computer that never saw the retire cannot bring a retired page back live", async () => {
		// The Mac's live copy is older than the host's retire, and the Mac has no sync history (a fresh pairing).
		mac.edit("decisions/jev-auto.md", "Jev updates itself.");
		win.edit("decisions/jev-auto.md", "Jev updates itself (host).");
		win.retire("decisions/jev-auto.md");

		await sync.sync("win");
		await sync.sync("win");
		expect(win.listed()).toEqual([]);
		expect(mac.listed()).toEqual([]);
		expect(win.pages.get("app/decisions/jev-auto.md")?.expiresAt).toBeTruthy();
	});

	it("writes nothing for a page both computers already hold the same", async () => {
		mac.edit("decisions/a.md", "Same words.");
		win.edit("decisions/a.md", "Same words.");

		expect(await sync.sync("win")).toEqual(QUIET);
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

	it("files a repository's pages and conclusions under each computer's own project for it, whatever its name there", async () => {
		// The paired Windows host names the repository path style, this Mac by its folder.
		win.identities.set("seuput0705-ompdesk", "github.com/seuput0705/ompdesk");
		mac.identities.set("ompdesk", "github.com/seuput0705/ompdesk");
		win.edit("decisions/host.md", "Decided on the host.", "seuput0705-ompdesk");
		mac.edit("decisions/mac.md", "Decided on the Mac.", "ompdesk");
		win.capture("w1", "Host conclusion.", "seuput0705-ompdesk");
		mac.capture("m1", "Mac conclusion.", "ompdesk");

		expect(await sync.sync("win")).toEqual({
			pulled: 1,
			pushed: 1,
			conflicts: 0,
			conclusions: { pulled: 1, pushed: 1 },
		});
		expect(mac.body("decisions/host.md", "ompdesk")).toBe("Decided on the host.");
		expect(win.body("decisions/mac.md", "seuput0705-ompdesk")).toBe("Decided on the Mac.");
		expect([...mac.pages.values()].map(p => p.project)).not.toContain("seuput0705-ompdesk");
		expect([...win.pages.values()].map(p => p.project)).not.toContain("ompdesk");
		expect(mac.synced).toMatchObject([{ project: "ompdesk", id: "w1" }]);
		expect(win.synced).toMatchObject([{ project: "seuput0705-ompdesk", id: "m1" }]);

		crossed = 0;
		mac.writes = [];
		win.writes = [];
		expect(await sync.sync("win")).toEqual(QUIET);
		expect(crossed).toBe(0);
		expect(mac.writes).toEqual([]);
		expect(win.writes).toEqual([]);
	});

	it("never files one repository's memory under another repository's project of the same name", async () => {
		// `acme/api` on GitLab there and on GitHub here: two repositories, one folder name.
		win.identities.set("api", "gitlab.com/acme/api");
		mac.identities.set("api", "github.com/acme/api");
		win.edit("decisions/gitlab.md", "GitLab's decision.", "api");
		mac.edit("decisions/github.md", "GitHub's decision.", "api");
		win.capture("w1", "GitLab conclusion.", "api");
		mac.capture("m1", "GitHub conclusion.", "api");

		await sync.sync("win");
		expect(mac.body("decisions/gitlab.md", "api")).toBeUndefined();
		expect(win.body("decisions/github.md", "api")).toBeUndefined();
		expect(mac.synced).toEqual([]);
		expect(win.synced).toEqual([]);
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

	describe("session conclusions", () => {
		const stored = (server: FakeServer) => server.synced.map(row => `${row.origin}:${row.id}`).sort();
		const hostDeps = () => ({ store: win.store, ready: () => win.ready, selfId: () => "win" });

		it("goes both ways, each stored under the computer that captured it", async () => {
			mac.capture("m1", "Mac: the pairing fix is shipped.", "app", "Pairing fix");
			win.capture("w1", "Windows: all tests are green.", "other");

			const report = await sync.sync("win");
			expect(report?.conclusions).toEqual({ pulled: 1, pushed: 1 });
			expect(win.synced).toEqual([
				{
					workspace: "default",
					project: "app",
					id: "m1",
					sessionId: "s-m1",
					title: "Pairing fix",
					body: "Mac: the pairing fix is shipped.",
					at: mac.native[0]?.at,
					origin: "mac",
				},
			]);
			expect(mac.synced).toMatchObject([{ project: "other", id: "w1", origin: "win", sessionId: "s-w1" }]);
			expect(logs.filter(line => line.message === "round")).toEqual([
				expect.objectContaining({ details: expect.objectContaining({ conclusions: { pulled: 1, pushed: 1 } }) }),
			]);
		});

		it("never writes one back to the computer it came from, and later rounds write nothing", async () => {
			mac.capture("m1", "Mac conclusion.");
			win.capture("w1", "Windows conclusion.");
			await sync.sync("win");
			win.conclusionCalls = [];
			mac.conclusionCalls = [];
			conclusionsCrossed = 0;

			for (let round = 0; round < 3; round++) expect(await sync.sync("win")).toEqual(QUIET);
			expect(conclusionsCrossed).toBe(0);
			expect(win.conclusionCalls).toEqual([]);
			expect(mac.conclusionCalls).toEqual([]);
			expect(stored(win)).toEqual(["mac:m1"]);
			expect(stored(mac)).toEqual(["win:w1"]);
		});

		it("passes a third computer's conclusions on, and never offers a computer its own back", async () => {
			win.synced.push({
				workspace: "default",
				project: "app",
				id: "t1",
				sessionId: "s-t1",
				title: "T1",
				body: "From the tablet.",
				at: "2026-10-19T00:00:01Z",
				origin: "tab",
			});
			mac.synced.push({
				workspace: "default",
				project: "app",
				id: "t2",
				sessionId: "s-t2",
				title: "T2",
				body: "Also from the tablet.",
				at: "2026-10-19T00:00:02Z",
				origin: "tab",
			});
			// A conclusion of the Mac's that the host holds, and one of the host's that the Mac holds.
			win.synced.push({
				workspace: "default",
				project: "app",
				id: "m-old",
				sessionId: "s-m",
				title: "M",
				body: "The Mac's own.",
				at: "2026-10-19T00:00:03Z",
				origin: "mac",
			});
			mac.synced.push({
				workspace: "default",
				project: "app",
				id: "w-old",
				sessionId: "s-w",
				title: "W",
				body: "The host's own.",
				at: "2026-10-19T00:00:04Z",
				origin: "win",
			});

			expect((await sync.sync("win"))?.conclusions).toEqual({ pulled: 1, pushed: 1 });
			expect(stored(mac)).toEqual(["tab:t1", "tab:t2", "win:w-old"]);
			expect(stored(win)).toEqual(["mac:m-old", "tab:t1", "tab:t2"]);
			// What it pulled from the host is offered back too (a third computer's row, not the host's own): "same".
			expect(win.conclusionCalls).toEqual([{ project: "app", origin: "tab", ids: ["t2", "t1"] }]);
			expect(mac.conclusionCalls).toEqual([{ project: "app", origin: "tab", ids: ["t1"] }]);
		});

		it("sends many in batches and reads the host's native stream before the ones it holds", async () => {
			for (let index = 0; index < 450; index++) win.capture(`w${index}`, `Host answer ${index}`);
			win.synced.push({
				workspace: "default",
				project: "app",
				id: "t1",
				sessionId: "s-t1",
				title: "T1",
				body: "From the tablet.",
				at: "2026-10-19T00:00:01Z",
				origin: "tab",
			});
			for (let index = 0; index < 430; index++) mac.capture(`m${index}`, `Mac answer ${index}`);

			expect((await sync.sync("win"))?.conclusions).toEqual({ pulled: 451, pushed: 430 });
			expect(mac.synced).toHaveLength(451);
			expect(win.synced.filter(row => row.origin === "mac")).toHaveLength(430);
			expect(await sync.sync("win")).toEqual(QUIET);
		});

		it("redacts a secret on the way out and on receipt, and cuts a long one on a character boundary", async () => {
			mac.capture("m1", `Deployed with ${TOKEN} just now`, "app", `Key ${TOKEN}`);
			win.capture("w1", `The host used ${TOKEN} too`);
			mac.capture("m2", "é".repeat(1500));
			await sync.sync("win");

			for (const row of [...win.synced, ...mac.synced]) {
				expect(`${row.title}\n${row.body}`).not.toContain(TOKEN);
			}
			expect(win.synced.find(row => row.id === "m1")?.body).toBe("Deployed with <token> just now");
			expect(mac.synced[0]?.body).toBe("The host used <token> too");
			const cut = win.synced.find(row => row.id === "m2")?.body ?? "";
			expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(2000);
			expect(cut).toBe("é".repeat(1000));

			// A push that carries one (an older or hostile device) is redacted by the host before it is written.
			const reply = await serveConclusionPush(hostDeps(), "mac", {
				conclusions: [
					{
						workspace: "default",
						project: "app",
						id: "x1",
						sessionId: "s-x",
						title: "t",
						body: `token ${TOKEN}`,
						at: "2026-10-19T00:00:09Z",
						origin: "win",
					},
					{
						workspace: "default",
						project: "app",
						id: "x2",
						sessionId: "s-x",
						title: "t",
						body: `token ${TOKEN}`,
						at: "2026-10-19T00:00:09Z",
						origin: "tab",
					},
				],
			});
			expect(reply).toEqual({ memory: true, results: [{ status: "same" }, { status: "written" }] });
			expect(win.synced.find(row => row.id === "x2")?.body).toBe("token <token>");
			expect(win.synced.some(row => row.id === "x1")).toBe(false);

			// A host that sends one unredacted is not trusted either.
			const hostile = new MemorySync({
				store: mac.store,
				ready: () => true,
				selfId: () => "mac",
				onlineHosts: () => ["win"],
				request: async <T>(_host: string, method: string): Promise<T> => {
					if (method === MEMORY_METHODS.pull) return { memory: true, pages: [], next: null, more: false } as T;
					if (method === MEMORY_METHODS.conclusionsPull)
						return {
							memory: true,
							conclusions: [
								{
									workspace: "default",
									project: "app",
									id: "h1",
									sessionId: "s-h",
									title: `Key ${TOKEN}`,
									body: `leaks ${TOKEN}`,
									at: "2026-10-19T00:00:10Z",
									origin: "win",
								},
							],
							next: { native: 1, synced: 0 },
							more: false,
						} as T;
					return { memory: true, results: [] } as T;
				},
				stateFile: join(dir, "hostile.json"),
				log: () => {},
			});
			await hostile.sync("win");
			hostile.dispose();
			const taken = mac.synced.find(row => row.id === "h1");
			expect(taken?.body).toBe("leaks <token>");
			expect(taken?.title).toBe("Key <token>");
		});

		it("serves nothing and writes nothing while memory is off", async () => {
			win.capture("w1", "Host conclusion.");
			win.ready = false;
			expect(await serveConclusionPull(hostDeps(), "mac", { since: { native: 3, synced: 4 } })).toEqual({
				memory: false,
				conclusions: [],
				next: { native: 3, synced: 4 },
				more: false,
			});
			const push = [
				{
					workspace: "default",
					project: "app",
					id: "x",
					sessionId: "s",
					title: "t",
					body: "b",
					at: "2026-10-19T00:00:09Z",
					origin: "tab",
				},
			];
			expect(await serveConclusionPush(hostDeps(), "mac", { conclusions: push })).toEqual({
				memory: false,
				results: [],
			});
			expect(win.conclusionReads).toBe(0);
			expect(win.conclusionCalls).toEqual([]);

			mac.capture("m1", "Mac conclusion.");
			expect(await sync.sync("win")).toBeNull();
			win.ready = true;
			mac.ready = false;
			expect(await sync.sync("win")).toBeNull();
			expect(mac.conclusionReads + win.conclusionReads).toBe(0);
			expect(mac.conclusionCalls).toEqual([]);
			expect(win.conclusionCalls).toEqual([]);
		});

		it("a conclusion captured after this computer's memory was deleted still reaches the host, once", async () => {
			for (const id of ["m1", "m2", "m3"]) mac.capture(id, `Before the delete ${id}.`);
			await sync.sync("win");
			expect(win.synced).toHaveLength(3);

			mac.replaceStore("db-2");
			mac.capture("m4", "After the delete.");
			expect((await sync.sync("win"))?.conclusions.pushed).toBe(1);
			expect(win.synced.map(row => row.id)).toEqual(["m1", "m2", "m3", "m4"]);

			mac.conclusionCalls = [];
			win.conclusionCalls = [];
			for (let round = 0; round < 3; round++) expect(await sync.sync("win")).toEqual(QUIET);
			expect(win.conclusionCalls).toEqual([]);
			expect(mac.conclusionCalls).toEqual([]);
		});

		it("a conclusion captured after the host's memory was deleted still reaches this computer, once", async () => {
			for (const id of ["w1", "w2", "w3"]) win.capture(id, `Before the delete ${id}.`);
			await sync.sync("win");
			expect(mac.synced).toHaveLength(3);

			win.replaceStore("db-2");
			win.capture("w4", "After the delete.");
			expect((await sync.sync("win"))?.conclusions.pulled).toBe(1);
			expect(mac.synced.map(row => row.id)).toEqual(["w1", "w2", "w3", "w4"]);

			mac.conclusionCalls = [];
			win.conclusionCalls = [];
			for (let round = 0; round < 3; round++) expect(await sync.sync("win")).toEqual(QUIET);
			expect(mac.conclusionCalls).toEqual([]);
			expect(win.conclusionCalls).toEqual([]);
		});

		it("a cursor past the end of its stream on the same database restarts that stream", async () => {
			for (const id of ["m1", "m2", "m3"]) mac.capture(id, `Mac ${id}.`);
			for (const id of ["w1", "w2", "w3"]) win.capture(id, `Host ${id}.`);
			await sync.sync("win");

			// A restored backup rewinds the streams (same database id, fewer rows).
			mac.native.length = 0;
			win.native.length = 0;
			mac.capture("m4", "Mac again.");
			win.capture("w4", "Host again.");
			expect((await sync.sync("win"))?.conclusions).toEqual({ pulled: 1, pushed: 1 });
			expect(win.synced.map(row => row.id)).toEqual(["m1", "m2", "m3", "m4"]);
			expect(mac.synced.map(row => row.id)).toEqual(["w1", "w2", "w3", "w4"]);
			expect(await sync.sync("win")).toEqual(QUIET);
		});

		it("answers a cursor of another database, or past the end, from the start, and names its own database", async () => {
			win.capture("w1", "One.");
			win.capture("w2", "Two.");
			win.synced.push({
				workspace: "default",
				project: "app",
				id: "t1",
				sessionId: "s-t1",
				title: "T",
				body: "Tablet.",
				at: "2026-10-19T00:00:01Z",
				origin: "tab",
			});
			const ids = async (since: { native: number; synced: number; store?: string }) =>
				(await serveConclusionPull(hostDeps(), "mac", { since })).conclusions.map(row => row.id);

			expect(await ids({ native: 2, synced: 1, store: "db-1" })).toEqual([]);
			expect(await ids({ native: 1, synced: 0, store: "db-1" })).toEqual(["w2", "t1"]);
			expect(await ids({ native: 2, synced: 1, store: "db-0" })).toEqual(["w1", "w2", "t1"]);
			expect(await ids({ native: 2, synced: 1 })).toEqual(["w1", "w2", "t1"]);
			expect(await ids({ native: 5, synced: 0, store: "db-1" })).toEqual(["w1", "w2", "t1"]);
			expect(await ids({ native: 2, synced: 7, store: "db-1" })).toEqual(["t1"]);
			expect(
				await serveConclusionPull(hostDeps(), "mac", { since: { native: 2, synced: 1, store: "db-0" } }),
			).toMatchObject({
				next: { native: 2, synced: 1, store: "db-1" },
				more: false,
			});
		});

		it("does not send again after a relaunch", async () => {
			mac.capture("m1", "Mac conclusion.");
			win.capture("w1", "Windows conclusion.");
			await sync.sync("win");
			sync.dispose();
			win.conclusionCalls = [];
			mac.conclusionCalls = [];
			conclusionsCrossed = 0;
			sync = connect(win);

			expect(await sync.sync("win")).toEqual(QUIET);
			expect(conclusionsCrossed).toBe(0);
			expect(win.conclusionCalls).toEqual([]);
			expect(mac.conclusionCalls).toEqual([]);
		});

		it("a conclusion that failed to write is offered again next round, in order", async () => {
			mac.capture("m1", "In app.", "app");
			mac.capture("m2", "In other.", "other");
			mac.capture("m3", "In app again.", "app");
			win.failConclusionOnce.add("m2");

			expect((await sync.sync("win"))?.conclusions.pushed).toBe(2);
			expect(stored(win)).toEqual(["mac:m1", "mac:m3"]);

			expect((await sync.sync("win"))?.conclusions.pushed).toBe(1);
			expect(stored(win)).toEqual(["mac:m1", "mac:m2", "mac:m3"]);
			win.conclusionCalls = [];
			expect(await sync.sync("win")).toEqual(QUIET);
			expect(win.conclusionCalls).toEqual([]);
		});

		it("an older host without the conclusion methods still syncs pages, and is asked again when its link returns", async () => {
			hostMethods = new Set([MEMORY_METHODS.pull, MEMORY_METHODS.push]);
			win.edit("decisions/b.md", "there");
			win.capture("w1", "Windows conclusion.");
			mac.capture("m1", "Mac conclusion.");

			expect(await sync.sync("win")).toMatchObject({ pulled: 1, conclusions: { pulled: 0, pushed: 0 } });
			expect(await sync.sync("win")).toEqual(QUIET);
			expect(mac.body("decisions/b.md")).toBe("there");
			expect(logs.filter(line => line.message === "conclusions-unsupported")).toHaveLength(1);
			expect(logs.filter(line => line.message === "unsupported")).toEqual([]);
			expect(mac.synced).toEqual([]);

			win.edit("decisions/c.md", "page while old");
			expect(await sync.sync("win")).toMatchObject({ pulled: 1 });

			hostMethods = new Set(Object.values(MEMORY_METHODS));
			sync.hostOnline("win");
			await expect.poll(() => [...stored(mac), ...stored(win)]).toEqual(["win:w1", "mac:m1"]);
		});

		it("a server without the conclusion routes fails only that step, and pages still sync", async () => {
			mac.noConclusionRoutes = true;
			win.edit("decisions/b.md", "there");
			mac.edit("decisions/a.md", "here");
			win.capture("w1", "Windows conclusion.");

			expect(await sync.sync("win")).toMatchObject({ pulled: 1, pushed: 1, conclusions: { pulled: 0, pushed: 0 } });
			expect(mac.body("decisions/b.md")).toBe("there");
			expect(win.body("decisions/a.md")).toBe("here");
			expect(logs.filter(line => line.message === "failed")).toEqual([
				expect.objectContaining({ details: expect.objectContaining({ step: "conclusions" }) }),
			]);

			mac.noConclusionRoutes = false;
			expect((await sync.sync("win"))?.conclusions.pulled).toBe(1);
			expect(stored(mac)).toEqual(["win:w1"]);
		});

		it("skips a conclusion that cannot cross, and goes on past it", async () => {
			win.native.push({
				workspace: "default",
				project: "app",
				id: "bad id",
				sessionId: "s-bad",
				title: "t",
				body: "whitespace in the id",
				at: "2026-10-19T00:00:05Z",
			});
			win.capture("w2", "Good one.");
			expect((await sync.sync("win"))?.conclusions.pulled).toBe(1);
			expect(stored(mac)).toEqual(["win:w2"]);
			expect(await sync.sync("win")).toEqual(QUIET);
		});
	});

	it("hashes what a page holds, not where it came from or when", () => {
		const a = page("decisions/a.md", "body");
		const copied: MemoryPageCopy = { ...a, origin: "win", updatedAt: "2026-10-19T00:00:00Z", pinned: true };
		expect(pageHash(a)).toBe(pageHash(copied));
		expect(pageHash(a)).not.toBe(pageHash({ ...a, body: "other" }));
		expect(pageHash({ ...a, tags: ["b", "a"] })).toBe(pageHash({ ...a, tags: ["a", "b"] }));
	});
});
