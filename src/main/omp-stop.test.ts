import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OMP_SPAWN_GROUP, STOP_GRACE_MS, STOP_HOLD_MAX_MS, stopOmp } from "./omp-stop";

/**
 * A stand-in for an omp whose exit waits on a login refresh it has to save: asked to stop (SIGTERM, or its stdin
 * ending, as on Windows), it says on stderr what stock's exit says (`postmortem.ts`: the hold's message and
 * "(up to N s)…"), then saves and exits once `gate` exists, or never when there is no gate. With `holdSeconds` 0 it
 * says nothing itself: the test writes its stderr.
 */
function refreshingOmp(dir: string, holdSeconds: number): ChildProcess {
	const script = `
const fs = require("node:fs");
let asked = false;
const stop = () => {
	if (asked) return;
	asked = true;
	if (${holdSeconds}) fs.writeSync(2, "Waiting for the login refresh to finish saving (up to ${holdSeconds} s)…\\n");
	setInterval(() => {
		if (!fs.existsSync(${JSON.stringify(join(dir, "gate"))})) return;
		fs.writeFileSync(${JSON.stringify(join(dir, "saved"))}, "token");
		process.exit(0);
	}, 10);
};
process.on("SIGTERM", stop);
process.stdin.on("end", stop);
process.stdin.resume();
fs.writeSync(1, "up\\n");
setInterval(() => {}, 1000);
`;
	return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], ...OMP_SPAWN_GROUP });
}

function firstData(stream: NodeJS.ReadableStream | null): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	stream?.once("data", chunk => resolve(String(chunk)));
	return promise;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

describe("stopOmp and an omp that is saving a refreshed login", () => {
	let dir = "";
	let child: ChildProcess | null = null;

	afterEach(() => {
		vi.useRealTimers();
		if (child && running(child)) child.kill("SIGKILL");
		if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	it("is not killed at the stop's bound while it says it waits to save, and ends by itself once it saved", async () => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-stop-hold-"));
		child = refreshingOmp(dir, 120);
		await firstData(child.stdout);
		const said = firstData(child.stderr);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const stop = stopOmp(child);
		expect(await said).toContain("(up to 120 s)");
		await vi.advanceTimersByTimeAsync(STOP_GRACE_MS * 4);
		expect(running(child)).toBe(true);
		writeFileSync(join(dir, "gate"), "");
		await stop;
		expect(existsSync(join(dir, "saved"))).toBe(true);
	}, 20_000);

	const WAIT_LINE = "Waiting for the login refresh to finish saving (up to 120 s)…\n";
	it.each([
		[
			"cut inside the number",
			[WAIT_LINE.slice(0, WAIT_LINE.indexOf("0 s)")), WAIT_LINE.slice(WAIT_LINE.indexOf("0 s)"))],
		],
		["followed by 300 characters of other output in the same chunk", [WAIT_LINE + "x".repeat(300)]],
		[
			"after 300 characters of other output, cut inside the number",
			["x".repeat(300) + WAIT_LINE.slice(0, -8), WAIT_LINE.slice(-8)],
		],
	])(
		"reads the wait however the pipe framed the line: %s",
		async (_name, chunks) => {
			dir = mkdtempSync(join(tmpdir(), "ompdesk-stop-hold-"));
			child = refreshingOmp(dir, 0);
			await firstData(child.stdout);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const stop = stopOmp(child);
			for (const chunk of chunks) child.stderr?.emit("data", Buffer.from(chunk));
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS * 4);
			expect(running(child)).toBe(true);
			writeFileSync(join(dir, "gate"), "");
			await stop;
			expect(existsSync(join(dir, "saved"))).toBe(true);
		},
		20_000,
	);

	it("is killed once the time it asked for ran out, and never held longer than the cap", async () => {
		for (const [asked, heldMs] of [
			[20, 20_000],
			[100_000, STOP_HOLD_MAX_MS],
		] as const) {
			dir = mkdtempSync(join(tmpdir(), "ompdesk-stop-hold-"));
			child = refreshingOmp(dir, asked);
			await firstData(child.stdout);
			const said = firstData(child.stderr);
			const exit = once(child, "exit");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			void stopOmp(child);
			await said;
			await vi.advanceTimersByTimeAsync(heldMs - 1_000);
			expect(running(child)).toBe(true);
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 1_000);
			vi.useRealTimers();
			// The kill, not the stand-in's own exit: it never saved.
			expect((await exit)[1]).toBe(process.platform === "win32" ? null : "SIGKILL");
			expect(existsSync(join(dir, "saved"))).toBe(false);
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}, 30_000);
});
