import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLauncherPath, openLocalPath } from "./open-path";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "open-path-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fakeShell(openError = "") {
	return {
		openPath: vi.fn(async (_file: string) => openError),
		showItemInFolder: vi.fn((_file: string) => {}),
	};
}

function file(name: string, body = "x", mode = 0o644): string {
	const target = path.join(dir, name);
	writeFileSync(target, body);
	chmodSync(target, mode);
	return target;
}

describe("isLauncherPath", () => {
	it.each([
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
		// python.org's install registers Python Launcher, which runs a script on open; an interpreter install can claim the others.
		"x.py",
		"x.pyw",
		"x.pyz",
		"x.pl",
		"x.rb",
	])("refuses %s on macOS", async name => {
		expect(await isLauncherPath(file(name), "darwin")).toBe(true);
	});

	it.each([
		"x.exe",
		"X.EXE",
		"x.bat",
		"x.cmd",
		"x.ps1",
		"x.lnk",
		"x.url",
		"x.msi",
		"x.vbs",
		"x.js",
		"x.hta",
		"x.scr",
		"x.jar",
		"x.exe.",
		"x.exe ",
		"x.chm",
		"x.settingcontent-ms",
		"x.website",
		"x.appinstaller",
		"x.xll",
		"x.wsc",
		"x.sct",
		"x.theme",
		"x.themepack",
	])("refuses %s on Windows", async name => {
		expect(await isLauncherPath(path.join(dir, name), "win32")).toBe(true);
	});

	it("refuses an .app bundle directory", async () => {
		const bundle = path.join(dir, "Thing.app");
		mkdirSync(bundle);
		expect(await isLauncherPath(bundle, "darwin")).toBe(true);
	});

	// NTFS has no exec bit (a chmod 0o755 file stats as 0o666), so these two need a POSIX filesystem.
	const posixFs = it.skipIf(process.platform === "win32");

	posixFs("refuses an extensionless regular file with an executable bit on POSIX", async () => {
		expect(await isLauncherPath(file("runme", "#!/bin/sh\n", 0o755), "darwin")).toBe(true);
	});

	it("does not treat the exec bit as meaningful on Windows", async () => {
		expect(await isLauncherPath(file("notes", "x", 0o755), "win32")).toBe(false);
	});

	it("refuses a plain-looking symlink to a launcher", async () => {
		const real = file("real.command");
		const link = path.join(dir, "readme.txt");
		symlinkSync(real, link);
		expect(await isLauncherPath(link, "darwin")).toBe(true);
	});

	posixFs("refuses a symlink to an executable file", async () => {
		const real = file("real", "#!/bin/sh\n", 0o755);
		const link = path.join(dir, "notes.txt");
		symlinkSync(real, link);
		expect(await isLauncherPath(link, "darwin")).toBe(true);
	});

	it("keeps ordinary documents, source and directories openable", async () => {
		for (const name of ["a.txt", "a.md", "a.ts", "a.png", "a.pdf", "a.json", "a.html"]) {
			expect(await isLauncherPath(file(name), "darwin")).toBe(false);
		}
		const folder = path.join(dir, "docs");
		mkdirSync(folder);
		expect(await isLauncherPath(folder, "darwin")).toBe(false);
	});

	it("keeps .js openable on macOS, where it opens in an editor", async () => {
		expect(await isLauncherPath(file("a.js"), "darwin")).toBe(false);
	});
});

describe("openLocalPath", () => {
	it("opens an ordinary file", async () => {
		const shell = fakeShell();
		const target = file("a.txt");
		expect(await openLocalPath(target, shell, "darwin")).toBe("opened");
		expect(shell.openPath).toHaveBeenCalledWith(target);
		expect(shell.showItemInFolder).not.toHaveBeenCalled();
	});

	it("reveals a launcher without ever opening it", async () => {
		const shell = fakeShell();
		const target = file("run.command", "#!/bin/sh\n", 0o755);
		expect(await openLocalPath(target, shell, "darwin")).toBe("revealed");
		expect(shell.openPath).not.toHaveBeenCalled();
		expect(shell.showItemInFolder).toHaveBeenCalledWith(target);
	});

	it("falls back to revealing when the system has no app for the file", async () => {
		const shell = fakeShell("no application");
		const target = file("a.xyz");
		expect(await openLocalPath(target, shell, "darwin")).toBe("revealed");
		expect(shell.showItemInFolder).toHaveBeenCalledWith(target);
	});
});
