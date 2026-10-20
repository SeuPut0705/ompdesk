/**
 * Opening a path a reply or tool card names. `shell.openPath` hands the file to
 * LaunchServices / ShellExecute, which RUN an app, a `.command`, an `.exe`,
 * a `.lnk` and the like. Model text (steered by a web page, README or issue)
 * can link such a file, and one click would launch it with no prompt, so
 * launcher types are revealed in Finder / Explorer instead, never opened.
 */

import path from "node:path";
import { promises as fsp } from "original-fs";

/**
 * Types that start code when opened, on any platform (a repo's `run.bat` is revealed on a Mac too). Scripts an
 * interpreter's install can claim are here too: python.org's Python Launcher runs a `.py` on open on macOS, and a
 * file a repo or the agent writes rarely carries the exec bit the POSIX check below needs.
 */
const COMMON_LAUNCHER_EXTENSIONS = [
	".app",
	".command",
	".sh",
	".jar",
	".bat",
	".cmd",
	".exe",
	".com",
	".lnk",
	".url",
	".py",
	".pyw",
	".pyz",
	".pl",
	".rb",
];

const MAC_LAUNCHER_EXTENSIONS = [
	".tool",
	".terminal",
	".workflow",
	".action",
	".saver",
	".pkg",
	".mpkg",
	".dmg",
	".scpt",
	".scptd",
	".applescript",
	".webloc",
	".inetloc",
	".fileloc",
	".zsh",
	".bash",
	".csh",
	".ksh",
	".fish",
	".prefpane",
	".appex",
	".xpc",
];

const WINDOWS_LAUNCHER_EXTENSIONS = [
	".ps1",
	".psm1",
	".ps1xml",
	".psc1",
	".vbs",
	".vbe",
	".js",
	".jse",
	".wsf",
	".wsh",
	".hta",
	".msi",
	".msp",
	".msc",
	".msix",
	".msixbundle",
	".appx",
	".appxbundle",
	".appref-ms",
	".application",
	".gadget",
	".reg",
	".scr",
	".pif",
	".cpl",
	".scf",
	".diagcab",
	".library-ms",
	".search-ms",
	".settingcontent-ms",
	".website",
	".appinstaller",
	// Compiled help runs embedded script; an Excel add-in loads native code; scriptlets run script.
	".chm",
	".xll",
	".wsc",
	".sct",
	// A theme fetches its resources from a path it names (a remote share leaks NTLM credentials).
	".theme",
	".themepack",
];

const LAUNCHER_EXTENSIONS: Record<"win32" | "posix", readonly string[]> = {
	win32: [...COMMON_LAUNCHER_EXTENSIONS, ...WINDOWS_LAUNCHER_EXTENSIONS],
	posix: [...COMMON_LAUNCHER_EXTENSIONS, ...MAC_LAUNCHER_EXTENSIONS],
};

function extensionLauncher(file: string, platform: NodeJS.Platform): boolean {
	const windows = platform === "win32";
	// Windows ignores trailing dots and spaces ("x.exe." and "x.exe " still run).
	const name = windows ? path.basename(file).replace(/[. ]+$/, "") : path.basename(file);
	return LAUNCHER_EXTENSIONS[windows ? "win32" : "posix"].includes(path.extname(name).toLowerCase());
}

/** True when opening `file` could run code: a launcher extension (also behind a symlink) or, on POSIX, an executable regular file. */
export async function isLauncherPath(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	if (extensionLauncher(file, platform)) return true;
	let real = file;
	try {
		real = await fsp.realpath(file);
	} catch {
		return false;
	}
	if (real !== file && extensionLauncher(real, platform)) return true;
	if (platform === "win32") return false;
	try {
		const info = await fsp.stat(real);
		return info.isFile() && (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

export interface OpenShell {
	openPath(file: string): Promise<string>;
	showItemInFolder(file: string): void;
}

/**
 * Opens `file` in its default app, or reveals it: always for a launcher, and as
 * the fallback when no app handles the file.
 */
export async function openLocalPath(
	file: string,
	shell: OpenShell,
	platform: NodeJS.Platform = process.platform,
): Promise<"opened" | "revealed"> {
	if (await isLauncherPath(file, platform)) {
		shell.showItemInFolder(file);
		return "revealed";
	}
	if (await shell.openPath(file)) {
		shell.showItemInFolder(file);
		return "revealed";
	}
	return "opened";
}
