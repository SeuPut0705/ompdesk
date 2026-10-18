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

	const json = (body: unknown, status = 200) => () => Response.json(body, { status });

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
		expect(await client.status()).toEqual({ version: "3.1.1", pages: 7, sessions: 3, observations: 120, diskBytes: 4096 });
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
		routes["/api/v1/search?q=code+name&limit=20&workspace=my+ws&project=a%2Fb"] = json([
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
		routes["/api/v1/workspaces/w/projects/ok/recent"] = json([{ path: "a.md", title: "A", updated_at: "2026-01-02T00:00:00Z" }]);
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
			markdown: "# Hello",
		});
	});

	it("a page without a title falls back to its path", async () => {
		routes["/api/v1/workspaces/w/projects/p/pages/x.md"] = json({ body_markdown: "b" });
		expect((await client.page({ workspace: "w", project: "p", path: "x.md" })).title).toBe("x.md");
	});

	it("says ai-memory answered <status> for a non-2xx and 'not running' for a network failure or no url", async () => {
		routes["/api/v1/projects"] = json({}, 401);
		await expect(client.projects()).rejects.toThrow("ai-memory answered 401");
		delete routes["/api/v1/projects"];
		await expect(client.projects()).rejects.toThrow("ai-memory is not running");
		const offline = new AiMemoryClient({ url: () => null, dataDir: () => dataDir });
		await expect(offline.projects()).rejects.toThrow("ai-memory is not running");
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
