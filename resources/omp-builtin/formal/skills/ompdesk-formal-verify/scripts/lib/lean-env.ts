import fs from "node:fs";
import path from "node:path";
import { cacheRoot } from "./cache";
import { run, Unavailable } from "./proc";
import { download, extractInto, forPlatform, loadToolchain, withLock } from "./toolchain";

export interface LeanEnv {
	elanHome: string;
	/** Environment for every lake/lean run: ELAN_HOME and PATH with elan's bin first. */
	env: NodeJS.ProcessEnv;
	lake: string;
	lean: string;
	toolchain: string;
	leanVersion: string;
	source: "ompdesk" | "system";
}

const EXE = process.platform === "win32" ? ".exe" : "";

/** elan's folder name for `leanprover/lean4:v4.35.0`. */
export function toolchainDirName(toolchain: string): string {
	return toolchain.replace("/", "--").replace(":", "---");
}

export function leanPaths(env: NodeJS.ProcessEnv = process.env): {
	elanHome: string;
	bin: string;
	toolchainDir: string;
} {
	const tc = loadToolchain(env);
	const elanHome = path.join(cacheRoot(env), "elan");
	return {
		elanHome,
		bin: path.join(elanHome, "bin"),
		toolchainDir: path.join(elanHome, "toolchains", toolchainDirName(tc.lean.toolchain)),
	};
}

function leanEnv(elanHome: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const bin = path.join(elanHome, "bin");
	const pathKey = Object.keys(base).find(key => key.toLowerCase() === "path") ?? "PATH";
	return { ...base, ELAN_HOME: elanHome, [pathKey]: `${bin}${path.delimiter}${base[pathKey] ?? ""}` };
}

async function versionOf(lake: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	const result = await run(lake, ["--version"], { env, timeoutMs: 60_000 });
	if (result.spawnError || result.code !== 0) return null;
	return /Lean version ([0-9][^\s)]*)/.exec(result.stdout)?.[1] ?? result.stdout.trim();
}

export interface LeanStatus {
	ready: boolean;
	missing: string[];
}

/** What is installed, without downloading anything. */
export function leanStatus(env: NodeJS.ProcessEnv = process.env): LeanStatus {
	const paths = leanPaths(env);
	const missing: string[] = [];
	if (!fs.existsSync(path.join(paths.bin, `elan${EXE}`))) missing.push("elan");
	if (!fs.existsSync(path.join(paths.toolchainDir, "bin", `lake${EXE}`))) missing.push("the pinned Lean toolchain");
	return { ready: missing.length === 0, missing };
}

/**
 * Makes `lake` runnable with the pinned Lean and no Mathlib: elan (SHA-256 pinned) into `<cache>/elan`, and the
 * pinned toolchain archive (SHA-256 checked, `zip`: no zstd needed) unpacked where elan keeps toolchains. Lazy and
 * idempotent. Platforms without a pin (Linux) use `lake` from PATH when it runs (`OMPDESK_FORMAL_SYSTEM_LEAN=1`
 * forces that everywhere). Throws Unavailable otherwise.
 */
export async function prepareLean(
	options: { env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {},
): Promise<LeanEnv> {
	const env = options.env ?? process.env;
	const tc = loadToolchain(env);
	const systemFirst = env.OMPDESK_FORMAL_SYSTEM_LEAN === "1";
	const hasPin = `${process.platform}-${process.arch}` in tc.lean.archive.platforms;
	if (systemFirst || !hasPin) {
		const version = await versionOf("lake", env);
		if (version) {
			return {
				elanHome: env.ELAN_HOME ?? "",
				env,
				lake: "lake",
				lean: "lean",
				toolchain: "system",
				leanVersion: version,
				source: "system",
			};
		}
		if (systemFirst) throw new Unavailable("OMPDESK_FORMAL_SYSTEM_LEAN=1 but `lake --version` does not run");
	}
	const root = cacheRoot(env);
	const paths = leanPaths(env);
	const elanBinary = path.join(paths.bin, `elan${EXE}`);
	if (!fs.existsSync(elanBinary)) {
		const entry = forPlatform(tc.lean.elan.platforms, "elan");
		await withLock(root, "elan", async () => {
			if (fs.existsSync(elanBinary)) return;
			const archive = path.join(root, "downloads", path.basename(new URL(entry.url).pathname));
			await download(entry.url, archive, entry.sha256, {
				label: `elan ${tc.lean.elan.version}`,
				env,
				log: options.log,
			});
			const unpacked = path.join(root, "downloads", `elan-${tc.lean.elan.version}`);
			await extractInto(archive, entry.format, unpacked);
			const init = fs.readdirSync(unpacked).find(name => name.startsWith("elan-init"));
			if (!init)
				throw new Unavailable(`the elan archive holds no elan-init (${fs.readdirSync(unpacked).join(", ")})`);
			const installed = await run(
				path.join(unpacked, init),
				["-y", "--no-modify-path", "--default-toolchain", "none"],
				{ env: { ...env, ELAN_HOME: paths.elanHome }, timeoutMs: 5 * 60_000 },
			);
			if (installed.spawnError || installed.code !== 0) {
				throw new Unavailable(`elan-init failed: ${installed.spawnError?.message ?? installed.stderr.trim()}`);
			}
			fs.rmSync(unpacked, { recursive: true, force: true });
			fs.rmSync(archive, { force: true });
		});
	}
	const lakeBinary = path.join(paths.toolchainDir, "bin", `lake${EXE}`);
	if (!fs.existsSync(lakeBinary)) {
		const entry = forPlatform(tc.lean.archive.platforms, "Lean toolchain");
		await withLock(root, "lean", async () => {
			if (fs.existsSync(lakeBinary)) return;
			const archive = path.join(root, "downloads", path.basename(new URL(entry.url).pathname));
			await download(entry.url, archive, entry.sha256, { label: `Lean ${tc.lean.version}`, env, log: options.log });
			options.log?.(`unpacking Lean ${tc.lean.version} (about 2 GB on disk)`);
			await extractInto(archive, entry.format, paths.toolchainDir);
			fs.rmSync(archive, { force: true });
		});
	}
	const runEnv = leanEnv(paths.elanHome, env);
	// `elan default` with an installed toolchain needs no network.
	await run(elanBinary, ["default", tc.lean.toolchain], { env: runEnv, timeoutMs: 60_000 });
	const lake = path.join(paths.bin, `lake${EXE}`);
	const version = await versionOf(lake, runEnv);
	if (!version) throw new Unavailable(`${lake} --version does not run; delete ${paths.elanHome} and retry`);
	return {
		elanHome: paths.elanHome,
		env: runEnv,
		lake,
		lean: path.join(paths.bin, `lean${EXE}`),
		toolchain: tc.lean.toolchain,
		leanVersion: version,
		source: "ompdesk",
	};
}
