/**
 * The fake omp keeps writing the stored session it opened, as stock's SessionManager does. It once wrote a
 * resumed journal to a second file named after its own pid: a relaunch that continued a cut-off turn on
 * `--session <file>` then left the original file unanswered and a second session with the same prompt, so the
 * sidebar listed the one conversation twice (the README resume scene).
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE = path.resolve("e2e/sidecar-fixture.ts");

interface Frame {
	type?: string;
	id?: string;
	success?: boolean;
}

interface Fake {
	send(command: Record<string, unknown>): void;
	next(match: (frame: Frame) => boolean): Promise<Frame>;
}

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await Promise.all(
		dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })),
	);
});

async function profile(): Promise<{ agent: string; cwd: string; stored: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-fixture-session-")));
	dirs.push(root);
	const agent = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const stored = path.join(agent, "sessions", "fixture", "stored-1.jsonl");
	await fs.mkdir(path.dirname(stored), { recursive: true });
	await fs.mkdir(cwd);
	// A first turn cut off after its prompt: what a relaunch reopens.
	const lines = [
		{ type: "title", v: 1, title: "", updatedAt: "2026-10-17T00:00:00.000Z" },
		{ type: "session", version: 3, id: "stored-1", timestamp: "2026-10-17T00:00:00.000Z", cwd },
		{
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-10-17T00:00:01.000Z",
			message: { role: "user", content: "Move the checkout page", timestamp: 1792195201000 },
		},
	];
	await fs.writeFile(stored, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return { agent, cwd, stored };
}

async function start(agent: string, cwd: string, args: string[]): Promise<Fake> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, { PI_CODING_AGENT_DIR: agent, OMP_GUI_TEST_SESSION_FILES: "1" });
	for (const key of ["OMP_GUI_BRIDGE", "OMP_GUI_TEST_RECORD", "OMP_GUI_README_SCENE"])
		Reflect.deleteProperty(env, key);
	const child = spawn("bun", [FIXTURE, "--mode", "rpc-ui", ...args], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
	children.push(child);
	const frames: Frame[] = [];
	const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
	createInterface({ input: child.stdout }).on("line", line => {
		const frame = JSON.parse(line) as Frame;
		frames.push(frame);
		for (const waiter of waiters.splice(0)) {
			if (waiter.match(frame)) waiter.resolve(frame);
			else waiters.push(waiter);
		}
	});
	const fake: Fake = {
		send: command => child.stdin.write(`${JSON.stringify(command)}\n`),
		next: match => {
			const seen = frames.find(match);
			if (seen) return Promise.resolve(seen);
			const { promise, resolve } = Promise.withResolvers<Frame>();
			waiters.push({ match, resolve });
			return promise;
		},
	};
	await fake.next(frame => frame.type === "ready");
	return fake;
}

/** One prompt answered: its `agent_end` is out once the answer is in the journal. */
async function answer(fake: Fake): Promise<void> {
	fake.send({ type: "prompt", message: "hello", id: "p1" });
	await fake.next(frame => frame.type === "agent_end");
}

async function sessionFiles(agent: string): Promise<string[]> {
	return (await fs.readdir(path.join(agent, "sessions", "fixture"))).sort();
}

/** One line of a session file, as the fake writes it. */
interface JournalLine {
	type?: string;
	message?: { role?: string };
	[key: string]: unknown;
}

async function journal(file: string): Promise<JournalLine[]> {
	const lines: JournalLine[] = [];
	for (const line of (await fs.readFile(file, "utf8")).split("\n")) if (line) lines.push(JSON.parse(line));
	return lines;
}

/** The roles of the journal's messages, in order. */
async function roles(file: string): Promise<Array<string | undefined>> {
	return (await journal(file)).flatMap(line => (line.type === "message" ? [line.message?.role] : []));
}

describe("fake omp session file", () => {
	it("writes a turn on a session opened with --session into that file, under its own header", async () => {
		const { agent, cwd, stored } = await profile();
		const fake = await start(agent, cwd, ["--session", stored]);
		await answer(fake);

		expect(await sessionFiles(agent)).toEqual(["stored-1.jsonl"]);
		expect((await journal(stored)).find(line => line.type === "session")).toEqual({
			type: "session",
			version: 3,
			id: "stored-1",
			timestamp: "2026-10-17T00:00:00.000Z",
			cwd,
		});
		expect(await roles(stored)).toEqual(["user", "user", "assistant"]);
	});

	it("writes a turn after switch_session into the stored file", async () => {
		const { agent, cwd, stored } = await profile();
		const fake = await start(agent, cwd, []);
		fake.send({ type: "switch_session", sessionPath: stored, id: "s1" });
		expect(await fake.next(frame => frame.id === "s1")).toMatchObject({ success: true });
		await answer(fake);

		expect(await sessionFiles(agent)).toEqual(["stored-1.jsonl"]);
		expect(await roles(stored)).toEqual(["user", "user", "assistant"]);
	});
});
