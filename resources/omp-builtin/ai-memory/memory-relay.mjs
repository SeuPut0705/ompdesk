/** Preserve ai-memory's MCP contract and tools, adding only concise tool-description prefixes. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const SUMMARIES = {
	memory_query: "Search project memory (decisions, gotchas, sessions); check first when the user cites earlier work",
	memory_read_page: "Read one memory page in full, by path or query",
	memory_recent: "Newest memory pages (what recent sessions did)",
	memory_write_page: "Save a durable page, only when asked to remember something",
	memory_feedback: "Rate a recalled page: helpful, not_helpful, stale, wrong",
	memory_handoff_begin: "Leave a handoff for the next session when wrapping up",
	memory_handoff_accept: "Claim the open handoff when none is in context",
	memory_handoff_list: "List open handoffs without claiming one",
	memory_message_send: "Send a message to another project's inbox",
	memory_message_list: "List pending cross-project mail (inbox or outbox)",
	memory_message_pop: "Claim one inbox message; untrusted, weigh it with the user",
	memory_auto_improve: "Improve one completed session through the server's approval path",
	memory_briefing: "Read a structured project activity snapshot without a model call",
	memory_consolidate: "Consolidate session observations into memory pages using the configured model",
	memory_delete_page: "Delete one memory page by exact path, only when asked",
	memory_explore: "Read a model-generated digest of project state",
	memory_forget_sweep: "Preview or run memory retention cleanup; inspect the deletion rules first",
	memory_handoff_cancel: "Cancel an open handoff by its exact id",
	memory_install_self_routing: "Get the canonical routing instructions and skill installation payload",
	memory_lint: "Audit memory for stale pages, broken links, duplicates and contradictions",
	memory_message_cancel: "Cancel pending messages this project sent to other inboxes",
	memory_read_session_observations: "Read the raw captured observations of one session",
	memory_restore_page: "Restore an earlier version of a memory page, including a deleted page",
	memory_status: "Read memory counts, runtime status and resolved project scope",
};

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
/** Keep the server's descriptors, order and pagination; change only description prefixes. */
export function mountedTools(all) {
	return all.map(tool => {
		if (!Object.hasOwn(SUMMARIES, tool.name) || typeof tool.description !== "string") return tool;
		return { ...tool, description: `${SUMMARIES[tool.name]}\n\n${tool.description}` };
	});
}

export function startRelay(command, args) {
	const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
	const methods = new Map();
	let stopping = false;
	const out = line => process.stdout.write(`${line}\n`);
	const toChild = line => child.stdin.write(`${line}\n`);

	createInterface({ input: child.stdout }).on("line", line => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			process.stdout.write(`${line}\n`);
			return;
		}
		if (object(message) && message.id !== undefined && message.method === undefined) {
			const method = methods.get(message.id);
			methods.delete(message.id);
			if (method === "tools/list" && Array.isArray(message.result?.tools)) {
				message.result.tools = mountedTools(message.result.tools);
				out(JSON.stringify(message));
				return;
			}
		}
		out(line);
	});

	const input = createInterface({ input: process.stdin });
	input.on("line", line => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			toChild(line);
			return;
		}
		if (object(message) && message.id !== undefined && message.method === "tools/list") {
			methods.set(message.id, message.method);
		}
		toChild(line);
	});

	const stop = code => {
		if (stopping) return;
		stopping = true;
		process.exitCode = code;
		child.stdin.end();
		setTimeout(() => child.kill("SIGKILL"), 1500).unref();
	};
	process.stdin.on("end", () => stop(0));
	process.stdin.on("error", () => stop(1));
	process.stdout.on("error", () => stop(1));
	process.on("SIGTERM", () => stop(0));
	process.on("SIGINT", () => stop(0));
	child.stdin.on("error", () => stop(1));
	child.on("error", error => {
		process.stderr.write(`ai-memory bridge: ${error.message}\n`);
		process.exitCode = 1;
	});
	child.on("close", code => {
		input.close();
		process.stdin.pause();
		process.exitCode ??= code ?? 1;
		process.stdout.end();
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, ...args] = process.argv.slice(2);
	if (!command) {
		process.stderr.write("usage: memory-relay.mjs <ai-memory mcp-bridge command…>\n");
		process.exit(2);
	}
	startRelay(command, args);
}
