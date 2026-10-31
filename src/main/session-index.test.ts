import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { BOT_ENABLED_PREF, BOT_PREF, botRowOf } from "../shared/agent-control";
import { deletedSessions, initDeletedSessions } from "./deleted-sessions";
import { ompPackageRoot } from "./omp-runtime";
import { SessionIndex } from "./session-index";

const stockRoot = ompPackageRoot(path.join(os.homedir(), ".bun", "bin", "omp"));
const tempDirs: string[] = [];
const indexes: SessionIndex[] = [];
const previousAgent = process.env.PI_CODING_AGENT_DIR;

async function makeIndex(prefs?: Map<string, unknown>): Promise<{ index: SessionIndex; dir: string }> {
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
	const index = new SessionIndex(dir, dir, undefined, undefined, sessionPath =>
		prefs ? botRowOf(sessionPath, key => prefs.get(key)) : null,
	);
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

	it("lists no bot session while the bot is off and flags it as the bot once it is on", async () => {
		const prefs = new Map<string, unknown>();
		const { index, dir } = await makeIndex(prefs);
		const bot = await writeSession(dir, "bot-one", "chat");
		await writeSession(dir, "chat-one", "chat");
		prefs.set(BOT_PREF, bot);
		expect((await index.list("global")).map(info => [info.id, info.bot])).toEqual([["chat-one", undefined]]);
		prefs.set(BOT_ENABLED_PREF, true);
		index.relist();
		const rows = await index.list("global");
		expect(rows.map(info => [info.id, info.bot]).sort()).toEqual([
			["bot-one", true],
			["chat-one", undefined],
		]);
	});

	it("reads each listed session's header once for the legacy chat flag, again only for another session there", async () => {
		const { index, dir } = await makeIndex();
		const file = await writeSession(dir, "chat-one", "chat", false);
		expect((await index.list("global"))[0]?.kind).toBe("chat");
		// The same session's header is not read again: a list asked for after every append reads no file heads.
		const header = { type: "session", version: 3, id: "chat-one", timestamp: new Date().toISOString(), cwd: dir };
		await fs.writeFile(file, `${JSON.stringify(header)}\n`);
		expect((await index.list("global"))[0]?.kind).toBe("chat");
		// Another session at that path is.
		await fs.writeFile(file, `${JSON.stringify({ ...header, id: "agent-two" })}\n`);
		const infos = await index.list("global");
		expect(infos.map(info => [info.id, info.kind])).toEqual([["agent-two", undefined]]);
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

	it("never lists a deleted session that a stray writer put back on disk", async () => {
		const { index, dir } = await makeIndex();
		const session = await writeSession(dir, "revenant");
		initDeletedSessions(null);
		deletedSessions().add(session);
		const listed = await index.list("global");
		initDeletedSessions(null);
		expect(listed.map(info => info.path)).not.toContain(session);
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
	/** Per awaited report: a real OS watcher, run beside a full gate (tsc, the build, the whole suite) on this Mac. */
	const REPORT_MS = 10_000;
	/** Recorded for a report without a path: anything may have changed. */
	const ANYTHING = "(anything)";

	async function sessionsRoot(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-watch-"));
		tempDirs.push(dir);
		return dir;
	}

	/** A started index on `dir` that records every path it reports. */
	function watchSessions(dir: string) {
		const index = new SessionIndex(dir, dir);
		indexes.push(index);
		const reports: string[] = [];
		const wakers = new Set<() => void>();
		index.onChange = changed => {
			reports.push(changed ?? ANYTHING);
			for (const wake of wakers) wake();
		};
		index.start();
		// Resolves on the report itself; the timer is only the deadline. No fake clock: the OS watcher runs on real time.
		const reportedWithin = (file: string, ms: number) =>
			new Promise<boolean>(done => {
				const finish = (value: boolean) => {
					clearTimeout(timer);
					wakers.delete(check);
					done(value);
				};
				const check = () => {
					if (reports.includes(file)) finish(true);
				};
				const timer = setTimeout(() => finish(false), ms);
				wakers.add(check);
				check();
			});
		return {
			reports,
			/** The OS starts delivering a moment after start() (FSEvents on macOS): a probe is rewritten until reported. */
			async live(): Promise<void> {
				const probe = path.join(dir, "probe.jsonl");
				const deadline = performance.now() + REPORT_MS;
				do await fs.appendFile(probe, "{}\n");
				while (!(await reportedWithin(probe, 1000)) && performance.now() < deadline);
				expect(reports).toContain(probe);
			},
			/** Each file is reported within REPORT_MS (one deadline for all). */
			async reported(...files: string[]): Promise<void> {
				await Promise.all(files.map(file => reportedWithin(file, REPORT_MS)));
				expect(reports).toEqual(expect.arrayContaining(files));
			},
		};
	}

	it("reports new session files at both depths and none of the other files beside them", {
		timeout: 3 * REPORT_MS + 5000,
	}, async () => {
		const dir = await sessionsRoot();
		const artifacts = path.join(dir, "project-x", "session-one");
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "tool-output.md"), "before\n");
		const watch = watchSessions(dir);
		await watch.live();
		// Each other file is written before a session file beside it, so a report for it would come first.
		await fs.writeFile(path.join(artifacts, "plan.md"), "a plan\n");
		await fs.writeFile(path.join(artifacts, "subagent.jsonl"), "{}\n");
		await watch.reported(path.join(artifacts, "subagent.jsonl"));
		await fs.writeFile(path.join(artifacts, "plan.md"), "a longer plan\n");
		await fs.appendFile(path.join(artifacts, "tool-output.md"), "after\n");
		await fs.writeFile(path.join(dir, "project-x", "session-two.jsonl"), "{}\n");
		await watch.reported(path.join(dir, "project-x", "session-two.jsonl"));
		expect(watch.reports.filter(file => file.endsWith(".md"))).toEqual([]);
	});

	// chokidar watched each directory on its own; on macOS every new one recreated libuv's single FSEvents stream, and
	// about one session file in a hundred written into a new directory under load went unreported until the next write.
	it("reports session files written the moment their project or session directory is made", {
		timeout: 2 * REPORT_MS + 5000,
	}, async () => {
		const dir = await sessionsRoot();
		await fs.mkdir(path.join(dir, "project-x"));
		const watch = watchSessions(dir);
		await watch.live();
		const files: string[] = [];
		for (let n = 0; n < 6; n++) {
			const project = path.join(dir, `project-${n}`);
			const artifacts = path.join(dir, "project-x", `session-${n}`);
			files.push(path.join(project, `session-${n}.jsonl`), path.join(artifacts, `subagent-${n}.jsonl`));
			await fs.mkdir(project);
			await fs.writeFile(path.join(project, `session-${n}.jsonl`), "{}\n");
			await fs.mkdir(artifacts);
			await fs.writeFile(path.join(artifacts, `subagent-${n}.jsonl`), "{}\n");
		}
		await watch.reported(...files);
	});

	it("reports a project directory renamed with its sessions in it", { timeout: 2 * REPORT_MS + 5000 }, async () => {
		const dir = await sessionsRoot();
		await fs.mkdir(path.join(dir, "project-old"));
		await fs.writeFile(path.join(dir, "project-old", "session.jsonl"), "{}\n");
		const watch = watchSessions(dir);
		await watch.live();
		// Stock's cwd-encoding migration moves a whole project directory: no session file event of its own.
		await fs.rename(path.join(dir, "project-old"), path.join(dir, "project-new"));
		await watch.reported(path.join(dir, "project-new"));
	});

	it("starts reporting once a missing sessions root is made", { timeout: 3 * REPORT_MS + 5000 }, async () => {
		const dir = path.join(await sessionsRoot(), "sessions");
		const watch = watchSessions(dir);
		// omp makes the root, a project and its first session together: a fresh list has to find that one.
		await fs.mkdir(path.join(dir, "project-x"), { recursive: true });
		await fs.writeFile(path.join(dir, "project-x", "first.jsonl"), "{}\n");
		await watch.reported(ANYTHING);
		await watch.live();
		await fs.writeFile(path.join(dir, "project-x", "second.jsonl"), "{}\n");
		await watch.reported(path.join(dir, "project-x", "second.jsonl"));
	});
});
