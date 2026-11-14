import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const tools = [
  { name: "open_binary", description: "Open binary\nComplete details", inputSchema: { type: "object" }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { provenance: { untrusted_content: true } } },
  { name: "other", description: "JavaScript detail\nFull details", inputSchema: { type: "object" } },
];
let initialized = false;
let changed = false;
const barrier = process.env.REA_BARRIER;

async function receive(message) {
  if (process.env.REA_LOG) appendFileSync(process.env.REA_LOG, `${JSON.stringify(message)}\n`);
  if (message.method === "initialize") {
    if (barrier) {
      writeFileSync(`${barrier}.started`, "ready");
      while (!existsSync(`${barrier}.release`)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (process.env.REA_FAIL_INITIALIZE) send({ id: message.id, error: { code: -32001, message: "refused", data: { source: "fixture" } } });
    else send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "Keep upstream instructions." } });
  } else if (message.method === "notifications/initialized") {
    initialized = true;
    send({ method: "notifications/message", params: { initialized } });
  } else if (message.method?.startsWith("notifications/")) {
    send({ method: "notifications/message", params: { notification: message.method, initialized } });
  } else if (message.method === "tools/list") {
    const list = changed ? tools.slice(1) : tools;
    const index = message.params?.cursor ? 1 : 0;
    send({ id: message.id, result: { tools: list.slice(index, index + 1), ...(index + 1 < list.length ? { nextCursor: "next" } : {}) } });
  } else if (message.method === "prompts/list") {
    if (process.env.REA_PROMPT_BARRIER) {
      const hold = process.env.REA_PROMPT_BARRIER;
      writeFileSync(`${hold}.started`, "ready");
      while (!existsSync(`${hold}.release`)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    send({ id: message.id, result: { prompts: [{ name: "investigate" }] } });
  } else if (message.method === "tools/call") {
    if (message.params.arguments?.marker === "hold") {
      const hold = process.env.REA_CALL_BARRIER;
      writeFileSync(`${hold}.started`, "ready");
      while (!existsSync(`${hold}.release`)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (message.params.arguments?.marker === "fail") send({ id: message.id, error: { code: -32001, message: "original", data: { source: "fixture" } } });
    else send({ id: message.id, result: { name: message.params.name, arguments: message.params.arguments } });
  } else if (message.method === "fixture/change") {
    changed = true;
    send({ method: "notifications/tools/list_changed" });
    send({ id: message.id, result: {} });
  } else if (message.method === "fixture/ask") {
    send({ method: "roots/list", id: 41, params: {} });
    send({ id: message.id, result: {} });
  } else if (message.method === "fixture/env") {
    send({ id: message.id, result: { auth: process.env.OMP_GUI_MCP_AUTH ?? null, hub: process.env.OMP_GUI_MCP_HUB ?? null, tag: process.env.OMP_GUI_SESSION_TAG ?? null } });
  } else if (message.method === "fixture/descendant_then_exit") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
    send({ id: message.id, result: { pid: child.pid } });
    setTimeout(() => process.exit(0), 20);
  } else if (message.method === "fixture/exit") {
    process.exit(0);
  } else if (!message.method && message.id === 41) {
    send({ method: "notifications/message", params: { answered: message.id, result: message.result } });
  } else if (message.id !== undefined) {
    send({ id: message.id, result: { pid: process.pid, cwd: process.cwd() } });
  }
}

createInterface({ input: process.stdin }).on("line", line => { void receive(JSON.parse(line)); });
