import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { ompPackageRoot } from "./omp-runtime";

const stockRoot = ompPackageRoot(path.join(os.homedir(), ".bun", "bin", "omp"));
const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function bun(args: string[], env: Record<string, string>): ChildProcessWithoutNullStreams {
	const child = spawn("bun", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
	children.push(child);
	return child;
}

describe.skipIf(!stockRoot)("sessions.owned against stock's ownership lease (installed omp)", () => {
	it("says a session is owned while another process holds its lease, and free once that process is gone", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-owned-"));
		dirs.push(dir);
		const sessionsRoot = path.join(dir, "sessions");
		await fs.mkdir(path.join(sessionsRoot, "-p"), { recursive: true });
		const sessionPath = path.join(sessionsRoot, "-p", "2026-10-23T00-00-00-000Z_owned-1.jsonl");
		const env = { OMP_PACKAGE_ROOT: stockRoot ?? "", PI_TEST_SESSION_OWNERS_DIR: path.join(dir, "owners") };
		// A titled journal as stock writes it: its fixed-width title slot first, then the session header.
		const titleSlot = path.join(stockRoot ?? "", "src", "session", "session-title-slot.ts");
		const writer = bun(
			[
				"-e",
				`const { serializeTitleSlot } = await import(${JSON.stringify(titleSlot)}); await Bun.write(${JSON.stringify(sessionPath)}, serializeTitleSlot({ title: "Autopilot run", source: "auto", updatedAt: "2026-10-23T00:00:00.000Z" }) + ${JSON.stringify(`${JSON.stringify({ type: "session", id: "owned-1", cwd: dir })}\n`)});`,
			],
			env,
		);
		expect((await once(writer, "exit"))[0]).toBe(0);
		expect((await fs.readFile(sessionPath, "utf8")).split("\n")[0]).not.toContain('"type":"session"');

		const helper = bun([path.resolve("resources/gui-bridge/stock-helper/host.ts")], env);
		const lines = createInterface({ input: helper.stdout });
		let id = 0;
		const owned = async (): Promise<unknown> => {
			const reply = once(lines, "line");
			helper.stdin.write(
				`${JSON.stringify({ id: ++id, method: "sessions.owned", params: { sessionsRoot, sessionPath } })}\n`,
			);
			const [line] = await reply;
			const answer = JSON.parse(String(line)) as { result?: unknown; error?: unknown };
			if (answer.error) throw new Error(String(answer.error));
			return answer.result;
		};
		expect(await owned()).toBe(false);

		// Another omp's hold, the way stock takes it when a session is opened (`FileSessionStorage.claimSession`).
		const storage = path.join(stockRoot ?? "", "src", "session", "session-storage.ts");
		const holder = bun(
			[
				"-e",
				`const { tryAcquireSessionLease } = await import(${JSON.stringify(storage)}); const lease = tryAcquireSessionLease("owned-1"); console.log(lease ? "held" : "busy"); await new Promise(() => {});`,
			],
			env,
		);
		const [held] = await once(createInterface({ input: holder.stdout }), "line");
		expect(String(held)).toBe("held");
		expect(await owned()).toBe(true);

		const exited = once(holder, "exit");
		holder.kill();
		await exited;
		expect(await owned()).toBe(false);
		lines.close();
	}, 30_000);
});
