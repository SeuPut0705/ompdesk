/**
 * What the dry run must never change: the person's own install, his uninstall entry, his `omp://` handler, his
 * shortcuts and `%APPDATA%\ompdesk`, and his running OMPdesk processes. `snapshotOwner()` reads them (read-only: a
 * directory walk, `reg query`, `Get-Process`); `diffOwner(before, after)` names every difference. `run-move.ts` takes
 * one before it does anything and one after everything, and exits 1 on any difference.
 *
 * His updater's cache (`%LOCALAPPDATA%\ompdesk-updater`, electron-updater's `updaterCacheDirName`, the same for every
 * copy of the app that runs with his LOCALAPPDATA) is compared whole: batch P's dry run ran its test app with his
 * LOCALAPPDATA and left its 200 MB test setup in `pending\` there.
 *
 * Not compared: the mtimes of `%APPDATA%\ompdesk` (his running app writes there all day; only the names of what sits
 * at its top level are held) and the contents of his install (listing, sizes and mtimes are).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const REAL_GUID = "e6f1f351-4346-5a64-a104-9a02672ef1bc";
const LOCAL = process.env.LOCALAPPDATA ?? "";
const APPDATA = process.env.APPDATA ?? "";
export const REAL_DIR = join(LOCAL, "Programs", "OMPdesk");
export const REAL_UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${REAL_GUID}`;
const REAL_INSTALL_KEY = `HKCU\\Software\\${REAL_GUID}`;
const CLASSES_OMP = "HKCU\\Software\\Classes\\omp";
export const REAL_UPDATER_CACHE = join(LOCAL, "ompdesk-updater");

export interface OwnerSnapshot {
	/** Relative path (with /) → "size:mtimeMs" of every file under his install folder; null when there is none. */
	installFolder: Record<string, string> | null;
	uninstallKey: string;
	installKey: string;
	classesOmp: string;
	/** Names at the top level of %APPDATA%\ompdesk. */
	appDataTop: string[] | null;
	/** "mtimeMs" of the Start-menu and desktop shortcuts named OMPdesk.lnk. */
	shortcuts: Record<string, string>;
	/** Relative path → "size:mtimeMs" of every file under his updater's cache; null when there is none. */
	updaterCache: Record<string, string> | null;
	/** pid → path of every running process whose image is under his install folder. */
	processes: Record<string, string>;
}

/** Output and exit code of a command, never throwing. */
export async function run(cmd: string[], env?: Record<string, string>): Promise<{ code: number; out: string }> {
	const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
	const [out, err] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
	return { code: await child.exited, out: out + err };
}

export const powershell = (script: string) => run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);

function walk(root: string, base = root, out: Record<string, string> = {}): Record<string, string> {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const file = join(root, entry.name);
		if (entry.isDirectory()) walk(file, base, out);
		else {
			const stat = statSync(file);
			out[file.slice(base.length + 1).replaceAll("\\", "/")] = `${stat.size}:${Math.round(stat.mtimeMs)}`;
		}
	}
	return out;
}

async function lnkTimes(): Promise<Record<string, string>> {
	const found: Record<string, string> = {};
	const desktop = (await powershell("[Environment]::GetFolderPath('Desktop')")).out.trim();
	const startMenu = (await powershell("[Environment]::GetFolderPath('Programs')")).out.trim();
	for (const file of [join(desktop, "OMPdesk.lnk"), join(startMenu, "OMPdesk.lnk")]) {
		found[file] = existsSync(file) ? String(Math.round(statSync(file).mtimeMs)) : "absent";
	}
	return found;
}

async function ownerProcesses(): Promise<Record<string, string>> {
	const listed = await powershell(
		`Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${REAL_DIR}', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.Id)|$($_.Path)" }`,
	);
	const found: Record<string, string> = {};
	for (const line of listed.out.split(/\r?\n/).filter(Boolean)) {
		const [pid, path] = line.split("|");
		if (pid && path) found[pid] = path;
	}
	return found;
}

export async function snapshotOwner(): Promise<OwnerSnapshot> {
	return {
		installFolder: existsSync(REAL_DIR) ? walk(REAL_DIR) : null,
		uninstallKey: (await run(["reg", "query", REAL_UNINSTALL_KEY, "/s"])).out,
		installKey: (await run(["reg", "query", REAL_INSTALL_KEY, "/s"])).out,
		classesOmp: (await run(["reg", "query", CLASSES_OMP, "/s"])).out,
		updaterCache: existsSync(REAL_UPDATER_CACHE) ? walk(REAL_UPDATER_CACHE) : null,
		appDataTop: existsSync(join(APPDATA, "ompdesk")) ? readdirSync(join(APPDATA, "ompdesk")).sort() : null,
		shortcuts: await lnkTimes(),
		processes: await ownerProcesses(),
	};
}

/** Every difference between two snapshots, one sentence each; empty when nothing changed. */
export function diffOwner(before: OwnerSnapshot, after: OwnerSnapshot): string[] {
	const problems: string[] = [];
	if (JSON.stringify(before.installFolder === null) !== JSON.stringify(after.installFolder === null)) {
		problems.push("his install folder appeared or disappeared");
	} else if (before.installFolder && after.installFolder) {
		for (const name of new Set([...Object.keys(before.installFolder), ...Object.keys(after.installFolder)])) {
			if (before.installFolder[name] !== after.installFolder[name]) {
				problems.push(
					`his install: ${name} was ${before.installFolder[name] ?? "absent"}, is ${after.installFolder[name] ?? "absent"}`,
				);
			}
		}
	}
	if (JSON.stringify(before.updaterCache) !== JSON.stringify(after.updaterCache)) {
		problems.push(
			`his updater cache changed: was ${JSON.stringify(before.updaterCache)}, is ${JSON.stringify(after.updaterCache)}`,
		);
	}
	for (const key of ["uninstallKey", "installKey", "classesOmp"] as const) {
		if (before[key] !== after[key])
			problems.push(`${key} changed:\n--- before\n${before[key]}\n--- after\n${after[key]}`);
	}
	if (JSON.stringify(before.appDataTop) !== JSON.stringify(after.appDataTop)) {
		const was = new Set(before.appDataTop ?? []);
		const is = new Set(after.appDataTop ?? []);
		problems.push(
			`%APPDATA%\\ompdesk top level: added [${[...is].filter(name => !was.has(name)).join(", ")}], removed [${[...was].filter(name => !is.has(name)).join(", ")}]`,
		);
	}
	for (const file of Object.keys({ ...before.shortcuts, ...after.shortcuts })) {
		if (before.shortcuts[file] !== after.shortcuts[file]) problems.push(`shortcut ${file} changed`);
	}
	for (const pid of Object.keys(before.processes)) {
		if (!(pid in after.processes)) problems.push(`his running process ${pid} (${before.processes[pid]}) is gone`);
	}
	return problems;
}

/** The two PowerShell calls electron-builder's setup makes to tell which processes run from the install folder. */
export async function setupCanFindProcesses(folder: string): Promise<string | null> {
	const available = await run([
		"powershell",
		"-C",
		"if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
	]);
	if (available.code !== 0) return `PowerShell has no Get-CimInstance (${available.out.trim()})`;
	const policy = await run([
		"powershell",
		"-C",
		"if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 0 } else { exit 1 }",
	]);
	if (policy.code === 0)
		return "PowerShell's process execution policy is Restricted: the setup would fall back to killing by image name";
	const probe = await run([
		"powershell",
		"-C",
		`if ((Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith('${folder}', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }`,
	]);
	if (probe.code !== 1 || probe.out.trim()) {
		return `the setup's own process query (Get-CimInstance Win32_Process) does not answer cleanly: exit ${probe.code} ${probe.out.trim()}`;
	}
	return null;
}
