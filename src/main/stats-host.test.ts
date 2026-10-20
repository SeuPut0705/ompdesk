/**
 * resources/gui-bridge/stats-host.ts exits when the app's stdin pipe closes, even while it is still starting.
 * Seen: 22 stats hosts left running for days with ppid 1, never listening, their stdin's other end gone: a
 * start that never finished had not yet attached the stdin shutdown.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fakePackage(root: string, name: string, exports: Record<string, string>, source: string) {
	const dir = path.join(root, "node_modules", "@oh-my-pi", name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: `@oh-my-pi/${name}`, type: "module", exports }),
	);
	await fs.writeFile(path.join(dir, "index.ts"), source);
}

it("exits when stdin closes while stock's server never finishes starting", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-stats-host-hang-"));
	tempDirs.push(root);
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fake-agent" }));
	const started = path.join(root, "started");
	await fakePackage(
		root,
		"omp-stats",
		{ ".": "./index.ts", "./db": "./index.ts", "./aggregator": "./index.ts", "./live": "./index.ts" },
		`export async function startServer() { await Bun.write(${JSON.stringify(started)}, ""); return new Promise(() => {}); }
export function closeDb() {}
export function getTimeRangeConfig() { return {}; }
export const statsLive = () => ({ start() {} });
`,
	);
	await fakePackage(
		root,
		"pi-coding-agent",
		{ "./judgment/standalone": "./index.ts" },
		"export async function openStandaloneJudge() { return { judge: null }; }\n",
	);
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stats-host.ts"), "127.0.0.1", "0"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, OMP_PACKAGE_ROOT: root },
	});
	children.push(child);
	child.stdout.resume();
	child.stderr.resume();
	await expect
		.poll(
			() =>
				fs.access(started).then(
					() => true,
					() => false,
				),
			{ timeout: 10_000 },
		)
		.toBe(true);

	child.stdin.end();
	await expect.poll(() => child.exitCode, { timeout: 5_000 }).toBe(0);
}, 30_000);
