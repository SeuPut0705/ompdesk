/**
 * omp's automatic update while an omp is running, for real: a fake npm registry
 * serves two versions of `@oh-my-pi/pi-coding-agent` (a stand-in CLI with the
 * stock layout: `bin: dist/cli.js`, `src/`, a hashed lazy asset), the real
 * `bun install -g` puts the old one in a throwaway BUN_INSTALL, one `omp hold`
 * process keeps its files open, and the app's own update path
 * (`SetupService.updateOmp`, the code behind omp-updater.ts) runs the stand-in's
 * `omp update`, which is `bun install -g` like stock's. Windows locks files a
 * running process holds (the launcher image, the package tree), so this is the
 * check that the update there ends in a defined state:
 *
 *   - the running omp keeps answering and keeps the code it loaded;
 *   - the launcher is never left broken: `omp --version` still runs;
 *   - the outcome is `updated` or a `failed` with a reason (`not-updated` is
 *     Bun tolerating EBUSY on the launcher, stock's known Windows case), never
 *     a hang or `unusable`;
 *   - once the running omp exits, the next update succeeds and the new omp runs.
 *
 *   bun scripts/omp-update-lock-check.ts
 *
 * Bun reads the home directory once at startup, so the check runs in a child
 * started with the isolated environment (as setup-install-check.ts does).
 * Only ci.yml's manual `win_e2e` run runs it on Windows (18 s it would add to
 * release.yml's `win` critical path).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_OMP_VERSION, resolveOmp } from "../src/main/omp-runtime";
import { bunInstallDir, managedToolsDir, setupPlatform } from "../src/main/setup/paths";
import type { OmpUpdateOutcome } from "../src/main/setup/service";
import { isNewer } from "../src/shared/version";
import { electronOutside } from "./electron-outside";

const ROOT_ENV = "OMPDESK_UPDATE_LOCK_CHECK_ROOT";
const PACKAGE = "@oh-my-pi/pi-coding-agent";

const platform = setupPlatform();
if (platform === "other") throw new Error("the omp update runs on macOS and Windows only");
const windows = platform === "win32";

function fail(message: string): never {
	throw new Error(message);
}

/** Parent: build the isolated environment, run the check in a child, delete everything. */
function orchestrate(): number {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ompdesk-update-lock-")));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[ROOT_ENV]: root,
		HOME: home,
		USERPROFILE: home,
		BUN_INSTALL: join(home, ".bun"),
		BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
	};
	Reflect.deleteProperty(env, "OMP_GUI_OMP");
	if (windows) {
		env.LOCALAPPDATA = join(home, "AppData", "Local");
		env.APPDATA = join(home, "AppData", "Roaming");
	}
	try {
		const child = spawnSync(process.execPath, [import.meta.path], { env, stdio: "inherit" });
		return child.status ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		console.log(`Removed ${root}`);
	}
}

/** One file of a ustar archive: header, data, padding to the 512-byte block. */
function tarEntry(name: string, data: Buffer, mode: number): Buffer[] {
	const header = Buffer.alloc(512);
	header.write(name, 0, "utf8");
	header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write("0", 156);
	header.write("ustar\0", 257);
	header.write("00", 263);
	const sum = header.reduce((total, byte) => total + byte, 0);
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

/** The stand-in CLI: stock's file layout and the four commands the check needs. */
const CLI = `#!/usr/bin/env bun
import { closeSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [command] = process.argv.slice(2);
if (command === "--version") {
	console.log("omp/" + pkg.version);
	process.exit(0);
}
if (command === "update") {
	// Stock's \`omp update\` on a Bun install: \`bun install -g\` of the package's latest release (no cache: Bun
	// keeps a manifest fresh for minutes, and \`latest\` moves within seconds here).
	const child = Bun.spawn([process.execPath, "install", "-g", "--no-cache", pkg.name + "@latest"], {
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	process.exit(await child.exited);
}
if (command === "hold") {
	// A running omp: every file of the package open, its code loaded, a lazy asset not yet loaded.
	const handles = [];
	const walk = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else handles.push(openSync(file, "r"));
		}
	};
	walk(root);
	if (process.platform === "win32") {
		// Stock loads pi-natives' .node addon, and a loaded image can be neither deleted nor overwritten.
		const { dlopen } = await import("bun:ffi");
		dlopen(join(root, "dist", "addon.dll"), { GetFileVersionInfoSizeW: { args: ["ptr", "ptr"], returns: "u32" } });
	}
	const features = await import("../src/features.js");
	const lazy = join(root, "dist", pkg.lazy);
	console.log("ready " + pkg.version + " " + features.id);
	let buffered = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", async chunk => {
		buffered += chunk;
		for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
			const line = buffered.slice(0, end).trim();
			buffered = buffered.slice(end + 1);
			if (line === "ping") console.log("pong " + pkg.version + " " + features.id);
			if (line === "lazy") {
				try {
					console.log("lazy " + (await import(lazy)).id);
				} catch (error) {
					console.log("lazy missing " + (error instanceof Error ? error.message.split("\\n")[0] : String(error)));
				}
			}
		}
	});
	process.stdin.on("end", () => {
		for (const handle of handles) closeSync(handle);
		process.exit(0);
	});
} else {
	console.error("unknown command " + command);
	process.exit(2);
}
`;

interface Release {
	version: string;
	tarball: Buffer;
	integrity: string;
	shasum: string;
}

function release(version: string): Release {
	const lazy = `lazy-${version.replaceAll(".", "")}.js`;
	const files: [string, string | Buffer, number][] = [
		[
			"package.json",
			JSON.stringify({ name: PACKAGE, version, lazy, bin: { omp: "dist/cli.js" }, files: ["src", "dist"] }),
			0o644,
		],
		["dist/cli.js", CLI, 0o755],
		[`dist/${lazy}`, `export const id = ${JSON.stringify(`lazy-${version}`)};\n`, 0o644],
		["src/features.js", `export const id = ${JSON.stringify(`features-${version}`)};\n`, 0o644],
		// A real DLL (the one the Windows loader certainly has) standing in for the native addon.
		...(windows
			? [
					[
						"dist/addon.dll",
						readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "version.dll")),
						0o644,
					] as [string, Buffer, number],
				]
			: []),
	];
	const blocks = files.flatMap(([name, text, mode]) => tarEntry(`package/${name}`, Buffer.from(text), mode));
	const tarball = Buffer.from(Bun.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
	return {
		version,
		tarball,
		integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
		shasum: createHash("sha1").update(tarball).digest("hex"),
	};
}

/** A registry with `old` and `next`; `latest` follows `dist-tags`, flipped by the check. */
async function registry(releases: Release[], latest: () => string) {
	const server = createServer((request, response) => {
		const url = decodeURIComponent(request.url ?? "");
		const origin = `http://${request.headers.host}`;
		if (url === `/${PACKAGE}`) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					name: PACKAGE,
					"dist-tags": { latest: latest() },
					versions: Object.fromEntries(
						releases.map(entry => [
							entry.version,
							{
								name: PACKAGE,
								version: entry.version,
								bin: { omp: "dist/cli.js" },
								dist: {
									tarball: `${origin}/tarballs/${entry.version}.tgz`,
									integrity: entry.integrity,
									shasum: entry.shasum,
								},
							},
						]),
					),
				}),
			);
			return;
		}
		const tarball = /^\/tarballs\/(.+)\.tgz$/.exec(url)?.[1];
		const found = releases.find(entry => entry.version === tarball);
		if (found) {
			response.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": found.tarball.length,
			});
			response.end(found.tarball);
			return;
		}
		response.writeHead(404).end();
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	return { server, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/` };
}

/** A process with a line reader over its stdout. */
function lineProcess(command: string[]) {
	const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
	const lines: string[] = [];
	const waiting: Array<() => void> = [];
	void (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of child.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
				lines.push(buffered.slice(0, end).trim());
				buffered = buffered.slice(end + 1);
				for (const wake of waiting.splice(0)) wake();
			}
		}
		for (const wake of waiting.splice(0)) wake();
	})();
	return {
		child,
		async next(timeoutMs = 30_000): Promise<string> {
			const deadline = Date.now() + timeoutMs;
			while (lines.length === 0) {
				if (child.exitCode !== null) fail(`${command.join(" ")} exited (${child.exitCode}) before answering`);
				if (Date.now() > deadline) fail(`${command.join(" ")} did not answer within ${timeoutMs} ms`);
				await Promise.race([new Promise<void>(resolve => waiting.push(resolve)), Bun.sleep(250)]);
			}
			return lines.shift() ?? "";
		},
		send(text: string): void {
			child.stdin.write(`${text}\n`);
			child.stdin.flush();
		},
		async stop(): Promise<number> {
			child.stdin.end();
			return await child.exited;
		},
	};
}

async function launcherVersion(bin: string): Promise<string> {
	const run = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe", env: process.env });
	const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
	if (code !== 0) fail(`${bin} --version exited ${code}: ${out}`);
	return out.trim();
}

const describe = (outcome: OmpUpdateOutcome) =>
	outcome.kind === "failed"
		? `failed (${outcome.failure.reason}${outcome.failure.detail ? `: ${outcome.failure.detail}` : ""})`
		: outcome.kind;

/** Child: HOME, USERPROFILE, BUN_INSTALL and the cache are already the isolated ones. */
async function check(root: string): Promise<void> {
	const home = process.env.HOME ?? fail("HOME is unset");
	const bunInstall = bunInstallDir(process.env, home);
	const bunBin = join(bunInstall, "bin");
	const [major = 0, minor = 0] = MIN_OMP_VERSION.split(".").map(Number);
	const older = release(MIN_OMP_VERSION);
	const newer = release(`${major}.${minor + 1}.0`);
	let latest = older.version;
	const fake = await registry([older, newer], () => latest);
	process.env.BUN_CONFIG_REGISTRY = fake.url;
	process.env.NPM_CONFIG_REGISTRY = fake.url;
	process.env.PATH = [bunBin, process.env.PATH].filter(Boolean).join(windows ? ";" : ":");
	const launcher = join(bunBin, windows ? "omp.exe" : "omp");
	process.env.OMP_GUI_OMP = launcher;
	// Async: the registry above lives in this process, which a blocking spawn would starve.
	const bun = async (...args: string[]) => {
		const run = Bun.spawn([process.execPath, ...args], { stdout: "inherit", stderr: "inherit", env: process.env });
		const code = await run.exited;
		if (code !== 0) fail(`bun ${args.join(" ")} exited ${code}`);
	};
	try {
		await bun("install", "-g", `${PACKAGE}@${older.version}`);
		latest = newer.version;
		const installed = await launcherVersion(launcher);
		if (!installed.includes(older.version)) fail(`the launcher reports ${installed}, not ${older.version}`);
		console.log(`✓ bun install -g put ${PACKAGE}@${older.version} at ${launcher}`);

		let printed = 0;
		electronOutside(join(root, "userData"), "0.0.0-lock-check");
		// Dynamic: service.ts links runtime-log's `electron` import, which only resolves once electronOutside ran.
		const { SetupService } = await import("../src/main/setup/service");
		const service = new SetupService({
			platform,
			arch: process.arch,
			systemRoot: process.env.SystemRoot || "C:\\Windows",
			toolsDir: managedToolsDir(platform, process.env, home, join(root, "userData")),
			bunInstall,
			statePath: join(root, "setup-state.json"),
			automatic: false,
			testInstaller: null,
			spawnEnv: async () => ({ ...process.env }),
			// The registry's PATH has no throwaway Bun in it.
			refreshPath: async () => undefined,
			onState: state => {
				const output = state.items.find(entry => entry.id === "omp")?.output ?? "";
				if (output.length < printed) printed = 0;
				process.stdout.write(output.slice(printed));
				printed = output.length;
			},
			onOmpReady: () => undefined,
		});

		// A running omp: its files open, its code loaded.
		const running = lineProcess([launcher, "hold"]);
		const ready = await running.next();
		if (ready !== `ready ${older.version} features-${older.version}`) fail(`omp hold said ${ready}`);
		console.log(`✓ a running omp holds ${PACKAGE}@${older.version}`);

		const first = await service.updateOmp(newer.version);
		console.log(`→ update while omp runs: ${describe(first)}`);
		if (first.kind === "skipped") fail("the update was skipped while omp ran");
		if (first.kind === "failed" && first.failure.reason !== "not-updated" && first.failure.reason !== "install") {
			fail(`the update ended as ${describe(first)}, not updated, not-updated or install`);
		}
		const afterFirst = await launcherVersion(launcher);
		console.log(`  launcher afterwards: ${afterFirst}`);
		if (!/\d+\.\d+\.\d+/.test(afterFirst)) fail(`the launcher no longer reports a version: ${afterFirst}`);
		const onDisk = JSON.parse(
			readFileSync(join(bunInstall, "install", "global", "node_modules", PACKAGE, "package.json"), "utf8"),
		) as { version: string };
		console.log(`  package on disk afterwards: ${onDisk.version}`);
		if (first.kind === "updated" && onDisk.version !== newer.version)
			fail("updated, but the package on disk is not the new one");

		// The running omp is untouched: same code, still answering.
		running.send("ping");
		const pong = await running.next();
		if (pong !== `pong ${older.version} features-${older.version}`) fail(`the running omp answered ${pong}`);
		console.log(`✓ the running omp still runs ${older.version}`);
		running.send("lazy");
		console.log(`  its lazy asset after the update: ${await running.next()}`);

		// It exits; the next check's update must go through.
		const exit = await running.stop();
		if (exit !== 0) fail(`omp hold exited ${exit}`);
		const second = await service.updateOmp(newer.version);
		console.log(`→ update after omp exited: ${describe(second)}`);
		if (second.kind !== "updated" || isNewer(newer.version, second.version)) {
			fail(`the update after omp exited ended as ${describe(second)}`);
		}
		const resolved = await resolveOmp();
		if (!resolved.ok || isNewer(newer.version, resolved.runtime.version)) {
			fail(`omp resolves to ${resolved.ok ? resolved.runtime.version : resolved.error}, not ${newer.version}`);
		}
		const fresh = lineProcess([launcher, "hold"]);
		const freshReady = await fresh.next();
		await fresh.stop();
		if (freshReady !== `ready ${newer.version} features-${newer.version}`) fail(`the new omp said ${freshReady}`);
		console.log(`✓ the new omp runs ${newer.version}`);
		console.log("\n✓ update lock check passed");
	} finally {
		fake.server.close();
	}
}

const childRoot = process.env[ROOT_ENV];
if (childRoot) {
	try {
		await check(childRoot);
	} catch (error) {
		console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	process.exit(0);
} else {
	process.exit(orchestrate());
}
