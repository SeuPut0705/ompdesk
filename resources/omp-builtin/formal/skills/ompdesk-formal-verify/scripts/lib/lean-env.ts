import fs from "node:fs";
import os from "node:os";
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

/**
 * `lake --version`, run in a neutral folder: elan picks the toolchain from the working directory's `lean-toolchain`, and
 * a project that names one that is not installed would make elan download it here, before any check could refuse.
 */
async function versionOf(lake: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
	const result = await run(lake, ["--version"], { env, cwd, timeoutMs: 60_000 });
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
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const tc = loadToolchain(env);
	const systemFirst = env.OMPDESK_FORMAL_SYSTEM_LEAN === "1";
	const hasPin = `${process.platform}-${process.arch}` in tc.lean.archive.platforms;
	if (systemFirst || !hasPin) {
		const version = await versionOf("lake", env, os.tmpdir());
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
	const lock = <T>(name: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> =>
		withLock(root, name, work, { log });
	const paths = leanPaths(env);
	const elanBinary = path.join(paths.bin, `elan${EXE}`);
	if (!fs.existsSync(elanBinary)) {
		const entry = forPlatform(tc.lean.elan.platforms, "elan");
		await lock("elan", async signal => {
			if (fs.existsSync(elanBinary)) return;
			const archive = path.join(root, "downloads", path.basename(new URL(entry.url).pathname));
			await download(entry.url, archive, entry.sha256, {
				label: `elan ${tc.lean.elan.version}`,
				env,
				log,
				signal,
			});
			const unpacked = path.join(root, "downloads", `elan-${tc.lean.elan.version}`);
			await extractInto(archive, entry.format, unpacked, signal);
			const init = fs.readdirSync(unpacked).find(name => name.startsWith("elan-init"));
			if (!init)
				throw new Unavailable(`the elan archive holds no elan-init (${fs.readdirSync(unpacked).join(", ")})`);
			const installed = await run(
				path.join(unpacked, init),
				["-y", "--no-modify-path", "--default-toolchain", "none"],
				{ env: { ...env, ELAN_HOME: paths.elanHome }, timeoutMs: 5 * 60_000, signal },
			);
			if (installed.spawnError || installed.code !== 0) {
				throw new Unavailable(`elan-init failed: ${installed.spawnError?.message ?? installed.stderr.trim()}`);
			}
			signal.throwIfAborted();
			fs.rmSync(unpacked, { recursive: true, force: true });
			fs.rmSync(archive, { force: true });
		});
	}
	const lakeBinary = path.join(paths.toolchainDir, "bin", `lake${EXE}`);
	if (!fs.existsSync(lakeBinary)) {
		const entry = forPlatform(tc.lean.archive.platforms, "Lean toolchain");
		await lock("lean", async signal => {
			if (fs.existsSync(lakeBinary)) return;
			const archive = path.join(root, "downloads", path.basename(new URL(entry.url).pathname));
			await download(entry.url, archive, entry.sha256, { label: `Lean ${tc.lean.version}`, env, log, signal });
			log(`unpacking Lean ${tc.lean.version} (about 3 GB on disk, about 4 GB free needed while it unpacks)`);
			await extractInto(archive, entry.format, paths.toolchainDir, signal);
			fs.rmSync(archive, { force: true });
		});
	}
	const runEnv = leanEnv(paths.elanHome, env);
	// `elan default` with an installed toolchain needs no network.
	await run(elanBinary, ["default", tc.lean.toolchain], { env: runEnv, timeoutMs: 60_000 });
	const lake = path.join(paths.bin, `lake${EXE}`);
	const version = await versionOf(lake, runEnv, paths.elanHome);
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

/** The toolchain string elan reads from a `lean-toolchain` file or `ELAN_TOOLCHAIN`: bare versions are Lean releases. */
export function normalizeToolchain(text: string): string {
	const value = text.trim();
	if (/^v?\d+\.\d+\.\d+(?:-rc\d+)?$/.test(value))
		return `leanprover/lean4:${value.startsWith("v") ? value : `v${value}`}`;
	return value;
}

/** The toolchain elan would pick for `dir`: `ELAN_TOOLCHAIN`, else the nearest `lean-toolchain` up the tree, else none. */
export function requestedToolchain(dir: string, env: NodeJS.ProcessEnv): { toolchain: string; source: string } | null {
	if (env.ELAN_TOOLCHAIN) return { toolchain: normalizeToolchain(env.ELAN_TOOLCHAIN), source: "ELAN_TOOLCHAIN" };
	let at = path.resolve(dir);
	for (;;) {
		const file = path.join(at, "lean-toolchain");
		try {
			const text = fs.readFileSync(file, "utf8").split(/\r?\n/)[0] ?? "";
			if (text.trim()) return { toolchain: normalizeToolchain(text), source: file };
		} catch {
			// none here
		}
		const parent = path.dirname(at);
		if (parent === at) return null;
		at = parent;
	}
}

/**
 * elan downloads whatever `lean-toolchain` names, with no hash and whatever OMPDESK_FORMAL_OFFLINE says. So a
 * project whose toolchain is not the pinned one and is not already installed is UNAVAILABLE here, before lake runs.
 * A project that requires git packages is refused while downloads are off and nothing is fetched yet.
 */
export function guardProjectToolchain(project: string, lean: LeanEnv, env: NodeJS.ProcessEnv): void {
	if (lean.source === "system") return;
	const wanted = requestedToolchain(project, env);
	if (wanted && wanted.toolchain !== lean.toolchain) {
		const installed = fs.existsSync(
			path.join(lean.elanHome, "toolchains", toolchainDirName(wanted.toolchain), "bin", `lake${EXE}`),
		);
		if (!installed) {
			throw new Unavailable(
				`${wanted.source} asks for ${wanted.toolchain}, but only ${lean.toolchain} is pinned and hash-checked, and elan would download the other one unchecked${
					env.OMPDESK_FORMAL_OFFLINE === "1" ? " (downloads are refused: OMPDESK_FORMAL_OFFLINE=1)" : ""
				}. Install it yourself (ELAN_HOME=${lean.elanHome} elan toolchain install ${wanted.toolchain}) or change lean-toolchain to ${lean.toolchain}`,
			);
		}
	}
	if (env.OMPDESK_FORMAL_OFFLINE === "1") {
		for (const file of ["lakefile.toml", "lakefile.lean"]) {
			let text = "";
			try {
				text = fs.readFileSync(path.join(project, file), "utf8");
			} catch {
				continue;
			}
			if (
				/^\s*(?:\[\[require\]\]|require\s)/m.test(text) &&
				!fs.existsSync(path.join(project, ".lake", "packages"))
			) {
				throw new Unavailable(
					`${file} requires packages that lake would fetch from git, and downloads are refused (OMPDESK_FORMAL_OFFLINE=1)`,
				);
			}
		}
	}
}
