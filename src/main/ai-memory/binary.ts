/**
 * Which ai-memory binary OMPdesk runs, and where it lives.
 *
 * The release binary ships in the app (`<resources>/ai-memory-bin/`, pinned by `AI_MEMORY_ASSETS`). It is never run from
 * inside the app: the launchd unit, the Windows logon entry and omp's MCP entry all record the binary's absolute path,
 * and the app's own folder is the wrong home for that (a Windows update replaces the install folder while the server
 * still holds its .exe open; a macOS app can be moved or run from a disk image). `stageBinary` therefore verifies the
 * shipped file (its bytes are the pin's, or on macOS its signature satisfies OMPdesk's `AI_MEMORY_REQUIREMENT`) and
 * copies it once into the managed tools dir as `<tools>/ai-memory/<version>/`. A new app version stages a new directory, so
 * ai-memory's own `setup` sees a changed unit path and restarts the service on the new binary; the old directory is
 * removed afterwards.
 *
 * A user's own newer ai-memory (on PATH, `~/.local/bin`, the Windows script's folders) wins over the shipped copy:
 * the data directory's schema only migrates forward, so an older binary must never open data a newer one wrote. An
 * equal or older one of theirs is left alone and the shipped copy is used.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import macSigning from "../../../scripts/mac-signing.json" with { type: "json" };
import { AI_MEMORY_ASSETS, AI_MEMORY_VERSION } from "../../shared/ai-memory";
import { compareVersions } from "../../shared/version";
import { executableName, findOnPath, needsShell, spawnArgs, spawnCommand } from "../spawn";

export type AiMemoryPlatform = "darwin" | "win32";

export interface PinnedAsset {
	archive: string;
	archiveSha256: string;
	binary: string;
	binarySha256: string;
}

/** The pin's asset for this machine, or null when the app has no build for it. */
export function pinnedAsset(platform: string, arch: string): PinnedAsset | null {
	return AI_MEMORY_ASSETS[`${platform}-${arch}`] ?? null;
}

export async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

/** `<tools>/ai-memory`: every staged version lives below it. */
export function stagingRoot(toolsDir: string): string {
	return join(toolsDir, "ai-memory");
}

export function stagedBinaryPath(toolsDir: string, asset: PinnedAsset, version = AI_MEMORY_VERSION): string {
	return join(stagingRoot(toolsDir), version, asset.binary);
}

/**
 * macOS: the designated requirement of the shipped binary in a release. Packaging re-signs it (`scripts/mac-sign.cjs`
 * through `@electron/osx-sign`) after `scripts/after-pack.cjs` held its bytes to the pin, so its bytes are no longer
 * the release's; what names it afterwards is this requirement: codesign identifies an unbundled Mach-O by its file
 * name, and every release is signed with OMPdesk's pinned certificate (`scripts/mac-signing.json`). Any other
 * signature, ad-hoc or not (`/usr/bin/true`, a re-signed copy), fails it.
 */
export const AI_MEMORY_REQUIREMENT = `identifier "ai-memory" and certificate root = H"${macSigning.certificateSha1}"`;

/**
 * macOS: why `file` does not carry a valid signature that satisfies `requirement`
 * (`codesign --verify --strict -R=<requirement>`), or null when it does.
 */
export function codeRequirementProblem(file: string, requirement: string): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(
		"/usr/bin/codesign",
		["--verify", "--strict", "-R", `=${requirement}`, file],
		{ timeout: 60_000 },
		(error, _stdout, stderr) => resolve(error ? String(stderr).trim() || error.message : null),
	);
	return promise;
}

/**
 * Verify the shipped binary and copy it into `<tools>/ai-memory/<version>/` (atomically: a temp directory renamed
 * into place). Returns the staged path. The shipped file is accepted when its bytes are the pin's (Windows ships the
 * release unsigned; a dev build's `resources/ai-memory-bin` copy) or, with `requirement` (macOS), when its signature
 * satisfies it (a release re-signed with OMPdesk's certificate). A staged copy is trusted only by bytes: it is reused
 * when it is the pin's (without reading the shipped file) or byte-identical to the shipped file just verified, and
 * replaced otherwise (a torn copy, tampering, another app version's signature).
 */
export async function stageBinary(options: {
	source: string;
	asset: PinnedAsset;
	toolsDir: string;
	/** Why the shipped file fails OMPdesk's signing requirement, or null (`codeRequirementProblem`). */
	requirement?: (file: string) => Promise<string | null>;
}): Promise<string> {
	const { source, asset, toolsDir, requirement } = options;
	const dest = stagedBinaryPath(toolsDir, asset);
	const staged = await sha256File(dest).catch(() => null);
	if (staged === asset.binarySha256) return dest;
	const actual = await sha256File(source).catch(() => null);
	if (actual === null) throw new Error(`The bundled ai-memory is missing (${source}). Reinstall OMPdesk.`);
	if (actual !== asset.binarySha256) {
		const pinned = `expected ${asset.binarySha256}, got ${actual}`;
		if (!requirement) throw new Error(`The bundled ai-memory does not match its pin (${pinned}). Reinstall OMPdesk.`);
		const problem = await requirement(source);
		if (problem !== null) {
			throw new Error(
				`The bundled ai-memory is neither the pinned release (${pinned}) nor signed with OMPdesk's certificate (${problem}). Reinstall OMPdesk.`,
			);
		}
	}
	if (staged === actual) return dest;
	const root = stagingRoot(toolsDir);
	const temp = join(root, `.stage-${process.pid}-${Date.now()}`);
	await mkdir(temp, { recursive: true });
	try {
		const copy = join(temp, asset.binary);
		await copyFile(source, copy);
		await chmod(copy, 0o755);
		await rm(join(root, AI_MEMORY_VERSION), { recursive: true, force: true });
		await rename(temp, join(root, AI_MEMORY_VERSION));
	} catch (error) {
		await rm(temp, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return dest;
}

/**
 * Remove staged versions other than the current one, and leftover temp directories. Best effort: on Windows the
 * previous version's .exe stays locked until its server has exited, and the next launch tries again.
 */
export async function pruneStaged(toolsDir: string): Promise<void> {
	const root = stagingRoot(toolsDir);
	const names = await readdir(root).catch(() => [] as string[]);
	await Promise.all(
		names
			.filter(name => name !== AI_MEMORY_VERSION)
			.map(name => rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)),
	);
}

/** `ai-memory 3.1.1` → `3.1.1`. */
export function parseAiMemoryVersion(output: string): string | null {
	return /\bai-memory\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1] ?? null;
}

/** `<bin> --version`, or null when it does not run or does not say. */
export function probeVersion(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	// A Windows `.cmd` launcher (the e2e's fake) only starts through cmd.exe; the release `.exe` starts directly.
	const args = spawnArgs(bin, ["--version"]);
	execFile(
		spawnCommand(bin),
		args,
		{ env, timeout: 10_000, windowsHide: true, shell: needsShell(bin) },
		(error, stdout) => {
			resolve(error ? null : parseAiMemoryVersion(stdout));
		},
	);
	return promise;
}

/** Where a user's own install usually lives: ai-memory's install scripts and its docs' manual paths. */
export function externalCandidates(platform: AiMemoryPlatform, home: string, env: NodeJS.ProcessEnv): string[] {
	if (platform === "win32") {
		const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
		return [join(local, "Programs", "ai-memory", "ai-memory.exe"), join(local, "ai-memory", "ai-memory.exe")];
	}
	return [join(home, ".local", "bin", "ai-memory"), "/opt/homebrew/bin/ai-memory", "/usr/local/bin/ai-memory"];
}

export interface ExternalInstall {
	bin: string;
	version: string;
}

/**
 * The user's own ai-memory when it is NEWER than the shipped one (never equal or older), else null. `exclude` keeps
 * the staged copy (which may sit on PATH) from counting as the user's.
 */
export async function newerExternal(options: {
	platform: AiMemoryPlatform;
	home: string;
	env: NodeJS.ProcessEnv;
	exclude: string[];
	probe?: (bin: string) => Promise<string | null>;
}): Promise<ExternalInstall | null> {
	const { platform, home, env, exclude } = options;
	const probe = options.probe ?? ((bin: string) => probeVersion(bin, env));
	const pathEnv = env.PATH ?? env.Path ?? "";
	const found = new Set<string>();
	const onPath = findOnPath([executableName("ai-memory", platform)], pathEnv, platform, [], exclude);
	if (onPath) found.add(onPath);
	for (const candidate of externalCandidates(platform, home, env)) {
		if (
			!exclude.includes(candidate) &&
			(await stat(candidate).then(
				info => info.isFile(),
				() => false,
			))
		) {
			found.add(candidate);
		}
	}
	let best: ExternalInstall | null = null;
	for (const bin of found) {
		const version = await probe(bin);
		if (!version) continue;
		if (compareVersions(version, AI_MEMORY_VERSION) !== 1) continue;
		if (!best || compareVersions(version, best.version) === 1) best = { bin, version };
	}
	return best;
}
