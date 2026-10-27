import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import config from "../../resources/omp-builtin/rea/rea-config.json";

const Message = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number(), z.null()]).optional(),
	method: z.string().optional(),
	params: z.unknown().optional(),
	result: z.unknown().optional(),
	error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
type Message = z.infer<typeof Message>;
const Tools = z.object({
	tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown().optional() })),
});
const Content = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const Pid = z.object({ pid: z.number() });
interface RelayFixture {
	child: ChildProcessWithoutNullStreams;
	closed: Promise<unknown[]>;
	request: (method: string, params?: unknown) => Promise<Message>;
	send: (message: unknown) => boolean;
	wait: (predicate: (message: Message) => boolean) => Promise<Message>;
}
const fixtures: RelayFixture[] = [];
function relay(cacheDir?: string, env: Record<string, string> = {}) {
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("./test-fixtures/rea-relay-entry.mjs", import.meta.url))],
		{
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, OMP_GUI_REA_CACHE: cacheDir ?? "", ...env },
		},
	);
	const closed = once(child, "close");
	const lines = createInterface({ input: child.stdout });
	const received: Message[] = [];
	const waiters: { predicate: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
	lines.on("line", line => {
		const message = Message.parse(JSON.parse(line));
		const index = waiters.findIndex(waiter => waiter.predicate(message));
		if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
		else received.push(message);
	});
	let id = 0;
	const wait = (predicate: (message: Message) => boolean) => {
		const index = received.findIndex(predicate);
		if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
		const result = Promise.withResolvers<Message>();
		waiters.push({ predicate, resolve: result.resolve });
		return result.promise;
	};
	const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
	const request = (method: string, params: unknown = {}) => {
		const requestId = ++id;
		send({ jsonrpc: "2.0", id: requestId, method, params });
		return wait(message => message.id === requestId);
	};
	const result = { child, closed, request, send, wait };
	fixtures.push(result);
	return result;
}
async function initialize(fixture: RelayFixture) {
	const response = await fixture.request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "test", version: "1" },
	});
	expect(response.result).toMatchObject({
		serverInfo: { name: "fake-rea" },
		capabilities: { tools: { listChanged: true } },
	});
	fixture.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	await fixture.wait(message => message.method === "notifications/message");
}
async function closeRelays() {
	for (const fixture of fixtures.splice(0)) {
		fixture.child.stdin.end();
		await fixture.closed;
	}
}
afterEach(closeRelays);

describe("REA relay", () => {
	it("exposes only the curated entry schemas plus two meta tools from a paginated 30-tool child", async () => {
		const fixture = relay();
		await initialize(fixture);
		const listed = Tools.parse((await fixture.request("tools/list")).result).tools;
		expect(listed.map(tool => tool.name)).toEqual([...config.curatedTools, "rea_catalog", "rea_call"]);
		expect(listed[0].inputSchema).toEqual({
			type: "object",
			properties: { marker: { type: "string" } },
			additionalProperties: false,
		});
	});
	it("searches concise summaries and supplies the full requested tool descriptor", async () => {
		const fixture = relay();
		await initialize(fixture);
		const response = await fixture.request("tools/call", {
			name: "rea_catalog",
			arguments: { query: "JAVASCRIPT optional" },
		});
		expect(JSON.parse(Content.parse(response.result).content[0].text)).toEqual({
			tools: [{ name: "extra_0", description: "JavaScript optional detail" }],
		});
		const schema = await fixture.request("tools/call", { name: "rea_catalog", arguments: { name: "extra_0" } });
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
		const all = await fixture.request("tools/call", { name: "rea_catalog", arguments: {} });
		expect(Tools.parse(JSON.parse(Content.parse(all.result).content[0].text)).tools).toHaveLength(30);
	});
	it("preserves REA errors and rejects unknown or invalid inputs", async () => {
		const fixture = relay();
		await initialize(fixture);
		const failed = await fixture.request("tools/call", {
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
			expect((await fixture.request("tools/call", params)).error?.code).toBe(-32602);
	});
	it("recomputes the catalog before forwarding list_changed", async () => {
		const fixture = relay();
		await initialize(fixture);
		await fixture.request("tools/list");
		await fixture.request("fixture/change");
		await fixture.wait(message => message.method === "notifications/tools/list_changed");
		const listed = Tools.parse((await fixture.request("tools/list")).result).tools;
		expect(listed).toHaveLength(config.curatedTools.length + 1);
		expect(listed.map(tool => tool.name)).not.toContain(config.curatedTools[0]);
		const call = await fixture.request("tools/call", {
			name: "rea_call",
			arguments: { name: config.curatedTools[0], arguments: {} },
		});
		expect(call.error?.code).toBe(-32602);
	});
	it("exits nonzero when its child exits", async () => {
		const fixture = relay();
		await initialize(fixture);
		fixture.send({ jsonrpc: "2.0", id: "exit", method: "fixture/exit" });
		expect((await fixture.closed)[0]).not.toBe(0);
	});
	it("kills the child and its descendants on stdin EOF without leaving an orphan", async () => {
		const fixture = relay();
		await initialize(fixture);
		const childPid = Pid.parse((await fixture.request("ping")).result).pid;
		const descendantPid = Pid.parse((await fixture.request("fixture/descendant")).result).pid;
		fixture.child.stdin.end();
		expect((await fixture.closed)[0]).toBe(0);
		expect(() => process.kill(childPid, 0)).toThrow();
		expect(() => process.kill(descendantPid, 0)).toThrow();
	});
});

describe("REA relay with a startup cache", () => {
	const HANDSHAKE = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } };
	const dirs: string[] = [];
	afterEach(async () => {
		// Inner hooks run first: a relay still running would write its cache back into a removed dir.
		await closeRelays();
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	const cacheFile = (dir: string) => path.join(dir, `rea-${config.version}.json`);
	/** A first relay finds no cache, starts REA with omp as before, and records its startup answers. */
	async function filledCache() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rea-cache-"));
		dirs.push(dir);
		const first = relay(dir);
		await initialize(first);
		await first.request("tools/list");
		await expect.poll(() => fs.existsSync(cacheFile(dir))).toBe(true);
		first.child.stdin.end();
		await first.closed;
		return dir;
	}
	async function cachedStartup(fixture: RelayFixture) {
		const response = await fixture.request("initialize", HANDSHAKE);
		fixture.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		return response;
	}
	const catalogSize = async (fixture: RelayFixture) =>
		Tools.parse(
			JSON.parse(
				Content.parse((await fixture.request("tools/call", { name: "rea_catalog", arguments: {} })).result)
					.content[0].text,
			),
		).tools.length;

	it("answers omp's startup from the cache and starts REA at the first call that needs it", async () => {
		const fixture = relay(await filledCache());
		expect((await cachedStartup(fixture)).result).toEqual({
			protocolVersion: "2024-11-05",
			capabilities: { tools: { listChanged: true }, prompts: {} },
			serverInfo: { name: "fake-rea", version: "test" },
			instructions: "Fake REA instructions, kept byte for byte.",
		});
		const listed = Tools.parse((await fixture.request("tools/list")).result).tools;
		expect(listed.map(tool => tool.name)).toEqual([...config.curatedTools, "rea_catalog", "rea_call"]);
		expect((await fixture.request("prompts/list")).result).toEqual({ prompts: [{ name: "investigate_feature" }] });
		expect(await catalogSize(fixture)).toBe(30);
		// The relay answers ping itself while REA is not running; REA's own ping names its pid.
		expect((await fixture.request("ping")).result).toEqual({});
		const call = await fixture.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		expect(JSON.parse(Content.parse(call.result).content[0].text)).toEqual({
			name: "extra_3",
			arguments: { marker: "x" },
		});
		await fixture.wait(message => message.method === "notifications/message");
		expect(Pid.parse((await fixture.request("ping")).result).pid).toBeGreaterThan(0);
	});

	it("announces a catalog that changed since the cache was written, and records the new one", async () => {
		const dir = await filledCache();
		const stale = JSON.parse(fs.readFileSync(cacheFile(dir), "utf8"));
		stale.tools = stale.tools.slice(0, -1);
		fs.writeFileSync(cacheFile(dir), JSON.stringify(stale));
		const fixture = relay(dir);
		await cachedStartup(fixture);
		expect(await catalogSize(fixture)).toBe(29);
		await fixture.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		await fixture.wait(message => message.method === "notifications/tools/list_changed");
		expect(await catalogSize(fixture)).toBe(30);
		await expect.poll(() => JSON.parse(fs.readFileSync(cacheFile(dir), "utf8")).tools.length).toBe(30);
	});

	it("lets REA answer a handshake the cache was not written for", async () => {
		const fixture = relay(await filledCache());
		const response = await fixture.request("initialize", { ...HANDSHAKE, protocolVersion: "2025-06-18" });
		expect(response.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "fake-rea" } });
		expect(Pid.parse((await fixture.request("ping")).result).pid).toBeGreaterThan(0);
	});

	it("exits cleanly on stdin EOF when REA never started", async () => {
		const fixture = relay(await filledCache());
		await cachedStartup(fixture);
		await fixture.request("tools/list");
		fixture.child.stdin.end();
		expect((await fixture.closed)[0]).toBe(0);
	});

	it("answers the first call with an error and forgets the cache when REA cannot start", async () => {
		const dir = await filledCache();
		const fixture = relay(dir, { REA_TEST_COMMAND: path.join(dir, "no-such-rea") });
		await cachedStartup(fixture);
		const call = await fixture.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		expect(call.error?.message).toBeTruthy();
		expect((await fixture.closed)[0]).not.toBe(0);
		// The next omp starts REA with its startup again and sees the failure there, not a healthy cached REA.
		expect(fs.existsSync(cacheFile(dir))).toBe(false);
	});

	it("answers the first call with REA's error and exits when REA refuses the handshake", async () => {
		const dir = await filledCache();
		const fixture = relay(dir, { REA_FIXTURE_FAIL_INITIALIZE: "1" });
		await cachedStartup(fixture);
		const call = await fixture.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		expect(call.error?.message).toBe("REA could not initialize");
		expect((await fixture.closed)[0]).not.toBe(0);
		expect(fs.existsSync(cacheFile(dir))).toBe(false);
	});

	it("does not run a call omp cancelled while REA was starting", async () => {
		const fixture = relay(await filledCache());
		await cachedStartup(fixture);
		fixture.send({
			jsonrpc: "2.0",
			id: "cancelled-call",
			method: "tools/call",
			params: { name: "rea_call", arguments: { name: "extra_3", arguments: { marker: "x" } } },
		});
		fixture.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancelled-call" } });
		const answer = await fixture.wait(message => message.id === "cancelled-call");
		expect(answer.result).toBeUndefined();
		expect(answer.error?.code).toBe(-32800);
		// REA did start: the next call runs.
		const next = await fixture.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "y" } },
		});
		expect(JSON.parse(Content.parse(next.result).content[0].text)).toMatchObject({ arguments: { marker: "y" } });
	});

	it("hands REA the notifications sent while it started only after its handshake", async () => {
		const fixture = relay(await filledCache(), { REA_FIXTURE_SLOW_INITIALIZE: "1" });
		await cachedStartup(fixture);
		const initializing = Promise.withResolvers<void>();
		createInterface({ input: fixture.child.stderr }).on("line", line => {
			if (line === "fake-rea: initializing") initializing.resolve();
		});
		const call = fixture.request("tools/call", {
			name: "rea_call",
			arguments: { name: "extra_3", arguments: { marker: "x" } },
		});
		// REA runs and has its handshake but has not answered it.
		await initializing.promise;
		fixture.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
		await call;
		const echo = await fixture.wait(
			message =>
				message.method === "notifications/message" &&
				z.object({ notification: z.string() }).safeParse(message.params).success,
		);
		expect(echo.params).toEqual({ notification: "notifications/roots/list_changed", initialized: true });
	});
});
