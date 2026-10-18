import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { AI_MEMORY_VERSION } from "../src/shared/ai-memory";
import { exitApp, fixtureOmp } from "./harness";

// A new macOS user's first launch of the PACKAGED app (dist/mac-arm64, from `bun run package:mac -- --publish never`;
// OMP_GUI_E2E_APP points at another OMPdesk binary, e.g. /Applications/OMPdesk.app/Contents/MacOS/OMPdesk) sets its
// memory up by itself with the shipped, re-signed ai-memory: the staged copy in `<userData>/tools`, ai-memory's own
// launchd service, the app-owned extension root, `ready`, and the `ai-memory` lines of gui-runtime.jsonl. The 0.38.x
// macOS releases never got there: packaging re-signs the nested binary after after-pack checked it against the pin, and
// staging compared the signed bytes with the pin, failed on every launch, and logged nothing.
//
// It runs in a private HOME (ai-memory's data, its plist and the shared skills land there) and a private userData. The
// launchd label is global to the logged-in user, so the test runs only when that label and ai-memory's port are free,
// and ends with ai-memory's own `uninstall --apply --yes` in the private HOME and the label gone.
const LABEL = "com.github.akitaonrails.ai-memory";
const PORT = 49374;

function labelLoaded(): boolean {
	return spawnSync("launchctl", ["list", LABEL], { stdio: "ignore" }).status === 0;
}

function portBusy(): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect(PORT, "127.0.0.1");
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}

test("@smoke macOS: the packaged app's first launch stages the shipped ai-memory, gets ready and creates its extension root", async () => {
	test.skip(process.platform !== "darwin", "the macOS package and its launchd service");
	const executable = process.env.OMP_GUI_E2E_APP || path.resolve("dist/mac-arm64/OMPdesk.app/Contents/MacOS/OMPdesk");
	test.skip(!existsSync(executable), "No packaged app: run `bun run package:mac -- --publish never` first");
	test.skip(labelLoaded(), `launchd label ${LABEL} is already loaded (the user's own ai-memory): not touching it`);
	test.skip(await portBusy(), `port ${PORT} is already in use (the user's own ai-memory server): not touching it`);
	test.setTimeout(330_000);
	const info = test.info();
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-packaged-ai-memory-")));
	const home = path.join(profile, "home");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([home, userData, agent].map(dir => fs.mkdir(dir, { recursive: true })));
	// The machine setup installs what is missing in a packaged app; here it runs a no-op instead of fetching Bun or gh
	// into the private HOME.
	const installer = path.join(profile, "installer.sh");
	await fs.writeFile(installer, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		HOME: home,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(home, profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_INSTALLER: installer,
	});
	// A real launch: what makes the packaged app manage ai-memory (not headless), and nothing standing in for it.
	for (const key of [
		"OMP_GUI_HEADLESS",
		"ELECTRON_RUN_AS_NODE",
		"ELECTRON_RENDERER_URL",
		"OMP_GUI_AI_MEMORY_BIN",
		"OMP_GUI_AI_MEMORY_NO_SERVICE",
		"OMP_GUI_AI_MEMORY_UNIT_PIDFILE",
		"AI_MEMORY_DATA_DIR",
	]) {
		Reflect.deleteProperty(env, key);
	}
	const staged = path.join(userData, "tools", "ai-memory", AI_MEMORY_VERSION, "ai-memory");
	const rootDir = path.join(userData, "ai-memory", "omp-ext");
	const runtimeLog = path.join(userData, "logs", "gui-runtime.jsonl");
	const memoryLines = async () =>
		(await fs.readFile(runtimeLog, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { source: string; message: string; details?: Record<string, unknown> })
			.filter(line => line.source === "ai-memory");
	const mainOutput: string[] = [];
	let app: ElectronApplication | null = null;
	try {
		app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], env });
		app.process().stdout?.on("data", chunk => mainOutput.push(String(chunk)));
		app.process().stderr?.on("data", chunk => mainOutput.push(String(chunk)));
		expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
		const page: Page = await app.firstWindow({ timeout: 60_000 });
		const state = () => page.evaluate(() => window.omp.aiMemory.getState());
		// Settled: ready, or a failure that will not change by itself (the 0.38.x Macs sat in `failed` from the start).
		await expect
			.poll(async () => (await state()).phase, { timeout: 240_000, message: "ai-memory never settled" })
			.toMatch(/^(ready|failed|unsupported)$/);
		const settled = await state();
		expect(settled.phase, `state: ${JSON.stringify(settled)}\nlog: ${JSON.stringify(await memoryLines())}`).toBe(
			"ready",
		);
		expect(settled).toMatchObject({ enabled: true, source: "bundled", binary: staged, version: AI_MEMORY_VERSION });
		// The staged copy is the shipped file, byte for byte (re-signed by the packager, so not the pin's bytes).
		const shipped = path.join(path.dirname(path.dirname(executable)), "Resources", "ai-memory-bin", "ai-memory");
		expect(Buffer.compare(await fs.readFile(staged), await fs.readFile(shipped))).toBe(0);
		// The app-owned extension root every spawned omp loads with `-e`.
		for (const entry of ["index.ts", ".mcp.json", "skills"]) expect(existsSync(path.join(rootDir, entry))).toBe(true);
		expect(labelLoaded()).toBe(true);
		// Every phase change reached the runtime log: the launch, the binary in use, and ready.
		const lines = await memoryLines();
		expect(lines[0]).toMatchObject({ message: "launch", details: { enabled: true, automatic: true } });
		expect(lines).toContainEqual(
			expect.objectContaining({ message: "binary", details: expect.objectContaining({ bin: staged }) }),
		);
		expect(lines).toContainEqual(
			expect.objectContaining({ message: "phase", details: expect.objectContaining({ phase: "ready" }) }),
		);
		expect(lines.filter(line => line.message === "failed")).toEqual([]);
	} finally {
		await fs.writeFile(info.outputPath("main-process.log"), mainOutput.join(""));
		await fs
			.cp(path.join(userData, "logs"), info.outputPath("userdata-logs"), { recursive: true })
			.catch(() => undefined);
		if (app) await exitApp(app);
		// ai-memory's own uninstall in the private HOME takes its launchd service away again.
		const bin = existsSync(staged) ? staged : null;
		if (bin) {
			spawnSync(bin, ["uninstall", "--apply", "--yes"], {
				env: { ...env, PI_CODING_AGENT_DIR: agent },
				cwd: home,
				stdio: "ignore",
				timeout: 120_000,
			});
		}
		if (labelLoaded())
			spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`], { stdio: "ignore" });
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
	expect(labelLoaded()).toBe(false);
});
