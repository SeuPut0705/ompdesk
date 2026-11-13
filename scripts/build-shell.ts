/**
 * Build OMPdesk's shell (`native/ompdesk/crates/shell`, a cargo workspace of its own: CEF through the `cef` crate) for
 * this machine and stage it where packaging and the e2e harness read it:
 *
 *   bun run build:shell
 *
 * `cargo build --locked --release`, then into the gitignored `resources/ompdesk-shell/<platform>-<arch>/`:
 *   win32-x64   ompdesk-shell.exe (manifest and icon embedded), CEF's runtime files, `locales/en-US.pak` and `ko.pak`
 *   darwin-*    ompdesk-shell (the one Mach-O; the helper apps are made from it when the bundle is assembled) and
 *               `Chromium Embedded Framework.framework` trimmed to `en.lproj` and `ko.lproj`
 * and `ompdesk-shell.build.json`, the record of THIS build: every staged file's SHA-256, the SHA-256 of the sources,
 * the CEF version and its archive's SHA-256, rustc, when. `scripts/after-pack.cjs` holds the shipped bytes to it.
 *
 * The CEF archive is pinned in `native/ompdesk/crates/shell/cef-pin.json` (name, SHA-256, SHA-1, size per platform).
 * It is fetched once into `native/ompdesk/crates/shell/target/cef-dl/`, checked against the SHA-256, and served to the
 * `cef-dll-sys` build script from a local HTTP server (`CEF_DOWNLOAD_URL`): that script reads CEF's whole 10 MB
 * `index.json` through a client limited to 10 MiB, which fails, so it is given a one-entry index instead.
 *
 * Windows facts learned in the prototype (batch P): cmake and Ninja come from the Visual Studio Build Tools; the
 * wrapper's object paths pass MAX_PATH from a deep worktree, so cargo runs in a `subst` drive of the crate folder;
 * `cl` needs INCLUDE only while `cef-dll-sys` builds (with it set, rustc's own linker discovery breaks), so that
 * package is built once with INCLUDE and everything else without.
 *
 *   bun run build:shell -- --check     builds nothing: staged bytes held to the record, the record to the sources
 *   bun run build:shell -- --ensure    builds only when --check fails
 *   bun run build:shell -- --cargo <args…>   cargo (clippy, test) in the same environment (subst drive, cmake)
 *
 * macOS is written from the prototype's bundle-mac.sh and has not been run on a Mac from this checkout.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoPath, rustcPath } from "./cargo";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHELL_DIR = path.join(REPO_ROOT, "native", "ompdesk", "crates", "shell");
export const SHELL_ROOT = path.join(REPO_ROOT, "resources", "ompdesk-shell");
export const RECORD_NAME = "ompdesk-shell.build.json";

export interface CefPinEntry {
	name: string;
	sha256: string;
	sha1: string;
	size: number;
}
export interface CefPin {
	cefVersion: string;
	crate: string;
	chromium: string;
	downloadBase: string;
	platforms: Record<string, CefPinEntry>;
}

export interface ShellBuildRecord {
	version: string;
	platform: string;
	arch: string;
	binary: string;
	/** macOS only: the bundle's `CFBundleExecutable`, which execs `binary` (`ompdesk-launcher`, a file of `files` like the binary). */
	launcher?: string;
	/** Every staged regular file but the record, by relative path with `/`, to its SHA-256. */
	files: Record<string, string>;
	sourceSha256: string;
	cef: { version: string; archiveSha256: string };
	rustc: string;
	builtAt: string;
	buildSeconds: number;
}

class BuildError extends Error {}

export const readPin = (): CefPin =>
	JSON.parse(fs.readFileSync(path.join(SHELL_DIR, "cef-pin.json"), "utf8")) as CefPin;

/** The CEF index key of a platform and architecture. */
export function cefPlatform(platform: string = process.platform, arch: string = process.arch): string {
	if (platform === "win32" && arch === "x64") return "windows64";
	if (platform === "darwin" && arch === "arm64") return "macosarm64";
	if (platform === "darwin" && arch === "x64") return "macosx64";
	throw new BuildError(`no CEF build is pinned for ${platform}-${arch}.`);
}

export const binaryName = (platform: string = process.platform): string =>
	platform === "win32" ? "ompdesk-shell.exe" : "ompdesk-shell";

/** The macOS bundle's `CFBundleExecutable` (it execs the shell and restores the last Electron when a new version never starts). */
export const launcherName = (platform: string = process.platform): string | undefined =>
	platform === "darwin" ? "ompdesk-launcher" : undefined;

/** Where this machine's build is staged. */
export const stagedDir = (): string => path.join(SHELL_ROOT, `${process.platform}-${process.arch}`);

/** The runtime files a Windows build stages from CEF's folder, next to the exe. */
export const WINDOWS_RUNTIME_FILES = [
	"libcef.dll",
	"chrome_elf.dll",
	"d3dcompiler_47.dll",
	"dxcompiler.dll",
	"vk_swiftshader.dll",
	"vk_swiftshader_icd.json",
	"vulkan-1.dll",
	"icudtl.dat",
	"resources.pak",
	"chrome_100_percent.pak",
	"chrome_200_percent.pak",
	"v8_context_snapshot.bin",
] as const;
export const KEPT_LOCALES = ["en-US", "ko"] as const;
export const KEPT_LPROJ = ["en.lproj", "ko.lproj"] as const;

const sha256 = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "target" || entry.name === ".DS_Store") continue;
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(file, out);
		else out.push(file);
	}
	return out;
}

/** One hash over the crate's sources (paths and bytes, `target/` left out), the icon it embeds and this script. */
export function sourceSha256(): string {
	const hash = createHash("sha256");
	const add = (name: string, file: string) => {
		hash.update(name);
		hash.update("\0");
		hash.update(fs.readFileSync(file));
		hash.update("\0");
	};
	for (const file of sourceFiles(SHELL_DIR).sort())
		add(path.relative(SHELL_DIR, file).split(path.sep).join("/"), file);
	add("icon.ico", path.join(REPO_ROOT, "resources", "icon.ico"));
	return hash.digest("hex");
}

/** Every regular file under `dir`, relative with `/`. */
function listFiles(dir: string, prefix = "", out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) listFiles(path.join(dir, entry.name), rel, out);
		else if (entry.isFile() && rel !== RECORD_NAME && !entry.name.includes(".old-")) out.push(rel);
	}
	return out.sort();
}

/** Holds the staged files (`target`: this machine's staging folder) to their record and the record to this checkout's sources. */
export function checkShell(target: string = stagedDir()): ShellBuildRecord {
	const manifest = path.join(target, RECORD_NAME);
	if (!fs.existsSync(manifest)) throw new BuildError(`${path.relative(REPO_ROOT, manifest)} is missing.`);
	const record = JSON.parse(fs.readFileSync(manifest, "utf8")) as ShellBuildRecord;
	if (record.platform !== process.platform || record.arch !== process.arch)
		throw new BuildError(
			`the build record is for ${record.platform}-${record.arch}, not ${process.platform}-${process.arch}.`,
		);
	if (record.sourceSha256 !== sourceSha256())
		throw new BuildError("the shell was built from other sources than this checkout's native/ompdesk/crates/shell.");
	const staged = listFiles(target);
	const named = Object.keys(record.files).sort();
	if (JSON.stringify(staged) !== JSON.stringify(named))
		throw new BuildError("the staged files are not the ones the build record names.");
	for (const rel of named) {
		const actual = sha256(path.join(target, rel));
		if (actual !== record.files[rel])
			throw new BuildError(`${rel} hashes to ${actual}; its build record expects another.`);
	}
	if (!(record.binary in record.files))
		throw new BuildError(`the record's binary ${record.binary} is not among its files.`);
	const launcher = launcherName();
	if (launcher && (record.launcher !== launcher || !(launcher in record.files)))
		throw new BuildError(`the record names no staged ${launcher}.`);
	return record;
}

// ------------------------------------------------------------------ the CEF archive

/** The archive in `native/ompdesk/crates/shell/target/cef-dl/`, fetched when absent or wrong, always checked. */
export async function ensureArchive(key: string = cefPlatform()): Promise<string> {
	const pin = readPin();
	const entry = pin.platforms[key];
	if (!entry) throw new BuildError(`no archive is pinned for ${key}.`);
	const dir = path.join(SHELL_DIR, "target", "cef-dl");
	const file = path.join(dir, entry.name);
	if (fs.existsSync(file) && sha256(file) === entry.sha256) return file;
	fs.mkdirSync(dir, { recursive: true });
	const url = `${pin.downloadBase}${encodeURIComponent(entry.name)}`;
	console.error(`build:shell: fetching ${entry.name} (${Math.round(entry.size / 1e6)} MB)`);
	const response = await fetch(url);
	if (!response.ok) throw new BuildError(`${url}: ${response.status}`);
	const temp = `${file}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
		const actual = sha256(temp);
		if (actual !== entry.sha256)
			throw new BuildError(
				`${entry.name} hashes to ${actual}; cef-pin.json pins ${entry.sha256}. Nothing was kept.`,
			);
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
	return file;
}

/** `cef-dll-sys` asks `<CEF_DOWNLOAD_URL>/index.json` for the version's archive; this is that index with the one entry. */
export function trimmedIndex(pin: CefPin, key: string): Record<string, { versions: unknown[] }> {
	const entry = pin.platforms[key];
	const names = [
		"macosarm64",
		"macosx64",
		"windows64",
		"windowsarm64",
		"windows32",
		"linux64",
		"linuxarm64",
		"linuxarm",
	];
	const index: Record<string, { versions: unknown[] }> = Object.fromEntries(
		names.map(name => [name, { versions: [] }]),
	);
	index[key] = {
		versions: [
			{
				channel: "stable",
				cef_version: entry.name.replace(/^cef_binary_/, "").replace(/_[a-z0-9]+_minimal\.tar\.bz2$/, ""),
				files: [{ type: "minimal", name: entry.name, sha1: entry.sha1, size: entry.size }],
			},
		],
	};
	return index;
}

function serveArchive(pin: CefPin, key: string, archive: string) {
	const entry = pin.platforms[key];
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
			if (name === "index.json") return Response.json(trimmedIndex(pin, key));
			if (name === entry.name) return new Response(Bun.file(archive));
			return new Response("not found", { status: 404 });
		},
	});
}

// ------------------------------------------------------------------ the toolchain environment

function vsTools(): { cmakeBin: string; ninjaBin: string; include: string } {
	const vswhere = path.join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	if (!fs.existsSync(vswhere))
		throw new BuildError("Visual Studio Build Tools are not installed (vswhere.exe is missing).");
	const install = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], {
		encoding: "utf8",
	}).trim();
	const cmakeRoot = path.join(install, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake");
	const cmakeBin = path.join(cmakeRoot, "CMake", "bin");
	const ninjaBin = path.join(cmakeRoot, "Ninja");
	if (!fs.existsSync(path.join(cmakeBin, "cmake.exe")) || !fs.existsSync(path.join(ninjaBin, "ninja.exe")))
		throw new BuildError(
			`cmake and Ninja were not found under ${cmakeRoot} (install the "C++ CMake tools for Windows" component).`,
		);
	const newest = (dir: string): string => {
		const names = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const last = names.at(-1);
		if (!last) throw new BuildError(`${dir} is empty.`);
		return last;
	};
	const msvc = path.join(install, "VC", "Tools", "MSVC");
	const msvcInclude = path.join(msvc, newest(msvc), "include");
	const kitsRoot = path.join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Windows Kits",
		"10",
		"Include",
	);
	const kit = path.join(kitsRoot, newest(kitsRoot));
	const include = [msvcInclude, ...["ucrt", "um", "shared", "winrt"].map(part => path.join(kit, part))].join(";");
	return { cmakeBin, ninjaBin, include };
}

/** A drive letter that points at the crate's folder for the length of `run`: the wrapper's paths then fit MAX_PATH. */
async function withSubst<T>(run: (cwd: string) => Promise<T>): Promise<T> {
	if (process.platform !== "win32") return run(SHELL_DIR);
	let letter = "";
	for (const candidate of "XYZWVUTSRQPONMLKJIHGFED") {
		if (!fs.existsSync(`${candidate}:\\`)) {
			letter = candidate;
			break;
		}
	}
	if (!letter) throw new BuildError("no free drive letter for subst.");
	execFileSync("subst", [`${letter}:`, SHELL_DIR]);
	try {
		return await run(`${letter}:\\`);
	} finally {
		spawnSync("subst", [`${letter}:`, "/d"]);
	}
}

function cargoEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.INCLUDE;
	delete env.LIB;
	delete env.LIBPATH;
	env.CEF_PATH = path.join(SHELL_DIR, "target", "cef-bin");
	env.OMPDESK_ICON = path.join(REPO_ROOT, "resources", "icon.ico");
	if (process.platform === "win32") {
		const tools = vsTools();
		env.PATH = `${env.PATH ?? env.Path ?? ""};${tools.cmakeBin};${tools.ninjaBin}`;
	}
	return env;
}

/** Asynchronous on purpose: the local server that hands `cef-dll-sys` its archive lives in this process and must keep answering. */
async function runCargo(
	cargo: string,
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	quiet = false,
): Promise<void> {
	const child = spawn(cargo, args, { cwd, env, stdio: quiet ? ["ignore", "ignore", "pipe"] : "inherit" });
	let stderr = "";
	child.stderr?.on("data", chunk => {
		stderr += String(chunk);
	});
	const { promise, resolve } = Promise.withResolvers<number | null>();
	child.on("close", code => resolve(code));
	child.on("error", () => resolve(null));
	const status = await promise;
	if (status !== 0) throw new BuildError(`cargo ${args.join(" ")} failed (${status}).${stderr ? `\n${stderr}` : ""}`);
}

/**
 * Runs `cargo <args>` in the shell workspace with the CEF archive in place (served locally for `cef-dll-sys`).
 * Builds `cef-dll-sys` first with INCLUDE set on Windows, so any later command finds its compiled wrapper cached.
 */
export async function cargoInShell(args: string[], options: { quiet?: boolean } = {}): Promise<void> {
	const cargo = cargoPath();
	if (!cargo)
		throw new BuildError(
			"Rust is not installed (no `cargo` on PATH or in ~/.cargo/bin). Install it from https://rustup.rs (the toolchain in native/ompdesk/rust-toolchain.toml is picked up automatically).",
		);
	const pin = readPin();
	const key = cefPlatform();
	const archive = await ensureArchive(key);
	// cef-dll-sys looks for the archive in <CEF_PATH>/<cef version>/ before it downloads one.
	const versioned = path.join(SHELL_DIR, "target", "cef-bin", pin.cefVersion);
	fs.mkdirSync(versioned, { recursive: true });
	const linked = path.join(versioned, path.basename(archive));
	if (!fs.existsSync(linked)) {
		try {
			fs.linkSync(archive, linked);
		} catch {
			fs.copyFileSync(archive, linked);
		}
	}
	dropIncompleteExtraction();
	const server = serveArchive(pin, key, archive);
	try {
		const env = cargoEnv();
		env.CEF_DOWNLOAD_URL = `http://127.0.0.1:${server.port}`;
		await withSubst(async cwd => {
			if (process.platform === "win32") {
				const withInclude = { ...env, INCLUDE: vsTools().include };
				const locked = args.includes("--locked") ? ["--locked"] : [];
				await runCargo(
					cargo,
					cwd,
					["build", ...locked, "--release", "-p", "cef-dll-sys"],
					withInclude,
					options.quiet,
				);
				// The debug profile's wrapper is a separate build of the same package.
				if (!args.includes("--release"))
					await runCargo(cargo, cwd, ["build", ...locked, "-p", "cef-dll-sys"], withInclude, options.quiet);
			}
			await runCargo(cargo, cwd, args, env, options.quiet);
		});
	} finally {
		server.stop(true);
	}
}

/** Where `cef-dll-sys` extracts the archive: Release files and Resources merged (Windows) or the framework's parent (macOS). */
function extractedCefDir(): string {
	const pin = readPin();
	const system = process.platform === "win32" ? "windows" : "macos";
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	return path.join(SHELL_DIR, "target", "cef-bin", pin.cefVersion, `cef_${system}_${arch}`);
}

/**
 * A restored build cache (CI's rust-cache prunes files) can keep the extracted folder without the `archive.json`
 * `cef-dll-sys` reads to trust it, and its build script then fails instead of extracting again: such a folder is removed,
 * so the archive in place is extracted afresh.
 */
function dropIncompleteExtraction(): void {
	const dir = extractedCefDir();
	if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, "archive.json")))
		fs.rmSync(dir, { recursive: true, force: true });
}

/** The extracted CEF folder `cef-dll-sys` made. */
function cefDir(): string {
	const dir = extractedCefDir();
	if (!fs.existsSync(dir)) throw new BuildError(`${dir} is missing: cef-dll-sys did not extract the archive.`);
	return dir;
}

function copyIfChanged(from: string, to: string): void {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	if (fs.existsSync(to) && sha256(to) === sha256(from)) return;
	const temp = `${to}.tmp-${process.pid}`;
	try {
		fs.copyFileSync(from, temp);
		fs.chmodSync(temp, 0o755);
		try {
			fs.renameSync(temp, to);
		} catch (error) {
			// Windows refuses to replace an executable a test or the person is running; it may be renamed, though.
			if (!fs.existsSync(to) || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			const old = `${to}.old-${process.pid}`;
			fs.renameSync(to, old);
			fs.renameSync(temp, to);
			try {
				fs.rmSync(old, { force: true });
			} catch {
				// Still running: the next build removes it (`removeLeftovers`).
			}
		}
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

/** Files an earlier build renamed aside because they were running then. */
function removeLeftovers(dir: string): void {
	for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
		if (entry.includes(".old-")) fs.rmSync(path.join(dir, entry), { force: true });
}

function stageFiles(target: string, built: string): void {
	removeLeftovers(target);
	const cef = cefDir();
	if (process.platform === "win32") {
		copyIfChanged(built, path.join(target, binaryName()));
		for (const name of WINDOWS_RUNTIME_FILES) {
			const from = path.join(cef, name);
			if (!fs.existsSync(from)) throw new BuildError(`${from} is missing from the CEF archive.`);
			copyIfChanged(from, path.join(target, name));
		}
		for (const locale of KEPT_LOCALES) {
			const from = path.join(cef, "locales", `${locale}.pak`);
			if (!fs.existsSync(from)) throw new BuildError(`${from} is missing from the CEF archive.`);
			copyIfChanged(from, path.join(target, "locales", `${locale}.pak`));
		}
		return;
	}
	copyIfChanged(built, path.join(target, binaryName()));
	const launcher = launcherName() as string;
	copyIfChanged(path.join(path.dirname(built), launcher), path.join(target, launcher));
	const framework = path.join(cef, "Chromium Embedded Framework.framework");
	if (!fs.existsSync(framework)) throw new BuildError(`${framework} is missing from the CEF archive.`);
	const staged = path.join(target, "Chromium Embedded Framework.framework");
	fs.rmSync(staged, { recursive: true, force: true });
	fs.cpSync(framework, staged, { recursive: true, verbatimSymlinks: true });
	const resources = path.join(staged, "Resources");
	if (fs.existsSync(resources))
		for (const entry of fs.readdirSync(resources))
			if (entry.endsWith(".lproj") && !(KEPT_LPROJ as readonly string[]).includes(entry))
				fs.rmSync(path.join(resources, entry), { recursive: true, force: true });
}

/** Builds the shell and stages it; returns the folder that holds it. cargo decides what is stale. */
export async function buildShell(options: { quiet?: boolean } = {}): Promise<string> {
	const started = Date.now();
	await cargoInShell(["build", "--locked", "--release"], options);
	const built = path.join(SHELL_DIR, "target", "release", binaryName());
	if (!fs.existsSync(built)) throw new BuildError(`${built} was not produced.`);
	const launcher = launcherName();
	if (launcher && !fs.existsSync(path.join(path.dirname(built), launcher)))
		throw new BuildError(`${launcher} was not produced.`);
	const target = stagedDir();
	fs.mkdirSync(target, { recursive: true });
	stageFiles(target, built);
	const files: Record<string, string> = {};
	for (const rel of listFiles(target)) files[rel] = sha256(path.join(target, rel));
	const cargo = cargoPath() as string;
	const version =
		/^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(SHELL_DIR, "Cargo.toml"), "utf8"))?.[1] ?? "0.0.0";
	const pin = readPin();
	const record: ShellBuildRecord = {
		version,
		platform: process.platform,
		arch: process.arch,
		binary: binaryName(),
		...(launcher ? { launcher } : {}),
		files,
		sourceSha256: sourceSha256(),
		cef: { version: pin.cefVersion, archiveSha256: pin.platforms[cefPlatform()].sha256 },
		rustc: execFileSync(rustcPath(cargo), ["--version"], { cwd: SHELL_DIR, encoding: "utf8" }).trim(),
		builtAt: new Date().toISOString(),
		buildSeconds: Math.round((Date.now() - started) / 1000),
	};
	const manifest = path.join(target, RECORD_NAME);
	const previous = fs.existsSync(manifest)
		? (JSON.parse(fs.readFileSync(manifest, "utf8")) as ShellBuildRecord)
		: null;
	const same =
		previous !== null &&
		previous.sourceSha256 === record.sourceSha256 &&
		JSON.stringify(previous.files) === JSON.stringify(record.files);
	if (!same) fs.writeFileSync(manifest, `${JSON.stringify(record, null, "\t")}\n`);
	return target;
}

/** The staged shell when it is this checkout's build (no cargo), else a build. Returns the folder that holds it. */
export async function ensureShell(): Promise<string> {
	try {
		checkShell();
		return stagedDir();
	} catch (error) {
		if (!(error instanceof BuildError)) throw error;
		return buildShell({ quiet: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	try {
		if (args[0] === "--cargo") {
			await cargoInShell(args.slice(1));
		} else if (args.includes("--check")) {
			const record = checkShell();
			console.log(
				`checked ${path.relative(REPO_ROOT, stagedDir())} (${Object.keys(record.files).length} files; built ${record.builtAt})`,
			);
		} else if (args.includes("--ensure")) {
			console.log(path.relative(REPO_ROOT, await ensureShell()));
		} else {
			const target = await buildShell();
			console.log(
				`built ${path.relative(REPO_ROOT, target)} (${binaryName()} ${fs.statSync(path.join(target, binaryName())).size} bytes)`,
			);
		}
	} catch (error) {
		if (!(error instanceof BuildError)) throw error;
		console.error(`build:shell: ${error.message}`);
		process.exit(1);
	}
}
