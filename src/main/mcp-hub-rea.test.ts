import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import config from "../../resources/omp-builtin/rea/rea-config.json";
import { type ReaClient, reaClient, startTestHub, stopTestHubs, type TestHub } from "./test-fixtures/mcp-hub-fixture";

const Tools = z.object({
	tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown().optional() })),
});
const Content = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const Pid = z.object({ pid: z.number() });
const HANDSHAKE = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } };
const sessions: ReaClient[] = [];

async function hubWith(cacheDir?: string, env: Record<string, string> = {}): Promise<TestHub> {
	return startTestHub({ OMP_GUI_REA_CACHE: cacheDir ?? "", ...env });
}
function session(hub: TestHub, cwd?: string): ReaClient {
	const client = reaClient(hub, cwd);
	sessions.push(client);
	return client;
}
async function initialize(client: ReaClient) {
	const response = await client.request("initialize", HANDSHAKE);
	expect(response.result).toMatchObject({
		serverInfo: { name: "fake-rea" },
		capabilities: { tools: { listChanged: true } },
	});
	client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	await client.wait(message => message.method === "notifications/message");
}
const gone = (pid: number) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};
afterEach(async () => {
	for (const client of sessions.splice(0)) client.drop();
	await stopTestHubs();
});

describe("MCP hub: REA", () => {
	it("refuses a request without the launch's secret", async () => {
		const hub = await hubWith();
		const answer = await hub.post(
			"/rea",
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: HANDSHAKE },
			{
				authorization: "Bearer wrong",
			},
		);
		expect(answer.status).toBe(401);
	});

	it("exposes only the curated entry schemas plus two meta tools from a paginated 30-tool child", async () => {
		const client = session(await hubWith());
		await initialize(client);
		const listed = Tools.parse((await client.request("tools/list")).result).tools;
		expect(listed.map(tool => tool.name)).toEqual([...config.curatedTools, "rea_catalog", "rea_call"]);
		expect(listed[0].inputSchema).toEqual({
			type: "object",
			properties: { marker: { type: "string" } },
			additionalProperties: false,
		});
	});

	it("searches concise summaries and supplies the full requested tool descriptor", async () => {
		const client = session(await hubWith());
		await initialize(client);
		const response = await client.request("tools/call", {
			name: "rea_catalog",
			arguments: { query: "JAVASCRIPT optional" },
		});
		expect(JSON.parse(Content.parse(response.result).content[0].text)).toEqual({
			tools: [{ name: "extra_0", description: "JavaScript optional detail" }],
		});
		const schema = await client.request("tools/call", { name: "rea_catalog", arguments: { name: "extra_0" } });
		expect(JSON.parse(Content.parse(schema.result).content[0].text)).toEqual({
			tools: [
				{
					name: "extra_0",
					description: "JavaScript optional detail\nMore documentation",
					inputSchema: {
						type: "object",
						properties: { marker: { type: "string" } },
						additionalProperties: false,
					},
					annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
					outputSchema: { type: "object", properties: { evidence: { type: "string" } }, required: ["evidence"] },
					_meta: { provenance: { untrusted_content: true } },
				},
			],
		});
		const all = await client.request("tools/call", { name: "rea_catalog", arguments: {} });
		expect(Tools.parse(JSON.parse(Content.parse(all.result).content[0].text)).tools).toHaveLength(30);
	});

	it("preserves REA errors and rejects unknown or invalid inputs", async () => {
		const client = session(await hubWith());
		await initialize(client);
		const failed = await client.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_14", arguments: { marker: "fail" } },
		});
		expect(failed.error).toEqual({ code: -32001, message: "REA original error", data: { source: "rea" } });
		for (const params of [
			{ name: "rea_call", arguments: { name: "missing", arguments: {} } },
			{ name: "extra_14", arguments: {} },
			{ name: "rea_call", arguments: { name: "extra_14", arguments: [] } },
			{ name: "rea_catalog", arguments: { query: 2 } },
			{ name: "rea_catalog", arguments: { name: "missing" } },
		])
			expect((await client.request("tools/call", params)).error?.code).toBe(-32602);
	});

	it("recomputes the catalog before forwarding list_changed", async () => {
		const client = session(await hubWith());
		await initialize(client);
		await client.request("tools/list");
		await client.request("fixture/change");
		await client.wait(message => message.method === "notifications/tools/list_changed");
		const listed = Tools.parse((await client.request("tools/list")).result).tools;
		expect(listed).toHaveLength(config.curatedTools.length + 1);
		expect(listed.map(tool => tool.name)).not.toContain(config.curatedTools[0]);
		const call = await client.request("tools/call", {
			name: "rea_call",
			arguments: { name: config.curatedTools[0], arguments: {} },
		});
		expect(call.error?.code).toBe(-32602);
	});

	it("carries REA's own requests to omp on the event stream and omp's answers back to REA", async () => {
		const client = session(await hubWith());
		await initialize(client);
		await client.request("fixture/ask");
		const asked = await client.wait(message => message.method === "roots/list");
		expect(asked.id).not.toBe(41);
		client.send({ jsonrpc: "2.0", id: asked.id, result: { roots: [] } });
		const answered = await client.wait(
			message =>
				message.method === "notifications/message" &&
				z.object({ answered: z.number() }).safeParse(message.params).success,
		);
		expect(answered.params).toEqual({ answered: 41, result: { roots: [] } });
	});

	it("runs each omp's REA in that omp's folder", async () => {
		const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rea-cwd-")));
		try {
			const client = session(await hubWith(), folder);
			await initialize(client);
			expect((await client.request("fixture/cwd")).result).toEqual({ cwd: folder });
			// Windows refuses to remove a running process's working folder: REA must be gone before the folder goes.
			const childPid = Pid.parse((await client.request("ping")).result).pid;
			await client.close();
			await expect.poll(() => gone(childPid), { timeout: 10_000 }).toBe(true);
		} finally {
			// A process gone from the process table can hold its working folder a moment longer on Windows (EBUSY).
			fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});

	it("gives every omp its own REA, side by side", async () => {
		const hub = await hubWith();
		const first = session(hub);
		const second = session(hub);
		await Promise.all([initialize(first), initialize(second)]);
		const [a, b] = await Promise.all([first.request("ping"), second.request("ping")]);
		expect(Pid.parse(a.result).pid).not.toBe(Pid.parse(b.result).pid);
	});

	it("ends the session when its REA exits, and only that session", async () => {
		const hub = await hubWith();
		const client = session(hub);
		const other = session(hub);
		await Promise.all([initialize(client), initialize(other)]);
		client.send({ jsonrpc: "2.0", id: "exit", method: "fixture/exit" });
		expect((await client.wait(message => message.id === "exit")).error?.message).toBe("REA child exited");
		await client.ended;
		expect(Pid.parse((await other.request("ping")).result).pid).toBeGreaterThan(0);
	});

	it("stops REA and its descendants when omp closes the session", async () => {
		const client = session(await hubWith());
		await initialize(client);
		const childPid = Pid.parse((await client.request("ping")).result).pid;
		const descendantPid = Pid.parse((await client.request("fixture/descendant")).result).pid;
		await client.close();
		await expect.poll(() => gone(childPid) && gone(descendantPid), { timeout: 10_000 }).toBe(true);
	});

	it("stops REA when omp goes away without closing (its event stream drops)", async () => {
		const client = session(await hubWith());
		await initialize(client);
		const childPid = Pid.parse((await client.request("ping")).result).pid;
		client.drop();
		await expect.poll(() => gone(childPid), { timeout: 10_000 }).toBe(true);
	});

	it("stops every REA when the app goes (the hub's stdin closes)", async () => {
		const hub = await hubWith();
		const client = session(hub);
		await initialize(client);
		const childPid = Pid.parse((await client.request("ping")).result).pid;
		await hub.stop();
		expect(gone(childPid)).toBe(true);
	});
});

describe("MCP hub: REA with a startup cache", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		// Inner hooks run first: a hub still running would write its cache back into a removed dir.
		for (const client of sessions.splice(0)) client.drop();
		await stopTestHubs();
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	const cacheFile = (dir: string) => path.join(dir, `rea-${config.version}.json`);
	/** A first session finds no cache, starts REA with omp as before, and records its startup answers. */
	async function filledCache() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rea-cache-"));
		dirs.push(dir);
		const hub = await hubWith(dir);
		const first = session(hub);
		await initialize(first);
		await first.request("tools/list");
		await expect.poll(() => fs.existsSync(cacheFile(dir))).toBe(true);
		await hub.stop();
		return dir;
	}
	async function cachedStartup(client: ReaClient) {
		const response = await client.request("initialize", HANDSHAKE);
		client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		return response;
	}
	const catalogSize = async (client: ReaClient) =>
		Tools.parse(
			JSON.parse(
				Content.parse((await client.request("tools/call", { name: "rea_catalog", arguments: {} })).result)
					.content[0].text,
			),
		).tools.length;

	it("answers omp's startup from the cache and starts REA at the first call that needs it", async () => {
		const client = session(await hubWith(await filledCache()));
		expect((await cachedStartup(client)).result).toEqual({
			protocolVersion: "2024-11-05",
			capabilities: { tools: { listChanged: true }, prompts: {} },
			serverInfo: { name: "fake-rea", version: "test" },
			instructions: "Fake REA instructions, kept byte for byte.",
		});
		const listed = Tools.parse((await client.request("tools/list")).result).tools;
		expect(listed.map(tool => tool.name)).toEqual([...config.curatedTools, "rea_catalog", "rea_call"]);
		expect((await client.request("prompts/list")).result).toEqual({ prompts: [{ name: "investigate_feature" }] });
		expect(await catalogSize(client)).toBe(30);
		// The hub answers ping itself while REA is not running; REA's own ping names its pid.
		expect((await client.request("ping")).result).toEqual({});
		const call = await client.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		expect(JSON.parse(Content.parse(call.result).content[0].text)).toEqual({
			name: "extra_3",
			arguments: { marker: "x" },
		});
		await client.wait(message => message.method === "notifications/message");
		expect(Pid.parse((await client.request("ping")).result).pid).toBeGreaterThan(0);
	});

	it("answers every session's startup from the one cache it read", async () => {
		const hub = await hubWith(await filledCache());
		const clients = [session(hub), session(hub), session(hub)];
		const answers = await Promise.all(clients.map(cachedStartup));
		for (const answer of answers) expect(answer.result).toMatchObject({ serverInfo: { name: "fake-rea" } });
		for (const client of clients) expect((await client.request("ping")).result).toEqual({});
	});

	it("announces a catalog that changed since the cache was written, and records the new one", async () => {
		const dir = await filledCache();
		const stale = JSON.parse(fs.readFileSync(cacheFile(dir), "utf8"));
		stale.tools = stale.tools.slice(0, -1);
		fs.writeFileSync(cacheFile(dir), JSON.stringify(stale));
		const client = session(await hubWith(dir));
		await cachedStartup(client);
		expect(await catalogSize(client)).toBe(29);
		await client.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		await client.wait(message => message.method === "notifications/tools/list_changed");
		expect(await catalogSize(client)).toBe(30);
		await expect.poll(() => JSON.parse(fs.readFileSync(cacheFile(dir), "utf8")).tools.length).toBe(30);
	});

	it("lets REA answer a handshake the cache was not written for", async () => {
		const client = session(await hubWith(await filledCache()));
		const response = await client.request("initialize", { ...HANDSHAKE, protocolVersion: "2025-06-18" });
		expect(response.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "fake-rea" } });
		expect(Pid.parse((await client.request("ping")).result).pid).toBeGreaterThan(0);
	});

	it("closes a session whose REA never started, and the hub goes on serving", async () => {
		const hub = await hubWith(await filledCache());
		const client = session(hub);
		await cachedStartup(client);
		expect((await client.request("ping")).result).toEqual({});
		await client.close();
		await client.ended;
		const next = session(hub);
		expect((await cachedStartup(next)).result).toMatchObject({ serverInfo: { name: "fake-rea" } });
	});

	it("answers the first call with an error and forgets the cache when REA cannot start", async () => {
		const dir = await filledCache();
		const client = session(await hubWith(dir, { REA_TEST_COMMAND: path.join(dir, "no-such-rea") }));
		await cachedStartup(client);
		const call = await client.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		expect(call.error?.message).toBeTruthy();
		await client.ended;
		// The next session starts REA with its startup again and sees the failure there, not a healthy cached REA.
		expect(fs.existsSync(cacheFile(dir))).toBe(false);
	});

	it("answers the first call with REA's error and ends the session when REA refuses the handshake", async () => {
		const dir = await filledCache();
		const client = session(await hubWith(dir, { REA_FIXTURE_FAIL_INITIALIZE: "1" }));
		await cachedStartup(client);
		const call = await client.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		expect(call.error?.message).toBe("REA could not initialize");
		await client.ended;
		expect(fs.existsSync(cacheFile(dir))).toBe(false);
	});

	it("does not run a call omp cancelled while REA was starting", async () => {
		const client = session(await hubWith(await filledCache()));
		await cachedStartup(client);
		client.send({
			jsonrpc: "2.0",
			id: "cancelled-call",
			method: "tools/call",
			params: { name: "rea_call", arguments: { name: "extra_3", arguments: { marker: "x" } } },
		});
		client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancelled-call" } });
		const answer = await client.wait(message => message.id === "cancelled-call");
		expect(answer.result).toBeUndefined();
		expect(answer.error?.code).toBe(-32800);
		// REA did start: the next call runs.
		const next = await client.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "y" } },
		});
		expect(JSON.parse(Content.parse(next.result).content[0].text)).toMatchObject({ arguments: { marker: "y" } });
	});

	it("hands REA the notifications sent while it started only after its handshake", async () => {
		const hub = await hubWith(await filledCache(), { REA_FIXTURE_SLOW_INITIALIZE: "1" });
		const client = session(hub);
		await cachedStartup(client);
		const call = client.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		// REA runs and has its handshake but has not answered it.
		await expect.poll(() => hub.stderr().includes("fake-rea: initializing")).toBe(true);
		client.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
		await call;
		const echo = await client.wait(
			message =>
				message.method === "notifications/message" &&
				z.object({ notification: z.string() }).safeParse(message.params).success,
		);
		expect(echo.params).toEqual({ notification: "notifications/roots/list_changed", initialized: true });
	});
});
