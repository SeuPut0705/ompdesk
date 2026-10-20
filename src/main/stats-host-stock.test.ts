/**
 * resources/gui-bridge/stats-host.ts on the real omp: the GUI's stats server keeps stock's stats database current
 * by itself. Stock omp-stats ingests sessions only once a dashboard page subscribes to its live events
 * (`/api/events` starts `statsLive()`); `omp stats` always opens that page, the GUI never does, so the database
 * stopped at whatever the last browser dashboard or `omp stats` run left (seen: 5 days stale).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const realRoot = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
	// Wait for each host to exit: on Windows its open stats.db keeps the home folder from being removed.
	await Promise.all(
		children.splice(0).map(
			child =>
				new Promise<void>(resolve => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
					child.kill();
				}),
		),
	);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** One stock assistant reply with usage, as the session journal records it. */
function reply(id: string, parentId: string, at: number): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: at,
		},
	});
}

/**
 * The stats host with its home at `home` (HOME, and USERPROFILE, which Windows reads instead), so stock reads
 * `<home>/.omp/agent/sessions` and writes `<home>/.omp/stats.db`.
 */
async function startHost(home: string): Promise<string> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		OMP_PACKAGE_ROOT: realRoot,
	};
	for (const key of ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME"])
		delete env[key];
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stats-host.ts"), "127.0.0.1", "0"], {
		stdio: ["pipe", "pipe", "pipe"],
		env,
	});
	children.push(child);
	child.stderr.resume();
	let out = "";
	return await new Promise<string>((resolve, reject) => {
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
			const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
			if (match) resolve(`http://127.0.0.1:${match[1]}`);
		});
		child.on("exit", code => reject(new Error(`stats host exited (${code}): ${out}`)));
	});
}

async function requestCount(origin: string): Promise<number | undefined> {
	const body: unknown = await (await fetch(`${origin}/api/stats/requests?range=all`)).json();
	return body && typeof body === "object" && "total" in body && typeof body.total === "number"
		? body.total
		: undefined;
}

describe.skipIf(!existsSync(path.join(realRoot, "package.json")))("the stats host on the real omp", () => {
	it("ingests the sessions on disk and every reply written after it started, with no dashboard page open", async () => {
		const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-stats-host-")));
		tempDirs.push(home);
		const sessions = path.join(home, ".omp", "agent", "sessions", "-tmp-project");
		await fs.mkdir(sessions, { recursive: true });
		const file = path.join(sessions, "2026-10-20T00-00-00-000Z_0199a000-0000-7000-8000-000000000001.jsonl");
		const start = Date.now() - 60_000;
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "0199a000-0000-7000-8000-000000000001",
			timestamp: new Date(start).toISOString(),
			cwd: "/tmp/project",
		});
		await fs.writeFile(file, `${header}\n${reply("a0000001", "", start)}\n`);

		const origin = await startHost(home);
		await expect.poll(() => requestCount(origin), { timeout: 20_000, interval: 250 }).toBe(1);

		await fs.appendFile(file, `${reply("a0000002", "a0000001", Date.now())}\n`);
		await expect.poll(() => requestCount(origin), { timeout: 20_000, interval: 250 }).toBe(2);
	}, 60_000);
});
