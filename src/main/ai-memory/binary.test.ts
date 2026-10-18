import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import macSigning from "../../../scripts/mac-signing.json" with { type: "json" };
import { AI_MEMORY_ASSETS, AI_MEMORY_VERSION } from "../../shared/ai-memory";
import { RM_TEMP } from "../test-fake-omp";
import {
	AI_MEMORY_REQUIREMENT,
	codeRequirementProblem,
	externalCandidates,
	newerExternal,
	type PinnedAsset,
	parseAiMemoryVersion,
	pinnedAsset,
	pruneStaged,
	sha256File,
	stageBinary,
	stagedBinaryPath,
	stagingRoot,
} from "./binary";

const CONTENT = "#!/bin/sh\necho ai-memory fake\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ASSET: PinnedAsset = {
	archive: "ai-memory-test.tar.gz",
	archiveSha256: "0".repeat(64),
	binary: "ai-memory",
	binarySha256: sha(CONTENT),
};

let root: string;
let toolsDir: string;
let source: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ai-memory-binary-"));
	toolsDir = join(root, "tools");
	source = join(root, "shipped", "ai-memory");
	await mkdir(join(root, "shipped"), { recursive: true });
	await writeFile(source, CONTENT);
});

afterEach(async () => {
	await rm(root, RM_TEMP);
});

describe("the pin file", () => {
	it("names darwin-arm64 and win32-x64 with 64-hex hashes and the shipped version", () => {
		expect(Object.keys(AI_MEMORY_ASSETS).sort()).toEqual(["darwin-arm64", "win32-x64"]);
		expect(AI_MEMORY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		for (const asset of Object.values(AI_MEMORY_ASSETS)) {
			expect(asset.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(asset.binarySha256).toMatch(/^[0-9a-f]{64}$/);
			expect(asset.archive).toMatch(/\.(tar\.gz|zip)$/);
		}
		expect(AI_MEMORY_ASSETS["darwin-arm64"]?.binary).toBe("ai-memory");
		expect(AI_MEMORY_ASSETS["win32-x64"]?.binary).toBe("ai-memory.exe");
	});

	it("reads its version from the pin json itself", async () => {
		const pin = JSON.parse(
			await readFile(join(process.cwd(), "resources/omp-builtin/ai-memory/ai-memory.json"), "utf8"),
		);
		expect(pin.version).toBe(AI_MEMORY_VERSION);
		expect(pin.assets).toEqual(AI_MEMORY_ASSETS);
	});
});

describe("pinnedAsset", () => {
	it("finds the supported platforms and refuses the rest", () => {
		expect(pinnedAsset("darwin", "arm64")).toEqual(AI_MEMORY_ASSETS["darwin-arm64"]);
		expect(pinnedAsset("win32", "x64")).toEqual(AI_MEMORY_ASSETS["win32-x64"]);
		expect(pinnedAsset("darwin", "x64")).toBeNull();
		expect(pinnedAsset("linux", "x64")).toBeNull();
		expect(pinnedAsset("win32", "arm64")).toBeNull();
	});
});

describe("stageBinary", () => {
	it("copies the shipped binary into <tools>/ai-memory/<version>/ and makes it executable", async () => {
		const staged = await stageBinary({ source, asset: ASSET, toolsDir });
		expect(staged).toBe(join(toolsDir, "ai-memory", AI_MEMORY_VERSION, "ai-memory"));
		expect(staged).toBe(stagedBinaryPath(toolsDir, ASSET));
		expect(await readFile(staged, "utf8")).toBe(CONTENT);
		if (process.platform !== "win32") expect((await stat(staged)).mode & 0o111).not.toBe(0);
		// Atomic: the temp directory was renamed into place, nothing else is left beside the version.
		expect(await readdir(stagingRoot(toolsDir))).toEqual([AI_MEMORY_VERSION]);
	});

	it("reuses a matching staged copy without reading the shipped file", async () => {
		await stageBinary({ source, asset: ASSET, toolsDir });
		await rm(source);
		const again = await stageBinary({ source: join(root, "no-such-file"), asset: ASSET, toolsDir });
		expect(again).toBe(stagedBinaryPath(toolsDir, ASSET));
		expect(await readFile(again, "utf8")).toBe(CONTENT);
	});

	it("refuses a shipped binary whose SHA-256 differs from the pin, and stages nothing", async () => {
		await writeFile(source, "tampered");
		await expect(stageBinary({ source, asset: ASSET, toolsDir })).rejects.toThrow(
			new RegExp(`does not match its pin \\(expected ${ASSET.binarySha256}, got ${sha("tampered")}\\)`),
		);
		expect(await readdir(stagingRoot(toolsDir)).catch(() => [] as string[])).not.toContain(AI_MEMORY_VERSION);
	});

	it("says so when the shipped binary is missing", async () => {
		await expect(stageBinary({ source: join(root, "gone"), asset: ASSET, toolsDir })).rejects.toThrow(
			/bundled ai-memory is missing/,
		);
	});

	it("replaces a torn or mismatched staged copy", async () => {
		const dest = stagedBinaryPath(toolsDir, ASSET);
		await mkdir(join(dest, ".."), { recursive: true });
		await writeFile(dest, "torn");
		await writeFile(join(dest, "..", "stray"), "left over");
		const staged = await stageBinary({ source, asset: ASSET, toolsDir });
		expect(await readFile(staged, "utf8")).toBe(CONTENT);
		expect(await readdir(join(dest, ".."))).toEqual(["ai-memory"]);
	});

	it("keeps a good staged copy when the shipped file turns out wrong", async () => {
		const staged = await stageBinary({ source, asset: ASSET, toolsDir });
		await writeFile(source, "tampered");
		await expect(stageBinary({ source, asset: ASSET, toolsDir })).resolves.toBe(staged);
	});

	describe("macOS, where packaging re-signed the shipped file with OMPdesk's certificate", () => {
		const SIGNED = "#!/bin/sh\necho ai-memory fake, re-signed by the packager\n";

		it("stages a binary that satisfies the requirement although its bytes differ from the pin, checking it every launch", async () => {
			await writeFile(source, SIGNED);
			const checked: string[] = [];
			const requirement = async (file: string) => {
				checked.push(file);
				return null;
			};
			const staged = await stageBinary({ source, asset: ASSET, toolsDir, requirement });
			expect(staged).toBe(stagedBinaryPath(toolsDir, ASSET));
			expect(await readFile(staged, "utf8")).toBe(SIGNED);
			// The next launch verifies the shipped file again and reuses the byte-identical copy.
			await stageBinary({ source, asset: ASSET, toolsDir, requirement });
			expect(checked).toEqual([source, source]);
		});

		it("never trusts a staged copy by itself: one that differs from the verified shipped file is replaced", async () => {
			await writeFile(source, SIGNED);
			const dest = stagedBinaryPath(toolsDir, ASSET);
			await mkdir(join(dest, ".."), { recursive: true });
			await writeFile(dest, "#!/bin/sh\necho planted, validly signed by someone else\n");
			const staged = await stageBinary({ source, asset: ASSET, toolsDir, requirement: async () => null });
			expect(await readFile(staged, "utf8")).toBe(SIGNED);
		});

		it("stages again when the shipped file changed (an update re-signed it)", async () => {
			const requirement = async () => null;
			await writeFile(source, SIGNED);
			await stageBinary({ source, asset: ASSET, toolsDir, requirement });
			await writeFile(source, `${SIGNED}# signed again\n`);
			const staged = await stageBinary({ source, asset: ASSET, toolsDir, requirement });
			expect(await readFile(staged, "utf8")).toBe(`${SIGNED}# signed again\n`);
		});

		it("refuses a binary that is neither the pin's bytes nor satisfies the requirement, and stages nothing", async () => {
			await writeFile(source, "tampered");
			await expect(
				stageBinary({ source, asset: ASSET, toolsDir, requirement: async () => "failed to satisfy" }),
			).rejects.toThrow(
				`The bundled ai-memory is neither the pinned release (expected ${ASSET.binarySha256}, got ${sha("tampered")}) nor signed with OMPdesk's certificate (failed to satisfy). Reinstall OMPdesk.`,
			);
			expect(await readdir(stagingRoot(toolsDir)).catch(() => [] as string[])).not.toContain(AI_MEMORY_VERSION);
		});

		it("the pin's own bytes (a dev build's synced copy) stage by hash, without asking codesign", async () => {
			const checked: string[] = [];
			const staged = await stageBinary({
				source,
				asset: ASSET,
				toolsDir,
				requirement: async file => {
					checked.push(file);
					return "not signed by OMPdesk";
				},
			});
			expect(await readFile(staged, "utf8")).toBe(CONTENT);
			expect(checked).toEqual([]);
		});
	});
});

describe("pruneStaged", () => {
	it("removes other versions and temp directories, keeps the current one", async () => {
		const stagingDir = stagingRoot(toolsDir);
		await stageBinary({ source, asset: ASSET, toolsDir });
		await mkdir(join(stagingDir, "3.0.0"), { recursive: true });
		await writeFile(join(stagingDir, "3.0.0", "ai-memory"), "old");
		await mkdir(join(stagingDir, ".stage-123-456"), { recursive: true });
		await pruneStaged(toolsDir);
		expect(await readdir(stagingDir)).toEqual([AI_MEMORY_VERSION]);
		expect(await readFile(stagedBinaryPath(toolsDir, ASSET), "utf8")).toBe(CONTENT);
	});

	it("does nothing when nothing was ever staged", async () => {
		await expect(pruneStaged(toolsDir)).resolves.toBeUndefined();
	});
});

describe.runIf(process.platform === "darwin")("the macOS signing requirement, with the real codesign", () => {
	const check = (file: string) => codeRequirementProblem(file, AI_MEMORY_REQUIREMENT);
	/** A copy of `file` named `ai-memory` (codesign's identifier) and signed ad-hoc: valid, but nobody's certificate. */
	const adHocCopy = async (file: string) => {
		const copy = join(root, "adhoc", "ai-memory");
		await mkdir(join(root, "adhoc"), { recursive: true });
		await copyFile(file, copy);
		execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", copy], { stdio: "ignore" });
		return copy;
	};

	it("names the binary's identifier and the certificate mac-sign.cjs pins", () => {
		expect(AI_MEMORY_REQUIREMENT).toBe(
			`identifier "ai-memory" and certificate root = H"${macSigning.certificateSha1}"`,
		);
	});

	it("rejects any other valid signature: a system binary, an ad-hoc copy named ai-memory, an unsigned file", async () => {
		expect(execFileSync("/usr/bin/codesign", ["--verify", "--strict", "/usr/bin/true"]).length).toBe(0);
		expect(await check("/usr/bin/true")).toMatch(/failed to satisfy/);
		const adHoc = await adHocCopy("/usr/bin/true");
		expect(execFileSync("/usr/bin/codesign", ["--verify", "--strict", adHoc]).length).toBe(0);
		expect(await check(adHoc)).toMatch(/failed to satisfy/);
		expect(await check(source)).toMatch(/not signed/);
	});

	const release = join(process.cwd(), "resources", "ai-memory-bin", "darwin-arm64", "ai-memory");
	const pinned = AI_MEMORY_ASSETS["darwin-arm64"];
	it.runIf(existsSync(release) && pinned)(
		"the real release (`bun run sync:ai-memory`) stages by its pin; an ad-hoc re-signed copy of it is refused",
		async () => {
			if (!pinned) return;
			const staged = await stageBinary({ source: release, asset: pinned, toolsDir, requirement: check });
			expect(await sha256File(staged)).toBe(pinned.binarySha256);
			await rm(toolsDir, RM_TEMP);
			await expect(
				stageBinary({ source: await adHocCopy(release), asset: pinned, toolsDir, requirement: check }),
			).rejects.toThrow(
				/neither the pinned release .* nor signed with OMPdesk's certificate \(.*failed to satisfy/s,
			);
		},
	);
});

describe("parseAiMemoryVersion", () => {
	it("reads the version from `--version` output", () => {
		expect(parseAiMemoryVersion("ai-memory 3.1.1\n")).toBe("3.1.1");
		expect(parseAiMemoryVersion("ai-memory v4.0.0-rc.1")).toBe("4.0.0-rc.1");
		expect(parseAiMemoryVersion("INFO starting\nai-memory 3.2.0 (abc123)")).toBe("3.2.0");
	});
	it("returns null for anything else", () => {
		expect(parseAiMemoryVersion("")).toBeNull();
		expect(parseAiMemoryVersion("omp/18.11.1")).toBeNull();
		expect(parseAiMemoryVersion("ai-memory unknown")).toBeNull();
	});
});

describe("externalCandidates", () => {
	it("lists the install script's folders per platform", () => {
		expect(externalCandidates("darwin", "/Users/a", {})).toEqual([
			join("/Users/a", ".local", "bin", "ai-memory"),
			"/opt/homebrew/bin/ai-memory",
			"/usr/local/bin/ai-memory",
		]);
		const windows = externalCandidates("win32", "C:\\Users\\a", { LOCALAPPDATA: "D:\\Local" });
		expect(windows).toEqual([
			join("D:\\Local", "Programs", "ai-memory", "ai-memory.exe"),
			join("D:\\Local", "ai-memory", "ai-memory.exe"),
		]);
	});
});

describe("newerExternal", () => {
	// The test home and PATH are temp folders, so the developer's own ai-memory is never probed; a fake `probe`
	// answers per path.
	async function install(dir: string): Promise<string> {
		await mkdir(dir, { recursive: true });
		const bin = join(dir, "ai-memory");
		await writeFile(bin, "#!/bin/sh\n");
		await chmod(bin, 0o755);
		return bin;
	}
	const run = (options: {
		home: string;
		path?: string;
		exclude?: string[];
		versions: Record<string, string | null>;
	}) =>
		newerExternal({
			platform: "darwin",
			home: options.home,
			env: { PATH: options.path ?? "" },
			exclude: options.exclude ?? [],
			probe: async bin => options.versions[bin] ?? null,
		});

	const [major = 0, minor = 0, patch = 0] = AI_MEMORY_VERSION.split(".").map(Number);
	const NEWER = `${major}.${minor}.${patch + 1}`;

	it.skipIf(process.platform === "win32")("takes a NEWER install on PATH", async () => {
		const bin = await install(join(root, "pathdir"));
		const found = await run({ home: join(root, "home"), path: join(root, "pathdir"), versions: { [bin]: NEWER } });
		expect(found).toEqual({ bin, version: NEWER });
	});

	it.skipIf(process.platform === "win32")("takes a NEWER install in ~/.local/bin", async () => {
		const home = join(root, "home");
		const bin = await install(join(home, ".local", "bin"));
		const found = await run({ home, versions: { [bin]: NEWER } });
		expect(found).toEqual({ bin, version: NEWER });
	});

	it.skipIf(process.platform === "win32")(
		"ignores an equal, an older, an unparsable and a missing install",
		async () => {
			const home = join(root, "home");
			const equal = await install(join(root, "equal"));
			const older = await install(join(root, "older"));
			const garbled = await install(join(root, "garbled"));
			const path = [join(root, "equal"), join(root, "older"), join(root, "garbled"), join(root, "absent")].join(
				delimiter,
			);
			const found = await run({
				home,
				path,
				versions: { [equal]: AI_MEMORY_VERSION, [older]: "0.0.1", [garbled]: null },
			});
			expect(found).toBeNull();
		},
	);

	it("is null when no ai-memory exists anywhere", async () => {
		expect(await run({ home: join(root, "home"), versions: {} })).toBeNull();
	});

	it.skipIf(process.platform === "win32")("never counts the staged copy as the user's", async () => {
		const staged = await install(join(root, "staged"));
		const found = await run({
			home: join(root, "home"),
			path: join(root, "staged"),
			exclude: [staged],
			versions: { [staged]: NEWER },
		});
		expect(found).toBeNull();
	});

	it.skipIf(process.platform === "win32")("picks the newest of several newer installs", async () => {
		const home = join(root, "home");
		const onPath = await install(join(root, "a"));
		const local = await install(join(home, ".local", "bin"));
		const found = await run({
			home,
			path: join(root, "a"),
			versions: { [onPath]: "99.0.1", [local]: "99.1.0" },
		});
		expect(found).toEqual({ bin: local, version: "99.1.0" });
	});
});
