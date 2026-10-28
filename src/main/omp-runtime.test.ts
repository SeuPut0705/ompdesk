import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isCompiledOmp,
	MIN_OMP_VERSION,
	ompBunDefaults,
	ompBunMinimum,
	ompCandidates,
	ompPackageRoot,
	ompPathEnv,
	ompUpdateEnv,
	parseOmpVersion,
	parseUpdateCheck,
	pickOmp,
	resolveOmp,
} from "./omp-runtime";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";
import { itWithFileSymlinks } from "./test-symlinks";

const originalOverride = process.env.OMP_GUI_OMP;

afterEach(() => {
	if (originalOverride === undefined) delete process.env.OMP_GUI_OMP;
	else process.env.OMP_GUI_OMP = originalOverride;
});

async function fakeOmp(versionLine: string): Promise<{ bin: string; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-"));
	const bin = await writeFakeOmp(dir, `console.log(${JSON.stringify(versionLine)});\n`);
	return { bin, dir };
}

/** The first bytes of a Mach-O 64-bit executable (`MH_MAGIC_64`, little-endian on disk). */
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

/** A minimal PE: DOS stub, `PE\0\0`, a COFF header with no optional header and one section named `section`. */
function peWithSection(section: string): Buffer {
	const file = Buffer.alloc(0x100);
	file.write("MZ", 0, "latin1");
	file.writeUInt32LE(0x40, 0x3c);
	file.write("PE\0\0", 0x40, "latin1");
	file.writeUInt16LE(0x8664, 0x44);
	file.writeUInt16LE(1, 0x46);
	file.writeUInt16LE(0, 0x54);
	file.write(section, 0x58, "latin1");
	return file;
}

/** A `bun build --compile` omp for this platform: a Mach-O on macOS (ELF elsewhere), a PE with Bun's `.bun` section on Windows. */
function compiledOmpBytes(): Buffer {
	if (process.platform === "win32") return peWithSection(".bun");
	if (process.platform === "darwin") return MACHO;
	return Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
}

describe("omp version parsing", () => {
	it("reads the semver out of `omp --version`", () => {
		expect(parseOmpVersion("omp/18.6.1\n")).toBe("18.6.1");
		expect(parseOmpVersion("no version here")).toBeNull();
	});
});

describe("parseUpdateCheck", () => {
	it("reads the installed version when already up to date", () => {
		expect(parseUpdateCheck("Current version: 18.6.1\n✔ Already up to date\n")).toEqual({
			currentVersion: "18.6.1",
			latestVersion: "18.6.1",
		});
	});

	it("reads the newer release on a pending update", () => {
		expect(
			parseUpdateCheck(
				"Current version: 18.6.1\r\nCurrent channel: canary\r\nNew version available: 18.7.0-canary.3\r\n",
			),
		).toEqual({ currentVersion: "18.6.1", latestVersion: "18.7.0-canary.3" });
	});

	it("rejects output it cannot account for", () => {
		expect(parseUpdateCheck("Failed to check for updates: offline")).toBeNull();
		expect(parseUpdateCheck("Current version: 18.6.1\n")).toBeNull();
	});
});

describe("omp lookup", () => {
	it("searches PATH before the well-known install locations", () => {
		const candidates = ompCandidates(["/a", "/b"].join(path.delimiter), "/home/u", "darwin");
		expect(candidates).toEqual([
			path.join("/a", "omp"),
			path.join("/b", "omp"),
			path.join("/home/u", ".bun", "bin", "omp"),
			"/opt/homebrew/bin/omp",
			"/usr/local/bin/omp",
		]);
	});

	it("puts the omp directory and ~/.bun/bin on the spawn PATH (the CLI is a bun script)", () => {
		const entries = ompPathEnv("/opt/tools/omp", "/usr/bin").split(path.delimiter);
		expect(entries[0]).toBe("/usr/bin");
		expect(entries).toContain("/opt/tools");
		expect(entries).toContain(path.join(os.homedir(), ".bun", "bin"));
	});

	it("turns bun's transpiler cache off for a session's omp on Windows, where filling it dominates a cold start", () => {
		// Measured on Windows: an empty cache made omp's start 4 s slower than none (thousands of small files behind
		// Defender), and a warm one was still ~0.4 s slower. Elsewhere the default stands.
		expect(ompBunDefaults("win32")).toEqual({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
		expect(ompBunDefaults("darwin")).toEqual({});
		expect(ompBunDefaults("linux")).toEqual({});
	});

	it("points stock `omp update` at this omp: its folder first on PATH, and its own Bun root as BUN_INSTALL", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-update-env-"));
		try {
			const bunRoot = path.join(root, "custom-bun");
			const bin = path.join(bunRoot, "bin", "omp");
			const other = path.join(root, "elsewhere", "bin");
			const base = [other, "/usr/bin", path.dirname(bin)].join(path.delimiter);
			// Not a `bun install -g` launcher (no package beside it): PATH only, BUN_INSTALL left to the caller.
			expect(ompUpdateEnv(bin, base)).toEqual({
				PATH: ompPathEnv(bin, [path.dirname(bin), other, "/usr/bin"].join(path.delimiter)),
			});
			const pkg = path.join(bunRoot, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
			await fs.mkdir(pkg, { recursive: true });
			await fs.writeFile(path.join(pkg, "package.json"), '{"name":"@oh-my-pi/pi-coding-agent"}');
			const env = ompUpdateEnv(bin, base);
			expect(env.BUN_INSTALL).toBe(bunRoot);
			expect(env.PATH.split(path.delimiter).slice(0, 3)).toEqual([path.dirname(bin), other, "/usr/bin"]);
		} finally {
			await fs.rm(root, RM_TEMP);
		}
	});

	// Creating the symlink needs Developer Mode or admin rights on Windows.
	it.skipIf(process.platform === "win32")(
		"finds the omp package behind a symlinked bin and a bun shim dir",
		async () => {
			const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-pkgroot-"));
			try {
				const pkg = path.join(home, ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
				await fs.mkdir(path.join(pkg, "dist"), { recursive: true });
				await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
				await fs.writeFile(path.join(pkg, "dist", "cli.js"), "");
				const binDir = path.join(home, ".bun", "bin");
				await fs.mkdir(binDir, { recursive: true });
				await fs.symlink(path.join(pkg, "dist", "cli.js"), path.join(binDir, "omp"));
				await fs.writeFile(path.join(binDir, "omp.exe"), "");

				expect(ompPackageRoot(path.join(binDir, "omp"))).toBe(await fs.realpath(pkg));
				// Windows-style shim: not a symlink, found through ~/.bun/install/global.
				expect(ompPackageRoot(path.join(binDir, "omp.exe"))).toBe(
					path.join(binDir, "..", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent"),
				);
				expect(ompPackageRoot(path.join(home, "nowhere", "omp"))).toBeNull();
			} finally {
				await fs.rm(home, { recursive: true, force: true });
			}
		},
	);

	it("tells a compiled omp (Bun's standalone build) from the package's launcher", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-compiled-"));
		try {
			const file = (name: string, bytes: Buffer | string) => {
				const target = path.join(dir, name);
				return fs.writeFile(target, bytes).then(() => target);
			};
			const script = await file("cli.js", "#!/usr/bin/env bun\nconsole.log('omp');\n");
			const macho = await file("omp-macho", MACHO);
			const elf = await file("omp-elf", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
			const standalone = await file("omp.exe", peWithSection(".bun"));
			// Bun's Windows launcher (`bun_shim_impl.exe`, beside `omp.bunx`) is a PE without the `.bun` section.
			const shim = await file("shim.exe", peWithSection(".text"));
			const npmShim = await file(
				"omp.cmd",
				'@"%dp0%\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*\r\n',
			);

			expect(isCompiledOmp(script, "darwin")).toBe(false);
			expect(isCompiledOmp(macho, "darwin")).toBe(true);
			expect(isCompiledOmp(elf, "linux")).toBe(true);
			expect(isCompiledOmp(standalone, "win32")).toBe(true);
			expect(isCompiledOmp(shim, "win32")).toBe(false);
			expect(isCompiledOmp(npmShim, "win32")).toBe(false);
			expect(isCompiledOmp(path.join(dir, "missing"), "darwin")).toBe(false);
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	it("runs the first omp that runs from its package, past a compiled one earlier in the lookup", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-pick-"));
		try {
			const compiled = path.join(dir, "compiled-omp");
			await fs.writeFile(compiled, compiledOmpBytes());
			const script = path.join(dir, "script-omp");
			await fs.writeFile(script, "#!/usr/bin/env bun\n");
			expect(pickOmp([compiled, script])).toEqual({ bin: script, compiled });
			expect(pickOmp([compiled])).toEqual({ bin: null, compiled });
			expect(pickOmp([])).toEqual({ bin: null, compiled: null });
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	it("reads the oldest Bun an omp package runs on from its `engines.bun`", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-engines-"));
		try {
			const manifest = (engines: unknown) =>
				fs.writeFile(
					path.join(dir, "package.json"),
					JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", engines }),
				);
			await manifest({ bun: ">=1.4.4" });
			expect(ompBunMinimum(dir)).toBe("1.4.4");
			await manifest({ bun: ">= v1.3.14" });
			expect(ompBunMinimum(dir)).toBe("1.3.14");
			// Only the `>=` form stock publishes is read; anything else names no minimum.
			await manifest({ bun: "^1.4.0" });
			expect(ompBunMinimum(dir)).toBeNull();
			await manifest(undefined);
			expect(ompBunMinimum(dir)).toBeNull();
			expect(ompBunMinimum(null)).toBeNull();
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});
});

describe("resolveOmp", () => {
	it("accepts a supported omp and runs subcommands through it", async () => {
		const { bin, dir } = await fakeOmp(`omp/${MIN_OMP_VERSION}`);
		process.env.OMP_GUI_OMP = bin;
		try {
			const resolution = await resolveOmp();
			if (!resolution.ok) throw new Error(resolution.error);
			expect(resolution.runtime).toMatchObject({ bin, version: MIN_OMP_VERSION });
			await expect(resolution.runtime.run(["anything"])).resolves.toMatchObject({
				code: 0,
				stdout: `omp/${MIN_OMP_VERSION}\n`,
			});
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	it("refuses an omp older than the minimum with an update hint", async () => {
		// 18.6.3: the last omp without `AgentSession.disarmPrewalk`.
		const { bin, dir } = await fakeOmp("omp/18.6.3");
		process.env.OMP_GUI_OMP = bin;
		try {
			const resolution = await resolveOmp();
			expect(resolution).toMatchObject({
				ok: false,
				error: expect.stringContaining("omp update"),
				reason: { kind: "too-old", version: "18.6.3", minimum: MIN_OMP_VERSION, bin },
			});
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	itWithFileSymlinks("reads a bun or npm install's version from its package, never starting omp for it", async () => {
		// A global bun or npm install links `bin/omp` to `<package>/dist/cli.js`; `omp --version` cost 0.3 s per launch.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-"));
		try {
			const pkg = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
			await fs.mkdir(path.join(pkg, "dist"), { recursive: true });
			await fs.writeFile(
				path.join(pkg, "package.json"),
				JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: MIN_OMP_VERSION }),
			);
			// Never run: it would print another version and fail.
			await fs.writeFile(path.join(pkg, "dist", "cli.js"), "#!/bin/sh\necho omp/1.0.0; exit 1\n", { mode: 0o755 });
			const bin = path.join(dir, "omp");
			await fs.symlink(path.join(pkg, "dist", "cli.js"), bin);
			process.env.OMP_GUI_OMP = bin;
			const resolution = await resolveOmp();
			if (!resolution.ok) throw new Error(resolution.error);
			expect(resolution.runtime).toMatchObject({ bin, version: MIN_OMP_VERSION });
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	it("refuses a compiled omp: the bridge loads only into omp run from its package", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-"));
		try {
			const bin = path.join(dir, process.platform === "win32" ? "omp.exe" : "omp");
			await fs.writeFile(bin, compiledOmpBytes(), { mode: 0o755 });
			process.env.OMP_GUI_OMP = bin;
			const resolution = await resolveOmp();
			expect(resolution).toMatchObject({
				ok: false,
				error: expect.stringContaining("bun install -g @oh-my-pi/pi-coding-agent"),
				reason: { kind: "compiled", bin },
			});
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	itWithFileSymlinks("refuses a package omp whose `engines.bun` the Bun that would run it does not meet", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-"));
		try {
			const pkg = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
			await fs.mkdir(path.join(pkg, "dist"), { recursive: true });
			const manifest = (bun: string) =>
				fs.writeFile(
					path.join(pkg, "package.json"),
					JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: MIN_OMP_VERSION, engines: { bun } }),
				);
			await fs.writeFile(path.join(pkg, "dist", "cli.js"), "#!/usr/bin/env bun\n", { mode: 0o755 });
			const bin = path.join(dir, "omp");
			await fs.symlink(path.join(pkg, "dist", "cli.js"), bin);
			process.env.OMP_GUI_OMP = bin;

			await manifest(">=99.0.0");
			const refused = await resolveOmp();
			expect(refused).toMatchObject({
				ok: false,
				error: expect.stringContaining("bun upgrade"),
				reason: { kind: "bun-too-old", bin, minimum: "99.0.0", bun: expect.any(String) },
			});
			if (refused.ok || refused.reason?.kind !== "bun-too-old") throw new Error("expected bun-too-old");
			expect(refused.reason.bunVersion).toMatch(/^\d+\.\d+\.\d+/);

			await manifest(">=1.0.0");
			const accepted = await resolveOmp();
			if (!accepted.ok) throw new Error(accepted.error);
			expect(accepted.runtime).toMatchObject({ bin, version: MIN_OMP_VERSION });
		} finally {
			await fs.rm(dir, RM_TEMP);
		}
	});

	it("names a missing override instead of searching elsewhere", async () => {
		const missing = path.join(os.tmpdir(), "definitely-not-omp");
		process.env.OMP_GUI_OMP = missing;
		const resolution = await resolveOmp();
		expect(resolution).toEqual({
			ok: false,
			error: expect.stringContaining("OMP_GUI_OMP"),
			reason: { kind: "override-missing", path: missing },
		});
	});
});
