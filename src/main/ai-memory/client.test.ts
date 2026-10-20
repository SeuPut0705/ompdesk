import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { AiMemoryClient, DEFAULT_SERVER_URL, plainSnippet, serverUrlFromConfig } from "./client";

const URL_BASE = "http://127.0.0.1:49374";

describe("serverUrlFromConfig", () => {
	it("prefers server_url, then bind, then the default", () => {
		expect(serverUrlFromConfig('server_url = "http://127.0.0.1:5000/"\nbind = "127.0.0.1:6000"\n')).toBe(
			"http://127.0.0.1:5000",
		);
		expect(serverUrlFromConfig('[server]\nbind = "127.0.0.1:49374"\n')).toBe(URL_BASE);
		expect(serverUrlFromConfig('# bind = "x"\nname = "y"')).toBe(DEFAULT_SERVER_URL);
		expect(serverUrlFromConfig(null)).toBe(DEFAULT_SERVER_URL);
		expect(serverUrlFromConfig("")).toBe(DEFAULT_SERVER_URL);
	});
});

describe("plainSnippet", () => {
	it("strips <mark> tags and nothing else", () => {
		expect(plainSnippet("the <mark>codename</mark> is <b>x</b> <mark>y</mark>")).toBe("the codename is <b>x</b> y");
	});
});

interface Call {
	url: string;
	authorization: string | undefined;
}

describe("AiMemoryClient", () => {
	let dataDir: string;
	let calls: Call[];
	let routes: Record<string, () => Response>;
	let client: AiMemoryClient;

	const json =
		(body: unknown, status = 200) =>
		() =>
			Response.json(body, { status });

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "ai-memory-client-"));
		await mkdir(join(dataDir, "auth-tokens"));
		await writeFile(join(dataDir, "auth-tokens", "default"), "secret-token\n");
		calls = [];
		routes = {};
		client = new AiMemoryClient({
			url: () => URL_BASE,
			dataDir: () => dataDir,
			fetch: async (url, init) => {
				const headers = new Headers(init.headers);
				calls.push({ url, authorization: headers.get("authorization") ?? undefined });
				const route = routes[url.slice(URL_BASE.length)];
				if (!route) throw new TypeError(`unexpected ${url}`);
				return route();
			},
		});
	});

	afterEach(async () => {
		await rm(dataDir, RM_TEMP);
	});

	it("reads the token from the data dir, trimmed, and null before init wrote it", async () => {
		expect(await client.token()).toBe("secret-token");
		const empty = new AiMemoryClient({ url: () => URL_BASE, dataDir: () => join(dataDir, "nope") });
		expect(await empty.token()).toBeNull();
		expect(await new AiMemoryClient({ url: () => URL_BASE, dataDir: () => null }).token()).toBeNull();
	});

	it("healthy is true on 200, false on non-2xx, network failure and an unknown url", async () => {
		routes["/healthz"] = json({ ok: true });
		expect(await client.healthy()).toBe(true);
		routes["/healthz"] = json({}, 503);
		expect(await client.healthy()).toBe(false);
		delete routes["/healthz"];
		expect(await client.healthy()).toBe(false);
		expect(await new AiMemoryClient({ url: () => null, dataDir: () => dataDir }).healthy()).toBe(false);
		// /healthz needs no token.
		expect(calls[0]?.authorization).toBeUndefined();
	});

	it("maps /admin/status and sends the bearer token", async () => {
		routes["/admin/status"] = json({
			version: "3.1.1",
			counts: { pages_latest: 7, sessions: 3, observations: 120 },
			storage: { database_bytes: 4096 },
		});
		expect(await client.status()).toEqual({
			version: "3.1.1",
			pages: 7,
			sessions: 3,
			observations: 120,
			diskBytes: 4096,
		});
		expect(calls[0]).toEqual({ url: `${URL_BASE}/admin/status`, authorization: "Bearer secret-token" });
	});

	it("status is null when the server is down or answers an error, and tolerates a sparse body", async () => {
		expect(await client.status()).toBeNull();
		routes["/admin/status"] = json({}, 500);
		expect(await client.status()).toBeNull();
		routes["/admin/status"] = json({});
		expect(await client.status()).toEqual({ version: null, pages: 0, sessions: 0, observations: 0, diskBytes: 0 });
	});

	it("lists projects newest first", async () => {
		routes["/api/v1/projects"] = json([
			{ workspace_name: "w", project_name: "old", page_count: 1, last_updated: "2026-01-01T00:00:00Z" },
			{ workspace_name: "w", project_name: "new", page_count: 4, last_updated: "2026-03-01T00:00:00Z" },
			{ workspace_name: "w", project_name: "never", page_count: "x" },
		]);
		expect(await client.projects()).toEqual([
			{ workspace: "w", project: "new", pages: 4, lastUpdated: "2026-03-01T00:00:00Z" },
			{ workspace: "w", project: "old", pages: 1, lastUpdated: "2026-01-01T00:00:00Z" },
			{ workspace: "w", project: "never", pages: 0, lastUpdated: null },
		]);
	});

	it("searches with the query, an optional project, and strips <mark> from the snippet", async () => {
		routes["/api/v1/search?q=code+name&limit=30&workspace=my+ws&project=a%2Fb"] = json([
			{
				workspace: "my ws",
				project: "a/b",
				path: "sessions/s1.md",
				title: "S1",
				updated_at: "2026-02-02T00:00:00Z",
				snippet: "the <mark>code</mark> <mark>name</mark>",
			},
		]);
		expect(await client.search("  code name ", { workspace: "my ws", project: "a/b" })).toEqual([
			{
				workspace: "my ws",
				project: "a/b",
				path: "sessions/s1.md",
				title: "S1",
				kind: undefined,
				tier: null,
				updatedAt: "2026-02-02T00:00:00Z",
				snippet: "the code name",
			},
		]);
	});

	it("an empty query reads nothing", async () => {
		expect(await client.search("   ")).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("reads a project's recent pages and URL-encodes the workspace and project segments", async () => {
		routes["/api/v1/workspaces/my%20ws/projects/a%2Fb%3F/recent"] = json([
			{ path: "decisions/0007-db.md", title: "DB", kind: "decision", tier: "t", updated_at: "2026-02-01T00:00:00Z" },
		]);
		expect(await client.recent({ workspace: "my ws", project: "a/b?" })).toEqual([
			{
				workspace: "my ws",
				project: "a/b?",
				path: "decisions/0007-db.md",
				title: "DB",
				kind: "decision",
				tier: "t",
				updatedAt: "2026-02-01T00:00:00Z",
			},
		]);
	});

	it("merges the recent pages of every project newest first and caps the list", async () => {
		const projects = Array.from({ length: 14 }, (_, index) => ({
			workspace_name: "w",
			project_name: `p${String(index).padStart(2, "0")}`,
			page_count: 3,
			// p13 is the newest project.
			last_updated: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
		}));
		routes["/api/v1/projects"] = json(projects);
		for (const project of projects) {
			routes[`/api/v1/workspaces/w/projects/${project.project_name}/recent`] = json(
				[0, 1, 2].map(page => ({
					path: `p/${page}.md`,
					title: `${project.project_name}-${page}`,
					updated_at: `${project.last_updated.slice(0, 10)}T0${page}:00:00Z`,
				})),
			);
		}
		const merged = await client.recentEverywhere();
		expect(merged).toHaveLength(20);
		expect(merged[0]?.title).toBe("p13-2");
		const times = merged.map(page => page.updatedAt ?? "");
		expect(times).toEqual([...times].sort().reverse());
		// Only the 12 newest projects are read: p00 and p01 never are.
		expect(calls.some(call => call.url.includes("/projects/p00/"))).toBe(false);
		expect(calls.some(call => call.url.includes("/projects/p01/"))).toBe(false);
		expect(calls.some(call => call.url.includes("/projects/p02/"))).toBe(true);
	});

	it("one project failing does not drop the others from the merged list", async () => {
		routes["/api/v1/projects"] = json([
			{ workspace_name: "w", project_name: "ok", page_count: 1, last_updated: "2026-01-02T00:00:00Z" },
			{ workspace_name: "w", project_name: "bad", page_count: 1, last_updated: "2026-01-01T00:00:00Z" },
		]);
		routes["/api/v1/workspaces/w/projects/ok/recent"] = json([
			{ path: "a.md", title: "A", updated_at: "2026-01-02T00:00:00Z" },
		]);
		routes["/api/v1/workspaces/w/projects/bad/recent"] = json({}, 500);
		expect((await client.recentEverywhere()).map(page => page.title)).toEqual(["A"]);
	});

	it("maps handoffs of one project and merges them across projects newest first", async () => {
		routes["/api/v1/workspaces/w/projects/p/handoffs"] = json({
			handoffs: [{ id: "h1", agent: "omp", at: "2026-02-01T00:00:00Z", state: "open", summary: "Did X", extra: 1 }],
		});
		expect(await client.handoffs({ workspace: "w", project: "p" })).toEqual([
			{
				workspace: "w",
				project: "p",
				id: "h1",
				agent: "omp",
				createdAt: "2026-02-01T00:00:00Z",
				summary: "Did X",
				openQuestions: [],
				nextSteps: [],
				state: "open",
			},
		]);
		routes["/api/v1/projects"] = json([
			{ workspace_name: "w", project_name: "p", page_count: 1, last_updated: "2026-02-01T00:00:00Z" },
			{ workspace_name: "w", project_name: "q", page_count: 1, last_updated: "2026-01-01T00:00:00Z" },
		]);
		routes["/api/v1/workspaces/w/projects/q/handoffs"] = json({
			handoffs: [{ id: "h2", agent: "omp", at: "2026-03-01T00:00:00Z", state: "accepted", summary: "Y" }],
		});
		expect((await client.handoffs()).map(handoff => handoff.id)).toEqual(["h2", "h1"]);
	});

	it("reads a page, encoding each path segment but keeping the slashes", async () => {
		routes["/api/v1/workspaces/w/projects/p/pages/sessions/a%20b%23c.md"] = json({
			title: "Page",
			updated_at: "2026-02-01T00:00:00Z",
			body_markdown: "# Hello",
		});
		expect(await client.page({ workspace: "w", project: "p", path: "sessions/a b#c.md" })).toEqual({
			workspace: "w",
			project: "p",
			path: "sessions/a b#c.md",
			title: "Page",
			updatedAt: "2026-02-01T00:00:00Z",
			kind: undefined,
			tier: null,
			markdown: "# Hello",
			id: "",
			pinned: false,
			createdAt: null,
			tags: [],
		});
	});

	it("a page without a title falls back to its path", async () => {
		routes["/api/v1/workspaces/w/projects/p/pages/x.md"] = json({ body_markdown: "b" });
		expect((await client.page({ workspace: "w", project: "p", path: "x.md" })).title).toBe("x.md");
	});

	it("says Memory answered <status> for a non-2xx and 'not running' for a network failure or no url", async () => {
		routes["/api/v1/projects"] = json({}, 401);
		await expect(client.projects()).rejects.toThrow("Memory answered 401");
		delete routes["/api/v1/projects"];
		await expect(client.projects()).rejects.toThrow("Memory is not running");
		const offline = new AiMemoryClient({ url: () => null, dataDir: () => dataDir });
		await expect(offline.projects()).rejects.toThrow("Memory is not running");
	});

	it("sends no authorization header before a token exists", async () => {
		routes["/api/v1/projects"] = json([]);
		const tokenless = new AiMemoryClient({
			url: () => URL_BASE,
			dataDir: () => join(dataDir, "none"),
			fetch: async (url, init) => {
				calls.push({ url, authorization: new Headers(init.headers).get("authorization") ?? undefined });
				return Response.json([]);
			},
		});
		await tokenless.projects();
		expect(calls[0]?.authorization).toBeUndefined();
	});
});

interface Sent {
	path: string;
	method: string;
	body: unknown;
	headers: Headers;
}

describe("AiMemoryClient (Memory page)", () => {
	let dataDir: string;
	let sent: Sent[];
	let routes: Record<string, (body: unknown) => Response>;
	let client: AiMemoryClient;
	const PROJECT = { workspace: "w", project: "p" };
	const BASE = "/api/v1/workspaces/w/projects/p";

	const json =
		(body: unknown, status = 200) =>
		() =>
			Response.json(body, { status });
	const mcp = (payload: unknown) =>
		json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "ai-memory-page-client-"));
		await mkdir(join(dataDir, "auth-tokens"));
		await writeFile(join(dataDir, "auth-tokens", "default"), "tok\n");
		sent = [];
		routes = {};
		client = new AiMemoryClient({
			url: () => URL_BASE,
			dataDir: () => dataDir,
			fetch: async (url, init) => {
				const path = url.slice(URL_BASE.length);
				const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
				sent.push({ path, method: init.method ?? "GET", body, headers: new Headers(init.headers) });
				const route = routes[path];
				if (!route) throw new TypeError(`unexpected ${url}`);
				return route(body);
			},
		});
	});

	afterEach(async () => {
		await rm(dataDir, RM_TEMP);
	});

	it("lists a project's pages with kind and tier, newest first", async () => {
		routes[`${BASE}/pages`] = json([
			{ path: "a.md", title: "A", kind: "note", tier: "semantic", updated_at: "2026-10-01T00:00:00Z" },
			{ path: "b.md", title: "B", updated_at: "2026-10-02T00:00:00Z" },
		]);
		expect(await client.pages(PROJECT)).toEqual([
			{ ...PROJECT, path: "b.md", title: "B", kind: undefined, tier: null, updatedAt: "2026-10-02T00:00:00Z" },
			{ ...PROJECT, path: "a.md", title: "A", kind: "note", tier: "semantic", updatedAt: "2026-10-01T00:00:00Z" },
		]);
	});

	it("search fills tier and time from the pages of the projects the hits sit in, and survives a failing list", async () => {
		routes["/api/v1/search?q=x&limit=30"] = json([
			{ workspace: "w", project: "p", path: "a.md", title: "A", kind: "note", snippet: "<mark>x</mark> y" },
			{ workspace: "w", project: "gone", path: "z.md", title: "Z", snippet: "" },
		]);
		routes[`${BASE}/pages`] = json([
			{ path: "a.md", title: "A", kind: "note", tier: "semantic", updated_at: "2026-10-01T00:00:00Z" },
		]);
		const hits = await client.search("x");
		expect(hits[0]).toMatchObject({
			path: "a.md",
			tier: "semantic",
			updatedAt: "2026-10-01T00:00:00Z",
			snippet: "x y",
		});
		expect(hits[1]).toMatchObject({ path: "z.md", tier: null, updatedAt: null });
	});

	it("maps the project overview", async () => {
		routes[`${BASE}/overview?limit=1`] = json({
			briefing: {
				counts: { pages_latest: 4, sessions: 2, observations: 17 },
				activity_7d: { sessions: 1, observations: 9, pages_updated: 3 },
				last_observation_at: "2026-10-18T10:00:00Z",
				pending_handoff_count: 2,
			},
			health: { stale: 1, duplicates: 2, contradictions: 0, orphans: 3 },
		});
		expect(await client.overview(PROJECT)).toEqual({
			pages: 4,
			sessions: 2,
			observations: 17,
			lastCaptureAt: "2026-10-18T10:00:00Z",
			openHandoffs: 2,
			activity7d: { sessions: 1, observations: 9, pagesUpdated: 3 },
			health: { stale: 1, duplicates: 2, contradictions: 0, orphans: 3 },
		});
		routes[`${BASE}/overview?limit=1`] = json({});
		expect((await client.overview(PROJECT)).lastCaptureAt).toBeNull();
	});

	it("lists sessions and reads one session's observations by offset", async () => {
		routes[`${BASE}/sessions?limit=30&include_open=true`] = json({
			sessions: [
				{
					session_id: "s1",
					cwd: "/a/b",
					agent_kind: "omp",
					started_at: "t0",
					ended_at: null,
					observation_count: 60,
					consolidation: { state: "failed", attempts: 2 },
				},
			],
		});
		expect(await client.sessions(PROJECT)).toEqual([
			{
				id: "s1",
				cwd: "/a/b",
				agent: "omp",
				startedAt: "t0",
				endedAt: null,
				observations: 60,
				consolidation: "failed",
			},
		]);
		routes[`${BASE}/sessions/s%2F1/observations?limit=50&offset=50&body_max_chars=2000`] = json({
			session: { session_id: "s/1", observation_count: 60 },
			observations: [{ id: "o1", kind: "user-prompt", title: "Prompt", body: "hi", created_at: "t1" }],
			total: 60,
			offset: 50,
		});
		const page = await client.observations(PROJECT, "s/1", 50);
		expect(page.total).toBe(60);
		expect(page.offset).toBe(50);
		expect(page.observations).toEqual([
			{ id: "o1", kind: "user-prompt", title: "Prompt", body: "hi", createdAt: "t1" },
		]);
	});

	it("reads the profile status and entries", async () => {
		routes["/admin/profile/status"] = json({
			enabled: "auto",
			effective_share: "global",
			inject_on_session_start: true,
			digest_bytes: 120,
		});
		routes["/admin/profile/list"] = json({
			scope: { workspace: "default", project: "_global" },
			entries: [
				{
					path: "profile/tools/pnpm.md",
					category: "tools",
					statement: "Use pnpm.",
					applies_to: ["javascript"],
					enforced_by: null,
				},
			],
		});
		expect(await client.profile()).toEqual({
			enabled: true,
			injected: true,
			digestBytes: 120,
			scope: { workspace: "default", project: "_global" },
			entries: [
				{
					path: "profile/tools/pnpm.md",
					category: "tools",
					statement: "Use pnpm.",
					appliesTo: ["javascript"],
					enforcedBy: null,
				},
			],
		});
		routes["/admin/profile/status"] = json({ enabled: "off", effective_share: "off" });
		routes["/admin/profile/list"] = json({ scope: null, entries: [] });
		expect(await client.profile()).toMatchObject({ enabled: false, scope: null, entries: [] });
	});

	it("lint is a dry rule-based run; sweep passes dry_run and counts what it reports", async () => {
		routes["/admin/lint"] = json({
			findings: [{ kind: "duplicate", severity: "warning", message: "m", pages: ["a.md"] }],
		});
		expect(await client.lint(PROJECT)).toEqual([
			{ kind: "duplicate", severity: "warning", message: "m", pages: ["a.md"] },
		]);
		expect(sent.at(-1)).toMatchObject({ method: "POST", body: { ...PROJECT, dry_run: true, no_llm: true } });
		routes["/admin/forget-sweep"] = json({
			dry_run: true,
			candidates_evaluated: 9,
			evicted: [{}, {}],
			compacted: [],
			merged: [{}],
			expired: [],
			observations_prunable: 5,
			observations_pruned: 0,
		});
		expect(await client.sweep(PROJECT, true)).toEqual({
			dryRun: true,
			evaluated: 9,
			evicted: 2,
			compacted: 0,
			merged: 1,
			expired: 0,
			observationsPruned: 5,
		});
		expect(sent.at(-1)?.body).toEqual({ ...PROJECT, dry_run: true });
		routes["/admin/forget-sweep"] = json({
			dry_run: false,
			candidates_evaluated: 9,
			evicted: [{}],
			observations_prunable: 5,
			observations_pruned: 4,
		});
		expect((await client.sweep(PROJECT, false)).observationsPruned).toBe(4);
	});

	it("writePage posts the body with only the fields it was given, with the bearer token", async () => {
		routes["/admin/write-page"] = json({ page_id: "id" });
		await client.writePage({
			...PROJECT,
			path: "notes/a.md",
			body: "text",
			title: "A",
			kind: "note",
			tier: "semantic",
			tags: ["t"],
			pinned: true,
		});
		expect(sent.at(-1)).toMatchObject({
			path: "/admin/write-page",
			method: "POST",
			body: {
				...PROJECT,
				path: "notes/a.md",
				body: "text",
				title: "A",
				kind: "note",
				tier: "semantic",
				tags: ["t"],
				pinned: true,
			},
		});
		expect(sent.at(-1)?.headers.get("authorization")).toBe("Bearer tok");
		expect(sent.at(-1)?.headers.get("content-type")).toBe("application/json");
		await client.writePage({ ...PROJECT, path: "notes/a.md", body: "text" });
		expect(sent.at(-1)?.body).toEqual({ ...PROJECT, path: "notes/a.md", body: "text" });
	});

	it("deletePage returns the pre-delete checkpoint, else the head checkpoint, else fails", async () => {
		routes["/admin/checkpoints?limit=1"] = json([{ oid: "head1" }]);
		routes["/admin/delete-page"] = json({ path: "a.md", deleted: true, pre_checkpoint: "pre1" });
		const first = await client.deletePage({ ...PROJECT, path: "a.md", title: "A" });
		expect(first).toMatchObject({ ...PROJECT, path: "a.md", title: "A", rev: "pre1" });
		expect(sent.at(-1)?.body).toEqual({ ...PROJECT, path: "a.md" });
		routes["/admin/delete-page"] = json({ path: "a.md", deleted: true });
		expect((await client.deletePage({ ...PROJECT, path: "a.md" })).rev).toBe("head1");
		routes["/admin/checkpoints?limit=1"] = json([]);
		await expect(client.deletePage({ ...PROJECT, path: "a.md" })).rejects.toThrow("no checkpoint");
	});

	it("restorePage posts the revision", async () => {
		routes["/admin/restore-page"] = json({ page_id: "x" });
		await client.restorePage({ ...PROJECT, path: "a.md" }, "rev9");
		expect(sent.at(-1)?.body).toEqual({ ...PROJECT, path: "a.md", rev: "rev9" });
	});

	it("feedback and cancelHandoff are MCP tools/call requests", async () => {
		routes["/mcp"] = mcp({ ok: true });
		await client.feedback({ ...PROJECT, path: "a.md" }, "helpful");
		expect(sent.at(-1)?.headers.get("accept")).toContain("text/event-stream");
		expect(sent.at(-1)?.body).toMatchObject({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: "memory_feedback", arguments: { ...PROJECT, path: "a.md", signal: "helpful" } },
		});
		routes["/mcp"] = mcp({ handoff_id: "h-1", cancelled: true, state: "expired" });
		await client.cancelHandoff(PROJECT, "h-1");
		expect(sent.at(-1)?.body).toMatchObject({
			params: { name: "memory_handoff_cancel", arguments: { ...PROJECT, handoff_id: "h-1" } },
		});
		routes["/mcp"] = mcp({ handoff_id: "h-1", cancelled: false, state: "accepted" });
		await expect(client.cancelHandoff(PROJECT, "h-1")).rejects.toThrow("no longer open");
	});

	it("surfaces a JSON-RPC error, a tool error and the server's error text", async () => {
		routes["/mcp"] = json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "page not found" } });
		await expect(client.feedback({ ...PROJECT, path: "a.md" }, "helpful")).rejects.toThrow("page not found");
		routes["/mcp"] = json({
			jsonrpc: "2.0",
			id: 1,
			result: { isError: true, content: [{ type: "text", text: "nope" }] },
		});
		await expect(client.feedback({ ...PROJECT, path: "a.md" }, "helpful")).rejects.toThrow("nope");
		routes["/admin/write-page"] = json({ error: "path escapes the wiki" }, 400);
		await expect(client.writePage({ ...PROJECT, path: "x", body: "y" })).rejects.toThrow("path escapes the wiki");
		routes["/admin/write-page"] = json({}, 500);
		await expect(client.writePage({ ...PROJECT, path: "x", body: "y" })).rejects.toThrow("answered 500");
	});

	it("retirePage writes the page back expired now, its metadata kept, tagged superseded and naming its successor", async () => {
		const at = new Date("2026-10-19T12:00:00Z");
		routes[`${BASE}/pages/decisions/jev-auto.md`] = json({
			id: "pg-1",
			tier: "semantic",
			kind: "decision",
			pinned: false,
			body_markdown: "# Jev는 자동으로 최신\n\n본문\n",
			frontmatter: {
				title: "Jev는 자동으로 최신",
				kind: "decision",
				abstract: "요약",
				entities: ["jev"],
				relations: { fixes: ["gotchas/x.md"], "see-also": ["notes/y.md"] },
				tags: ["judge"],
				last_modified_by: "someone",
			},
		});
		routes["/mcp"] = mcp({ page_id: "pg-2" });
		expect(
			await client.retirePage({ ...PROJECT, path: "decisions/jev-auto.md", successor: "decisions/jev-1-14.md", at }),
		).toBe("retired");
		expect(sent.at(-1)?.body).toMatchObject({
			params: {
				name: "memory_write_page",
				arguments: {
					...PROJECT,
					path: "decisions/jev-auto.md",
					body: "# Jev는 자동으로 최신\n\n본문\n\n_Superseded by [[decisions/jev-1-14.md]] on 2026-10-19 (memory upkeep)._\n",
					tier: "semantic",
					title: "Jev는 자동으로 최신",
					kind: "decision",
					abstract: "요약",
					entities: ["jev"],
					relations: { fixes: ["gotchas/x.md"] },
					tags: ["judge", "superseded"],
					expires_at: "2026-10-19T12:00:00.000Z",
					expected_page_id: "pg-1",
				},
			},
		});
	});

	it("retirePage without a successor names the reason and tags the page retired", async () => {
		const at = new Date("2026-10-20T08:00:00Z");
		routes[`${BASE}/pages/decisions/pairing.md`] = json({
			id: "pg-1",
			body_markdown: "# 페어링 코드\n",
			frontmatter: { title: "페어링 코드", tags: ["remote"] },
		});
		routes["/mcp"] = mcp({ page_id: "pg-2" });
		expect(
			await client.retirePage({
				...PROJECT,
				path: "decisions/pairing.md",
				reason: "names files  that are gone",
				at,
			}),
		).toBe("retired");
		expect(sent.at(-1)?.body).toMatchObject({
			params: {
				arguments: {
					body: "# 페어링 코드\n\n_Retired on 2026-10-20 (memory upkeep): names files that are gone._\n",
					tags: ["remote", "retired"],
					expires_at: "2026-10-20T08:00:00.000Z",
				},
			},
		});
	});

	it("retirePage leaves a pinned page alone and says when the page is not the version the caller judged", async () => {
		const ref = { ...PROJECT, path: "a.md", successor: "b.md", at: new Date() };
		routes[`${BASE}/pages/a.md`] = json({ id: "pg-1", pinned: true, body_markdown: "# A", frontmatter: {} });
		expect(await client.retirePage(ref)).toBe("pinned");
		routes[`${BASE}/pages/a.md`] = json({ id: "pg-2", body_markdown: "# A", frontmatter: {} });
		expect(await client.retirePage({ ...ref, expectedPageId: "pg-1" })).toBe("changed");
		expect(sent.some(call => call.path === "/mcp")).toBe(false);
		routes["/mcp"] = json({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32602, message: "precondition failed for a.md: expected pg-2, found pg-3" },
		});
		expect(await client.retirePage({ ...ref, expectedPageId: "pg-2" })).toBe("changed");
	});

	it("createPage writes create_only, with the session as evidence only when it is given", async () => {
		routes["/mcp"] = mcp({ page_id: "pg-1" });
		const page = { ...PROJECT, path: "decisions/x.md", body: "# X", tier: "semantic", kind: "decision" };
		expect(await client.createPage({ ...page, sessionId: "s-1" })).toBe(true);
		expect(sent.at(-1)?.body).toMatchObject({
			params: { arguments: { ...page, create_only: true, session_id: "s-1" } },
		});
		await client.createPage({ ...page, workspace: "default", project: "_global" });
		expect(sent.at(-1)?.body).toMatchObject({ params: { arguments: { project: "_global", create_only: true } } });
		expect(sent.at(-1)?.body).not.toHaveProperty("params.arguments.session_id");
		routes["/mcp"] = json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "precondition failed for x" } });
		expect(await client.createPage(page)).toBe(false);
	});

	it("a page copy carries what the write path takes, and its origin only when given one", async () => {
		routes[`${BASE}/pages/decisions/sharing%20plan.md`] = json({
			id: "pg-7",
			title: "Sharing",
			kind: "decision",
			tier: "semantic",
			pinned: true,
			updated_at: "2026-10-19T10:00:00Z",
			body_markdown: "# Sharing\n\nTailscale identity only.",
			frontmatter: {
				tags: ["remote"],
				entities: ["tailscale"],
				abstract: "Who may connect.",
				relations: { supersedes: ["decisions/codes.md"], fixes: [] },
				origin_device: "mac-1",
				last_modified_by: "someone",
			},
		});
		const copy = await client.pageCopy({ ...PROJECT, path: "decisions/sharing plan.md" });
		expect(copy).toEqual({
			...PROJECT,
			path: "decisions/sharing plan.md",
			title: "Sharing",
			kind: "decision",
			tier: "semantic",
			body: "# Sharing\n\nTailscale identity only.",
			tags: ["remote"],
			pinned: true,
			metadata: {
				entities: ["tailscale"],
				abstract: "Who may connect.",
				relations: { supersedes: ["decisions/codes.md"] },
			},
			origin: "mac-1",
			id: "pg-7",
			updatedAt: "2026-10-19T10:00:00Z",
		});
		routes["/admin/write-page"] = json({ page_id: "id" });
		expect(await client.writePageCopy(copy, "mac-1", "pg-7")).toBe(true);
		expect(sent.at(-1)?.body).toEqual({
			...PROJECT,
			path: "decisions/sharing plan.md",
			body: "# Sharing\n\nTailscale identity only.",
			title: "Sharing",
			kind: "decision",
			tier: "semantic",
			tags: ["remote"],
			pinned: true,
			entities: ["tailscale"],
			abstract: "Who may connect.",
			relations: { supersedes: ["decisions/codes.md"] },
			origin_device: "mac-1",
			expected_page_id: "pg-7",
		});
		await client.writePageCopy(copy, undefined, null);
		expect(sent.at(-1)?.body).not.toHaveProperty("origin_device");
		expect(sent.at(-1)?.body).toMatchObject({ create_only: true });
		expect(sent.at(-1)?.body).not.toHaveProperty("expected_page_id");
		// The page moved on between the read and the write: nothing written, false, not an error.
		routes["/admin/write-page"] = json({ error: "precondition failed for decisions/x.md: latest is pg-8" }, 409);
		expect(await client.writePageCopy(copy, undefined, "pg-7")).toBe(false);
		routes["/admin/write-page"] = json({}, 500);
		await expect(client.writePageCopy(copy, undefined, "pg-7")).rejects.toThrow("answered 500");
	});

	it("a retired page's copy carries its expiry both ways, and the full list asks for expired pages too", async () => {
		routes[`${BASE}/pages/decisions/old.md`] = json({
			title: "Old",
			tier: "semantic",
			body_markdown: "Old.\n\n_Superseded by [[decisions/new.md]]._",
			frontmatter: { tags: ["superseded"], expires_at: "2026-10-19T12:00:00Z" },
		});
		const copy = await client.pageCopy({ ...PROJECT, path: "decisions/old.md" });
		expect(copy.expiresAt).toBe("2026-10-19T12:00:00Z");
		routes["/admin/write-page"] = json({ page_id: "id" });
		await client.writePageCopy(copy, "win-1", null);
		expect(sent.at(-1)?.body).toMatchObject({ expires_at: "2026-10-19T12:00:00Z", origin_device: "win-1" });

		routes[`${BASE}/pages?include_expired=true`] = json([{ path: "decisions/old.md", title: "Old" }]);
		expect((await client.allPages(PROJECT)).map(page => page.path)).toEqual(["decisions/old.md"]);
	});

	it("reads a conclusion stream after a cursor and parses its rows, the origin only on synced ones", async () => {
		routes["/admin/conclusions?source=native&after=0&limit=200"] = json({
			conclusions: [
				{
					seq: 4,
					workspace: "w",
					project: "p",
					id: "obs-1",
					session_id: "s-1",
					title: "Sharing plan",
					body: "Done: Tailscale identity only.",
					created_at: "2026-10-19T10:00:00Z",
				},
			],
			next: 4,
			more: true,
			store: "db-1",
			last: 9,
		});
		expect(await client.conclusions("native", 0, 200)).toEqual({
			rows: [
				{
					seq: 4,
					...PROJECT,
					id: "obs-1",
					sessionId: "s-1",
					title: "Sharing plan",
					body: "Done: Tailscale identity only.",
					at: "2026-10-19T10:00:00Z",
				},
			],
			next: 4,
			more: true,
			store: "db-1",
			last: 9,
		});
		expect(sent.at(-1)?.method).toBe("GET");
		routes["/admin/conclusions?source=synced&after=9&limit=5"] = json({
			conclusions: [
				{
					seq: 10,
					workspace: "w",
					project: "p",
					id: "o-2",
					session_id: "s-2",
					title: "T",
					body: "B",
					created_at: "2026-10-19T11:00:00Z",
					origin_device: "win-1",
				},
			],
			next: 10,
			more: false,
			store: "db-1",
			last: 10,
		});
		const synced = await client.conclusions("synced", 9, 5);
		expect(synced.rows[0]?.origin).toBe("win-1");
		routes["/admin/conclusions?source=synced&after=10&limit=5"] = json({
			conclusions: [],
			next: 10,
			more: false,
			store: "db-2",
			last: 3,
		});
		expect(await client.conclusions("synced", 10, 5)).toEqual({
			rows: [],
			next: 10,
			more: false,
			store: "db-2",
			last: 3,
		});
		// A server that does not name its database or its last seq: no store, nothing ever above its end.
		routes["/admin/conclusions?source=native&after=2&limit=5"] = json({ conclusions: [], next: 2, more: false });
		expect(await client.conclusions("native", 2, 5)).toMatchObject({ store: "", last: 2 });
		routes["/admin/conclusions?source=native&after=7&limit=5"] = json({ conclusions: [] });
		expect((await client.conclusions("native", 7, 5)).next).toBe(7);
		routes["/admin/conclusions?source=native&after=8&limit=5"] = json({ error: "not found" }, 404);
		await expect(client.conclusions("native", 8, 5)).rejects.toThrow("not found");
	});

	it("writes conclusions with their origin and answers one status per item", async () => {
		routes["/admin/write-conclusions"] = json({
			results: [
				{ id: "a", status: "written" },
				{ id: "b", status: "same" },
				{ id: "c", status: "skipped" },
			],
		});
		const item = (id: string) => ({
			id,
			sessionId: "s-1",
			title: "T",
			body: "Body",
			at: "2026-10-19T10:00:00Z",
		});
		expect(await client.writeConclusions(PROJECT, "mac-1", [item("a"), item("b"), item("c")])).toEqual([
			"written",
			"same",
			"skipped",
		]);
		expect(sent.at(-1)?.method).toBe("POST");
		expect(sent.at(-1)?.body).toEqual({
			...PROJECT,
			origin_device: "mac-1",
			conclusions: ["a", "b", "c"].map(id => ({
				id,
				session_id: "s-1",
				title: "T",
				body: "Body",
				created_at: "2026-10-19T10:00:00Z",
			})),
		});
		routes["/admin/write-conclusions"] = json({ results: [{ id: "a", status: "written" }] });
		await expect(client.writeConclusions(PROJECT, "mac-1", [item("a"), item("b")])).rejects.toThrow("unknown");
		routes["/admin/write-conclusions"] = json({ error: "invalid conclusion" }, 422);
		await expect(client.writeConclusions(PROJECT, "mac-1", [item("a")])).rejects.toThrow("invalid conclusion");
	});
});
