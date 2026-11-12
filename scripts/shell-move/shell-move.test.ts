/**
 * The pure parts of the dry run of the update move (run-move.ts needs a Windows desktop, the released setup and a built
 * shell; its real run is the evidence in the batch's report). What is pinned here is what keeps the run off the
 * person's install and what the setups it builds have to carry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findEmbedded7z } from "./build-setups";
import { TEST_GUID, TEST_SHORTCUT } from "./constants";
import { diffOwner, type OwnerSnapshot, REAL_GUID } from "./guard";

const ROOT = path.join(__dirname, "..", "..");
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), "utf8");

const owner = (): OwnerSnapshot => ({
	installFolder: { "OMPdesk.exe": "100:1" },
	uninstallKey: "DisplayVersion REG_SZ 0.127.0",
	installKey: "InstallLocation REG_SZ C:\\x",
	classesOmp: "omp",
	appDataTop: ["logs", "prefs.json"],
	shortcuts: { "desktop/OMPdesk.lnk": "5" },
	processes: { "10": "C:\\x\\OMPdesk.exe" },
});

describe("the test identity", () => {
	it("is shaped like electron-builder's GUIDs (UUID v5) and is never the real one, the real folder or the real shortcut", () => {
		expect(TEST_GUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(TEST_GUID).not.toBe(REAL_GUID);
		expect(REAL_GUID).toBe("e6f1f351-4346-5a64-a104-9a02672ef1bc");
		expect(TEST_SHORTCUT).not.toBe("OMPdesk");
	});
});

describe("the person's-install guard", () => {
	it("is silent when nothing changed, and its install listing is not fooled by his app writing its own data", () => {
		expect(diffOwner(owner(), owner())).toEqual([]);
		const busy = owner();
		busy.appDataTop = ["logs", "prefs.json"];
		expect(diffOwner(owner(), busy)).toEqual([]);
	});

	it("names a changed file, a registry entry, a new name in %APPDATA%\\ompdesk, a shortcut and a process that ended", () => {
		const changed = owner();
		changed.installFolder = { "OMPdesk.exe": "100:2", "new.dll": "1:1" };
		changed.uninstallKey = "DisplayVersion REG_SZ 0.200.0";
		changed.appDataTop = ["logs", "prefs.json", "shell-webview"];
		changed.shortcuts = { "desktop/OMPdesk.lnk": "6" };
		changed.processes = {};
		const problems = diffOwner(owner(), changed).join("\n");
		expect(problems).toContain("OMPdesk.exe was 100:1, is 100:2");
		expect(problems).toContain("new.dll was absent");
		expect(problems).toContain("uninstallKey changed");
		expect(problems).toContain("added [shell-webview]");
		expect(problems).toContain("shortcut desktop/OMPdesk.lnk changed");
		expect(problems).toContain("his running process 10");
	});
});

describe("the released setup's payload", () => {
	it("is found by the 7z signature and the length its start header states", () => {
		const header = Buffer.alloc(32);
		Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]).copy(header);
		header.writeBigUInt64LE(100n, 12);
		header.writeBigUInt64LE(20n, 20);
		const archive = Buffer.concat([header, Buffer.alloc(120)]);
		const setup = Buffer.concat([Buffer.alloc(5000, 0x37), archive, Buffer.alloc(40)]);
		expect(findEmbedded7z(setup)).toEqual({ offset: 5000, length: 152 });
		expect(() => findEmbedded7z(Buffer.alloc(100))).toThrow(/no 7z archive/);
	});
});

describe("resources/installer.nsh and the test seams", () => {
	const shipping = read("resources/installer.nsh");
	const seams = read("scripts/shell-move/move-test.nsh");

	it("keeps the old folder until the new one is complete, and checks the shell, CEF, Node and the main", () => {
		expect(shipping).toContain("!macro customCheckAppRunning");
		// electron-builder's own check first, then the old folder is set aside.
		expect(shipping).toMatch(/!insertmacro _CHECK_APP_RUNNING\n\s+!insertmacro ompKeepOldFolder/);
		expect(shipping).toContain('Rename "$INSTDIR" "$ompBackup"');
		expect(shipping).toContain("!macro customInstall");
		for (const needed of ["libcef.dll", "resources\\node\\node.exe", "resources\\app\\out\\main\\index.js"]) {
			expect(shipping, needed).toContain(`$INSTDIR\\${needed}`);
		}
		// A failed check restores the old folder and its uninstall entry's values and fails the setup.
		expect(shipping).toMatch(
			/!macro ompRestoreOldFolder[\s\S]*Rename "\$ompBackup" "\$INSTDIR"[\s\S]*SetErrorLevel 2\n\s+Quit/,
		);
		// `${NAME}` as NSIS writes it, built so it never reads as a template slot.
		expect(shipping).toContain(`WriteRegStr SHELL_CONTEXT "$${"{"}UNINSTALL_REGISTRY_KEY}" DisplayVersion`);
	});

	it("never defines OMP_MOVE_TEST itself, and only the dry run's include does", () => {
		expect(shipping).not.toMatch(/^!define OMP_MOVE_TEST/m);
		expect(seams).toMatch(/^!define OMP_MOVE_TEST/m);
		// Every seam the shipping file calls is defined by the include, and nothing else is.
		for (const macro of ["ompMoveTestBeforeCheck", "ompMoveTestAfterInstall"]) {
			expect(shipping, macro).toContain(`!insertmacro ${macro}`);
			expect(seams, macro).toContain(`!macro ${macro}`);
		}
		// A release-time restore of the old app starts it again; the dry run must not (Explorer has no test environment).
		expect(shipping).toMatch(/!ifndef OMP_MOVE_TEST\n\s+\$\{if\} \$ompBackupMode != ""/);
	});

	it("starts nothing without the test profile and the isolated home in the setup's environment", () => {
		expect(seams).toMatch(
			/\$\{if\} \$R9 == ""\n\s+\$\{orIf\} \$R7 == ""\n\s+FileWrite \$R8 "@echo off\$\\r\$\\nexit \/b 1/,
		);
		expect(seams).toContain("OMP_GUI_TEST_USER_DATA_DIR");
		expect(seams).toContain("OMP_GUI_HEADLESS");
	});
});
