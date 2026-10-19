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
});
