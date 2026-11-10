import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const GUARD = pathToFileURL(resolve("scripts/vitest-orphan-guard.ts")).href;
const FAKE_OMP = pathToFileURL(resolve("src/main/test-fake-omp.ts")).href;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Imports the guard and installs it, polling every 100 ms. */
const INSTALL = `const { exitWhenParentGone } = await import(${JSON.stringify(GUARD)}); exitWhenParentGone(100);`;

/** Waits, in the worker, until the process that started it is gone (reparented on POSIX, not running on Windows). */
const AWAIT_ORPHANED = `
	const first = process.ppid;
	const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
	while (process.ppid === first && running(first)) await new Promise(next => setTimeout(next, 20));
`;

/**
 * A parent that starts a long-running worker (an IPC child, like a Vitest fork), waits for the worker's "ready" line,
 * prints the worker's pid and exits on its own. `worker` is the module code run before the worker says ready.
 */
function orphan(worker: string): Promise<number> {
	const code = `${worker}\nprocess.stdout.write("ready\\n");\nsetInterval(() => {}, 1000);`;
	const parent = `
		const { spawn } = require("node:child_process");
		const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(code)}], {
			stdio: ["ignore", "pipe", "ignore", "ipc"],
			detached: true,
		});
		child.stdout.once("data", () => {
			console.log(child.pid);
			process.exit(0);
		});
		child.on("exit", () => {
			console.log(child.pid);
			process.exit(0);
		});
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
 * A writer process that writes a fake omp with `writeFakeOmp` (so the fake's guard watches the writer), starts it,
 * prints the fake's pid once it is up and exits. The fake's source imports a module whose top-level await never
 * settles and which ignores SIGTERM: the `stats` and `-p` modes of `e2e/sidecar-fixture.ts` await that way.
 */
function fakeOutlivingItsWriter(dir: string): Promise<number> {
	const hang = join(dir, "hang.ts");
	writeFileSync(hang, 'process.on("SIGTERM", () => {});\nconsole.log("up");\nawait new Promise(() => {});\n');
	const writer = join(dir, "writer.ts");
	writeFileSync(
		writer,
		[
			'import { spawn } from "node:child_process";',
			'import { dirname, join } from "node:path";',
			`import { writeFakeOmp } from ${JSON.stringify(FAKE_OMP)};`,
			`const bin = await writeFakeOmp(${JSON.stringify(dir)}, ${JSON.stringify(`import ${JSON.stringify(pathToFileURL(hang).href)};\n`)});`,
			// The entry itself, not the Windows `omp.cmd` shim, which only cmd.exe starts.
			'const fake = spawn("bun", [join(dirname(bin), "omp.ts"), "stats"], { stdio: ["ignore", "pipe", "ignore"], detached: true });',
			'fake.stdout.once("data", () => { console.log(fake.pid); process.exit(0); });',
			'fake.on("exit", () => { console.log(fake.pid); process.exit(0); });',
			"",
		].join("\n"),
	);
	return new Promise((done, fail) => {
		const proc = spawn("bun", [writer], { stdio: ["ignore", "pipe", "inherit"] });
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
		const guarded = await orphan(INSTALL);
		const bare = await orphan("");
		try {
			expect(await gone(guarded, 5_000)).toBe(true);
			expect(alive(bare)).toBe(true);
		} finally {
			for (const pid of [guarded, bare]) if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 15_000);

	it("ends a worker that lost its parent before the guard was installed", async () => {
		// The worker says ready at once, its parent exits, and only then does it install the guard.
		const late = await orphan(`setTimeout(async () => { ${AWAIT_ORPHANED} ${INSTALL} }, 0);`);
		try {
			expect(await gone(late, 5_000)).toBe(true);
		} finally {
			if (alive(late)) process.kill(late, "SIGKILL");
		}
	}, 15_000);
});

describe("exitWhenGone through writeFakeOmp", () => {
	it("ends a fake omp whose source never finishes importing, once the process that wrote it is gone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-gui-orphan-fake-"));
		let fake = 0;
		try {
			fake = await fakeOutlivingItsWriter(dir);
			expect(fake).toBeGreaterThan(0);
			expect(await gone(fake, 5_000)).toBe(true);
		} finally {
			if (fake > 0 && alive(fake)) process.kill(fake, "SIGKILL");
			rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		}
	}, 15_000);
});
