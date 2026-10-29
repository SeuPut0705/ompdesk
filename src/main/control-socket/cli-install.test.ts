import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCliLaunchers, LAUNCHER_MARKER } from "./cli-install";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cli-install-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(packaged: boolean, platform: "darwin" | "win32" | "other" = "darwin") {
	const home = join(root, "home");
	const bunBin = join(home, ".bun", "bin");
	mkdirSync(bunBin, { recursive: true });
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
	const options = {
		cliDir: join(root, "res", "cli"),
		userData: join(root, "userData"),
		platform,
		packaged,
		env,
		home,
	};
	return { options, env, bunBin, appBin: join(root, "userData", "bin") };
}

describe("installCliLaunchers", () => {
	it("writes an executable launcher with the script path and appends PATH once", () => {
		const { options, env, appBin, bunBin } = setup(false);
		const written = installCliLaunchers(options);
		installCliLaunchers(options);
		const launcher = readFileSync(join(appBin, "ompdesk"), "utf8");
		expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
		expect(launcher).toContain(LAUNCHER_MARKER);
		expect(launcher).toContain(join(root, "res", "cli", "ompdesk.ts"));
		expect(launcher).toContain(bunBin);
		if (process.platform !== "win32") expect(statSync(join(appBin, "ompdesk")).mode & 0o111).not.toBe(0);
		expect(written).toEqual([appBin]);
		expect(env.PATH).toBe(`/usr/bin:${appBin}`);
	});

	it("skips Bun's bin folder when not packaged", () => {
		const { options, bunBin } = setup(false);
		installCliLaunchers(options);
		expect(existsSync(join(bunBin, "ompdesk"))).toBe(false);
	});

	it("puts a launcher in Bun's bin folder when packaged, and rewrites its own when the script moves", () => {
		const { options, bunBin, appBin } = setup(true);
		expect(installCliLaunchers(options)).toEqual([appBin, bunBin]);
		const moved = { ...options, cliDir: join(root, "elsewhere", "cli") };
		installCliLaunchers(moved);
		expect(readFileSync(join(bunBin, "ompdesk"), "utf8")).toContain(join(root, "elsewhere", "cli", "ompdesk.ts"));
	});

	it("never overwrites a foreign file in Bun's bin folder", () => {
		const { options, bunBin, appBin } = setup(true);
		writeFileSync(join(bunBin, "ompdesk"), "#!/bin/sh\necho mine\n");
		expect(installCliLaunchers(options)).toEqual([appBin]);
		expect(readFileSync(join(bunBin, "ompdesk"), "utf8")).toBe("#!/bin/sh\necho mine\n");
	});

	it("does not touch Bun's bin folder in a headless launch or when it is absent", () => {
		const headless = setup(true);
		headless.env.OMP_GUI_HEADLESS = "1";
		installCliLaunchers(headless.options);
		expect(existsSync(join(headless.bunBin, "ompdesk"))).toBe(false);
		rmSync(headless.bunBin, { recursive: true });
		headless.env.OMP_GUI_HEADLESS = "0";
		expect(installCliLaunchers(headless.options)).toEqual([headless.appBin]);
		expect(existsSync(headless.bunBin)).toBe(false);
	});

	it("writes a .cmd next to it on Windows", () => {
		const { options, appBin } = setup(false, "win32");
		installCliLaunchers(options);
		const cmd = readFileSync(join(appBin, "ompdesk.cmd"), "utf8");
		expect(cmd.startsWith("@echo off\r\nrem ")).toBe(true);
		expect(cmd).toContain(`"bun" "${join(root, "res", "cli", "ompdesk.ts")}" %*`);
	});

	it("leaves the command out, and the app starting, when its folder cannot be written", () => {
		const { options, env, appBin } = setup(false);
		mkdirSync(join(root, "userData"), { recursive: true });
		writeFileSync(appBin, "a file where the folder goes");
		expect(installCliLaunchers(options)).toEqual([]);
		expect(env.PATH).toBe(`/usr/bin:${appBin}`);
	});
});
