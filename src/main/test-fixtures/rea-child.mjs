import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import config from "../../../resources/omp-builtin/rea/rea-config.json" with { type: "json" };

let tools = [
	...config.curatedTools,
	...Array.from({ length: 30 - config.curatedTools.length }, (_, i) => `extra_${i}`),
].map(name => ({
	name,
	description: name === "extra_0" ? "JavaScript optional detail\nMore documentation" : `${name} analysis entry`,
	inputSchema: { type: "object", properties: { marker: { type: "string" } }, additionalProperties: false },
	...(name === "extra_0"
		? {
				annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
				outputSchema: { type: "object", properties: { evidence: { type: "string" } }, required: ["evidence"] },
				_meta: { provenance: { untrusted_content: true } },
			}
		: {}),
}));
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin });
let descendant;
let initialized = false;
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
		if (message.method === "notifications/initialized") {
			initialized = true;
			send({ jsonrpc: "2.0", method: "notifications/message", params: { initialized: true } });
		} else if (message.method !== "notifications/cancelled")
			// Says which notification arrived and whether `initialized` came before it, as MCP requires.
			send({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { notification: message.method, initialized },
			});
		return;
	}
	const reply = result => send({ jsonrpc: "2.0", id: message.id, result });
	if (message.method === "initialize" && process.env.REA_FIXTURE_FAIL_INITIALIZE)
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "REA could not initialize" } });
	else if (message.method === "initialize" && process.env.REA_FIXTURE_SLOW_INITIALIZE) {
		// Started and holding its handshake answer: the window in which omp's notifications must wait for `initialized`.
		process.stderr.write("fake-rea: initializing\n");
		setTimeout(
			() =>
				reply({
					protocolVersion: message.params.protocolVersion,
					capabilities: { tools: {}, prompts: {} },
					serverInfo: { name: "fake-rea", version: "test" },
				}),
			300,
		);
	} else if (message.method === "initialize")
		reply({
			protocolVersion: message.params.protocolVersion,
			capabilities: { tools: {}, prompts: {} },
			serverInfo: { name: "fake-rea", version: "test" },
			instructions: "Fake REA instructions, kept byte for byte.",
		});
	else if (message.method === "ping") reply({ pid: process.pid });
	else if (message.method === "prompts/list") reply({ prompts: [{ name: "investigate_feature" }] });
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
