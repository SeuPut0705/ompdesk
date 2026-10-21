import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompPackageRoot } from "./omp-runtime";
import { SessionIndex } from "./session-index";

const stockRoot = ompPackageRoot(path.join(os.homedir(), ".bun", "bin", "omp"));
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

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

async function sessionsRoot(): Promise<{ dir: string; project: string }> {
	agent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-activity-"));
	await fs.chmod(agent, 0o700);
	process.env.PI_CODING_AGENT_DIR = agent;
	const dir = path.join(agent, "sessions");
	const project = path.join(dir, "project-x");
	await fs.mkdir(project, { recursive: true });
	return { dir, project };
}

async function writeJournal(file: string, lines: unknown[]): Promise<void> {
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	// The file was just written by a relaunch: its mtime is now.
	const now = new Date();
	await fs.utimes(file, now, now);
}

function header(id: string, at: number, cwd: string): unknown[] {
	return [
		{ type: "title", v: 1, title: "" },
		{ type: "session", version: 3, id, timestamp: iso(at), cwd },
	];
}

function message(id: string, at: number, body: Record<string, unknown>, journaledAt = at): unknown {
	return { type: "message", id, parentId: null, timestamp: iso(journaledAt), message: { ...body, timestamp: at } };
}

describe.skipIf(!stockRoot)("SessionIndex last activity", () => {
	it("lists when the conversation last moved, not when a relaunch last wrote the file", async () => {
		const { dir, project } = await sessionsRoot();
		const asked = Date.now() - 3 * DAY;
		const answered = asked + 60_000;
		const cut = answered + 60_000;
		await writeJournal(path.join(project, "idle.jsonl"), [
			...header("idle", asked, dir),
			message("u1", asked, { role: "user", content: [{ type: "text", text: "Create notes.txt." }] }),
			message("a1", answered, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] }),
			// What a quit and the next launch append to a session that did nothing: the turn the quit cut (stock's
			// interrupted-turn record keeps the time it was cut, journaled at the relaunch), usage, a title, an idle
			// recap, a report and a restart notice from another session, the process exit.
			message(
				"a2",
				cut,
				{ role: "assistant", stopReason: "aborted", errorMessage: "interrupted", content: [] },
				Date.now(),
			),
			{ type: "model_usage", id: "mu", parentId: "a2", timestamp: iso(Date.now()) },
			{ type: "title_change", id: "tc", parentId: "mu", timestamp: iso(Date.now()), title: "Notes" },
			{
				type: "custom_message",
				customType: "recap",
				content: "Created notes.txt.",
				display: true,
				timestamp: iso(Date.now()),
			},
			{
				type: "custom_message",
				customType: "ompdesk.mail",
				content: "<ompdesk-mail>done</ompdesk-mail>",
				display: true,
				timestamp: iso(Date.now()),
			},
			{
				type: "custom_message",
				customType: "ompdesk-restart-jobs",
				content: "restart",
				display: true,
				timestamp: iso(Date.now()),
			},
			{ type: "custom", customType: "session_exit", data: { kind: "normal" }, timestamp: iso(Date.now()) },
		]);
		index = new SessionIndex(dir, dir);
		const [info] = await index.list("global");
		expect(info?.id).toBe("idle");
		expect(Date.parse(info!.modified)).toBe(cut);
	});

	it("reads back past a reply larger than the first window", async () => {
		const { dir, project } = await sessionsRoot();
		const answered = Date.now() - 2 * DAY;
		await writeJournal(path.join(project, "big.jsonl"), [
			...header("big", answered - 60_000, dir),
			message("u1", answered - 60_000, { role: "user", content: [{ type: "text", text: "Read the log." }] }),
			message("a1", answered, {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "x".repeat(300 * 1024) }],
			}),
			{ type: "custom", customType: "session_exit", data: { kind: "normal" }, timestamp: iso(Date.now()) },
		]);
		index = new SessionIndex(dir, dir);
		const [info] = await index.list("global");
		expect(Date.parse(info!.modified)).toBe(answered);
	});

	it("keeps the file's time for a session with no message in its journal", async () => {
		const { dir, project } = await sessionsRoot();
		const file = path.join(project, "notice.jsonl");
		const then = new Date(Date.now() - 5 * DAY);
		await fs.writeFile(
			file,
			`${[
				...header("notice", then.getTime(), dir),
				{ type: "custom_message", customType: "recap", content: "Nothing yet.", display: true },
			]
				.map(line => JSON.stringify(line))
				.join("\n")}\n`,
		);
		await fs.utimes(file, then, then);
		index = new SessionIndex(dir, dir);
		const [info] = await index.list("global");
		expect(info?.id).toBe("notice");
		expect(Date.parse(info!.modified)).toBe(then.getTime());
	});
});
