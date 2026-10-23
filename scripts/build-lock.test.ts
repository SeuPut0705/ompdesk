import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeExit, run } from "./build-lock";
import { type LockLogEntry, readLockLog } from "./lock-log";

describe("run", () => {
	it("delivers spaces, quotes, %PATH%, & and ^ to a native child unchanged", async () => {
		const args = ["a b", 'say "hi"', "%PATH%", "x&y", "c^d", ""];
		const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
		const result = await run(["node", "-e", script, ...args], { capture: true });
		expect(result.code).toBe(0);
		expect(JSON.parse(result.output)).toEqual(args);
	});

	it.skipIf(process.platform === "win32")("names the signal that ended a step, never a bare exit code", async () => {
		const result = await run(["node", "-e", "process.kill(process.pid, 'SIGKILL')"], { capture: true });
		expect(result.signal).toBe("SIGKILL");
		expect(result.code).toBe(137);
		expect(describeExit(result)).toBe("killed by SIGKILL before it finished");
		expect(describeExit({ code: 2, ms: 0, output: "" })).toBe("exit 2");
	});
});

const LOCK = path.join(import.meta.dirname, "build-lock.ts");
let dir: string;

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
	...process.env,
	OMPDESK_LOCK_ROOT: path.join(dir, "locks"),
	OMPDESK_LOCK_LOG: path.join(dir, "lock.log"),
	OMPDESK_LOCK_OWNER: "test@lock",
	OMPDESK_LOCK_POLL_MS: "20",
	OMPDESK_LOCK_REPORT_MS: "1",
	OMPDESK_BUILD_LOCK_HELD: "",
	...extra,
});

const locked = (args: string[], extra: Record<string, string> = {}) =>
	spawnSync("bun", [LOCK, ...args], { env: env(extra), encoding: "utf8" });
const entries = (): LockLogEntry[] => readLockLog(path.join(dir, "lock.log"));
/** `node <file>`: node takes what follows a script file as the script's own arguments, unlike after `-e`. */
const nodeScript = (code: string) => {
	const file = path.join(dir, "script.cjs");
	fs.writeFileSync(file, code);
	return ["node", file];
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-build-lock-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("bun scripts/build-lock.ts", () => {
	it("runs a command in a slot of its kind and logs the hold with its slot", () => {
		const result = locked(["--kind", "playwright", "--", "node", "-e", "process.exit(3)"]);
		expect(result.status).toBe(3);
		expect(entries()).toMatchObject([{ kind: "playwright", slot: 0, exit: 3, owner: "test@lock" }]);
	});

	it("runs a nested command of a kind an ancestor holds without waiting or logging", () => {
		const result = locked([
			"--kind",
			"playwright",
			"--",
			"bun",
			LOCK,
			"--kind",
			"playwright",
			"--",
			"node",
			"-e",
			"console.log(process.env.OMPDESK_BUILD_LOCK_HELD)",
		]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("playwright");
		expect(entries()).toHaveLength(1);
		expect(result.stderr).not.toContain("waiting for");
	});

	it("takes the slot of another kind for a nested command, so the build inside a Playwright run is exclusive", () => {
		const result = locked(["--kind", "playwright", "--", "bun", LOCK, "--kind", "build", "--", "node", "-e", "0"]);
		expect(result.status).toBe(0);
		expect(entries().map(entry => entry.kind)).toEqual(["build", "playwright"]);
	});

	it("treats the old marker OMPDESK_BUILD_LOCK_HELD=1 as every kind held", () => {
		const result = locked(["--kind", "vitest", "--", "node", "-e", "0"], { OMPDESK_BUILD_LOCK_HELD: "1" });
		expect(result.status).toBe(0);
		expect(entries()).toHaveLength(0);
	});

	it("runs gate and check:changed without a slot of their own", () => {
		const result = locked(["--", "node", "-e", "0", "check:changed"]);
		expect(result.status).toBe(0);
		expect(entries()).toHaveLength(0);
	});

	it("gives a Playwright run fewer workers when others hold slots, and leaves a caller's own count alone", () => {
		const print = ["--kind", "playwright", "--", ...nodeScript("console.log(process.env.OMP_GUI_WORKERS)")];
		expect(locked(print, { OMPDESK_LOCK_SLOTS: "playwright=4" }).stdout.trim()).toBe("4");
		for (const slot of [0, 1]) {
			const held = path.join(dir, "locks", `playwright.${slot}`);
			fs.mkdirSync(held, { recursive: true });
			fs.writeFileSync(path.join(held, "owner"), `other${slot}@checkout 10:00:00 pid 1\n`);
		}
		expect(locked(print, { OMPDESK_LOCK_SLOTS: "playwright=4" }).stdout.trim()).toBe("2");
		expect(locked(print, { OMPDESK_LOCK_SLOTS: "playwright=4", OMP_GUI_WORKERS: "1" }).stdout.trim()).toBe("1");
	});

	it("--chunk n runs the command as n shards, one logged hold each", () => {
		const result = locked(["--kind", "vitest", "--chunk", "3", "--", ...nodeScript("console.log(process.argv[2])")]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["--shard=1/3", "--shard=2/3", "--shard=3/3"]);
		expect(entries().map(entry => [entry.kind, entry.via])).toEqual(Array(3).fill(["vitest", "chunk"]));
	});

	it("--chunk keeps going after a failed chunk and exits with its code", () => {
		const result = locked([
			"--kind",
			"vitest",
			"--chunk",
			"2",
			"--",
			...nodeScript("process.exit(process.argv[2] === '--shard=1/2' ? 4 : 0)"),
		]);
		expect(result.status).toBe(4);
		expect(entries().map(entry => entry.exit)).toEqual([4, 0]);
	});

	it("--chunk refuses kinds that cannot shard and commands that shard already", () => {
		expect(locked(["--kind", "build", "--chunk", "2", "--", "true"]).status).toBe(2);
		expect(locked(["--kind", "vitest", "--chunk", "2", "--", "vitest", "--shard=1/2"]).status).toBe(2);
		expect(locked(["--chunk", "0", "--", "true"]).status).toBe(2);
	});

	it("warns once about a non-gate hold past the limit and says how to split it", () => {
		// `shell: true` on Windows hands cmd.exe the words unquoted: no spaces or `>` inside the script.
		const result = locked(["--kind", "playwright", "--", "node", "-e", "setTimeout(Function.prototype,900)"], {
			OMPDESK_LOCK_MAX_HOLD_MS: "100",
			OMPDESK_LOCK_HEARTBEAT_MS: "50",
		});
		expect(result.status).toBe(0);
		expect(result.stderr.match(/\[lock\] WARNING/g)).toHaveLength(1);
		expect(result.stderr).toMatch(/--chunk <n> -- node -e/);
	});

	it("waits behind a holder of the old single lock and logs the wait", async () => {
		const legacy = path.join(dir, "locks.legacy");
		fs.mkdirSync(legacy);
		fs.writeFileSync(path.join(legacy, "owner"), "old@checkout 10:00:00 pid 1\n");
		const child = spawn("bun", [LOCK, "--kind", "playwright", "--", "node", "-e", "0"], { env: env() });
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk;
		});
		const exited = new Promise<number | null>(resolve => child.once("close", resolve));
		// A loaded Windows runner takes over a second to start bun and print the line (vi.waitFor's default).
		await vi.waitFor(() => expect(stderr).toMatch(/waiting for .*\.legacy \(held by old@checkout 10:00:00 pid 1/), {
			timeout: 15_000,
		});
		expect(entries()).toHaveLength(0);
		fs.rmSync(legacy, { recursive: true });
		expect(await exited).toBe(0);
		expect(stderr).toMatch(/\[lock\] waited \d+\.\ds for old@checkout 10:00:00 pid 1/);
		expect(entries()[0]?.waitedMs).toBeGreaterThan(0);
	});
});
