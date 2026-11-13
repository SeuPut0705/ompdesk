import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cefPlatform,
	checkShell,
	KEPT_LOCALES,
	RECORD_NAME,
	readPin,
	type ShellBuildRecord,
	sourceSha256,
	trimmedIndex,
	WINDOWS_RUNTIME_FILES,
} from "./build-shell";

const dirs: string[] = [];
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A staged folder for this platform with the files and a record that fit this checkout's sources. */
function stage(files: Record<string, string>, patch: Partial<ShellBuildRecord> = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-stage-"));
	dirs.push(dir);
	const hashes: Record<string, string> = {};
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
		hashes[rel] = sha(text);
	}
	const record: ShellBuildRecord = {
		version: "0.1.0",
		platform: process.platform,
		arch: process.arch,
		binary: "ompdesk-shell",
		files: hashes,
		sourceSha256: sourceSha256(),
		cef: { version: "156.0.26", archiveSha256: "0".repeat(64) },
		rustc: "rustc test",
		builtAt: "2026-11-12T00:00:00.000Z",
		buildSeconds: 1,
		...patch,
	};
	fs.writeFileSync(path.join(dir, RECORD_NAME), JSON.stringify(record));
	return dir;
}

describe("the CEF pin", () => {
	it("names an archive with a SHA-256 for every platform the shell ships on", () => {
		const pin = readPin();
		for (const key of ["windows64", "macosarm64", "macosx64"]) {
			const entry = pin.platforms[key];
			expect(entry.name).toMatch(
				new RegExp(`^cef_binary_${pin.cefVersion.replaceAll(".", "\\.")}\\+.*_${key}_minimal\\.tar\\.bz2$`),
			);
			expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(entry.sha1).toMatch(/^[0-9a-f]{40}$/);
			expect(entry.size).toBeGreaterThan(1e8);
		}
	});

	it("matches the cef crate the shell is locked to", () => {
		const pin = readPin();
		const lock = fs.readFileSync(
			path.join(path.dirname(path.dirname(__filename)), "native", "ompdesk", "crates", "shell", "Cargo.lock"),
			"utf8",
		);
		expect(lock).toContain(`name = "cef"\nversion = "${pin.crate}"`);
	});

	it("serves cef-dll-sys an index with the one entry, in the shape its client reads", () => {
		const pin = readPin();
		const index = trimmedIndex(pin, "windows64");
		expect(Object.keys(index).sort()).toEqual([
			"linux64",
			"linuxarm",
			"linuxarm64",
			"macosarm64",
			"macosx64",
			"windows32",
			"windows64",
			"windowsarm64",
		]);
		expect(index.macosarm64.versions).toEqual([]);
		const [version] = index.windows64.versions as Array<{
			channel: string;
			cef_version: string;
			files: Array<{ type: string; name: string; sha1: string }>;
		}>;
		expect(version.channel).toBe("stable");
		expect(version.cef_version.startsWith(`${pin.cefVersion}+`)).toBe(true);
		expect(version.files).toEqual([
			{
				type: "minimal",
				name: pin.platforms.windows64.name,
				sha1: pin.platforms.windows64.sha1,
				size: pin.platforms.windows64.size,
			},
		]);
	});

	it("maps this machine to an index key, and refuses a machine it has no CEF build for", () => {
		expect(cefPlatform("win32", "x64")).toBe("windows64");
		expect(cefPlatform("darwin", "arm64")).toBe("macosarm64");
		expect(cefPlatform("darwin", "x64")).toBe("macosx64");
		expect(() => cefPlatform("linux", "x64")).toThrow(/no CEF build/);
	});
});

describe("the staged shell", () => {
	it("passes when every file, the record and the sources agree", () => {
		const dir = stage({ "ompdesk-shell": "binary", "libcef.so": "cef", [`locales/${KEPT_LOCALES[0]}.pak`]: "en" });
		expect(checkShell(dir).binary).toBe("ompdesk-shell");
	});

	it("fails when a staged byte changed, a file is missing, or an extra file appeared", () => {
		const changed = stage({ "ompdesk-shell": "binary", "a.dat": "x" });
		fs.writeFileSync(path.join(changed, "a.dat"), "y");
		expect(() => checkShell(changed)).toThrow(/a\.dat hashes to/);
		const missing = stage({ "ompdesk-shell": "binary", "a.dat": "x" });
		fs.rmSync(path.join(missing, "a.dat"));
		expect(() => checkShell(missing)).toThrow(/not the ones the build record names/);
		const extra = stage({ "ompdesk-shell": "binary" });
		fs.writeFileSync(path.join(extra, "stray.dll"), "z");
		expect(() => checkShell(extra)).toThrow(/not the ones the build record names/);
	});

	it("fails when the record is for other sources or another machine, or names no binary", () => {
		expect(() => checkShell(stage({ "ompdesk-shell": "b" }, { sourceSha256: "1".repeat(64) }))).toThrow(
			/other sources/,
		);
		expect(() => checkShell(stage({ "ompdesk-shell": "b" }, { platform: "plan9" }))).toThrow(
			/build record is for plan9/,
		);
		expect(() => checkShell(stage({ x: "b" }))).toThrow(/binary ompdesk-shell is not among/);
		expect(() => checkShell(fs.mkdtempSync(path.join(os.tmpdir(), "shell-empty-")))).toThrow(/is missing/);
	});

	it("stages the files the Windows runtime needs, and only two locales", () => {
		expect(WINDOWS_RUNTIME_FILES).toContain("libcef.dll");
		expect(WINDOWS_RUNTIME_FILES.some(name => name.includes("bootstrap"))).toBe(false);
		expect([...KEPT_LOCALES]).toEqual(["en-US", "ko"]);
	});
});
