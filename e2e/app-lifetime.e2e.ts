import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { appLaunchOptions } from "./harness";
import { survivors } from "./process-tree";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Playwright's exit handler is the only thing that ends an app it launched (`taskkill /T` of its cmd.exe launcher
// on Windows, the process group elsewhere). A worker that dies without running it (Node 24.15's 0xC0000409 on
// Windows, an outer `taskkill /F`) left the app, its Chromium helpers and its omp running: 108 of them on a Windows
// PC after a day of agent runs. The app ends with the process that launched it (src/main/test-launcher-exit.ts).
test("a test app ends when the process that launched it dies without cleaning up", async () => {
	test.setTimeout(120_000);
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-app-lifetime-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir as string)));
	await fs.writeFile(
		path.join(desktop as string, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true }),
	);
	const launch = path.join(profile, "launch.json");
	await fs.writeFile(
		launch,
		JSON.stringify(
			await appLaunchOptions({
				project: project as string,
				desktop: desktop as string,
				agent: agent as string,
				profile,
			}),
		),
	);
	let pid = 0;
	try {
		const launcher = spawn(
			process.execPath,
			[path.join(import.meta.dirname, "fixture", "launch-then-die.ts"), launch],
			{
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let output = "";
		launcher.stdout.on("data", chunk => {
			output += String(chunk);
		});
		launcher.stderr.on("data", chunk => {
			output += String(chunk);
		});
		const exited = Promise.withResolvers<void>();
		launcher.once("exit", () => exited.resolve());
		await exited.promise;
		pid = Number(/APP_PID (\d+)/.exec(output)?.[1] ?? 0);
		expect(pid, `the launcher printed no app pid:\n${output}`).toBeGreaterThan(0);

		await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
		// Its omp and Chromium's helpers read EOF on the pipes the app held, or die with it.
		await expect.poll(() => survivors(profile), { timeout: 15_000 }).toEqual([]);
	} finally {
		for (const line of survivors(profile)) {
			const leftover = Number(line.trim().split(/\s+/)[0]);
			if (process.platform === "win32")
				spawnSync("taskkill", ["/T", "/F", "/PID", String(leftover)], { stdio: "ignore" });
			else if (alive(leftover)) process.kill(leftover, "SIGKILL");
		}
		if (pid && alive(pid)) process.kill(pid, "SIGKILL");
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
