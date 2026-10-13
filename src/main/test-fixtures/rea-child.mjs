import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import config from "../../../resources/omp-builtin/rea-config.json" with { type: "json" };

let tools = [...config.curatedTools, ...Array.from({ length: 15 }, (_, i) => `extra_${i}`)].map(name => ({
	name,
	description: name === "extra_0" ? "JavaScript optional detail\nMore documentation" : `${name} analysis entry`,
	inputSchema: { type: "object", properties: { marker: { type: "string" } }, additionalProperties: false },
}));
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin });
let descendant;
process.on("SIGTERM", () => {
	if (descendant) descendant.once("exit", () => process.exit(0));
	else process.exit(0);
});
lines.on("close", () => {
	if (descendant) {
		descendant.once("exit", () => process.exit(0));
		descendant.kill();
	} else process.exit(0);
});
lines.on("line", line => {
	const message = JSON.parse(line);
	if (message.id === undefined) {
		if (message.method === "notifications/initialized")
			send({ jsonrpc: "2.0", method: "notifications/message", params: { initialized: true } });
		return;
	}
	const reply = result => send({ jsonrpc: "2.0", id: message.id, result });
	if (message.method === "initialize")
		reply({
			protocolVersion: message.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "fake-rea", version: "test" },
		});
	else if (message.method === "ping") reply({ pid: process.pid });
	else if (message.method === "tools/list")
		reply(message.params?.cursor ? { tools: tools.slice(20) } : { tools: tools.slice(0, 20), nextCursor: "page-2" });
	else if (message.method === "fixture/change") {
		tools = tools.slice(1);
		send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		reply({});
	} else if (message.method === "fixture/exit") process.exit(7);
	else if (message.method === "fixture/descendant") {
		descendant = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(() => {}, 1000)"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		reply({ pid: descendant.pid });
	} else if (message.method === "tools/call") {
		if (message.params.arguments?.marker === "fail")
			send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32001, message: "REA original error", data: { source: "rea" } },
			});
		else reply({ content: [{ type: "text", text: JSON.stringify(message.params) }] });
	} else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } });
});
