/**
 * `sessions.createNamed` on the installed omp (skipped without one): the bot's session (agent-control/bot-home.ts) is
 * stock's `createEmptySessionFile` plus stock's own title rename in a private HOME and agent dir. Pins what the bot
 * relies on: stock's session list shows it, with the title and the folder it was made for, and no omp agent ran.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { ompPackageRoot, systemOmp } from "./omp-runtime";

const stock = await systemOmp();
const packageRoot = stock.ok ? ompPackageRoot(stock.runtime.bin) : null;
const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-named-"));
const agentDir = path.join(home, "agent");
const sessionsRoot = path.join(agentDir, "sessions");
const work = path.join(home, "work");
let child: ChildProcessWithoutNullStreams | null = null;

afterAll(async () => {
	child?.kill();
	await fs.rm(home, { recursive: true, force: true });
});

async function call(method: string, params: unknown): Promise<{ result?: unknown; error?: string }> {
	if (!child) {
		child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts")], {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				OMP_PACKAGE_ROOT: packageRoot ?? "",
				PI_NOTIFICATIONS: "off",
			},
		});
		child.stderr.resume();
	}
	const lines = createInterface({ input: child.stdout });
	const reply = once(lines, "line");
	child.stdin.write(`${JSON.stringify({ id: 1, method, params })}\n`);
	const [line] = await reply;
	lines.close();
	return JSON.parse(String(line));
}

describe.skipIf(!packageRoot)("sessions.createNamed on the installed omp", () => {
	it("makes a titled session stock's own list shows, in the folder it was made for", async () => {
		await fs.mkdir(work, { recursive: true });
		const made = await call("sessions.createNamed", { sessionsRoot, cwd: work, title: " Bot " });
		expect(made.error).toBeUndefined();
		const { sessionPath, sessionId } = made.result as { sessionPath: string; sessionId: string };
		expect(sessionPath.startsWith(`${sessionsRoot}${path.sep}`)).toBe(true);
		const listed = (await call("sessions.list", { sessionsRoot })).result as {
			path: string;
			id: string;
			title: string | null;
			cwd: string;
			messageCount: number;
		}[];
		expect(listed.filter(row => row.path === sessionPath)).toEqual([
			expect.objectContaining({ id: sessionId, title: "Bot", cwd: work, messageCount: 0 }),
		]);
	}, 60_000);

	it("refuses a folder that is not absolute and a title that is blank, making no file", async () => {
		const before = (await call("sessions.list", { sessionsRoot })).result as unknown[];
		expect((await call("sessions.createNamed", { sessionsRoot, cwd: "work", title: "Bot" })).error).toMatch(
			/Invalid session folder/,
		);
		expect((await call("sessions.createNamed", { sessionsRoot, cwd: work, title: "  " })).error).toMatch(
			/Invalid session title/,
		);
		expect((await call("sessions.list", { sessionsRoot })).result).toEqual(before);
	}, 60_000);
});
