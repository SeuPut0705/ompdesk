/**
 * The pure parts of the dry run of the update move (run-move.ts needs a Windows desktop, the released setup and a built
 * shell; its real run is the evidence in the batch's report). What is pinned here is what keeps the run off the
 * person's install and what the setups it builds have to carry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("the released Electron selection", () => {
	it("keeps both released update paths and rejects an unrecognised source", async () => {
		// Import after changing the environment: this exercises the module-load selection, which a static import caches.
		try {
			for (const tag of ["v0.127.0", "v0.128.0"]) {
				vi.stubEnv("OMP_MOVE_RELEASED_TAG", tag);
				vi.resetModules();
				const released = await import("./constants");
				expect(released.RELEASED_TAG).toBe(tag);
				expect(released.RELEASED_VERSION).toBe(tag.slice(1));
				expect(released.TEST_GUID).toBe(TEST_GUID);
			}
			vi.stubEnv("OMP_MOVE_RELEASED_TAG", "v0.129.0");
			vi.resetModules();
			await expect(import("./constants")).rejects.toThrow("OMP_MOVE_RELEASED_TAG must be v0.127.0 or v0.128.0");
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
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
		// electron-builder includes getProcessInfo.nsh (and declares $pid) only while it has no such macro of ours to use.
		expect(shipping).toMatch(/^!include "getProcessInfo\.nsh"\nVar pid$/m);
		// electron-builder's own check first, then the old folder is set aside.
		expect(shipping).toMatch(
			/!insertmacro _CHECK_APP_RUNNING\n\s+!insertmacro ompSkipRepeatedFailure\n\s+!insertmacro ompKeepOldFolder/,
		);
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

	it("shows no dialog to an update: every MessageBox is behind `IfNot Silent` and `AndIfNot isUpdated`", () => {
		// v0.127.0's "Restart & install" starts the setup without /S: a rollback's dialog would reach a person whose update
		// went wrong (the dry run's two windows on the owner's desktop, 13 Nov 2026). An update reports through the
		// next launch's `swap result … rolled back` line and %TEMP%\ompdesk-setup.log.
		const boxes = shipping.match(/MessageBox /g)?.length ?? 0;
		const guarded =
			shipping.match(/\$\{IfNot\} \$\{Silent\}\n\s+\$\{AndIfNot\} \$\{isUpdated\}\n\s+MessageBox /g)?.length ?? 0;
		expect(boxes).toBe(3);
		expect(guarded).toBe(boxes);
		expect(shipping).toContain("%TEMP%\\ompdesk-setup.log");
	});

	it("steps out of the install folder before it deletes or renames it (NSIS cannot delete the folder it stands in)", () => {
		expect(shipping).toMatch(
			/SetOutPath "\$TEMP"\n\s+RMDir \/r "\$INSTDIR"\n\s+ClearErrors\n\s+Rename "\$ompBackup" "\$INSTDIR"/,
		);
		expect(shipping).toMatch(/SetOutPath "\$TEMP"\n\s+ClearErrors\n\s+Rename "\$INSTDIR" "\$ompBackup"/);
	});

	it("makes the dry run's setup silent however the updater starts it", () => {
		expect(seams).toMatch(
			/!macro preInit\n\s+ReadEnvStr \$R9 OMP_MOVE_SILENT\n\s+StrCmp \$R9 "1" 0 \+2\n\s+SetSilent silent/,
		);
	});

	it("counts start failures in userData and skips an automatic update of a version that already failed", () => {
		// The record's shape is release 1's (`{"version","count","at"}`, one line, `at` in epoch milliseconds).
		expect(shipping).toContain('StrCpy $ompFailed "$ompUserData\\update-start-failed.json"');
		expect(shipping).toMatch(/\$\{StdUtils\.Time\} \$R6[\s\S]*\$\\"at\$\\":\$R6000\}/);
		// The skip comes before the old folder is touched, only for an automatic update, and exits 2 with the old app started.
		expect(shipping).toMatch(
			/!insertmacro _CHECK_APP_RUNNING\n\s+!insertmacro ompSkipRepeatedFailure\n\s+!insertmacro ompKeepOldFolder/,
		);
		expect(shipping).toMatch(
			/!macro ompSkipRepeatedFailure[\s\S]*\$\{if\} \$\{isUpdated\}[\s\S]*start-failed-before: skipped[\s\S]*SetErrorLevel 2\n\s+Quit/,
		);
		// A proof of start removes the record; a failure writes it before the old app is restored.
		expect(shipping).toMatch(/RMDir \/r "\$ompBackup"\n\s+Delete "\$ompFailed"/);
		expect(shipping).toMatch(/!insertmacro ompRecordFailure\n\s+!insertmacro ompLog "start-failed:/);
	});

	it("never defines OMP_MOVE_TEST itself, and only the dry run's include does", () => {
		expect(shipping).not.toMatch(/^!define OMP_MOVE_TEST/m);
		expect(seams).toMatch(/^!define OMP_MOVE_TEST/m);
		// Every seam the shipping file calls is defined by the include, and nothing else is.
		for (const macro of ["ompMoveTestBeforeCheck", "ompMoveTestAfterInstall"]) {
			expect(shipping, macro).toContain(`!insertmacro ${macro}`);
			expect(seams, macro).toContain(`!macro ${macro}`);
		}
		// The old app comes back through the launcher in the dry run (Explorer has no test environment), through its exe in a release.
		expect(shipping).toMatch(
			/!ifdef OMP_MOVE_TEST\n\s+\$\{StdUtils\.ExecShellAsUser\} \$0 "\$launchLink" "open" ""\n\s+!else\n\s+\$\{StdUtils\.ExecShellAsUser\} \$0 "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" "open" ""/,
		);
	});

	it("keeps the old folder until the new shell proved it started (app-started.json of this version), else puts it back", () => {
		// The mark is written by the main once the first window's page loaded; it carries the setup's own version.
		expect(shipping).toContain('StrCpy $ompMarker "$ompUserData\\app-started.json"');
		expect(shipping).toContain("ReadEnvStr $ompUserData OMP_GUI_TEST_USER_DATA_DIR");
		expect(shipping).toContain('StrCpy $ompUserData "$APPDATA\\ompdesk"');
		expect(shipping).toMatch(/Delete "\$ompMarker"\n[\s\S]*ExecShellAsUser\} \$0 "\$launchLink" "open" "\$ompArgs"/);
		expect(shipping).toContain("${For} $ompWaited 1 120");
		expect(shipping).toContain('$\\"version$\\":$\\"${VERSION}$\\"');
		// The proof removes the backup; the lack of it kills the new app's processes, restores and exits 2, no dialog.
		expect(shipping).toMatch(
			/\$\{if\} \$ompSeen == "1"\n\s+RMDir \/r "\$ompBackup"\n\s+Delete "\$ompFailed"\n\s+\$\{else\}\n\s+!insertmacro ompRecordFailure\n\s+!insertmacro ompLog "start-failed:[^\n]*\n\s+!insertmacro KILL_PROCESS "\$\{APP_EXECUTABLE_FILENAME\}" 1\n\s+Sleep 3000\n\s+!insertmacro ompRestoreOldFolder "start-failed"/,
		);
		// Neither check removes the backup before the proof, and `start-failed` shows no dialog.
		expect(shipping).toMatch(/!if "\$\{REASON\}" == "incomplete"\n\s+\$\{IfNot\} \$\{Silent\}/);
	});

	it("starts nothing without the test profile and the isolated home in the setup's environment", () => {
		expect(seams).toMatch(
			/\$\{if\} \$R9 == ""\n\s+\$\{orIf\} \$R7 == ""\n\s+FileWrite \$R8 "@echo off\$\\r\$\\nexit \/b 1/,
		);
		expect(seams).toContain("OMP_GUI_TEST_USER_DATA_DIR");
		expect(seams).toContain("OMP_GUI_HEADLESS");
	});
});
