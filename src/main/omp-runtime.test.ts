import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareVersions,
	MIN_OMP_VERSION,
	ompCandidates,
	ompPackageRoot,
	ompPathEnv,
	parseOmpVersion,
	resolveOmp,
} from "./omp-runtime";

const originalOverride = process.env.OMP_GUI_OMP;

afterEach(() => {
	if (originalOverride === undefined) delete process.env.OMP_GUI_OMP;
	else process.env.OMP_GUI_OMP = originalOverride;
});

async function fakeOmp(versionLine: string): Promise<{ bin: string; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-"));
	const bin = path.join(dir, "omp");
	await fs.writeFile(bin, `#!/bin/sh\necho '${versionLine}'\n`);
	await fs.chmod(bin, 0o755);
	return { bin, dir };
}

describe("omp version parsing", () => {
	it("reads the semver out of `omp --version`", () => {
		expect(parseOmpVersion("omp/18.6.1\n")).toBe("18.6.1");
		expect(parseOmpVersion("no version here")).toBeNull();
	});

	it("compares numerically, not lexically", () => {
		expect(compareVersions("18.10.0", "18.6.0")).toBeGreaterThan(0);
		expect(compareVersions("18.6.0", MIN_OMP_VERSION)).toBe(0);
		expect(compareVersions("17.99.99", "18.0.0")).toBeLessThan(0);
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
});

describe("resolveOmp", () => {
	it.skipIf(process.platform === "win32")("accepts a supported omp and runs subcommands through it", async () => {
		const { bin, dir } = await fakeOmp("omp/18.6.1");
		process.env.OMP_GUI_OMP = bin;
		try {
			const resolution = await resolveOmp();
			if (!resolution.ok) throw new Error(resolution.error);
			expect(resolution.runtime).toMatchObject({ bin, version: "18.6.1" });
			await expect(resolution.runtime.run(["anything"])).resolves.toMatchObject({ code: 0, stdout: "omp/18.6.1\n" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("refuses an omp older than the minimum with an update hint", async () => {
		const { bin, dir } = await fakeOmp("omp/18.5.9");
		process.env.OMP_GUI_OMP = bin;
		try {
			const resolution = await resolveOmp();
			expect(resolution).toMatchObject({
				ok: false,
				error: expect.stringContaining("omp update"),
				reason: { kind: "too-old", version: "18.5.9", minimum: MIN_OMP_VERSION },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
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
