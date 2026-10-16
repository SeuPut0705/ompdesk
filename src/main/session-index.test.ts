import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ompPackageRoot } from "./omp-runtime";
import { SessionIndex } from "./session-index";

const stockRoot = ompPackageRoot(path.join(os.homedir(), ".bun", "bin", "omp"));
const tempDirs: string[] = [];
const indexes: SessionIndex[] = [];
const previousAgent = process.env.PI_CODING_AGENT_DIR;

async function makeIndex(): Promise<{ index: SessionIndex; dir: string }> {
	const agent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-index-"));
	tempDirs.push(agent);
	await fs.chmod(agent, 0o700);
	const realAgent = path.join(os.homedir(), ".omp", "agent");
	await fs.copyFile(path.join(realAgent, "config.yml"), path.join(agent, "config.yml")).catch(() => {});
	try {
		await fs.access(path.join(realAgent, "agent.db"));
		execFileSync("sqlite3", [
			path.join(realAgent, "agent.db"),
			`VACUUM INTO '${path.join(agent, "agent.db").replaceAll("'", "''")}'`,
		]);
	} catch {
		/* CI may have no stock database. */
	}
	process.env.PI_CODING_AGENT_DIR = agent;
	const dir = path.join(agent, "sessions");
	const index = new SessionIndex(dir, dir);
	indexes.push(index);
	return { index, dir };
}

async function writeSession(dir: string, id: string, kind?: "chat", titleSlot = true): Promise<string> {
	const projectDir = path.join(dir, "project-x");
	await fs.mkdir(projectDir, { recursive: true });
	const file = path.join(projectDir, `${id}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: dir,
		...(kind ? { kind } : {}),
	};
	await fs.writeFile(
		file,
		`${titleSlot ? `${JSON.stringify({ type: "title", title: "" })}\n` : ""}${JSON.stringify(header)}\n`,
	);
	return file;
}

afterEach(async () => {
	for (const index of indexes.splice(0)) index.stop();
	if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgent;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!stockRoot)("SessionIndex using real stock storage", () => {
	it("keeps GUI kind overlays and handles headers with no title slot", async () => {
		const { index, dir } = await makeIndex();
		const chat = await writeSession(dir, "chat-one", "chat", false);
		await writeSession(dir, "agent-one");
		const infos = await index.list("global");
		expect(infos.find(info => info.id === "chat-one")?.kind).toBe("chat");
		expect(infos.find(info => info.id === "agent-one")?.kind).toBeUndefined();
		expect(await index.kindFor(chat)).toBe("chat");
		expect(await index.kindFor(path.join(dir, "missing.jsonl"))).toBe("agent");
	});

	it("classifies errors, cancellation, truncation and unanswered tools like stock", async () => {
		const { index, dir } = await makeIndex();
		const cases = [
			{ id: "error", stopReason: "error", content: [], expected: "error" },
			{ id: "aborted", stopReason: "aborted", content: [], expected: "aborted" },
			{ id: "length", stopReason: "length", content: [], expected: "interrupted" },
			{
				id: "tool",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "unanswered", name: "bash", arguments: {} }],
				expected: "interrupted",
			},
			{ id: "complete", stopReason: "stop", content: [{ type: "text", text: "done" }], expected: "complete" },
		];
		for (const item of cases) {
			const file = await writeSession(dir, item.id, undefined, false);
			await fs.appendFile(
				file,
				`${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: item.stopReason, content: item.content } })}\n`,
			);
		}
		const infos = await index.list("global");
		for (const item of cases) expect(infos.find(info => info.id === item.id)?.status).toBe(item.expected);
		console.log(
			"Session status before -> stock:",
			cases.map(item => `${item.id}: complete -> ${item.expected}`).join(", "),
		);
	});

	it("refreshes changed files, filters local cwd and suppresses duplicate ids", async () => {
		const { index, dir } = await makeIndex();
		const file = await writeSession(dir, "growing");
		expect((await index.list("global"))[0]?.messageCount).toBe(0);
		await fs.appendFile(
			file,
			`${JSON.stringify({ type: "message", message: { role: "user", content: "next turn" } })}\n`,
		);
		const duplicateDir = path.join(dir, "legacy");
		await fs.mkdir(duplicateDir);
		await fs.copyFile(file, path.join(duplicateDir, "growing.jsonl"));
		const infos = await index.list("local", dir);
		expect(infos).toHaveLength(1);
		expect(infos[0]?.messageCount).toBe(1);
		expect(await index.list("local", os.tmpdir())).toEqual([]);
	});

	it("does not repair orphan backups and deletes session artifacts through stock", async () => {
		const { index, dir } = await makeIndex();
		const session = await writeSession(dir, "s1");
		await fs.mkdir(path.join(path.dirname(session), "s1", "nested"), { recursive: true });
		await fs.writeFile(path.join(path.dirname(session), "s1", "nested", "artifact.txt"), "artifact");
		await fs.copyFile(session, `${session}.123.bak`);
		await fs.copyFile(session, path.join(path.dirname(session), "orphan.jsonl.123.bak"));
		await index.list("global");
		await expect(fs.access(path.join(path.dirname(session), "orphan.jsonl"))).rejects.toThrow();
		await index.deleteSession(session);
		expect((await fs.readdir(path.dirname(session))).sort()).toEqual(["orphan.jsonl.123.bak"]);
		// A file already gone (a session never written, or a second delete) is deleted already.
		await index.deleteSession(session);
		await expect(index.deleteSession("/tmp/not-a-session")).rejects.toThrow("Invalid session path");
	});

	it("exits on stdin EOF even without an app quit handler", async () => {
		const { dir } = await makeIndex();
		const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts")], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, OMP_PACKAGE_ROOT: stockRoot ?? "" },
		});
		const input = createInterface({ input: child.stdout });
		try {
			const reply = once(input, "line");
			child.stdin.write(`${JSON.stringify({ id: 1, method: "sessions.list", params: { sessionsRoot: dir } })}\n`);
			await reply;
			const exited = once(child, "exit");
			child.stdin.end();
			expect(await exited).toEqual([0, null]);
		} finally {
			input.close();
			child.kill();
		}
	});
});

describe("SessionIndex watcher", () => {
	it("reports new session files at both depths and none of the other files beside them", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-watch-"));
		tempDirs.push(dir);
		const artifacts = path.join(dir, "project-x", "session-one");
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "tool-output.md"), "before\n");
		const index = new SessionIndex(dir, dir);
		indexes.push(index);
		let changes = 0;
		index.onChange = () => {
			changes += 1;
		};
		index.start();
		// A real OS watcher, so the order of the writes is the signal: a change for the plan (it should get none)
		// would land before the subagent file's and make the first count 2.
		await fs.writeFile(path.join(artifacts, "plan.md"), "a plan\n");
		await fs.writeFile(path.join(artifacts, "subagent.jsonl"), "{}\n");
		await vi.waitFor(() => expect(changes).toBe(1), { timeout: 5000 });
		await fs.writeFile(path.join(artifacts, "plan.md"), "a longer plan\n");
		await fs.writeFile(path.join(dir, "project-x", "session-two.jsonl"), "{}\n");
		await vi.waitFor(() => expect(changes).toBe(2), { timeout: 5000 });
	});
});
