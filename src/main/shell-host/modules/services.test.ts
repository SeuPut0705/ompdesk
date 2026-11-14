/**
 * `services.*` against the real shell (PROTOCOL.md §15.3): the cases of the deleted `open-path.test.ts` and the
 * control socket's confirm card. `OMP_GUI_TEST_SERVICES_DRY=1` keeps `openOrReveal` from handing anything to the OS
 * (no Finder or Explorer window, no app opened); the answers are the ones it would act on. Cases for the
 * other platform's launchers, the "no app for the file" fallback and the saved picture's name are the Rust tests of
 * `services_core` (with `captured.json`).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { itWithFileSymlinks } from "../../test-symlinks";
import { shellModule } from "./client";
import { type DesktopServices, type ServicesSpec, servicesClient } from "./services";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const executable = testShellExecutable();
const windows = process.platform === "win32";

describe.skipIf(!executable)("services against the shell", () => {
	let shell: TestShell;
	let services: DesktopServices;
	let dir: string;

	beforeAll(async () => {
		const seams = { OMP_GUI_TEST_SERVICES_DRY: "1", OMP_GUI_TEST_SERVICES_NO_APP: ".xyz" };
		const before = Object.fromEntries(Object.keys(seams).map(key => [key, process.env[key]]));
		Object.assign(process.env, seams);
		try {
			shell = await startTestShell(executable as string);
		} finally {
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = value;
			}
		}
		services = servicesClient(shellModule<ServicesSpec>("services", () => shell.client));
	}, 90_000);
	afterAll(() => shell?.close());

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "services-"));
		return () => rmSync(dir, { recursive: true, force: true });
	});

	function file(name: string, body = "x", mode = 0o644): string {
		const target = path.join(dir, name);
		writeFileSync(target, body);
		chmodSync(target, mode);
		return target;
	}

	// open-path.test.ts's rows, each on its own platform.
	it
		.runIf(!windows)
		.each([
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
		])("reveals %s on macOS without opening it", async name => {
		expect(await services.openOrReveal(file(name))).toBe("revealed");
	});

	it
		.runIf(windows)
		.each([
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
		])("reveals %s on Windows without opening it", async name => {
		// As in open-path.test.ts, by name: NTFS would drop the trailing dot or space of a file it makes.
		expect(await services.openOrReveal(path.join(dir, name))).toBe("revealed");
	});

	it("falls back to revealing when the system has no app for the file", async () => {
		// OMP_GUI_TEST_SERVICES_NO_APP=.xyz: the shell's dry open answers "no application" for it, as the OS would.
		expect(await services.openOrReveal(file("a.xyz"))).toBe("revealed");
	});

	it.runIf(!windows)("reveals an .app bundle directory", async () => {
		const bundle = path.join(dir, "Thing.app");
		mkdirSync(bundle);
		expect(await services.openOrReveal(bundle)).toBe("revealed");
	});

	it.runIf(!windows)("reveals an extensionless regular file with an executable bit", async () => {
		expect(await services.openOrReveal(file("runme", "#!/bin/sh\n", 0o755))).toBe("revealed");
	});

	it.runIf(windows)("does not treat the exec bit as meaningful on Windows", async () => {
		expect(await services.openOrReveal(file("notes", "x", 0o755))).toBe("opened");
	});

	itWithFileSymlinks("reveals a plain-looking symlink to a launcher", async () => {
		const real = file(windows ? "real.bat" : "real.command");
		const link = path.join(dir, "readme.txt");
		symlinkSync(real, link);
		expect(await services.openOrReveal(link)).toBe("revealed");
	});

	it.runIf(!windows)("reveals a symlink to an executable file", async () => {
		const real = file("real", "#!/bin/sh\n", 0o755);
		const link = path.join(dir, "notes.txt");
		symlinkSync(real, link);
		expect(await services.openOrReveal(link)).toBe("revealed");
	});

	it("opens ordinary documents, source and directories", async () => {
		for (const name of ["a.txt", "a.md", "a.ts", "a.png", "a.pdf", "a.json", "a.html"]) {
			expect(await services.openOrReveal(file(name)), name).toBe("opened");
		}
		const folder = path.join(dir, "docs");
		mkdirSync(folder);
		expect(await services.openOrReveal(folder)).toBe("opened");
	});

	it.runIf(!windows)("opens .js on macOS, where it opens in an editor", async () => {
		expect(await services.openOrReveal(file("a.js"))).toBe("opened");
	});

	// It shows a real message box for half a second, so it runs only on a GitHub runner, never on a person's desktop.
	it.runIf(process.env.GITHUB_ACTIONS === "true")(
		"closes a confirm card nobody answers once its time is up, and answers its cancelId (refused)",
		async () => {
			const started = Date.now();
			const response = await services.confirm(
				undefined,
				{
					type: "question",
					title: "Outside process",
					message: "Allow?",
					detail: "Outside process: test (self-declared)",
					buttons: ["Allow", "Don't allow"],
					defaultId: 1,
					cancelId: 1,
				},
				500,
			);
			expect(response).toBe(1);
			expect(Date.now() - started).toBeGreaterThanOrEqual(400);
		},
		30_000,
	);
});
