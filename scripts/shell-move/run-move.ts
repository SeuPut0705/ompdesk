/**
 * The dry run of the update from the released Electron app (v0.127.0) to the CEF shell, on this PC, never touching the
 * person's install (native-rust › S):
 *
 *   bun scripts/shell-move/run-move.ts [--label success] [--fail-at swap] [--work <dir>] [--keep] [--stand-in <project>]
 *
 * `--stand-in <project>` packs a project of the same shape (package.json, out/, a staged shell) in place of this
 * checkout, without the package check: the harness's own dry test while the real shell is not built yet.
 *
 * 1. `build-setups.ts` makes two real electron-builder NSIS setups under a TEST identity (an `nsis.guid` shaped like
 *    electron-builder's, shortcut `OMPdesk-movetest`, folder `%LOCALAPPDATA%\Programs\OMPdesk-movetest`): the released
 *    v0.127.0 app files in a setup of the same shape (the old install), and this checkout's shell build offered as
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
	assertTestIdentity,
	LOCAL,
	OFFERED_VERSION,
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
if (failAt !== undefined && failAt !== "swap") throw new Error("--fail-at takes `swap`");
const label = values.label ?? (failAt ? `fail-${failAt}` : "success");
const work = resolve(values.work ?? join(tmpdir(), "ompdesk-shell-move"));
const out = join(work, "runs", label);
const profile = join(out, "profile");
const home = join(out, "home");
const feedPort = 18000 + (process.pid % 1000);
const debugPort = feedPort + 1;
const setupLog = join(out, "setup-env.log");
const t0 = Date.now();
const evidence: Record<string, unknown> = { label, failAt: failAt ?? null, steps: [] as unknown[] };
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

const regValues = async (key: string) => (await run(["reg", "query", key])).out;
const regValue = (text: string, name: string) => new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(text)?.[1]?.trim();

/** The environment of every test app: the profile, the isolated home, no registration, no setup installs. */
function testEnv(): Record<string, string> {
	return {
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
		OMP_MOVE_HOME: home,
		OMP_MOVE_DEBUG_PORT: String(debugPort),
		...(failAt ? { OMP_MOVE_FAIL: failAt } : {}),
	};
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
	else await verifyRolledBack(feedPort);
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
		const quiet = regValue(entry, "QuietUninstallString");
		if (quiet) {
			await run(["cmd", "/c", quiet], testEnv());
			await sleep(5000);
		}
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

async function verifyRolledBack(port: number): Promise<void> {
	await sleep(3000);
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
	expect(!existsSync(join(TEST_DIR, "ompdesk-move-test.cmd")), "nothing of the new install is left in the folder");
	// The old app starts as before, on the same profile, with no feed to update from this time.
	await stopTestProcesses();
	const before = updateLines().length;
	const restarted = Bun.spawn([join(TEST_DIR, "OMPdesk.exe"), `--user-data-dir=${profile}`, ...switches(port + 500)], {
		env: testEnv(),
		stdout: "ignore",
		stderr: "ignore",
	});
	note("released app started again", { pid: restarted.pid });
	let result: LogLine | undefined;
	for (let waited = 0; waited < 90 && !result; waited += 2) {
		await sleep(2000);
		result = updateLines()
			.slice(before)
			.find(line => line.message === "swap" && line.details?.event === "result");
	}
	evidence.swapResult = result?.details ?? null;
	expect(
		result?.details?.outcome === "rolled back",
		"the restarted app logged `swap result outcome rolled back`",
		result?.details,
	);
	expect(
		(await processesUnder(TEST_DIR)).some(process_ => process_.name.toLowerCase() === "ompdesk"),
		"the Electron app is running again",
	);
	if (!values.keep) {
		await stopTestProcesses();
		await run(["cmd", "/c", regValue(entry, "QuietUninstallString") ?? "exit 0"], testEnv());
	}
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
