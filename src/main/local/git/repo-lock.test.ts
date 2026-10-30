import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StepStalledError } from "../../serial-chain";
import { execBin, REPO_LOCK_HOLD_MS, withRepoLock } from "./exec";

const NEVER = () => Promise.withResolvers<never>().promise;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("withRepoLock", () => {
	let dir: string;
	beforeEach(async () => {
		vi.useFakeTimers();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-lock-"));
	});
	afterEach(async () => {
		vi.useRealTimers();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("runs the mutations of one repository one after another and the repositories side by side", async () => {
		const order: string[] = [];
		const gate = Promise.withResolvers<void>();
		const first = withRepoLock("/repo/a", async () => {
			order.push("a1 start");
			await gate.promise;
			order.push("a1 end");
		});
		const second = withRepoLock("/repo/a", async () => {
			order.push("a2");
		});
		const other = withRepoLock("/repo/b", async () => {
			order.push("b");
		});
		await other;
		expect(order).toEqual(["a1 start", "b"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["a1 start", "b", "a1 end", "a2"]);
	});

	it("a holder that never settles does not keep the next call of that repository waiting", async () => {
		const hung = withRepoLock("/repo/hung", NEVER).then(
			() => null,
			error => error,
		);
		const next = withRepoLock("/repo/hung", async () => "ran");
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		const error = await hung;
		expect(error).toBeInstanceOf(StepStalledError);
		expect((error as StepStalledError).message).toContain("repository lock");
		expect(await next).toBe("ran");
	});

	it.skipIf(process.platform === "win32")(
		"ends the process a stopped holder still runs, and the next call goes on",
		async () => {
			const pidFile = path.join(dir, "pid");
			const script = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)`;
			const stopped = withRepoLock("/repo/child", () =>
				execBin(process.execPath, ["-e", script, pidFile], { cwd: dir, timeoutMs: 24 * 60 * 60_000 }),
			).then(
				() => null,
				error => error,
			);
			const next = withRepoLock("/repo/child", async () => "ran");
			let pid = 0;
			await vi.waitFor(
				async () => {
					pid = Number(await fs.readFile(pidFile, "utf8"));
					expect(pid).toBeGreaterThan(0);
				},
				{ timeout: 20_000, interval: 20 },
			);
			expect(alive(pid)).toBe(true);
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			expect(await stopped).toBeInstanceOf(StepStalledError);
			expect(await next).toBe("ran");
			await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 20_000, interval: 20 });
		},
	);

	it("a process a stopped holder starts later never starts", async () => {
		const release = Promise.withResolvers<void>();
		const caught = Promise.withResolvers<unknown>();
		const stopped = withRepoLock("/repo/late", async () => {
			await release.promise;
			await execBin(process.execPath, ["-e", "process.exit(0)"], { cwd: dir }).catch(caught.resolve);
		}).then(
			() => null,
			error => error,
		);
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		expect(await stopped).toBeInstanceOf(StepStalledError);
		release.resolve();
		expect(await caught.promise).toBeInstanceOf(StepStalledError);
	});
});
