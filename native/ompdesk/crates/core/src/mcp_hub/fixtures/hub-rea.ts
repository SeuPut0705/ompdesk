import { createInterface } from "node:readline";

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (message.id === undefined) continue;
	let result: unknown = {};
	if (message.method === "initialize") {
		result = { protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "Keep upstream trust instructions.\n\n" };
	} else if (message.method === "tools/list") {
		result = { tools: [{ name: "inspect", description: "Read isolated fixture state.", inputSchema: { type: "object" }, outputSchema: { type: "object" }, _meta: { intact: true } }] };
	} else if (message.method === "prompts/list") {
		result = { prompts: [] };
	} else if (message.method === "tools/call") {
		if (message.params.arguments?.notify) send({ jsonrpc: "2.0", method: "notifications/progress", params: { marker: message.params.arguments.notify } });
        result = { content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), pid: process.pid, secret: process.env.OMP_GUI_MCP_HUB_SECRET ?? null, marker: process.env.FIXTURE_MARKER, plumbing: ["OMP_GUI_MCP_AUTH", "OMP_GUI_MCP_HUB", "OMP_GUI_MCP_CWD", "OMP_GUI_BRIDGE", "OMPDESK_SOCKET", "OMP_GUI_SESSION_TAG", "OMP_GUI_REA_ROOT"].map(key => process.env[key] ?? null) }) }] };
	}
	send({ jsonrpc: "2.0", id: message.id, result });
}
