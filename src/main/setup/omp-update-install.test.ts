/**
 * omp's update for real: a fake registry (127.0.0.1) serves two releases of
 * `@oh-my-pi/pi-coding-agent`, the real `bun install -g` puts the older one in
 * two Bun roots under a temp HOME — the default `~/.bun`, whose `bin` comes
 * first on the user's PATH, and a custom BUN_INSTALL whose omp is the one
 * OMPdesk runs — and SetupService's `latestOmp` + `updateOmp` (the code behind
 * omp-updater.ts, real supervisor) check and update. The stand-in launcher's
 * `update` resolves its target the way stock's `resolveUpdateTarget` does: the
 * first `omp` on PATH, a Bun install only inside `bun pm bin -g`, then
 * `bun install -g` of the release. The update must land in the omp OMPdesk
 * runs and leave the other one alone. Nothing outside the temp root is
 * written: HOME, BUN_INSTALL and Bun's cache all point into it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SetupPresence } from "../../shared/setup";
import { isCompiledOmp, MIN_OMP_VERSION, parseOmpVersion } from "../omp-runtime";
import { type OmpRegistry, ompRegistry, ompRelease } from "../test-omp-registry";
import type { Detection } from "./detect";
import { OMP_PACKAGE } from "./plans";
import { SetupService } from "./service";

const windows = process.platform === "win32";

/** Stock's update on a Bun install, reduced to what decides where it lands. */
const CLI = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const same = (a, b) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
if (args[0] === "--version") {
	console.log("omp/" + pkg.version);
	process.exit(0);
}
if (args[0] !== "update") process.exit(2);
console.log("Current version: " + pkg.version);
const registry = (process.env.BUN_CONFIG_REGISTRY ?? "").replace(/\\/+$/, "");
const latest = (await (await fetch(registry + "/" + pkg.name)).json())["dist-tags"].latest;
if (latest === pkg.version) {
	console.log("Already up to date");
	process.exit(0);
}
console.log("New version available: " + latest);
if (args.includes("--check")) process.exit(0);
const target = Bun.which("omp");
const pm = Bun.spawn([process.execPath, "pm", "bin", "-g"], { stdout: "pipe", env: process.env });
const binDir = (await new Response(pm.stdout).text()).trim();
if (!target || !same(dirname(target), binDir)) {
	console.error("Update failed: " + target + " is not in bun's global bin " + binDir);
	process.exit(1);
}
const install = Bun.spawn([process.execPath, "install", "-g", "--no-cache", pkg.name + "@" + latest], {
	stdout: "inherit",
	stderr: "inherit",
	env: process.env,
});
process.exit(await install.exited);
`;

const bunProbe = spawnSync("bun", ["-e", "console.log(process.execPath + '\\n' + Bun.version)"], { encoding: "utf8" });
const [bun = null, bunVersion = "0.0.0"] = bunProbe.status === 0 ? bunProbe.stdout.trim().split(/\r?\n/) : [];

/** Run to the end without blocking this process (the registry lives here). */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
	const child = spawn(command, args, { env, windowsHide: true });
	let output = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.on("error", error => resolve({ code: 127, output: error.message }));
	child.on("close", code => resolve({ code: code ?? 1, output }));
	return promise;
}

describe.skipIf(bun === null)("omp update with a real bun install -g", () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ompdesk-omp-update-")));
	const home = join(root, "home");
	const shellBun = join(home, ".bun");
	const ownBun = join(root, "own-bun");
	const ownOmp = join(ownBun, "bin", windows ? "omp.exe" : "omp");
	const shellOmp = join(shellBun, "bin", windows ? "omp.exe" : "omp");
	/** The package version `bun install -g` left in a Bun root. */
	const installedVersion = (bunRoot: string): unknown => {
		const file = join(bunRoot, "install", "global", "node_modules", OMP_PACKAGE, "package.json");
		const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
	};
	const [major = 0, minor = 0] = MIN_OMP_VERSION.split(".").map(Number);
	const older = ompRelease(MIN_OMP_VERSION, CLI);
	// The release names the running Bun as its oldest (stock's `engines.bun`): OMPdesk reads it from the registry
	// before `omp update` (real `bun pm view`) and finds nothing to upgrade.
	const newer = ompRelease(`${major}.${minor + 1}.0`, CLI, {}, { bun: `>=${bunVersion}` });
	let latest = older.version;
	let registry: OmpRegistry | undefined;
	let env: NodeJS.ProcessEnv;

	beforeAll(async () => {
		mkdirSync(home, { recursive: true });
		const served = await ompRegistry([older, newer], () => latest);
		registry = served;
		const systemDirs = windows
			? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"]
			: ["/usr/bin", "/bin"];
		env = {
			...Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) => !/^(BUN_INSTALL|OMP_GUI_OMP|https?_proxy|all_proxy|npm_config_registry)/i.test(key),
				),
			),
			HOME: home,
			USERPROFILE: home,
			BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
			BUN_CONFIG_REGISTRY: served.url,
			NPM_CONFIG_REGISTRY: served.url,
			NO_PROXY: "127.0.0.1,localhost",
			// The user's shell: the default Bun root's bin first, the omp OMPdesk runs further down.
			PATH: [join(shellBun, "bin"), dirname(bun ?? ""), ...systemDirs, join(ownBun, "bin")].join(delimiter),
		};
		for (const bunRoot of [shellBun, ownBun]) {
			const installed = await run(bun ?? "bun", ["install", "-g", "--no-cache", `${OMP_PACKAGE}@${older.version}`], {
				...env,
				BUN_INSTALL: bunRoot,
			});
			expect(installed.code, installed.output).toBe(0);
		}
		latest = newer.version;
	}, 120_000);

	afterAll(async () => {
		await registry?.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	});

	it("checks and updates the omp OMPdesk runs, not the omp first on PATH or the default Bun root", async () => {
		const ompPresence = async (): Promise<SetupPresence> => {
			const answer = await run(ownOmp, ["--version"], env);
			const version = parseOmpVersion(answer.output);
			return version
				? { kind: "present", version, path: ownOmp }
				: { kind: "broken", detail: answer.output, path: ownOmp };
		};
		const present: SetupPresence = { kind: "present", version: bunVersion, path: bun ?? "" };
		const detect = async (): Promise<Detection> => ({
			presence: {
				bun: present,
				git: present,
				gh: present,
				node: present,
				tailscale: present,
				omp: await ompPresence(),
			},
			bun,
			omp: ownOmp,
			brew: null,
			winget: null,
		});
		const service = new SetupService({
			platform: windows ? "win32" : "darwin",
			arch: process.arch,
			systemRoot: process.env.SystemRoot ?? "C:\\Windows",
			toolsDir: join(root, "tools"),
			// OMPdesk's default Bun root (`bunInstallDir`): the one the user's shell would update.
			bunInstall: shellBun,
			statePath: join(root, "setup-state.json"),
			automatic: false,
			testInstaller: null,
			spawnEnv: async () => ({ ...env }),
			onState: () => undefined,
			onOmpReady: () => undefined,
			detect,
			refreshPath: async () => undefined,
		});
		await service.start();

		await expect(service.latestOmp()).resolves.toBe(newer.version);
		const outcome = await service.updateOmp(newer.version);
		expect(outcome).toEqual({ kind: "updated", version: newer.version });
		expect(installedVersion(ownBun)).toBe(newer.version);
		expect(installedVersion(shellBun)).toBe(older.version);
		expect((await run(shellOmp, ["--version"], env)).output.trim()).toBe(`omp/${older.version}`);
		// Up to date now: the next check says so.
		await expect(service.latestOmp()).resolves.toBe(newer.version);
		service.dispose();
	}, 120_000);

	it("puts the package's launcher back over stock's compiled omp, which `bun install -g` alone cannot replace", async () => {
		// 29 Oct 2026: stock's launcher repair left its standalone build in `bin/omp`; Bun 1.4.4's own reinstall then
		// failed `failed to link @oh-my-pi/pi-coding-agent: EEXIST` on POSIX and kept a running `omp.exe` on Windows.
		const compiled = windows
			? (() => {
					const file = Buffer.alloc(0xc0);
					file.write("MZ", 0, "latin1");
					file.writeUInt32LE(0x40, 0x3c);
					file.write("PE\0\0", 0x40, "latin1");
					file.writeUInt16LE(1, 0x46);
					file.write(".bun", 0x58, "latin1");
					return file;
				})()
			: Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
		rmSync(shellOmp, { force: true });
		writeFileSync(shellOmp, compiled, { mode: 0o755 });
		expect(isCompiledOmp(shellOmp)).toBe(true);
		const present: SetupPresence = { kind: "present", version: bunVersion, path: bun ?? "" };
		const ompPresence = async (): Promise<SetupPresence> => {
			if (isCompiledOmp(shellOmp)) return { kind: "broken", detail: "a compiled omp", path: shellOmp };
			const version = parseOmpVersion((await run(shellOmp, ["--version"], env)).output);
			return version ? { kind: "present", version, path: shellOmp } : { kind: "missing" };
		};
		const service = new SetupService({
			platform: windows ? "win32" : "darwin",
			arch: process.arch,
			systemRoot: process.env.SystemRoot ?? "C:\\Windows",
			toolsDir: join(root, "tools"),
			bunInstall: shellBun,
			statePath: join(root, "setup-state-repair.json"),
			automatic: false,
			testInstaller: null,
			spawnEnv: async () => ({ ...env }),
			onState: () => undefined,
			onOmpReady: () => undefined,
			detect: async () => {
				const omp = await ompPresence();
				return {
					presence: { bun: present, git: present, gh: present, node: present, tailscale: present, omp },
					bun,
					omp: omp.kind === "present" ? shellOmp : null,
					brew: null,
					winget: null,
				};
			},
			refreshPath: async () => undefined,
		});
		await service.start();
		await service.retry("omp");
		const item = service.state().items.find(entry => entry.id === "omp");
		expect(item?.presence, item?.output).toEqual({ kind: "present", version: newer.version, path: shellOmp });
		expect(readdirSync(dirname(shellOmp)).filter(name => name.includes(".ompdesk-compiled-"))).toEqual([]);
		service.dispose();
	}, 120_000);
});
