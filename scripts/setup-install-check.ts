/**
 * Real install check for this machine's automatic setup (src/main/setup/):
 * runs the actual Bun installer, (on Windows) Git for Windows' PortableGit
 * when no Git for Windows is found, and `bun install -g @oh-my-pi/pi-coding-agent`
 * through the app's own runner and supervisor, inside a throwaway
 * HOME/USERPROFILE and BUN_INSTALL. It then checks that omp is detected at or
 * above MIN_OMP_VERSION, and on Windows that the registry PATH refresh picked
 * up Bun and that stock omp's shell resolves to Git Bash, not cmd.exe. Only
 * the required items run; the temp dir is deleted afterwards.
 *
 *   bun scripts/setup-install-check.ts                     # macOS or Windows
 *   bun scripts/setup-install-check.ts --hide-system-git   # Windows: ignore a preinstalled Git for Windows
 *
 * Bun reads the home directory once at startup, so the check itself runs in a
 * child started with the isolated environment. ci.yml's manual `install_check`
 * job runs it on windows-latest.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, MIN_OMP_VERSION, resolveOmp } from "../src/main/omp-runtime";
import { applyManagedToolEnv, bunInstallDir, managedToolsDir, setupPlatform } from "../src/main/setup/paths";
import { SetupService } from "../src/main/setup/service";
import type { SetupState } from "../src/shared/setup";

const ROOT_ENV = "OMPDESK_INSTALL_CHECK_ROOT";
const PROGRAM_FILES_ENV = "OMPDESK_INSTALL_CHECK_PROGRAM_FILES";

const platform = setupPlatform();
if (platform === "other") throw new Error("setup runs on macOS and Windows only");
const windows = platform === "win32";
const hideSystemGit = process.argv.includes("--hide-system-git");

/** Parent: build the isolated environment, run the check in a child, delete everything. */
function orchestrate(): number {
	const root = mkdtempSync(join(tmpdir(), "ompdesk-install-check-"));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[ROOT_ENV]: root,
		HOME: home,
		USERPROFILE: home,
		BUN_INSTALL: join(home, ".bun"),
	};
	Reflect.deleteProperty(env, "OMP_GUI_OMP");
	if (windows) {
		env.LOCALAPPDATA = join(home, "AppData", "Local");
		env.APPDATA = join(home, "AppData", "Roaming");
		// Drop every Bun/omp the runner already has (setup-bun, npm globals).
		env.PATH = (env.PATH ?? "")
			.split(";")
			.filter(entry => !/[\\/]\.?bun([\\/]|$)|setup-bun|[\\/]npm$/i.test(entry))
			.filter(entry => !hideSystemGit || !/[\\/]Git[\\/]/i.test(entry))
			.join(";");
		if (hideSystemGit) {
			env[PROGRAM_FILES_ENV] = JSON.stringify({
				ProgramFiles: process.env.ProgramFiles,
				"ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
			});
			for (const key of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) env[key] = join(root, "no-git");
		}
	} else {
		env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
	}
	try {
		const child = spawnSync(process.execPath, [import.meta.path, ...process.argv.slice(2)], {
			env,
			stdio: "inherit",
		});
		return child.status ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		console.log(`Removed ${root}`);
	}
}

function fail(message: string): never {
	throw new Error(message);
}

/** Child: HOME, USERPROFILE, BUN_INSTALL and PATH are already the isolated ones. */
async function check(root: string): Promise<void> {
	const home = process.env.HOME ?? fail("HOME is unset");
	const toolsDir = managedToolsDir(platform, process.env, home, join(root, "userData"));
	const realProgramFiles: Record<string, string> = JSON.parse(process.env[PROGRAM_FILES_ENV] ?? "{}");
	const states: SetupState[] = [];
	const printed = new Map<string, number>();
	const service = new SetupService({
		platform,
		arch: process.arch,
		systemRoot: process.env.SystemRoot || "C:\\Windows",
		toolsDir,
		bunInstall: bunInstallDir(process.env, home),
		statePath: join(root, "setup-state.json"),
		// Required items only: optional ones (brew/winget) would install machine-wide.
		automatic: false,
		testInstaller: null,
		// Installers themselves may need the real Program Files (PowerShell modules).
		spawnEnv: async () => ({ ...process.env, ...realProgramFiles }),
		onState: state => {
			states.push(state);
			for (const item of state.items) {
				const seen = printed.get(item.id) ?? 0;
				if (item.output.length > seen) process.stdout.write(item.output.slice(seen));
				printed.set(item.id, item.output.length);
			}
		},
		onOmpReady: () => console.log("\n→ omp ready"),
	});
	const started = performance.now();
	await service.retry("omp");
	const state = service.state();
	console.log(`\nSetup finished in ${((performance.now() - started) / 1000).toFixed(1)} s`);
	for (const item of state.items.filter(entry => entry.required)) {
		const failure = item.failure ? ` ${JSON.stringify(item.failure)}` : "";
		console.log(`  ${item.id}: ${item.phase} ${JSON.stringify(item.presence)}${failure}`);
	}
	const ran = new Set(
		states.flatMap(entry => entry.items.filter(item => item.phase === "running").map(item => item.id)),
	);
	console.log(`  installed by the runner: ${[...ran].join(", ") || "nothing"}`);
	if (!ran.has("bun") || !ran.has("omp")) fail("the runner did not install both Bun and omp");
	if (!state.ompReady) fail("omp is not detected after setup");
	if (ran.has("git")) {
		// Main downloads PortableGit itself: the screen must have shown its bytes against the announced size.
		const seen = states.flatMap(entry => {
			const download = entry.items.find(item => item.id === "git")?.progress?.download;
			return download?.total ? [download] : [];
		});
		const received = new Set(seen.map(download => download.received));
		if (received.size < 2) fail("the PortableGit download reported no byte progress against its size");
		const total = seen[0]?.total ?? 0;
		console.log(
			`✓ PortableGit download progress: ${received.size} updates, up to ${Math.max(...received)} of ${total} bytes`,
		);
	}

	applyManagedToolEnv(toolsDir, platform);
	const omp = await resolveOmp();
	if (!omp.ok) fail(`omp resolution failed: ${omp.error}`);
	if (!omp.runtime.bin.startsWith(home)) fail(`omp resolved outside the temp profile: ${omp.runtime.bin}`);
	if (compareVersions(omp.runtime.version, MIN_OMP_VERSION) < 0) {
		fail(`omp ${omp.runtime.version} is below ${MIN_OMP_VERSION}`);
	}
	const version = await omp.runtime.run(["--version"]);
	console.log(`✓ ${omp.runtime.bin} --version → ${version.stdout.trim()} (minimum ${MIN_OMP_VERSION})`);

	if (windows) {
		const bunBin = join(bunInstallDir(process.env, home), "bin");
		if (!(process.env.PATH ?? "").toLowerCase().includes(bunBin.toLowerCase())) {
			fail(`PATH refresh did not pick up ${bunBin} from the registry`);
		}
		console.log(`✓ PATH refreshed from the registry: ${bunBin}`);
		const procmgr = join(
			bunInstallDir(process.env, home),
			"install",
			"global",
			"node_modules",
			"@oh-my-pi",
			"pi-utils",
			"src",
			"procmgr.ts",
		);
		if (!existsSync(procmgr)) fail(`stock procmgr not found at ${procmgr}`);
		const script = `import { resolveWindowsShell } from ${JSON.stringify(procmgr)};\nconsole.log(resolveWindowsShell(process.env));`;
		const shell = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: process.env }).stdout.trim();
		console.log(`  stock omp's shell → ${shell}`);
		if (!/bash\.exe$/i.test(shell)) fail(`omp's shell resolves to ${shell}, not Git Bash`);
		if (hideSystemGit && !shell.toLowerCase().startsWith(toolsDir.toLowerCase())) {
			fail(`omp's shell is not the managed PortableGit: ${shell}`);
		}
		console.log("✓ omp's shell is Git Bash");
	}
	console.log("\n✓ install check passed");
}

const childRoot = process.env[ROOT_ENV];
if (childRoot) {
	try {
		await check(childRoot);
	} catch (error) {
		console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
} else {
	process.exit(orchestrate());
}
