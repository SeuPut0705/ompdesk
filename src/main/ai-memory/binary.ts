/**
 * Which ai-memory binary OMPdesk runs, and where it lives.
 *
 * The binary OMPdesk builds ships in the app (`<resources>/ai-memory-bin/`, built by OMPdesk from `native/memory`, recorded in `AI_MEMORY_BUILD_MANIFEST`). It is never run from
 * inside the app: the launchd unit, the Windows logon entry and omp's MCP entry all record the binary's absolute path,
 * and the app's own folder is the wrong home for that (a Windows update replaces the install folder while the server
 * still holds its .exe open; a macOS app can be moved or run from a disk image). `stageBinary` therefore verifies the
 * shipped file (its bytes are the build record's, or on macOS its signature satisfies OMPdesk's `AI_MEMORY_REQUIREMENT`) and
 * copies it once into the managed tools dir under `<tools>/ai-memory/<stageKey>/`: one stable folder on macOS, whose TCC
 * grants then survive updates, and a folder per build on Windows. Either way the unit `setup` renders changes with the
 * new bytes, so ai-memory's own `setup` restarts the service on them; other folders are removed afterwards.
 *
 * Only this build ever runs: no other ai-memory (PATH, `~/.local/bin`, Homebrew, the Windows script's folders) is
 * looked for or used, however new it is (the user's decision of 29 Oct 2026).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import macSigning from "../../../scripts/mac-signing.json" with { type: "json" };
import { AI_MEMORY_BINARIES, AI_MEMORY_BUILD_MANIFEST, AI_MEMORY_VERSION } from "../../shared/ai-memory";
import { needsShell, spawnArgs, spawnCommand } from "../spawn";

export type AiMemoryPlatform = "darwin" | "win32";

/** What the build (`bun run build:memory`) recorded next to the shipped binary: its name and the SHA-256 of its bytes. */
export interface BuiltAsset {
	binary: string;
	binarySha256: string;
	/** The platform it was built for, which decides where it is staged (`stageKey`). */
	platform: AiMemoryPlatform;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The binary this app was built with for `platform`/`arch`: null when OMPdesk builds none for it. Throws a message
 * for the person when the folder carries no (valid) build record, i.e. a development checkout that never ran
 * `bun run build:memory` (which needs Rust) or a damaged install.
 */
export async function readBuiltAsset(bundledDir: string, platform: string, arch: string): Promise<BuiltAsset | null> {
	const binary = AI_MEMORY_BINARIES[`${platform}-${arch}`];
	if (!binary) return null;
	const file = join(bundledDir, AI_MEMORY_BUILD_MANIFEST);
	let record: { binary?: unknown; binarySha256?: unknown };
	try {
		record = JSON.parse(await readFile(file, "utf8"));
	} catch {
		throw new Error(
			`Memory is not built (${file} is missing). Run \`bun run build:memory\` (needs Rust) or reinstall OMPdesk.`,
		);
	}
	if (record.binary !== binary || typeof record.binarySha256 !== "string" || !HEX64.test(record.binarySha256)) {
		throw new Error(`${file} is not a build record of ${binary}. Run \`bun run build:memory\` or reinstall OMPdesk.`);
	}
	return { binary, binarySha256: record.binarySha256, platform: platform === "darwin" ? "darwin" : "win32" };
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

/** macOS: the one folder every build stages into (`stageKey`). */
export const MAC_STAGE_KEY = "current";

/**
 * The folder a build stages under.
 *
 * macOS: always `MAC_STAGE_KEY`. The service is a launchd job, so it is its own responsible process for TCC, and TCC
 * keys an unbundled program's privacy grants (Desktop, Documents, Downloads, network volumes) by its absolute path
 * (`AUTHREQ_SUBJECT` in tccd's log is the binary's path), checked against its designated requirement. A path that
 * changed with every build asked for every protected folder again after each update, although the requirement
 * (`AI_MEMORY_REQUIREMENT`) never changes. The new bytes replace the old file at the same path; the unit `setup` renders
 * names the binary's SHA-256 (`native/memory` `user_service.rs`), so `setup` still restarts the server on them.
 *
 * Windows: the version and the first 8 hex of the recorded SHA-256, because a running server keeps its .exe locked
 * and a new build cannot replace it; the logon entry then points at the new path and `setup` restarts the host on it.
 */
export function stageKey(asset: BuiltAsset): string {
	if (asset.platform === "darwin") return MAC_STAGE_KEY;
	return `${AI_MEMORY_VERSION}-${asset.binarySha256.slice(0, 8)}`;
}

export function stagedBinaryPath(toolsDir: string, asset: BuiltAsset): string {
	return join(stagingRoot(toolsDir), stageKey(asset), asset.binary);
}

/**
 * macOS: the designated requirement of the shipped binary of a packaged build. Packaging re-signs it (`scripts/mac-sign.cjs`
 * through `@electron/osx-sign`) after `scripts/after-pack.cjs` held its bytes to the build record, so its bytes are no longer
 * the built ones; what names it afterwards is this requirement: codesign identifies an unbundled Mach-O by its file
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
 * Verify the shipped binary and copy it into `<tools>/ai-memory/<stageKey>/` (atomically: a temp directory renamed
 * into place). Returns the staged path. The shipped file is accepted when its bytes are the build record's (Windows ships the
 * binary unsigned; a dev build's `resources/ai-memory-bin` copy) or, with `requirement` (macOS), when its signature
 * satisfies it (re-signed with OMPdesk's certificate). A staged copy is trusted only by bytes: it is reused
 * when it is the recorded one (without reading the shipped file) or byte-identical to the shipped file just verified, and
 * replaced otherwise (a torn copy, tampering, another app version's signature).
 */
export async function stageBinary(options: {
	source: string;
	asset: BuiltAsset;
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
		if (!requirement)
			throw new Error(`The bundled ai-memory does not match its build record (${pinned}). Reinstall OMPdesk.`);
		const problem = await requirement(source);
		if (problem !== null) {
			throw new Error(
				`The bundled ai-memory is neither the built binary (${pinned}) nor signed with OMPdesk's certificate (${problem}). Reinstall OMPdesk.`,
			);
		}
	}
	if (staged === actual) return dest;
	const root = stagingRoot(toolsDir);
	const folder = join(root, stageKey(asset));
	const temp = join(root, `.stage-${process.pid}-${Date.now()}`);
	await mkdir(temp, { recursive: true });
	try {
		const copy = join(temp, asset.binary);
		await copyFile(source, copy);
		await chmod(copy, 0o755);
		// One rename of the verified copy over the binary in use: the folder may be the one macOS keeps (`MAC_STAGE_KEY`),
		// whose binary the service runs, so it is never deleted first; a failure here leaves the previous one in place.
		await mkdir(folder, { recursive: true });
		await rename(copy, dest);
	} finally {
		await rm(temp, { recursive: true, force: true }).catch(() => undefined);
	}
	const strays = (await readdir(folder)).filter(name => name !== asset.binary);
	await Promise.all(
		strays.map(name => rm(join(folder, name), { recursive: true, force: true }).catch(() => undefined)),
	);
	return dest;
}

/**
 * Remove staged versions other than the current one, and leftover temp directories. Best effort: on Windows the
 * previous version's .exe stays locked until its server has exited, and the next launch tries again.
 */
export async function pruneStaged(toolsDir: string, asset: BuiltAsset): Promise<void> {
	const root = stagingRoot(toolsDir);
	const names = await readdir(root).catch(() => [] as string[]);
	await Promise.all(
		names
			.filter(name => name !== stageKey(asset))
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
