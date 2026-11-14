/**
 * The dry run of the update from either released Electron app (v0.127.0 or v0.128.0) to the CEF shell, never touching the
 * person's install (native-rust › S):
 *
 *   bun scripts/shell-move/run-move.ts [--label success] [--fail-at swap|start|start-twice] [--work <dir>] [--keep] [--stand-in <project>]
 *   OMP_MOVE_RELEASED_TAG=v0.128.0 bun scripts/shell-move/run-move.ts --work <separate release-1 work dir>
 *
 * `--stand-in <project>` packs a project of the same shape (package.json, out/, a staged shell) in place of this
 * checkout, without the package check: the harness's own dry test while the real shell is not built yet.
 *
 * 1. `build-setups.ts` makes two real electron-builder NSIS setups under a TEST identity (an `nsis.guid` shaped like
 *    electron-builder's, shortcut `OMPdesk-movetest`, folder `%LOCALAPPDATA%\Programs\OMPdesk-movetest`): the released
 *    Electron files selected by OMP_MOVE_RELEASED_TAG (default v0.127.0) in a setup of the same shape, and this checkout's shell build offered as
 *    v0.200.0. Neither can touch the person's install: other GUID, other folder, other shortcuts; the setup's own
 *    process search is path-prefixed on the install folder (checked first: `setupCanFindProcesses`), and the folder is
 *    also pinned through the registry (`HKCU\Software\<test guid>\InstallLocation`) before the old setup runs.
 * 2. The old setup installs the released app. The SAME Electron writes a profile into a temp `--user-data-dir`: a
 *    stand-in token through safeStorage (DPAPI) and `file://` Local Storage with Korean text and a 200 000-character
 *    value (seed-profile.cjs).
 * 3. `feed.ts` answers api.github.com for the released app, which reaches it through Chromium's own switches only
 *    (`--host-resolver-rules`, `--ignore-certificate-errors`). The released app's updater, unchanged, finds v0.200.0,
 *    downloads it, checks its SHA-512, counts down, starts the new setup and quits: the update log lines
 *    (`check found` … `swap helper nsis`) are the record.
 * 4. The new setup (electron-builder's NSIS flow over the old install; resources/installer.nsh keeps the old folder
 *    until the new one is complete) starts the shell, which reads the profile: the shell's log (`cef.ready`,
 *    `migrate.token`, `migrate.localStorage`, the window) and the page itself (CDP: the seeded keys are there) are the
 *    record, then the uninstall entry, the folder and the uninstall.
 * 5. `--fail-at swap`: the same, but the unpack comes out incomplete on purpose (the test seam of move-test.nsh): the
 *    old app must come back (folder, uninstall entry) and start, and log `swap result … rolled back`.
 * 6. `--fail-at start`: the unpack is complete but the new shell exits right after CEF init
 *    (`OMP_GUI_TEST_SHELL_FAIL_START=1`, in the launcher's environment): the setup, which waits for the main's
 *    `app-started.json` of the new version, ends what the new app started, puts the old folder and uninstall entry
 *    back, starts the old app (logging `start-failed`, exit 2, no dialog) and that app logs `swap result … rolled back`.
 *    The success run checks the other side: the marker names the new version and the backup of the old folder is gone.
 * 7. `--fail-at start-twice`: `start`, then the old app runs again with its updater and offers the same version once more.
 *    v0.127.0 reaches NSIS, which reads update-start-failed.json and skips the swap (`start-failed-before: skipped`, exit 2).
 *    v0.128.0's own updater withdraws the repeat before running any setup. Both stay on Electron with no window.
 *
 * What protects the person's data: the old Electron runs with `OMP_GUI_TEST_USER_DATA_DIR=<temp profile>`,
 * `OMP_GUI_HEADLESS=1` (no `omp://` registration, no focus) and a temp HOME, APPDATA and LOCALAPPDATA (its updater's
 * cache). electron-updater's installer start (installer-spawn.ts `spawnDetachedOffThread`: a worker thread's
 * `child_process.spawn` with no `env`, so the worker's copy of the process environment) hands them to the setup;
 * the setup starts the app through Explorer (`StdUtils.ExecShellAsUser`), which has none of them, so the test setup
 * starts it through a launcher that sets them first (move-test.nsh), and refuses to start anything when the setup's
 * environment lacks the profile. The setup logs the environment it saw: that line is the check that the environment
 * passes through. Before and after, `guard.ts` snapshots his install folder (listing, sizes, mtimes), his uninstall
 * entry, `HKCU\Software\Classes\omp`, his shortcuts, the names at the top of `%APPDATA%\ompdesk` and his running
 * processes; any difference fails the run loudly.
 *
 * Needs the shell staged (`bun run build:shell`), Node (`bun run build:node`), CEF's licences (`bun run
 * stage:cef-licenses`), `out/` (`bun run build`) and the other staged binaries, exactly as a package does.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSetups } from "./build-setups";
import {
	assertTestEnv,
	assertTestIdentity,
	LOCAL,
	OFFERED_VERSION,
	RELEASED_TAG,
	RELEASED_VERSION,
	TEST_DIR,
	TEST_INSTALL_KEY,
	TEST_SHORTCUT,
	TEST_UNINSTALL_KEY,
} from "./constants";
import { diffOwner, powershell, run, setupCanFindProcesses, snapshotOwner } from "./guard";

const { values } = parseArgs({
	options: {
		label: { type: "string" },
		work: { type: "string" },
		"fail-at": { type: "string" },
		keep: { type: "boolean", default: false },
		"stand-in": { type: "string" },
		"timeout-minutes": { type: "string", default: "20" },
	},
});
const failAt = values["fail-at"];
if (failAt !== undefined && !["swap", "start", "start-twice"].includes(failAt))
	throw new Error("--fail-at takes `swap`, `start` or `start-twice`");
const label = values.label ?? (failAt ? `fail-${failAt}` : "success");
const work = resolve(values.work ?? join(tmpdir(), "ompdesk-shell-move", RELEASED_TAG));
const out = join(work, "runs", label);
const profile = join(out, "profile");
const home = join(out, "home");
const feedPort = 18000 + (process.pid % 1000);
const debugPort = feedPort + 1;
const setupLog = join(out, "setup-env.log");
const t0 = Date.now();
const evidence: Record<string, unknown> = {
	label,
	releasedTag: RELEASED_TAG,
	failAt: failAt ?? null,
	steps: [] as unknown[],
};
const failures: string[] = [];

function note(step: string, data?: unknown): void {
	const line = { s: Math.round((Date.now() - t0) / 1000), step, ...(data === undefined ? {} : { data }) };
	console.log(JSON.stringify(line));
	(evidence.steps as unknown[]).push(line);
}
function expect(ok: boolean, what: string, detail?: unknown): void {
	note(ok ? `ok: ${what}` : `FAILED: ${what}`, detail);
	if (!ok) failures.push(what);
}
const sleep = (ms: number) => Bun.sleep(ms);

/** A line of the app's runtime log (source `app-update`) or of the shell's log. */
interface LogLine {
	source?: string;
	message?: string;
	event?: string;
	ok?: boolean;
	raw?: string;
	details?: { event?: string; mode?: string; outcome?: string; [key: string]: unknown };
	[key: string]: unknown;
}

function readJsonl(file: string): LogLine[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => {
			try {
				return JSON.parse(line) as LogLine;
			} catch {
				return { raw: line };
			}
		});
}

/** Processes whose image sits under `folder`: [{id, name, path}]. */
async function processesUnder(folder: string): Promise<Array<{ id: number; name: string; path: string }>> {
	const listed = await powershell(
		`Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${folder}\\', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.Path)" }`,
	);
	return listed.out
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => {
			const [id, name, path] = line.split("|");
			return { id: Number(id), name: name ?? "", path: path ?? "" };
		});
}

/** Ends every process of the TEST install (path under TEST_DIR) and nothing else, then waits for them to be gone. */
async function stopTestProcesses(): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const running = await processesUnder(TEST_DIR);
		if (!running.length) return;
		for (const process_ of running) await run(["taskkill", "/PID", String(process_.id), "/T", "/F"]);
		await sleep(1000);
	}
}

/**
 * The dry run puts no window on anyone's screen: a setup or test-folder process with a visible main window is a failure,
 * and its process is ended (never one outside the test folder or the dry run's own home).
 */
async function noWindows(): Promise<boolean> {
	const seen = await powershell(
		`Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -and ($_.Path.StartsWith('${TEST_DIR}\\', 'OrdinalIgnoreCase') -or $_.Path.StartsWith('${home}\\', 'OrdinalIgnoreCase')) -and $_.ProcessName -ne 'OMPdesk' } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }`,
	);
	const windows = seen.out.split(/\r?\n/).filter(Boolean);
	for (const line of windows) {
		await run(["taskkill", "/PID", line.split("|")[0] ?? "0", "/T", "/F"]);
		expect(false, "no window appears (a process of the dry run showed one and was ended)", line);
	}
	return windows.length === 0;
}

const regValues = async (key: string) => (await run(["reg", "query", key])).out;
const regValue = (text: string, name: string) => new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(text)?.[1]?.trim();

/** The environment of every test app: the profile, the isolated home, no registration, no setup installs. */
function testEnv(): Record<string, string> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		USERPROFILE: home,
		HOME: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		OMP_GUI_HEADLESS: "1",
		OMP_GUI_TEST_USER_DATA_DIR: profile,
		OMP_GUI_OMP: join(home, "no-omp.cmd"),
		OMP_GUI_TEST_INSTALLER: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
		OMP_MOVE_LOG: setupLog,
		OMP_MOVE_SILENT: "1",
		OMP_MOVE_HOME: home,
		OMP_MOVE_DEBUG_PORT: String(debugPort),
		...(failAt ? { OMP_MOVE_FAIL: failAt === "start-twice" ? "start" : failAt } : {}),
	};
	assertTestEnv(env);
	return env;
}

const switches = (port: number) => [
	`--host-resolver-rules=MAP api.github.com 127.0.0.1:${port}`,
	"--ignore-certificate-errors",
];

const updateLines = () =>
	readJsonl(join(profile, "logs", "gui-runtime.jsonl")).filter(line => line.source === "app-update");
const shellLog = () => readJsonl(join(profile, "shell-webview", "shell.log.jsonl"));

/** Evaluates `expression` in the app's page over CDP (`--remote-debugging-port`); undefined when nothing answers. */
async function pageEval(expression: string): Promise<unknown> {
	try {
		const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{
			type: string;
			url: string;
			webSocketDebuggerUrl: string;
		}>;
		const page = targets.find(target => target.type === "page" && target.url.startsWith("app://ompdesk/"));
		if (!page) return undefined;
		const socket = new WebSocket(page.webSocketDebuggerUrl);
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => resolve(undefined), 10_000);
		socket.onopen = () =>
			socket.send(
				JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
			);
		socket.onmessage = event => {
			const reply = JSON.parse(String(event.data)) as { id: number; result?: { result?: { value?: unknown } } };
			if (reply.id !== 1) return;
			clearTimeout(timer);
			socket.close();
			resolve(reply.result?.result?.value);
		};
		socket.onerror = () => resolve(undefined);
		return await promise;
	} catch {
		return undefined;
	}
}

/** The stand-in feed, killed in `cleanup` however the run ends. */
let feed: ReturnType<typeof Bun.spawn> | undefined;

async function main(): Promise<void> {
	mkdirSync(profile, { recursive: true });
	mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });
	mkdirSync(join(home, "AppData", "Local"), { recursive: true });
	rmSync(setupLog, { force: true });
	rmSync(join(process.env.TEMP ?? tmpdir(), "ompdesk-setup.log"), { force: true });

	// 0. Before anything: the test identity is clean and the setup's process search is trustworthy.
	expect(!existsSync(TEST_DIR), "the test install folder does not exist yet", TEST_DIR);
	expect((await run(["reg", "query", TEST_UNINSTALL_KEY])).code !== 0, "the test uninstall entry does not exist yet");
	expect((await processesUnder(TEST_DIR)).length === 0, "no process runs from the test folder");
	const search = await setupCanFindProcesses(TEST_DIR);
	expect(
		search === null,
		"the setup's own process search (PowerShell Get-CimInstance) answers cleanly",
		search ?? undefined,
	);
	if (failures.length) return;

	// 1. The two setups.
	const setups = await buildSetups(work, values["stand-in"] ? { standIn: values["stand-in"] } : {});
	note("setups", setups);
	evidence.setups = { old: setups.old, new: setups.new };

	// 2. The old install: the released app, in the test folder, under the test GUID. The folder is pinned through the
	// registry first (the one-click setup installs where InstallLocation says), never relying on the default.
	await run(["reg", "add", TEST_INSTALL_KEY, "/v", "InstallLocation", "/t", "REG_SZ", "/d", TEST_DIR, "/f"]);
	const oldRun = await run([setups.old, "/S"], testEnv());
	expect(
		oldRun.code === 0 && existsSync(join(TEST_DIR, "OMPdesk.exe")),
		"the released app is installed in the test folder",
		{ code: oldRun.code },
	);
	const oldEntry = await regValues(TEST_UNINSTALL_KEY);
	expect(
		regValue(oldEntry, "DisplayVersion") === RELEASED_VERSION,
		`the test uninstall entry says ${RELEASED_VERSION}`,
	);
	expect(existsSync(join(TEST_DIR, "resources", "app.asar")), "it is the Electron app (resources/app.asar)");
	evidence.oldEntry = oldEntry;

	// 3. The profile, written by the same Electron.
	const seedApp = join(work, "seed-app");
	if (!existsSync(join(seedApp, "OMPdesk.exe"))) {
		cpSync(join(work, "released", "app"), seedApp, { recursive: true });
		rmSync(join(seedApp, "resources", "app.asar"), { force: true });
		rmSync(join(seedApp, "resources", "app-update.yml"), { force: true });
		mkdirSync(join(seedApp, "resources", "app"), { recursive: true });
		writeFileSync(
			join(seedApp, "resources", "app", "package.json"),
			JSON.stringify({ name: "ompdesk", main: "seed-profile.cjs" }),
		);
		cpSync(join(import.meta.dir, "seed-profile.cjs"), join(seedApp, "resources", "app", "seed-profile.cjs"));
	}
	const seeded = await run([join(seedApp, "OMPdesk.exe"), `--user-data-dir=${profile}`], testEnv());
	note("profile seeded", seeded.out.trim().split("\n").pop());
	expect(existsSync(join(profile, "update-token.bin")), "the profile holds an Electron safeStorage token");

	// 4. The stand-in feed.
	feed = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "feed.ts"),
			"--setup",
			setups.new,
			"--version",
			OFFERED_VERSION,
			"--cert-dir",
			join(work, "cert"),
			"--port",
			String(feedPort),
		],
		{ stdout: Bun.file(join(out, "feed.log")), stderr: "inherit" },
	);
	await sleep(2000);

	// 5. The released app, left alone with its updater.
	const exe = join(TEST_DIR, "OMPdesk.exe");
	const launched = Bun.spawn([exe, `--user-data-dir=${profile}`, ...switches(feedPort)], {
		env: testEnv(),
		stdout: "ignore",
		stderr: "ignore",
	});
	note("released app launched", { pid: launched.pid });

	const deadline = Date.now() + Number(values["timeout-minutes"]) * 60_000;
	let seen = 0;
	let moved = false;
	while (Date.now() < deadline) {
		await sleep(2000);
		const lines = updateLines();
		for (const line of lines.slice(seen)) note("app-update", { message: line.message, ...line.details });
		seen = lines.length;
		await noWindows();
		const installer = (
			await powershell(
				"Get-Process -Name ompdesk-windows-setup -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }",
			)
		).out.trim();
		if (
			existsSync(setupLog) &&
			!installer &&
			lines.some(line => line.message === "swap" && line.details?.event === "helper")
		) {
			moved = true;
			break;
		}
	}
	expect(moved, "the released app's updater started the setup, and the setup finished", {
		setupLog: existsSync(setupLog) ? readFileSync(setupLog, "utf8") : null,
	});
	const updateLog = updateLines();
	const events = updateLog.map(line => `${line.message} ${line.details?.event ?? ""}`.trim());
	evidence.updateLog = updateLog.map(line => ({ message: line.message, ...line.details }));
	for (const wanted of ["check found", "download started", "download verified", "swap helper"]) {
		expect(events.includes(wanted), `the update log has "${wanted}"`);
	}
	expect(
		updateLog.some(
			line => line.message === "swap" && line.details?.event === "helper" && line.details?.mode === "nsis",
		),
		"the update log has `swap helper` with mode nsis",
	);

	// What the setup saw of its environment.
	const setupEnv = existsSync(setupLog) ? readFileSync(setupLog, "utf8") : "";
	evidence.setupEnv = setupEnv;
	expect(
		setupEnv.includes(`userData=${profile}`) && setupEnv.includes("headless=1"),
		"the environment reached the setup through electron-updater and spawnDetachedOffThread",
		setupEnv.trim(),
	);
	expect(
		setupEnv.includes("backup=renamed"),
		"the setup set the old folder aside before it installed",
		setupEnv.trim(),
	);

	if (!failAt) await verifyMoved();
	else await verifyRolledBack(failAt === "swap" ? "swap" : "start", failAt !== "start-twice");
}

async function verifyMoved(): Promise<void> {
	// The new shell starts (through the launcher the test setup left as its start link) and reads the profile.
	let log = shellLog();
	for (let waited = 0; waited < 120 && !log.some(event => event.event === "window.created"); waited += 2) {
		await sleep(2000);
		log = shellLog();
	}
	const wanted = (name: string) => log.find(event => event.event === name);
	evidence.shellLog = log.filter(event =>
		/^(cef|node|host\.hello|migrate|window|wc\.created|session)/.test(String(event.event)),
	);
	note("shell log", evidence.shellLog);
	expect(!!wanted("cef.ready"), "the new shell started (cef.ready)");
	expect(
		wanted("migrate.token")?.ok === true,
		"Electron's safeStorage token was decrypted by the shell",
		wanted("migrate.token"),
	);
	expect(
		wanted("migrate.localStorage")?.ok === true,
		"Electron's Local Storage was imported",
		wanted("migrate.localStorage"),
	);
	expect(!!wanted("window.created"), "the window was created");
	// The page itself.
	let draft: unknown;
	for (let attempt = 0; attempt < 30 && draft === undefined; attempt++) {
		draft = await pageEval(
			`JSON.stringify({ href: location.href, draft: localStorage.getItem("ompdesk.seed.draft"), korean: localStorage.getItem("ompdesk.seed.korean"), large: (localStorage.getItem("ompdesk.seed.large") || "").length, omp: typeof window.omp })`,
		);
		if (draft === undefined) await sleep(2000);
	}
	const page =
		typeof draft === "string"
			? (JSON.parse(draft) as { href: string; draft: string; korean: string; large: number; omp: string })
			: null;
	evidence.page = page;
	note("page", page);
	expect(page?.href.startsWith("app://ompdesk/") === true, "the page loaded from app://ompdesk", page?.href);
	expect(
		page?.draft === "a draft typed in Electron" && page?.korean === "한국어 초안 ✓" && page?.large === 200_000,
		"Local Storage reached the page (draft, Korean, 200 000 characters)",
	);
	expect(page?.omp === "object", "window.omp is there");
	// The main (Node, through the shim) reads the same profile: its update log says what came of the move.
	let result = updateLines().find(line => line.message === "swap" && line.details?.event === "result");
	for (let waited = 0; waited < 60 && !result; waited += 2) {
		await sleep(2000);
		result = updateLines().find(line => line.message === "swap" && line.details?.event === "result");
	}
	evidence.swapResult = result?.details ?? null;
	expect(
		result?.details?.outcome === "installed",
		"the new app logged `swap result outcome installed`",
		result?.details,
	);

	const running = await processesUnder(TEST_DIR);
	evidence.running = running;
	note("processes under the test folder", running);
	expect(
		running.some(process_ => process_.name.toLowerCase() === "ompdesk"),
		"OMPdesk.exe (the shell) runs from the test folder",
	);
	expect(
		running.some(process_ => process_.path.toLowerCase().endsWith("\\resources\\node\\node.exe")),
		"Node (resources/node/node.exe) runs the main",
	);

	const entry = await regValues(TEST_UNINSTALL_KEY);
	evidence.uninstallEntry = entry;
	expect(
		regValue(entry, "DisplayVersion") === OFFERED_VERSION,
		`the uninstall entry now says ${OFFERED_VERSION}`,
		entry,
	);
	expect(
		regValue(await regValues(TEST_INSTALL_KEY), "InstallLocation")?.toLowerCase() === TEST_DIR.toLowerCase(),
		"InstallLocation is still the test folder",
	);
	expect(
		existsSync(join(TEST_DIR, "libcef.dll")) && !existsSync(join(TEST_DIR, "resources", "app.asar")),
		"the folder holds the shell (libcef.dll), no asar",
	);
	expect(!existsSync(`${TEST_DIR}.move-backup`), "the backup of the old folder is gone");
	const started = existsSync(join(profile, "app-started.json"))
		? (JSON.parse(readFileSync(join(profile, "app-started.json"), "utf8")) as { version?: string; pid?: number })
		: null;
	evidence.appStarted = started;
	expect(
		started?.version === OFFERED_VERSION && typeof started.pid === "number",
		`the main wrote app-started.json for ${OFFERED_VERSION} (the setup waited for it, then dropped the backup)`,
		started,
	);
	expect(!setupLogText().includes("start-failed"), "the setup logged no start-failed", setupLogText().trim());
	const programs = (await run(["cmd", "/c", "dir", "/b", join(LOCAL, "Programs")])).out
		.split(/\r?\n/)
		.filter(name => name.startsWith("OMPdesk"));
	evidence.siblings = programs;
	expect(
		programs.sort().join(",") === ["OMPdesk", "OMPdesk-movetest"].filter(name => programs.includes(name)).join(","),
		"no second copy appeared beside the install",
		programs,
	);
	evidence.folder = (await run(["cmd", "/c", "dir", "/b", TEST_DIR])).out.split(/\r?\n/).filter(Boolean);

	// The shell's own uninstaller (the entry's), keeping userData.
	if (!values.keep) {
		await stopTestProcesses();
		await uninstallQuiet(entry);
		evidence.afterUninstall = {
			folderGone: !existsSync(join(TEST_DIR, "OMPdesk.exe")),
			entryGone: (await run(["reg", "query", TEST_UNINSTALL_KEY])).code !== 0,
			userDataKept: existsSync(join(profile, "update-token.bin")),
		};
		note("after the new uninstaller", evidence.afterUninstall);
		const after = evidence.afterUninstall as { folderGone: boolean; entryGone: boolean; userDataKept: boolean };
		expect(
			after.folderGone && after.entryGone && after.userDataKept,
			"the uninstaller removes the app and its entry and keeps userData",
		);
	}
}

function setupLogText(): string {
	const file = join(process.env.TEMP ?? tmpdir(), "ompdesk-setup.log");
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function verifyRolledBack(reason: "swap" | "start", final: boolean): Promise<void> {
	// `start` waits for the old app too: the setup has to see the new one fail (it leaves at once when nothing of it runs).
	let result: LogLine | undefined;
	// The setup starts the old app at once, so its line may be there before this looks: every `swap result` of the run counts
	// (the first launch of the harness's own, before the update, logs none).
	for (let waited = 0; waited < 150 && !result; waited += 2) {
		await sleep(2000);
		result = updateLines().find(line => line.message === "swap" && line.details?.event === "result");
	}
	evidence.swapResult = result?.details ?? null;
	// The old app the SETUP started (through the launcher) reads the profile and says what came of the move.
	expect(
		result?.details?.outcome === "rolled back",
		"the old app the setup started logged `swap result outcome rolled back`",
		result?.details,
	);
	const entry = await regValues(TEST_UNINSTALL_KEY);
	evidence.uninstallEntry = entry;
	expect(
		regValue(entry, "DisplayVersion") === RELEASED_VERSION,
		`the uninstall entry still says ${RELEASED_VERSION}`,
		entry,
	);
	expect(
		existsSync(join(TEST_DIR, "resources", "app.asar")) && !existsSync(join(TEST_DIR, "libcef.dll")),
		"the folder holds the Electron app again (app.asar, no libcef.dll)",
	);
	expect(!existsSync(`${TEST_DIR}.move-backup`), "no backup folder is left");
	const setupText = setupLogText();
	expect(
		setupText.includes(
			reason === "swap" ? "incomplete: putting the old app back" : "start-failed: no app-started.json",
		),
		`the setup logged ${reason === "swap" ? "the incomplete unpack" : "`start-failed`"} (in %TEMP%\\ompdesk-setup.log), no dialog`,
		setupText.trim(),
	);
	expect(
		!existsSync(join(profile, "app-started.json")) || reason === "swap",
		"the failed new app left no app-started.json for the new version",
	);
	expect(await noWindows(), "no window appeared during the failed move");
	const running = await processesUnder(TEST_DIR);
	evidence.running = running;
	expect(
		running.some(process_ => process_.name.toLowerCase() === "ompdesk") &&
			!running.some(process_ => process_.path.toLowerCase().endsWith("\\resources\\node\\node.exe")),
		"the Electron app is running again from the test folder, with nothing of the shell left",
		running,
	);
	if (final) {
		if (!values.keep) {
			await stopTestProcesses();
			await uninstallQuiet(entry);
		}
		return;
	}
	await verifyNotTriedAgain(entry);
}

/**
 * The second round after a failed start: v0.127.0 reaches NSIS, which skips the swap; v0.128.0's updater holds the failed
 * version before starting any installer. Neither released updater is patched by the harness.
 */
async function verifyNotTriedAgain(entry: string): Promise<void> {
	const failedFile = join(profile, "update-start-failed.json");
	const record = existsSync(failedFile)
		? (JSON.parse(readFileSync(failedFile, "utf8")) as { version?: string; count?: number; at?: number })
		: null;
	evidence.startFailedRecord = record;
	expect(
		record?.version === OFFERED_VERSION && (record.count ?? 0) >= 1 && typeof record.at === "number",
		`the first failure left update-start-failed.json naming ${OFFERED_VERSION}`,
		record,
	);
	await stopTestProcesses();
	rmSync(join(process.env.TEMP ?? tmpdir(), "ompdesk-setup.log"), { force: true });
	const helpersBefore = updateLines().filter(
		line => line.message === "swap" && line.details?.event === "helper",
	).length;
	const beforeRound = updateLines().length;
	const updaterHolds = RELEASED_TAG === "v0.128.0";
	const started = Date.now();
	const second = Bun.spawn([join(TEST_DIR, "OMPdesk.exe"), `--user-data-dir=${profile}`, ...switches(feedPort)], {
		env: testEnv(),
		stdout: "ignore",
		stderr: "ignore",
	});
	note("released app started again, its updater offers the same version", { pid: second.pid });
	let skipped = false;
	for (let waited = 0; waited < 600 && !skipped; waited += 2) {
		await sleep(2000);
		await noWindows();
		skipped = updaterHolds
			? updateLines()
					.slice(beforeRound)
					.some(
						line =>
							line.message === "scheduler" &&
							line.details?.event === "withdrawn" &&
							line.details?.reason === "start failed before",
					)
			: setupLogText().includes("start-failed-before: skipped");
	}
	if (skipped && updaterHolds) {
		// Past the released updater's 60 s countdown: a withdrawn install must stay withdrawn, with no setup or window.
		for (let waited = 0; waited < 75; waited += 5) {
			await sleep(5000);
			await noWindows();
		}
	}
	const seconds = Math.round((Date.now() - started) / 1000);
	evidence.secondRoundSeconds = seconds;
	const text = setupLogText();
	if (updaterHolds) {
		expect(
			skipped,
			"v0.128.0's updater withdrew the repeat (`scheduler withdrawn`, reason `start failed before`)",
			updateLines().slice(beforeRound),
		);
		expect(
			updateLines().filter(line => line.message === "swap" && line.details?.event === "helper").length ===
				helpersBefore &&
				text === "" &&
				second.exitCode === null,
			"the released updater stayed running past the countdown and started no second setup",
		);
	} else {
		expect(
			skipped,
			"the second setup skipped the swap (`start-failed-before: skipped` in %TEMP%\\ompdesk-setup.log)",
			text.trim(),
		);
		expect(
			updateLines().filter(line => line.message === "swap" && line.details?.event === "helper").length >
				helpersBefore,
			"the old app's updater started that setup (a second `swap helper`)",
		);
	}
	expect(
		!text.includes("putting the old app back") && !text.includes("start-failed: no app-started.json"),
		"it did not swap anything (no backup, no restore)",
		text.trim(),
	);
	// v0.127.0 was restarted by the skipped setup; v0.128.0 never exited.
	let running = false;
	for (let waited = 0; waited < 60 && !running; waited += 2) {
		await sleep(2000);
		running = (await processesUnder(TEST_DIR)).some(process_ => process_.name.toLowerCase() === "ompdesk");
	}
	expect(running, "the Electron app is running after the repeat was held");
	expect(
		regValue(await regValues(TEST_UNINSTALL_KEY), "DisplayVersion") === RELEASED_VERSION &&
			existsSync(join(TEST_DIR, "resources", "app.asar")) &&
			!existsSync(`${TEST_DIR}.move-backup`),
		`nothing was replaced: the entry still says ${RELEASED_VERSION}, the folder is the Electron app, no backup`,
	);
	expect(await noWindows(), "no window appeared in the second round either");
	if (!values.keep) {
		await stopTestProcesses();
		await uninstallQuiet(entry);
	}
}

/**
 * Runs the entry's own quiet uninstaller (`"<folder>\\Uninstall OMPdesk.exe" /currentuser /S`) directly, never through a
 * shell, and waits for its copy in %TEMP% to finish the folder (it deletes the install folder after it exits).
 */
async function uninstallQuiet(entry: string): Promise<void> {
	const quiet = regValue(entry, "QuietUninstallString") ?? "";
	const match = /^"([^"]+)"\s*(.*)$/.exec(quiet);
	if (!match?.[1] || !match[1].toLowerCase().startsWith(TEST_DIR.toLowerCase())) {
		note("no quiet uninstaller inside the test folder", quiet);
		return;
	}
	await run([match[1], ...(match[2] ?? "").split(/\s+/).filter(Boolean)], testEnv());
	for (let waited = 0; waited < 60 && existsSync(join(TEST_DIR, "OMPdesk.exe")); waited += 2) await sleep(2000);
	await sleep(2000);
}

async function cleanup(): Promise<void> {
	if (values.keep) return;
	await stopTestProcesses();
	rmSync(TEST_DIR, { recursive: true, force: true });
	rmSync(`${TEST_DIR}.move-backup`, { recursive: true, force: true });
	await run(["reg", "delete", TEST_UNINSTALL_KEY, "/f"]);
	await run(["reg", "delete", TEST_INSTALL_KEY, "/f"]);
	const desktop = (await powershell("[Environment]::GetFolderPath('Desktop')")).out.trim();
	const programs = (await powershell("[Environment]::GetFolderPath('Programs')")).out.trim();
	for (const folder of [desktop, programs]) rmSync(join(folder, `${TEST_SHORTCUT}.lnk`), { force: true });
}

assertTestIdentity();
// A run starts from nothing: a profile, update log or shell log of an earlier run would pass for this one's evidence.
rmSync(out, { recursive: true, force: true });
rmSync(join(process.env.TEMP ?? tmpdir(), "ompdesk-setup.log"), { force: true });
mkdirSync(out, { recursive: true });
const ownerBefore = await snapshotOwner();
await Bun.write(join(out, "owner-before.json"), JSON.stringify(ownerBefore, null, 2));
note("owner snapshot taken", {
	installFiles: Object.keys(ownerBefore.installFolder ?? {}).length,
	processes: Object.keys(ownerBefore.processes).length,
	appDataTop: ownerBefore.appDataTop?.length,
});
try {
	await main();
} catch (error) {
	failures.push(`the run threw: ${error instanceof Error ? error.stack : String(error)}`);
	note("FAILED: the run threw", String(error));
} finally {
	feed?.kill();
	await cleanup();
}
const ownerAfter = await snapshotOwner();
await Bun.write(join(out, "owner-after.json"), JSON.stringify(ownerAfter, null, 2));
const touched = diffOwner(ownerBefore, ownerAfter);
evidence.ownerUntouched = touched.length === 0;
if (touched.length) {
	failures.push("THE PERSON'S INSTALL OR DATA CHANGED");
	for (const problem of touched) console.error(`OWNER CHANGED: ${problem}`);
} else {
	note(
		"the person's install, uninstall entry, omp:// handler, shortcuts, %APPDATA%\\ompdesk names and running processes are as they were",
	);
}
evidence.failures = failures;
await Bun.write(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(failures.length ? `RESULT: FAILED (${failures.length}): ${failures.join("; ")}` : `RESULT: ok (${label})`);
process.exit(failures.length ? 1 : 0);
