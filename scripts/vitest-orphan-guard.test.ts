import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const GUARD = pathToFileURL(resolve("scripts/vitest-orphan-guard.ts")).href;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * A parent that starts a long-running worker carrying the guard, prints the worker's pid, then exits on its own.
 * `withGuard` false starts the same worker without it, the orphan the guard exists to end.
 */
function orphan(withGuard: boolean): Promise<number> {
	const worker = [
		withGuard
			? `const { exitWhenParentGone } = await import(${JSON.stringify(GUARD)}); exitWhenParentGone(100);`
			: "",
		"setInterval(() => {}, 1000);",
	].join("\n");
	const parent = `
		const { spawn } = require("node:child_process");
		const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(worker)}], { stdio: "ignore", detached: true });
		console.log(child.pid);
		setTimeout(() => process.exit(0), 300);
	`;
	return new Promise((done, fail) => {
		const proc = spawn(process.execPath, ["-e", parent], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		proc.stdout.on("data", chunk => {
			out += String(chunk);
		});
		proc.on("error", fail);
		proc.on("exit", () => done(Number(out.trim())));
	});
}

/**
 * Real processes and their real clocks: the guard watches another process's parent, which no fake timer reaches,
 * so this polls for the worker's exit (every 50 ms, up to `withinMs`).
 */
async function gone(pid: number, withinMs: number): Promise<boolean> {
	const until = Date.now() + withinMs;
	while (Date.now() < until) {
		if (!alive(pid)) return true;
		await new Promise(next => setTimeout(next, 50));
	}
	return !alive(pid);
}

describe("exitWhenParentGone", () => {
	it("ends a worker whose parent exited, where one without it runs on", async () => {
		const guarded = await orphan(true);
		const bare = await orphan(false);
		try {
			expect(await gone(guarded, 5_000)).toBe(true);
			expect(alive(bare)).toBe(true);
		} finally {
			for (const pid of [guarded, bare]) if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 15_000);
});
