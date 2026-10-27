/**
 * The fake ai-memory's detached server (`__serve`) never outlives its test. It is detached like a real service, so
 * no app or worker exit reaches it on macOS: 49 servers from a week of e2e runs were found alive with their data dirs
 * long deleted. It ends itself once its data dir is gone or the worker that installed the fake no longer runs.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixtureAiMemory, stopFakeServer } from "./fake-ai-memory-install";

const homes: string[] = [];
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(homes.splice(0).map(home => stopFakeServer(home)));
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Run the installed fake's `setup` (which starts the detached server) and return the server's pid. */
async function startServer(env: Record<string, string> = {}) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-ai-memory-")));
	roots.push(root);
	const home = path.join(root, "home");
	homes.push(home);
	await fs.mkdir(path.join(root, "agent"), { recursive: true });
	const memory = await fixtureAiMemory(root);
	const setup = spawnSync(memory.bin, ["setup", "--yes", "--agent", "omp"], {
		env: { ...process.env, ...memory.env, HOME: home, PI_CODING_AGENT_DIR: path.join(root, "agent"), ...env },
		encoding: "utf8",
	});
	expect(setup.stdout).toContain("setup complete");
	const pid = Number(await fs.readFile(path.join(home, ".fake-ai-memory", "server.pid"), "utf8"));
	expect(alive(pid)).toBe(true);
	return { pid, home };
}

// The specs that install this fake run on macOS (Windows CI runs vitest only, `test:platform`), where the leak was
// found; on windows-latest its `ai-memory.cmd` launcher printed nothing when spawned from a vitest worker.
const posix = it.skipIf(process.platform === "win32");

posix(
	"the server ends once its data dir is gone (the spec's teardown)",
	async () => {
		const { pid, home } = await startServer();
		await fs.rm(path.join(home, "ai-memory-data"), { recursive: true, force: true });
		await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
	},
	20_000,
);

posix(
	"the server ends once the worker that installed the fake is gone, its data dir still there",
	async () => {
		const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const { pid, home } = await startServer({ FAKE_AI_MEMORY_OWNER_PID: String(owner.pid) });
		// Real time on purpose: the server is another process checking once a second; past one check it must still run.
		await new Promise(resolve => setTimeout(resolve, 1_500));
		expect(alive(pid)).toBe(true);
		owner.kill();
		await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
		await expect(fs.stat(path.join(home, "ai-memory-data"))).resolves.toBeTruthy();
	},
	20_000,
);
