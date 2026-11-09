import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_TEXT_PROMPT } from "../../resources/gui-bridge/session-list-contracts";
import { ompPackageRoot } from "./omp-runtime";
import { SessionIndex } from "./session-index";
import { INSTALLED_OMP } from "./test-bridge-probe";

const stockRoot = ompPackageRoot(INSTALLED_OMP);
const previousAgent = process.env.PI_CODING_AGENT_DIR;
let agent: string | undefined;
let index: SessionIndex | undefined;

afterEach(async () => {
	index?.stop();
	index = undefined;
	if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgent;
	if (agent) await fs.rm(agent, { recursive: true, force: true });
	agent = undefined;
});

describe.skipIf(!stockRoot)("SessionIndex first prompt", () => {
	it("lists the first prompt that stock persists after a long xd:// mount notice", async () => {
		agent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-first-prompt-"));
		await fs.chmod(agent, 0o700);
		process.env.PI_CODING_AGENT_DIR = agent;
		const dir = path.join(agent, "sessions");
		const project = path.join(dir, "project-x");
		await fs.mkdir(project, { recursive: true });
		// The shape a real GUI session has with the built-in REA MCP server mounted:
		// stock writes its tool inventory notice (tens of KB) before the first prompt.
		const tools = Array.from({ length: 170 }, (_, n) => `- xd://mcp__rea_tool_${n} — ${"Analyze ".repeat(20)}`);
		const lines = [
			{ type: "title", v: 1, title: "" },
			{ type: "session", version: 3, id: "rea", timestamp: new Date().toISOString(), cwd: dir },
			{
				type: "custom_message",
				customType: "xdev-mount-notice",
				content: `<system-notice>\nxd:// device inventory changed.\n${tools.join("\n")}\n</system-notice>`,
				display: false,
			},
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "text", text: "Create the file notes.txt containing alpha." }] },
			},
			{
				type: "message",
				id: "a1",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] },
			},
		];
		await fs.writeFile(path.join(project, "rea.jsonl"), `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		index = new SessionIndex(dir, dir);
		const [info] = await index.list("global");
		expect(info?.firstMessage).toBe("Create the file notes.txt containing alpha.");
	});

	// A paired device's agent opened the session on this computer: its first prompt is that agent's brief and the
	// bridge's prompt-origin entry names the device. The bridge journals it on the prompt's `message_end`, so after the
	// prompt (the fixture had it in front, which the bridge never writes: the read stopped at the prompt and missed it).
	// The sidebar must tell such a session from a child of a session listed here.
	it("reports the device the first prompt came from, journaled after it, behind a long notice or not", async () => {
		agent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-first-prompt-"));
		await fs.chmod(agent, 0o700);
		process.env.PI_CODING_AGENT_DIR = agent;
		const dir = path.join(agent, "sessions");
		const project = path.join(dir, "project-x");
		await fs.mkdir(project, { recursive: true });
		const notice = {
			type: "custom_message",
			customType: "xdev-mount-notice",
			content: `<system-notice>\n${"- xd://tool — Analyze\n".repeat(400)}</system-notice>`,
			display: false,
		};
		const brief = '<ompdesk-agent-message from="Mac session">\nTitle: Measure\n\nDo it.\n</ompdesk-agent-message>';
		const origin = {
			type: "custom",
			customType: "ompdesk.prompt-origin",
			data: { deviceId: "mac-1", name: "Mac", timestamp: 1 },
		};
		const prompt = { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: brief }] } };
		const answer = {
			type: "message",
			id: "a1",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Ok." }] },
		};
		const journal = (id: string, entries: readonly object[]) =>
			[
				{ type: "title", v: 1, title: "" },
				{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir },
				...entries,
			]
				.map(line => JSON.stringify(line))
				.join("\n");
		await fs.writeFile(path.join(project, "long.jsonl"), `${journal("long", [notice, prompt, origin, answer])}\n`);
		await fs.writeFile(path.join(project, "short.jsonl"), `${journal("short", [prompt, origin, answer])}\n`);
		await fs.writeFile(path.join(project, "here.jsonl"), `${journal("here", [notice, prompt, answer])}\n`);
		// A device's prompt later in a session this computer started does not make the device its opener.
		await fs.writeFile(path.join(project, "later.jsonl"), `${journal("later", [prompt, answer, origin])}\n`);
		index = new SessionIndex(dir, dir);
		const rows = await index.list("global");
		const byId = Object.fromEntries(rows.map(row => [row.id, row]));
		expect(byId.long?.promptOriginDevice).toBe("mac-1");
		expect(byId.short?.promptOriginDevice).toBe("mac-1");
		expect(byId.here?.promptOriginDevice).toBeUndefined();
		expect(byId.later?.promptOriginDevice).toBeUndefined();
		expect(byId.long?.firstMessage).toContain("ompdesk-agent-message");
	});

	// The file stock writes when the last chat is deleted and the next one starts (header and
	// settings entries only). Stock's listing reads "(no messages)", which the sidebar took for
	// content, so the row came back after every delete.
	it("lists a header-only session with no first message", async () => {
		agent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-first-prompt-"));
		await fs.chmod(agent, 0o700);
		process.env.PI_CODING_AGENT_DIR = agent;
		const dir = path.join(agent, "sessions");
		const project = path.join(dir, "project-x");
		await fs.mkdir(project, { recursive: true });
		const at = new Date().toISOString();
		const lines = [
			{ type: "title", v: 1, title: "", updatedAt: at },
			{ type: "session", version: 3, id: "empty", timestamp: at, cwd: dir },
			{ type: "thinking_level_change", id: "t1", parentId: null, timestamp: at, thinkingLevel: "high" },
			{ type: "service_tier_change", id: "s1", parentId: "t1", timestamp: at, serviceTier: null },
		];
		await fs.writeFile(path.join(project, "empty.jsonl"), `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		index = new SessionIndex(dir, dir);
		const [info] = await index.list("global");
		expect(info?.id).toBe("empty");
		expect(info?.firstMessage).toBe("");
		expect(info?.messageCount).toBe(0);
	});

	// An image-only prompt has no text, and after a long mount notice stock's 4 KB prefix also
	// counts no messages: the row must stay listed, not be taken for an empty session.
	it("keeps a session whose only prompt is an image behind a long mount notice", async () => {
		agent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-first-prompt-"));
		await fs.chmod(agent, 0o700);
		process.env.PI_CODING_AGENT_DIR = agent;
		const dir = path.join(agent, "sessions");
		const project = path.join(dir, "project-x");
		await fs.mkdir(project, { recursive: true });
		const tools = Array.from({ length: 170 }, (_, n) => `- xd://mcp__rea_tool_${n} — ${"Analyze ".repeat(20)}`);
		const lines = [
			{ type: "title", v: 1, title: "" },
			{ type: "session", version: 3, id: "image", timestamp: new Date().toISOString(), cwd: dir },
			{
				type: "custom_message",
				customType: "xdev-mount-notice",
				content: `<system-notice>\n${tools.join("\n")}\n</system-notice>`,
				display: false,
			},
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
			},
			{
				type: "message",
				id: "a1",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "A small image." }] },
			},
		];
		await fs.writeFile(path.join(project, "image.jsonl"), `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		index = new SessionIndex(dir, dir);
		const [info] = await index.list("global");
		expect(info?.id).toBe("image");
		expect(info?.firstMessage).toBe(NO_TEXT_PROMPT);
	});
});
