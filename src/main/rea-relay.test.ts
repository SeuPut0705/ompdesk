import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
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
function relay() {
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("./test-fixtures/rea-relay-entry.mjs", import.meta.url))],
		{ stdio: ["pipe", "pipe", "pipe"] },
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
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		fixture.child.stdin.end();
		await fixture.closed;
	}
});

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
