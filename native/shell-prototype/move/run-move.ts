// The update move, measured from the released Electron app (Windows):
//   bun run-move.ts --label <name> --payload <candidate release folder> --exe <exe name in it> [--fail-at swap|extract]
// 1. A second install of the released app: the installed OMPdesk's own files (the released v0.127.0 bytes) copied to
//    %LOCALAPPDATA%\Programs\OMPdesk-movetest, with an uninstall entry and InstallLocation under a test GUID shaped
//    exactly like the real ones (the real install, its registry and %APPDATA%\ompdesk are never touched).
// 2. A test profile written by the same Electron (stand-in token through safeStorage/DPAPI, file:// Local Storage).
// 3. The handoff installer (move/installer) packed with the candidate as ompdesk-windows-setup.exe, offered by
//    feed.ts as v0.200.0; the released app reaches it through Chromium switches only.
// 4. The released app runs on its own: check → download → SHA-512 → automatic install at a safe point → installer
//    → the new shell starts. Then the checks: folder, exe name, uninstall entry, userData read, token decrypted,
//    Local Storage carried, uninstall. With --fail-at the installer fails on purpose and Electron must come back.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		label: { type: "string" },
		payload: { type: "string" },
		exe: { type: "string" },
		"fail-at": { type: "string" },
		"keep-running": { type: "boolean", default: false },
	},
});
const label = values.label ?? "dry";
const here = import.meta.dir;
const proto = resolve(here, "..");
const repo = resolve(proto, "../..");
const out = join(proto, "results", "move", label);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const GUID = "0be7e57a-0127-4c0d-9a77-6d6f76657465";
const LOCAL = process.env.LOCALAPPDATA ?? "";
const REAL_DIR = join(LOCAL, "Programs", "OMPdesk");
const TEST_DIR = join(LOCAL, "Programs", "OMPdesk-movetest");
const UNINSTALL = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`;
const LOCATION = `HKCU\\Software\\${GUID}`;
const REAL_UNINSTALL = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\e6f1f351-4346-5a64-a104-9a02672ef1bc";
const ud = join(out, "userData");
const home = join(out, "home");
const evidence: Record<string, unknown> = { label, failAt: values["fail-at"] ?? null };
const t0 = Date.now();
const note = (step: string, data?: unknown) => {
	const line = { s: Math.round((Date.now() - t0) / 1000), step, ...(data === undefined ? {} : { data }) };
	console.log(JSON.stringify(line));
	(evidence.steps ??= [] as unknown[]) && (evidence.steps as unknown[]).push(line);
};
const sh = async (cmd: string[]) => {
	const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
	return { code: await p.exited, out: o + e };
};
const ps = (script: string) => sh(["powershell", "-NoProfile", "-Command", script]);
const readJsonl = (file: string) =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => {
					try {
						return JSON.parse(line);
					} catch {
						return { raw: line };
					}
				})
		: [];
const stopTestProcesses = () =>
	ps(`Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${TEST_DIR}', 'OrdinalIgnoreCase') } | Stop-Process -Force -PassThru | Select-Object -ExpandProperty Id`);

// 0. What must stay untouched.
const realBefore = (await sh(["reg", "query", REAL_UNINSTALL])).out;
const ompKey = join(out, "classes-omp.reg");
await sh(["reg", "export", "HKCU\\Software\\Classes\\omp", ompKey, "/y"]);

// 1. The second install of the released app.
await stopTestProcesses();
rmSync(TEST_DIR, { recursive: true, force: true });
const copy = await sh(["robocopy", REAL_DIR, TEST_DIR, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/R:1", "/W:1"]);
if (copy.code >= 8) throw new Error(`robocopy ${copy.code}: ${copy.out}`);
const realValues = (await sh(["reg", "query", REAL_UNINSTALL])).out;
const version = /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(realValues)?.[1] ?? "?";
for (const [name, type, value] of [
	["DisplayName", "REG_SZ", `OMPdesk ${version}`],
	["UninstallString", "REG_SZ", `"${TEST_DIR}\\Uninstall OMPdesk.exe" /currentuser`],
	["QuietUninstallString", "REG_SZ", `"${TEST_DIR}\\Uninstall OMPdesk.exe" /currentuser /S`],
	["DisplayVersion", "REG_SZ", version],
	["DisplayIcon", "REG_SZ", `${TEST_DIR}\\uninstallerIcon.ico`],
	["Publisher", "REG_SZ", "SeuPut"],
	["NoModify", "REG_DWORD", "1"],
	["NoRepair", "REG_DWORD", "1"],
])
	await sh(["reg", "add", UNINSTALL, "/v", name, "/t", type, "/d", value, "/f"]);
for (const [name, value] of [
	["InstallLocation", TEST_DIR],
	["KeepShortcuts", "true"],
	["ShortcutName", "OMPdesk"],
])
	await sh(["reg", "add", LOCATION, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
note("electron-installed", { version, dir: TEST_DIR });

// 2. The test profile.
mkdirSync(home, { recursive: true });
const seed = await sh([join(repo, "node_modules/electron/dist/electron.exe"), join(here, "seed-profile.cjs"), `--user-data-dir=${ud}`]);
note("profile-seeded", seed.out.trim().split("\n").pop());

// 3. The handoff installer with the candidate.
const setup = join(out, "ompdesk-windows-setup.exe");
if (values.payload) {
	const payload = join(out, "payload");
	await sh(["robocopy", values.payload, payload, "/E", "/NFL", "/NDL", "/NJH", "/NJS"]);
	await sh(["cmd", "/c", "move", "/y", join(payload, values.exe ?? ""), join(payload, "OMPdesk.exe")]);
	await sh(["robocopy", join(repo, "out/renderer"), join(payload, "renderer"), "/E", "/NFL", "/NDL", "/NJH", "/NJS"]);
	await sh(["robocopy", join(proto, "shell-assets"), join(payload, "shell-assets"), "/E", "/NFL", "/NDL", "/NJH", "/NJS"]);
	const identity = join(out, "identity.json");
	await Bun.write(identity, JSON.stringify({ guid: GUID, product: "OMPdesk", version: "0.200.0" }));
	const packed = await sh([join(here, "installer/target/release/handoff-setup.exe"), "pack", payload, identity, setup]);
	note("installer-packed", packed.out.trim());
	rmSync(payload, { recursive: true, force: true });
}
const feed = Bun.spawn(["bun", join(here, "feed.ts"), "--setup", setup, "--version", "0.200.0", "--port", "8443"], {
	stdout: Bun.file(join(out, "feed.log")),
	stderr: "inherit",
});
await Bun.sleep(1500);

// 4. The released app, left alone.
const switches = ["--host-resolver-rules=MAP api.github.com 127.0.0.1:8443", "--ignore-certificate-errors"];
const handoffLog = join(out, "handoff.jsonl");
const env: Record<string, string> = {
	...(process.env as Record<string, string>),
	USERPROFILE: home,
	HOME: home,
	OMPDESK_PROTO_USER_DATA: ud,
	OMPDESK_PROTO_APP_ID: "com.seuput.ompdesk",
	HANDOFF_LOG: handoffLog,
	HANDOFF_RELAUNCH_ARGS: [`--user-data-dir=${ud}`, ...switches].join("|"),
};
if (values["fail-at"]) env.HANDOFF_FAIL_AT = values["fail-at"];
Bun.spawn([join(TEST_DIR, "OMPdesk.exe"), `--user-data-dir=${ud}`, ...switches], { env, stdout: "ignore", stderr: "ignore" });
note("electron-launched");

const updateLines = () => readJsonl(join(ud, "logs", "gui-runtime.jsonl")).filter(l => l.source === "app-update");
const deadline = Date.now() + 8 * 60_000;
let seen = 0;
while (Date.now() < deadline) {
	await Bun.sleep(2000);
	const lines = updateLines();
	for (const line of lines.slice(seen)) note("electron-log", { message: line.message, ...line.details });
	seen = lines.length;
	const handoff = readJsonl(handoffLog);
	if (handoff.some(l => l.event === "relaunch" || l.event === "failed")) break;
}
const handoff = readJsonl(handoffLog);
evidence.handoff = handoff;
note("handoff", handoff.map(l => l.event));

// 5. What came back.
await Bun.sleep(values["fail-at"] ? 25_000 : 15_000);
for (const line of updateLines().slice(seen)) note("electron-log", { message: line.message, ...line.details });
evidence.running = (await ps(`Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${TEST_DIR}', 'OrdinalIgnoreCase') } | Select-Object Id,ProcessName,Path,@{n='Version';e={$_.MainModule.FileVersionInfo.ProductVersion}} | ConvertTo-Json`)).out;
evidence.uninstallEntry = (await sh(["reg", "query", UNINSTALL])).out;
evidence.installLocation = (await sh(["reg", "query", LOCATION])).out;
evidence.folder = (await sh(["cmd", "/c", "dir", "/b", TEST_DIR])).out;
evidence.siblings = (await sh(["cmd", "/c", "dir", "/b", join(LOCAL, "Programs")])).out.split(/\r?\n/).filter(n => n.startsWith("OMPdesk"));
const shellLog = readJsonl(join(ud, "shell-webview", "shell.log.jsonl"));
evidence.shellLog = shellLog.filter(l => /^(start|page\.|migrate\.)/.test(String(l.event)));
note("shell-log", evidence.shellLog);
evidence.userDataFiles = (await sh(["cmd", "/c", "dir", "/b", ud])).out;

if (!values["keep-running"]) {
	const stopped = await stopTestProcesses();
	note("stopped", stopped.out.trim());
	await Bun.sleep(1500);
	// The uninstaller the move wrote (new shell) or Electron's own (failed move: leave it, we only remove the copy).
	if (!values["fail-at"] && values.payload) {
		const uninstall = /UninstallString\s+REG_SZ\s+"([^"]+)"/.exec(String(evidence.uninstallEntry))?.[1];
		if (uninstall) {
			await sh([uninstall, "--uninstall", "/currentuser"]);
			await Bun.sleep(4000);
			evidence.afterUninstall = {
				dirExists: existsSync(TEST_DIR),
				entry: (await sh(["reg", "query", UNINSTALL])).code === 0,
				location: (await sh(["reg", "query", LOCATION])).code === 0,
				userDataKept: existsSync(join(ud, "update-token.bin")),
			};
			note("uninstalled", evidence.afterUninstall);
		}
	}
	rmSync(TEST_DIR, { recursive: true, force: true });
	await sh(["reg", "delete", UNINSTALL, "/f"]);
	await sh(["reg", "delete", LOCATION, "/f"]);
}
feed.kill();
await sh(["reg", "import", ompKey]);
const realAfter = (await sh(["reg", "query", REAL_UNINSTALL])).out;
evidence.realInstallUntouched = realAfter === realBefore;
note("real-install-untouched", evidence.realInstallUntouched);
await Bun.write(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
