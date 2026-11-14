/**
 * Captures the pure rules SX3 moves into the shell's `services` module (PROTOCOL.md §15.3 step 2) from the TypeScript
 * that still has them, into `native/ompdesk/crates/shell/src/services_core/captured.json`:
 * - `launcher`: `open-path.ts` `isLauncherPath` by name alone (paths that do not exist), on Windows and on POSIX;
 * - `imageExtension`: the extension `ipc.ts`'s `SYSTEM_SAVE_IMAGE` gives a saved image for its MIME type (the
 *   expression copied verbatim from ipc.ts at the capture commit, since it is inline there).
 * Run: `bun scripts/shell-port/capture-services.ts`.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isLauncherPath } from "../../src/main/open-path";

const NAMES = [
	"run.command",
	"tool.TOOL",
	"x.terminal",
	"x.workflow",
	"x.pkg",
	"x.dmg",
	"x.scpt",
	"x.webloc",
	"x.inetloc",
	"x.fileloc",
	"run.sh",
	"x.jar",
	"x.py",
	"x.pyw",
	"x.pyz",
	"x.pl",
	"x.rb",
	"x.exe",
	"X.EXE",
	"x.bat",
	"x.cmd",
	"x.com",
	"x.ps1",
	"x.lnk",
	"x.url",
	"x.msi",
	"x.vbs",
	"x.js",
	"x.hta",
	"x.scr",
	"x.exe.",
	"x.exe ",
	"x.exe. . ",
	"x.chm",
	"x.settingcontent-ms",
	"x.website",
	"x.appinstaller",
	"x.xll",
	"x.wsc",
	"x.sct",
	"x.theme",
	"x.themepack",
	"x.zsh",
	"x.applescript",
	"x.prefpane",
	"Thing.app",
	"a.txt",
	"a.md",
	"a.ts",
	"a.png",
	"a.pdf",
	"a.json",
	"a.html",
	"README",
	".exe",
	".bashrc",
	"archive.tar.gz",
	"x.EXE.txt",
	"x.txt.exe",
	"dir.app/inner.txt",
	"x.app/",
	"x.",
	"x ",
	"x.cmd.",
	"x.sh ",
	"x.Py",
	"x.ÉXE",
];

const MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/png; charset=binary",
	"image/jpeg;q=1",
	"image/",
	"image",
	"",
	"text/plain",
	"application/octet-stream",
	"image/PNG",
	"image/x.y-z_9",
	"image/heic+jpeg",
	"/png",
	"image/png/extra",
	"image/jpegjpeg",
	"image/ü",
];

/** `ipc.ts` SYSTEM_SAVE_IMAGE's extension, verbatim. */
function imageExtension(mimeType: string): string {
	return (
		mimeType
			.split("/")[1]
			?.split(/[+;]/)[0]
			?.replace("jpeg", "jpg")
			.replace(/[^a-z0-9]/gi, "") || "png"
	);
}

const missing = path.join("/nonexistent-ompdesk-capture", "dir");
const launcher: Array<{ name: string; platform: "win32" | "posix"; launcher: boolean }> = [];
for (const name of NAMES) {
	for (const platform of ["win32", "posix"] as const) {
		const file = path.join(missing, name);
		launcher.push({
			name,
			platform,
			launcher: await isLauncherPath(file, platform === "win32" ? "win32" : "darwin"),
		});
	}
}

const captured = {
	capturedFrom: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	launcher,
	imageExtension: MIME_TYPES.map(mimeType => ({ mimeType, extension: imageExtension(mimeType) })),
};
const out = path.join(import.meta.dir, "../../native/ompdesk/crates/shell/src/services_core/captured.json");
writeFileSync(out, `${JSON.stringify(captured, null, "\t")}\n`);
console.log(`captured ${launcher.length} launcher rows and ${captured.imageExtension.length} image rows into ${out}`);
