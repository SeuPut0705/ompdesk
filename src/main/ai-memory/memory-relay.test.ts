import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";

const RELAY = fileURLToPath(new URL("../../../resources/omp-builtin/ai-memory/memory-relay.mjs", import.meta.url));

/** Every tool ai-memory 3.1.1's server lists; the relay mounts the first eleven and keeps the rest behind the catalog. */
const CORE = [
	"memory_query",
	"memory_read_page",
	"memory_recent",
	"memory_write_page",
	"memory_feedback",
	"memory_handoff_begin",
	"memory_handoff_accept",
	"memory_handoff_list",
	"memory_message_send",
	"memory_message_list",
	"memory_message_pop",
];
const HIDDEN = [
	"memory_auto_improve",
	"memory_briefing",
	"memory_consolidate",
	"memory_delete_page",
	"memory_explore",
	"memory_forget_sweep",
	"memory_handoff_cancel",
	"memory_install_self_routing",
	"memory_lint",
	"memory_message_cancel",
	"memory_read_session_observations",
	"memory_restore_page",
	"memory_status",
];

/** Stands in for `ai-memory mcp-bridge`: the server's own initialize, tools/list and tools/call. */
const BRIDGE = `
const { createInterface } = require("node:readline");
const names = ${JSON.stringify([...CORE, ...HIDDEN])};
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
	const m = JSON.parse(line);
	if (m.method === "initialize")
		return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ai-memory", version: "3" }, instructions: "THE SERVER'S LONG INSTRUCTIONS" } });
	if (m.method === "tools/list")
		return send({ jsonrpc: "2.0", id: m.id, result: { tools: names.map(name => ({ name, description: name + " does a thing. Then a long second sentence.\\nMore detail.", inputSchema: { type: "object", properties: { x: { type: "string" } } }, annotations: { readOnlyHint: name.includes("list") } })) } });
	if (m.method === "tools/call") {
		if (!names.includes(m.params.name)) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool " + m.params.name } });
		return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ran " + m.params.name + " " + JSON.stringify(m.params.arguments) }] } });
	}
	if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

interface Tool {
	name: string;
	description: string;
	inputSchema: unknown;
	annotations?: unknown;
}
interface Message {
	id?: number | string;
	method?: string;
	result?: {
		instructions?: string;
		serverInfo?: unknown;
		capabilities?: unknown;
		tools?: Tool[];
		content?: { text: string }[];
	};
	error?: { code: number; message: string };
}
let dir: string;
const children: ChildProcessWithoutNullStreams[] = [];
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "memory-relay-"));
	await writeFile(join(dir, "bridge.cjs"), BRIDGE);
});
afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await rm(dir, RM_TEMP);
});

function relay() {
	const child = spawn(process.execPath, [RELAY, process.execPath, join(dir, "bridge.cjs")], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const waiting = new Map<number | string, (message: Message) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		const message = JSON.parse(line) as Message;
		if (message.id !== undefined) waiting.get(message.id)?.(message);
	});
	let next = 0;
	const request = (method: string, params: unknown = {}) => {
		const { promise, resolve } = Promise.withResolvers<Message>();
		const id = ++next;
		waiting.set(id, resolve);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return promise;
	};
	const call = (name: string, args?: unknown) => request("tools/call", { name, arguments: args });
	return { child, request, call };
}
const text = (message: Message): string => message.result?.content?.[0]?.text ?? "";
const tools = (message: Message): Tool[] => message.result?.tools ?? [];

describe("memory-relay", () => {
	it("replaces the server's instructions with the short text and leaves the rest of initialize alone", async () => {
		const { request } = relay();
		const { result } = await request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "t", version: "1" },
		});
		if (!result?.instructions) throw new Error("no instructions");
		expect(result.serverInfo).toEqual({ name: "ai-memory", version: "3" });
		expect(result.capabilities).toEqual({ tools: {} });
		expect(result.instructions).not.toContain("LONG INSTRUCTIONS");
		expect(result.instructions).toContain("untrusted");
		expect(result.instructions).toContain("memory_call");
	});

	it("lists the eleven everyday tools with a one-line summary above the original description, and memory_call", async () => {
		const { request } = relay();
		await request("initialize");
		const listed = tools(await request("tools/list"));
		expect(listed.map(tool => tool.name)).toEqual([...CORE, "memory_call"]);
		const query = listed[0];
		const [summary, blank, original] = query.description.split("\n");
		expect(summary.length).toBeLessThan(120);
		expect(blank).toBe("");
		expect(original).toBe("memory_query does a thing. Then a long second sentence.");
		// The server's own schema and annotations are untouched.
		expect(query.inputSchema).toEqual({ type: "object", properties: { x: { type: "string" } } });
		expect(listed.find(tool => tool.name === "memory_handoff_list")?.annotations).toEqual({ readOnlyHint: true });
	});

	it("memory_call's first line is the whole prompt cost; its docs name every unmounted tool", async () => {
		const { request } = relay();
		await request("initialize");
		const call = tools(await request("tools/list")).at(-1);
		const [first, ...docs] = (call?.description ?? "").split("\n");
		expect(first.length).toBeLessThan(140);
		for (const name of HIDDEN) expect(docs.join("\n"), name).toContain(`- ${name}(x?): ${name} does a thing`);
		for (const name of CORE) expect(docs.join("\n"), name).not.toContain(`- ${name}(`);
	});

	it("memory_call with describe describes the tool and runs nothing; with no name it lists the unmounted ones", async () => {
		const { request, call } = relay();
		await request("initialize");
		const one = JSON.parse(text(await call("memory_call", { name: "memory_lint", describe: true })));
		expect(one).toMatchObject({ name: "memory_lint", inputSchema: { type: "object" } });
		expect(one.description).toContain("More detail.");
		expect(one.note).toContain("Nothing ran");
		const list = JSON.parse(text(await call("memory_call", {})));
		expect(list.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...HIDDEN].sort());
		expect((await call("memory_call", { name: "memory_nope", describe: true })).error?.message).toContain(
			"Unknown memory tool",
		);
	});

	it("memory_call with arguments runs any tool of the server, mounted or not, and returns its answer unchanged", async () => {
		const { request, call } = relay();
		await request("initialize");
		await request("tools/list");
		for (const name of [...CORE, ...HIDDEN]) {
			expect(text(await call("memory_call", { name, arguments: { x: name } })), name).toBe(
				`ran ${name} {"x":"${name}"}`,
			);
		}
		// No arguments is a call with none, as a direct call without them would be.
		expect(text(await call("memory_call", { name: "memory_lint", arguments: {} }))).toBe("ran memory_lint {}");
		expect(text(await call("memory_call", { name: "memory_status" }))).toBe("ran memory_status {}");
		expect(text(await call("memory_call", { name: "memory_status", describe: false }))).toBe("ran memory_status {}");
	});

	it("passes a mounted tool's call through byte for byte, and the server's errors with it", async () => {
		const { request, call } = relay();
		await request("initialize");
		expect(text(await call("memory_query", { query: "a b" }))).toBe('ran memory_query {"query":"a b"}');
		expect((await call("memory_call", { name: "memory_nope", arguments: {} })).error).toEqual({
			code: -32602,
			message: "unknown tool memory_nope",
		});
	});

	it("refuses memory_call with a non-string name, non-object arguments, a non-boolean describe or aimed at itself", async () => {
		const { request, call } = relay();
		await request("initialize");
		expect((await call("memory_call", { name: 3 })).error?.code).toBe(-32602);
		expect((await call("memory_call", { name: "memory_lint", describe: "yes" })).error?.code).toBe(-32602);
		expect((await call("memory_call", { name: "memory_lint", arguments: "x" })).error?.code).toBe(-32602);
		expect((await call("memory_call", { name: "memory_call", arguments: {} })).error?.code).toBe(-32602);
	});

	it("answers before the client ever listed the tools", async () => {
		const { request, call } = relay();
		await request("initialize");
		const list = JSON.parse(text(await call("memory_call", {})));
		expect(list.tools).toHaveLength(HIDDEN.length);
	});

	it("exits when its client closes stdin", async () => {
		const { child, request } = relay();
		await request("initialize");
		child.stdin.end();
		const [code] = await once(child, "close");
		expect(code).toBe(0);
	});
});
