import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import macSigning from "../../../scripts/mac-signing.json" with { type: "json" };
import { AI_MEMORY_BINARIES, AI_MEMORY_BUILD_MANIFEST, AI_MEMORY_VERSION } from "../../shared/ai-memory";
import { RM_TEMP } from "../test-fake-omp";
import {
	AI_MEMORY_REQUIREMENT,
	type BuiltAsset,
	codeRequirementProblem,
	externalCandidates,
	newerExternal,
	parseAiMemoryVersion,
	pruneStaged,
	readBuiltAsset,
	sha256File,
	stageBinary,
	stagedBinaryPath,
	stageKey,
	stagingRoot,
} from "./binary";

const CONTENT = "#!/bin/sh\necho ai-memory fake\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ASSET: BuiltAsset = {
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

describe("the build record", () => {
	it("names the two platforms' binaries and the source's version", async () => {
		expect(Object.keys(AI_MEMORY_BINARIES).sort()).toEqual(["darwin-arm64", "win32-x64"]);
		expect(AI_MEMORY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(AI_MEMORY_BINARIES["darwin-arm64"]).toBe("ai-memory");
		expect(AI_MEMORY_BINARIES["win32-x64"]).toBe("ai-memory.exe");
		const source = JSON.parse(await readFile(join(process.cwd(), "native/memory/ompdesk.json"), "utf8"));
		expect(source.version).toBe(AI_MEMORY_VERSION);
	});
});

describe("readBuiltAsset", () => {
	const record = (binary: string, binarySha256: string) =>
		writeFile(join(root, "shipped", AI_MEMORY_BUILD_MANIFEST), JSON.stringify({ binary, binarySha256 }));

	it("reads the recorded hash for the supported platforms and refuses the rest", async () => {
		const dir = join(root, "shipped");
		await record("ai-memory", sha("a"));
		expect(await readBuiltAsset(dir, "darwin", "arm64")).toEqual({ binary: "ai-memory", binarySha256: sha("a") });
		expect(await readBuiltAsset(dir, "darwin", "x64")).toBeNull();
		expect(await readBuiltAsset(dir, "linux", "x64")).toBeNull();
		expect(await readBuiltAsset(dir, "win32", "arm64")).toBeNull();
	});

	it("says to build when there is no record, and rejects a record of another binary or a bad hash", async () => {
		const dir = join(root, "shipped");
		await expect(readBuiltAsset(dir, "darwin", "arm64")).rejects.toThrow(
			/Memory is not built .*bun run build:memory/,
		);
		await record("ai-memory.exe", sha("a"));
		await expect(readBuiltAsset(dir, "darwin", "arm64")).rejects.toThrow(/not a build record of ai-memory/);
		await record("ai-memory", "xyz");
		await expect(readBuiltAsset(dir, "darwin", "arm64")).rejects.toThrow(/not a build record/);
	});
});

describe("stageBinary", () => {
	it("copies the shipped binary into <tools>/ai-memory/<version>/ and makes it executable", async () => {
		const staged = await stageBinary({ source, asset: ASSET, toolsDir });
		expect(staged).toBe(join(toolsDir, "ai-memory", stageKey(ASSET), "ai-memory"));
		expect(staged).toBe(stagedBinaryPath(toolsDir, ASSET));
		expect(await readFile(staged, "utf8")).toBe(CONTENT);
		if (process.platform !== "win32") expect((await stat(staged)).mode & 0o111).not.toBe(0);
		// Atomic: the temp directory was renamed into place, nothing else is left beside the version.
		expect(await readdir(stagingRoot(toolsDir))).toEqual([stageKey(ASSET)]);
	});

	it("reuses a matching staged copy without reading the shipped file", async () => {
		await stageBinary({ source, asset: ASSET, toolsDir });
		await rm(source);
		const again = await stageBinary({ source: join(root, "no-such-file"), asset: ASSET, toolsDir });
		expect(again).toBe(stagedBinaryPath(toolsDir, ASSET));
		expect(await readFile(again, "utf8")).toBe(CONTENT);
	});

	it("refuses a shipped binary whose SHA-256 differs from the build record, and stages nothing", async () => {
		await writeFile(source, "tampered");
		await expect(stageBinary({ source, asset: ASSET, toolsDir })).rejects.toThrow(
			new RegExp(`does not match its build record \\(expected ${ASSET.binarySha256}, got ${sha("tampered")}\\)`),
		);
		expect(await readdir(stagingRoot(toolsDir)).catch(() => [] as string[])).not.toContain(stageKey(ASSET));
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

		it("refuses a binary that is neither the recorded bytes nor satisfies the requirement, and stages nothing", async () => {
			await writeFile(source, "tampered");
			await expect(
				stageBinary({ source, asset: ASSET, toolsDir, requirement: async () => "failed to satisfy" }),
			).rejects.toThrow(
				`The bundled ai-memory is neither the built binary (expected ${ASSET.binarySha256}, got ${sha("tampered")}) nor signed with OMPdesk's certificate (failed to satisfy). Reinstall OMPdesk.`,
			);
			expect(await readdir(stagingRoot(toolsDir)).catch(() => [] as string[])).not.toContain(stageKey(ASSET));
		});

		it("the recorded bytes (a dev build's own copy) stage by hash, without asking codesign", async () => {
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
		await pruneStaged(toolsDir, ASSET);
		expect(await readdir(stagingDir)).toEqual([stageKey(ASSET)]);
		expect(await readFile(stagedBinaryPath(toolsDir, ASSET), "utf8")).toBe(CONTENT);
	});

	it("does nothing when nothing was ever staged", async () => {
		await expect(pruneStaged(toolsDir, ASSET)).resolves.toBeUndefined();
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
	it.runIf(existsSync(release))(
		"the real build (`bun run build:memory`) stages by its record; an ad-hoc re-signed copy of it is refused",
		async () => {
			const built = await readBuiltAsset(
				join(process.cwd(), "resources", "ai-memory-bin", "darwin-arm64"),
				"darwin",
				"arm64",
			);
			if (!built) throw new Error("no darwin-arm64 build record");
			const staged = await stageBinary({ source: release, asset: built, toolsDir, requirement: check });
			expect(await sha256File(staged)).toBe(built.binarySha256);
			await rm(toolsDir, RM_TEMP);
			await expect(
				stageBinary({ source: await adHocCopy(release), asset: built, toolsDir, requirement: check }),
			).rejects.toThrow(/neither the built binary .* nor signed with OMPdesk's certificate \(.*failed to satisfy/s);
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
