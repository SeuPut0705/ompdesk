/**
 * Packaging contract of the CEF shell (native-rust › S). Windows is electron-builder's NSIS one-click installer over a
 * custom `electronDist` (electron-builder.win.yml); macOS is `scripts/package-mac.ts`, which assembles OMPdesk.app
 * itself and uses electron-builder (electron-builder.yml) for the DMG only. Both end in `scripts/after-pack.cjs`.
 * A key the finished bundle depends on can exist in one place and be missing in another — which is how `omp://` deep
 * links came to be dead code in every installed build.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { type PlistObject, parsePlistFile, savePlistFile } from "app-builder-lib/out/util/plist";
import { UUID } from "builder-util-runtime";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REA_HUB_ENTRY } from "../../resources/gui-bridge/mcp-hub-contracts";
import { AGENT_DESKTOP_SERVER } from "../../resources/gui-bridge/modes/computer-use-contracts";
import { assembleBundle, RESOURCE_COPIES } from "../../scripts/package-mac";
import { REA_VERSION } from "../shared/builtin-mcp";
import { UPDATE_ASSETS } from "./update-release";

interface BuilderConfig {
	appId?: string;
	productName?: string;
	afterPack?: string;
	asar?: boolean;
	npmRebuild?: boolean;
	electronDist?: string;
	afterExtract?: string;
	electronBranding?: unknown;
	electronLanguages?: string[];
	extraResources?: { from: string; to: string }[];
	protocols?: { name: string; schemes?: string[] }[];
	mac?: {
		artifactName?: string;
		identity?: string | null;
		target?: { target?: string; arch?: string[] }[];
	};
	dmg?: { artifactName?: string; icon?: string; background?: string };
	win?: { target?: { target?: string; arch?: string[] }[] };
	nsis?: Record<string, unknown> & { artifactName?: string; include?: string };
}

interface ReleaseWorkflow {
	env: Record<string, string>;
	jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
}

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

type AfterPackHook = (context: {
	electronPlatformName: string;
	appOutDir: string;
	packager: { appInfo: { productFilename: string } };
}) => Promise<void>;

/** The directories a packaged app keeps CEF's locale files in, under `appOutDir`. */
const LOCALE_DIRS: Record<string, { dirs: string[]; ext: string }> = {
	darwin: {
		dirs: ["OMPdesk.app/Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Resources"],
		ext: ".lproj",
	},
	win32: { dirs: ["locales"], ext: ".pak" },
};

/** A packaged app's locale directories holding `names` (with the platform's extension). */
async function fakeLocales(appOutDir: string, platform: string, names: string[]): Promise<void> {
	const { dirs, ext } = LOCALE_DIRS[platform] ?? { dirs: [], ext: "" };
	for (const dir of dirs) {
		await fs.promises.rm(path.join(appOutDir, dir), { recursive: true, force: true });
		await fs.promises.mkdir(path.join(appOutDir, dir), { recursive: true });
		for (const name of names) await fs.promises.writeFile(path.join(appOutDir, dir, `${name}${ext}`), "");
	}
}

const AI_MEMORY_SOURCE_FILE = path.join(PACKAGE_ROOT, "native/memory/ompdesk.json");
const AI_MEMORY_PLATFORMS: Record<string, { key: string; binary: string }> = {
	darwin: { key: "darwin-arm64", binary: "ai-memory" },
	win32: { key: "win32-x64", binary: "ai-memory.exe" },
};
/** A tiny stand-in for the 40 MB built binary; `fakeAiMemory` writes it with the build record `bun run build:memory` makes. */
const FAKE_AI_MEMORY = Buffer.from("#!/bin/sh\necho fake ai-memory\n");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** What a platform's package copies into the app's resources: Windows' `extraResources`, macOS's `RESOURCE_COPIES`. */
function packagedResources(platform: string): { from: string; to: string }[] {
	if (platform === "darwin") return RESOURCE_COPIES.map(([from, to]) => ({ from, to }));
	const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8")) as BuilderConfig;
	return config.extraResources ?? [];
}

/** The packed app's `ai-memory-bin/<binary>` for `platform` under `appOutDir`. */
async function fakeAiMemory(
	appOutDir: string,
	platform: string,
	bytes: Uint8Array = FAKE_AI_MEMORY,
	mode = 0o755,
): Promise<string> {
	const resources =
		platform === "darwin"
			? path.join(appOutDir, "OMPdesk.app", "Contents", "Resources")
			: path.join(appOutDir, "resources");
	const file = path.join(resources, "ai-memory-bin", AI_MEMORY_PLATFORMS[platform]?.binary ?? "");
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.rm(file, { force: true });
	await fs.promises.writeFile(file, bytes, { mode });
	await fs.promises.chmod(file, mode);
	const source = JSON.parse(fs.readFileSync(AI_MEMORY_SOURCE_FILE, "utf8")) as { version: string };
	await fs.promises.writeFile(
		path.join(path.dirname(file), "ai-memory.build.json"),
		JSON.stringify({ version: source.version, binary: path.basename(file), binarySha256: sha256(FAKE_AI_MEMORY) }),
	);
	return file;
}

/** The packed app's `ompdesk-bin/` for `platform` under `appOutDir`, as `bun run build:native` stages it. */
async function fakeNative(
	appOutDir: string,
	platform: string,
	bytes: Uint8Array = FAKE_AI_MEMORY,
	mode = 0o755,
): Promise<void> {
	const hook = require(path.resolve(PACKAGE_ROOT, "scripts/after-pack.cjs")) as {
		NATIVE_BINARIES: Record<string, string[]>;
	};
	const resources =
		platform === "darwin"
			? path.join(appOutDir, "OMPdesk.app", "Contents", "Resources")
			: path.join(appOutDir, "resources");
	const folder = path.join(resources, "ompdesk-bin");
	await fs.promises.rm(folder, { recursive: true, force: true });
	await fs.promises.mkdir(folder, { recursive: true });
	const binaries: Record<string, string> = {};
	for (const name of hook.NATIVE_BINARIES[platform] ?? []) {
		await fs.promises.writeFile(path.join(folder, name), bytes, { mode });
		await fs.promises.chmod(path.join(folder, name), mode);
		binaries[name] = sha256(FAKE_AI_MEMORY);
	}
	await fs.promises.writeFile(path.join(folder, "ompdesk.build.json"), JSON.stringify({ binaries }));
}

const AGENT_DESKTOP_PIN = JSON.parse(
	fs.readFileSync(path.join(PACKAGE_ROOT, "scripts/agent-desktop-pin.json"), "utf8"),
) as { version: string; targets: Record<string, { sha256: string; binaries: string[] }> };
const AGENT_DESKTOP_KEYS: Record<string, string> = { darwin: "darwin-arm64", win32: "win32-x64" };

/**
 * The packed app's `agent-desktop-bin/` for `platform` under `appOutDir`, as `bun run build:agent-desktop` leaves it:
 * every pinned binary (a stand-in's bytes), upstream's LICENSE and the build record; `record` overrides its fields.
 */
async function fakeAgentDesktop(
	appOutDir: string,
	platform: string,
	record: Record<string, unknown> = {},
	mode = 0o755,
): Promise<string> {
	const key = AGENT_DESKTOP_KEYS[platform] ?? "";
	const target = AGENT_DESKTOP_PIN.targets[key] ?? { sha256: "", binaries: [] };
	const directory = path.join(
		platform === "darwin"
			? path.join(appOutDir, "OMPdesk.app", "Contents", "Resources")
			: path.join(appOutDir, "resources"),
		"agent-desktop-bin",
	);
	await fs.promises.rm(directory, { recursive: true, force: true });
	await fs.promises.mkdir(directory, { recursive: true });
	const binaries: Record<string, string> = {};
	for (const name of target.binaries) {
		const bytes = Buffer.from(`#!/bin/sh\necho ${name}\n`);
		await fs.promises.writeFile(path.join(directory, name), bytes, { mode });
		await fs.promises.chmod(path.join(directory, name), mode);
		binaries[name] = sha256(bytes);
	}
	await fs.promises.writeFile(path.join(directory, "LICENSE"), "Apache License");
	await fs.promises.writeFile(
		path.join(directory, "agent-desktop.build.json"),
		JSON.stringify({
			version: AGENT_DESKTOP_PIN.version,
			target: key,
			archiveSha256: target.sha256,
			binaries,
			...record,
		}),
	);
	return directory;
}

const AFTER_PACK = path.resolve(PACKAGE_ROOT, "scripts/after-pack.cjs");
const NODE_PIN = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "scripts/node-runtime-pin.json"), "utf8")) as {
	version: string;
	targets: Record<string, { sha256: string; binary: string }>;
};
const NODE_KEYS: Record<string, string> = { darwin: "darwin-arm64", win32: "win32-x64" };
const bundleInfo = require(path.join(PACKAGE_ROOT, "scripts/mac-bundle-info.cjs")) as {
	FRAMEWORK: string;
	HELPERS: { suffix: string; id: string }[];
	PRIVACY: Record<string, string>;
	appInfo: (version: string) => Record<string, unknown>;
};
const FAKE_SHELL = Buffer.from("#!/bin/sh\necho fake ompdesk-shell\n");
/** CEF's files as the Windows stage holds them (names from `bun run build:shell`); tiny stand-ins for 200 MB of them. */
const WIN_CEF_FILES = ["libcef.dll", "chrome_elf.dll", "icudtl.dat", "resources.pak", "v8_context_snapshot.bin"];

/** A packed app's root, `resources` and the shell's executable path for `platform` under `appOutDir`. */
function packedPaths(appOutDir: string, platform: string) {
	if (platform === "darwin") {
		const contents = path.join(appOutDir, "OMPdesk.app", "Contents");
		return {
			contents,
			resources: path.join(contents, "Resources"),
			frameworks: path.join(contents, "Frameworks"),
			executable: path.join(contents, "MacOS", "OMPdesk"),
			record: path.join(contents, "Resources", "ompdesk-shell.build.json"),
		};
	}
	return {
		contents: appOutDir,
		resources: path.join(appOutDir, "resources"),
		frameworks: appOutDir,
		executable: path.join(appOutDir, "OMPdesk.exe"),
		record: path.join(appOutDir, "ompdesk-shell.build.json"),
	};
}

/**
 * The shell as `bun run build:shell` stages it and a pack lays it out: the executable (under the product's name),
 * CEF's files and a build record listing each file's SHA-256; on macOS also the five helper apps. `record` overrides
 * the record's fields, `files` adds a file the record does not list.
 */
async function fakeShell(
	appOutDir: string,
	platform: string,
	options: { record?: Record<string, unknown>; mode?: number } = {},
): Promise<ReturnType<typeof packedPaths>> {
	const where = packedPaths(appOutDir, platform);
	const mode = options.mode ?? 0o755;
	const binary = platform === "darwin" ? "ompdesk-shell" : "ompdesk-shell.exe";
	const files: Record<string, string> = { [binary]: sha256(FAKE_SHELL) };
	const write = async (file: string, bytes: Uint8Array, fileMode = 0o644) => {
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		await fs.promises.writeFile(file, bytes, { mode: fileMode });
		await fs.promises.chmod(file, fileMode);
	};
	await write(where.executable, FAKE_SHELL, mode);
	const cef =
		platform === "darwin"
			? [
					`${bundleInfo.FRAMEWORK}/Versions/A/Chromium Embedded Framework`,
					`${bundleInfo.FRAMEWORK}/Versions/A/Libraries/libEGL.dylib`,
				]
			: WIN_CEF_FILES;
	for (const name of cef) {
		const bytes = Buffer.from(`cef ${name}`);
		files[name] = sha256(bytes);
		await write(path.join(where.frameworks, name), bytes);
	}
	if (platform === "darwin") {
		for (const helper of bundleInfo.HELPERS) {
			const name = `OMPdesk Helper${helper.suffix}`;
			await write(path.join(where.frameworks, `${name}.app`, "Contents", "MacOS", name), FAKE_SHELL, mode);
		}
	}
	await fs.promises.mkdir(path.dirname(where.record), { recursive: true });
	await fs.promises.writeFile(
		where.record,
		JSON.stringify({
			version: "0.1.0",
			platform,
			arch: platform === "darwin" ? "arm64" : "x64",
			binary,
			files,
			cef: { version: "156.0.26", archiveSha256: "a".repeat(64) },
			...options.record,
		}),
	);
	return where;
}

/**
 * The pinned Node as `bun run build:node` stages it, in the packed app's `resources/node`: the record names the pin
 * and the bytes; `record` overrides its fields.
 */
async function fakeNode(
	appOutDir: string,
	platform: string,
	options: { record?: Record<string, unknown>; bytes?: Uint8Array; mode?: number } = {},
): Promise<string> {
	const key = NODE_KEYS[platform] ?? "";
	const target = NODE_PIN.targets[key] ?? { sha256: "", binary: "" };
	const directory = path.join(packedPaths(appOutDir, platform).resources, "node");
	await fs.promises.rm(directory, { recursive: true, force: true });
	await fs.promises.mkdir(directory, { recursive: true });
	const bytes = Buffer.from(`#!/bin/sh\necho v${NODE_PIN.version}\n`);
	const file = path.join(directory, target.binary);
	await fs.promises.writeFile(file, options.bytes ?? bytes, { mode: options.mode ?? 0o755 });
	await fs.promises.chmod(file, options.mode ?? 0o755);
	await fs.promises.writeFile(path.join(directory, "LICENSE"), "MIT");
	await fs.promises.writeFile(
		path.join(directory, "node.build.json"),
		JSON.stringify({
			version: NODE_PIN.version,
			target: key,
			archiveSha256: target.sha256,
			binary: target.binary,
			binarySha256: sha256(bytes),
			...options.record,
		}),
	);
	return file;
}

/** The app folder, the licences and (macOS) the Info.plist a pack leaves; `without` leaves one file out. */
async function fakeAppFiles(appOutDir: string, platform: string, without?: string): Promise<void> {
	const where = packedPaths(appOutDir, platform);
	const files = [
		"app/package.json",
		"app/out/main/index.js",
		"app/out/preload/shell.js",
		"app/out/renderer/index.html",
		"LICENSES.chromium.html",
		"LICENSE.cef.txt",
		"LICENSE",
		"NOTICE",
		"THIRD_PARTY_NOTICES.txt",
	];
	for (const name of files) {
		if (name === without) continue;
		await fs.promises.mkdir(path.dirname(path.join(where.resources, name)), { recursive: true });
		await fs.promises.writeFile(path.join(where.resources, name), name);
	}
	if (platform === "darwin") {
		await savePlistFile(path.join(where.contents, "Info.plist"), bundleInfo.appInfo("9.9.9") as PlistObject);
	}
}

/** Everything of a pack but the ai-memory binary, agent-desktop and the native binaries, which each test fakes itself. */
async function fakeShellPack(appOutDir: string, platform: string): Promise<void> {
	await fakeLocales(appOutDir, platform, platform === "darwin" ? ["en", "ko"] : ["en-US", "ko"]);
	await fakeShell(appOutDir, platform);
	await fakeNode(appOutDir, platform);
	await fakeAppFiles(appOutDir, platform);
}

function macConfigs(): { file: string; config: BuilderConfig }[] {
	return fs
		.readdirSync(PACKAGE_ROOT)
		.filter(name => /^electron-builder.*\.yml$/.test(name))
		.map(file => ({
			file,
			config: parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig,
		}))
		.filter(entry => entry.config.mac);
}

describe("mac bundle configs", () => {
	const configs = macConfigs();

	it("sees every builder variant sitting in the package root", () => {
		// The guards below iterate this list, so discovery is itself a contract: a
		// new variant must not slip past them unnoticed. electron-builder.trial.yml is
		// a gitignored local override, so it is tolerated but never required.
		expect(
			configs
				.map(entry => entry.file)
				.filter(file => file !== "electron-builder.trial.yml")
				.sort()
				.join(","),
		).toBe("electron-builder.yml");
	});

	it("builds only the Apple Silicon DMG for macOS", () => {
		const main = configs.find(entry => entry.file === "electron-builder.yml")?.config;
		// The legacy update feed adds the ZIP from the release workflow's command line.
		expect(main?.mac?.target).toEqual([{ target: "dmg", arch: ["arm64"] }]);
	});

	it("ships the gui-bridge extension as a plain folder beside the app on both platforms", () => {
		for (const platform of ["darwin", "win32"]) {
			expect(packagedResources(platform), platform).toContainEqual({
				from: "resources/gui-bridge",
				to: "gui-bridge",
			});
		}
	});

	it("wears the generated mark on the DMG, the installer and the Windows icon file", () => {
		const main = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.yml"), "utf8")) as BuilderConfig;
		expect(main.dmg).toMatchObject({ icon: "icon.icns", background: "resources/dmg-background.tiff" });
		for (const platform of ["darwin", "win32"]) {
			expect(packagedResources(platform), platform).toContainEqual({
				from: "resources/brand/app-icon.png",
				to: "app-icon.png",
			});
		}
		const win = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8")) as BuilderConfig;
		expect(win.nsis).toMatchObject({ installerIcon: "resources/icon.ico", uninstallerIcon: "resources/icon.ico" });
	});

	it("ships the built-in REA declaration and the MCP hub that serves it outside the asar on both platforms", () => {
		for (const file of ["darwin", "win32"]) {
			expect(packagedResources(file), file).toContainEqual({ from: "resources/omp-builtin", to: "omp-builtin" });
			for (const name of ["mcp-hub.ts", "mcp-hub-rea.ts", "mcp-hub-memory.ts", "mcp-hub-contracts.ts"]) {
				expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/gui-bridge", name)), `${file} omits ${name}`).toBe(
					true,
				);
			}
			for (const name of [
				"rea/.mcp.json",
				"rea/rea-config.json",
				"rea/skills/reverse-engineer-anything/SKILL.md",
				"rea/skills/reverse-engineer-anything/LICENSE",
				"pstack/pstack-config.json",
				"pstack/UPSTREAM-LICENSE",
				"pstack/adapter.md",
				"pstack/skills/poteto-mode/SKILL.md",
				"pstack/agents/pstack-agent.md",
				"ecc/ecc-config.json",
				"ecc/UPSTREAM-LICENSE",
				"ecc/README.md",
				"ecc/skills/ecc/SKILL.md",
				"ecc/skills/golang-patterns/SKILL.md",
				"ecc/commands/code-review.md",
				"skills/ompdesk/SKILL.md",
				"formal/skills/ompdesk-formal-verify/SKILL.md",
				"formal/skills/ompdesk-formal-verify/assets/toolchain.json",
				"formal/skills/ompdesk-formal-verify/scripts/tlc.ts",
				"formal/skills/ompdesk-formal-verify/scripts/setup.ts",
				"formal/skills/ompdesk-formal-verify/examples/job-lease/formal/manifest.json",
			]) {
				expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/omp-builtin", name)), `${file} omits ${name}`).toBe(
					true,
				);
			}
		}
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/pstack/plugin.json"))).toBe(false);
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/ecc/plugin.json"))).toBe(false);
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/ecc/package.json"))).toBe(false);
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/formal/plugin.json"))).toBe(false);
		const declaration: unknown = JSON.parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/rea/.mcp.json"), "utf8"),
		);
		expect(declaration).toEqual({ mcpServers: { rea: REA_HUB_ENTRY } });
		expect(declaration).toEqual({
			mcpServers: {
				rea: {
					type: "http",
					url: "$" + "{OMP_GUI_MCP_HUB}/rea?cwd=" + "$" + "{OMP_GUI_MCP_CWD}",
					headers: { Authorization: "$" + "{OMP_GUI_MCP_AUTH}" },
				},
			},
		});
	});

	it("ships the agent-desktop root: one stdio server whose command is the executable the spawn names", () => {
		// `-e omp-builtin/agent-desktop` only while the engine is agent-desktop and the executable exists
		// (src/main/agent-desktop.ts); stock expands `${…}` in a plugin root's `.mcp.json` from the omp's env. Its request
		// deadline is pinned against stock in bridge-computer-use-mcp-stock.test.ts.
		const declaration: unknown = JSON.parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/agent-desktop/.mcp.json"), "utf8"),
		);
		expect(declaration).toMatchObject({
			mcpServers: {
				[AGENT_DESKTOP_SERVER]: {
					type: "stdio",
					command: "$" + "{OMP_GUI_AGENT_DESKTOP}",
					args: ["mcp"],
				},
			},
		});
	});

	it("keeps OMPdesk's own extension root to its skill, so loading it never starts REA", () => {
		// The control tools load `-e omp-builtin` on their own switch; REA is the separate `-e omp-builtin/rea`.
		const root = path.join(PACKAGE_ROOT, "resources/omp-builtin");
		expect(fs.readdirSync(root).sort()).toEqual(["agent-desktop", "ecc", "formal", "pstack", "rea", "skills"]);
		expect(fs.readdirSync(path.join(root, "skills"))).toEqual(["ompdesk"]);
		const skill = fs.readFileSync(path.join(root, "skills/ompdesk/SKILL.md"), "utf8");
		expect(skill).toMatch(/^---\nname: ompdesk\ndescription: \S/);
	});

	it("ships the formal-verification skill as its own model-invocable root, under a name no installed skill shares", () => {
		// `-e omp-builtin/formal` on every spawn (sidecar-factory.ts). Stock dedups skills by name, so a user's own
		// `formal-verify` (proof-skills, agent-formal-verify) would shadow or rename ours: it is `ompdesk-formal-verify`.
		const root = path.join(PACKAGE_ROOT, "resources/omp-builtin/formal");
		expect(fs.readdirSync(path.join(root, "skills"))).toEqual(["ompdesk-formal-verify"]);
		const skillDir = path.join(root, "skills/ompdesk-formal-verify");
		const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
		const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
		expect(frontmatter).toMatch(/^name: ompdesk-formal-verify$/m);
		expect(frontmatter).toMatch(/^description: \S/m);
		expect(frontmatter).not.toMatch(/disable-model-invocation|^hide:/m);
		for (const name of ["setup", "tlc", "lean-check", "mutate", "report", "verify-all", "new-lean"]) {
			expect(fs.existsSync(path.join(skillDir, "scripts", `${name}.ts`)), name).toBe(true);
		}
		const pins = JSON.parse(fs.readFileSync(path.join(skillDir, "assets/toolchain.json"), "utf8")) as {
			tla: { tla2tools: { sha256: string } };
		};
		expect(pins.tla.tla2tools.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "LICENSES/proof-skills-MIT.txt"))).toBe(true);
		const notices = fs.readFileSync(path.join(PACKAGE_ROOT, "THIRD_PARTY_NOTICES.txt"), "utf8");
		expect(notices).toContain("proof-skills (https://github.com/opum-ai/proof-skills)");
	});

	it("vendors REA's skill from the pinned REA release (bun run sync:rea-skill after a bump)", () => {
		const skill = fs.readFileSync(
			path.join(PACKAGE_ROOT, "resources/omp-builtin/rea/skills/reverse-engineer-anything/SKILL.md"),
			"utf8",
		);
		expect(skill).toMatch(/^---\nname: reverse-engineer-anything\ndescription: \S/);
		// Upstream's own commands name the release the skill was generated for.
		const releases = new Set(Array.from(skill.matchAll(/rea-agents@(\d+\.\d+\.\d+)/g), match => match[1]));
		expect([...releases]).toEqual([REA_VERSION]);
	});

	it("ships the license texts of vendored code on both platforms", () => {
		for (const platform of ["darwin", "win32"]) {
			expect(packagedResources(platform), platform).toContainEqual({ from: "LICENSES", to: "LICENSES" });
		}
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "LICENSES/Apache-2.0.txt"))).toBe(true);
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "LICENSES/MIT-lobe-icons.txt"))).toBe(true);
		expect(fs.readdirSync(path.join(PACKAGE_ROOT, "src/renderer/assets/provider-marks")).length).toBeGreaterThan(0);
	});

	it("ships OMPdesk's Apache-2.0 LICENSE, its NOTICE and the generated third-party notices on both platforms", () => {
		for (const platform of ["darwin", "win32"]) {
			const resources = packagedResources(platform);
			for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]) {
				expect(resources, platform).toContainEqual({ from: name, to: name });
				expect(fs.existsSync(path.join(PACKAGE_ROOT, name)), `${platform}: ${name} is missing`).toBe(true);
			}
			// Chromium's third-party licences (CEF's CREDITS.html) and CEF's own travel with the app, taken out of the
			// CEF archive by `bun run stage:cef-licenses`; Node's LICENSE ships inside `node/`.
			const key = platform === "darwin" ? "darwin-arm64" : "win32-x64";
			expect(resources, platform).toContainEqual({
				from: `resources/shell-licenses/${key}/LICENSES.chromium.html`,
				to: "LICENSES.chromium.html",
			});
			expect(resources, platform).toContainEqual({
				from: `resources/shell-licenses/${key}/LICENSE.cef.txt`,
				to: "LICENSE.cef.txt",
			});
			expect(resources, platform).toContainEqual({ from: `resources/node/${key}`, to: "node" });
		}
		// No installer license page: the license ships as a file, not a click-through.
		const win = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8")) as BuilderConfig;
		expect(win.nsis).not.toHaveProperty("license");
		const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			license?: string;
		};
		expect(manifest.license).toBe("Apache-2.0");
		const license = fs.readFileSync(path.join(PACKAGE_ROOT, "LICENSE"), "utf8");
		expect(license).toMatch(/^\s+Apache License\n\s+Version 2\.0, January 2004\n/);
		expect(license).toContain("\nCopyright 2026 SeuPut\n");
		// Apache-2.0 §4(d): a NOTICE is carried along with every redistribution, so it names
		// the holder and where the vendored code's notices are.
		const notice = fs.readFileSync(path.join(PACKAGE_ROOT, "NOTICE"), "utf8");
		expect(notice).toMatch(/^OMPdesk\nCopyright 2026 SeuPut\n/);
		expect(notice).toContain("THIRD_PARTY_NOTICES.txt");
		const notices = fs.readFileSync(path.join(PACKAGE_ROOT, "THIRD_PARTY_NOTICES.txt"), "utf8");
		// What the shell ships: CEF and Chromium (their notices are LICENSES.chromium.html beside the app), Node, and the
		// shell's own Rust crates. Electron is not shipped.
		expect(notices).toContain("Chromium Embedded Framework");
		expect(notices).toContain("LICENSES.chromium.html");
		expect(notices).toContain("Node.js");
		expect(notices).toContain("OMPdesk's CEF shell");
		// The vendored code is credited here, not in NOTICE.
		expect(notices).toContain("Mixdog (https://github.com/tribgames/mixdog)");
		expect(notices).toContain("LICENSES/Apache-2.0.txt");
		expect(notices).toContain("@lobehub/icons");
		expect(notices).toContain("LICENSES/MIT-lobe-icons.txt");
		expect(notices).toContain("reverse-engineer-anything skill from REA");
	});

	it("ships the shared auto-mode contract inside the bridge on macOS and Windows", () => {
		for (const file of ["darwin", "win32"]) {
			const bridge = packagedResources(file).find(resource => resource.to === "gui-bridge");
			expect(bridge?.from, file).toBe("resources/gui-bridge");
			const source = path.join(PACKAGE_ROOT, bridge?.from ?? "", "modes/auto-mode-contracts.ts");
			expect(fs.existsSync(source), `${file} omits modes/auto-mode-contracts.ts`).toBe(true);
			const core = fs.readFileSync(path.join(PACKAGE_ROOT, "resources/gui-bridge/modes/auto-mode-core.ts"), "utf8");
			expect(core).toContain('from "./auto-mode-contracts"');
			expect(fs.readFileSync(source, "utf8")).not.toMatch(/^\s*import\s/m);
		}
	});

	it("registers the omp:// scheme that src/main/deep-link.ts handles, in the NSIS registry entry and the bundle's Info.plist", () => {
		for (const { file, config } of configs) {
			expect(config.mac, `${file} is a mac config`).toBeDefined();
		}
		const win = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8")) as BuilderConfig;
		expect(win.protocols?.flatMap(protocol => protocol.schemes ?? [])).toContain("omp");
		const urlTypes = bundleInfo.appInfo("1.0.0").CFBundleURLTypes as { CFBundleURLSchemes: string[] }[];
		expect(urlTypes.flatMap(type => type.CFBundleURLSchemes)).toContain("omp");
	});

	it("names the app in every privacy prompt the bundle can trigger", () => {
		const info = bundleInfo.appInfo("1.0.0");
		for (const key of Object.keys(bundleInfo.PRIVACY)) {
			const value = info[key];
			// Chromium's own default reads "This app needs access to the camera":
			// a prompt that names no product and claims a capability OMPdesk never uses.
			expect(typeof value === "string" && /\bOMPdesk\b/.test(value), key).toBe(true);
		}
		expect(Object.keys(bundleInfo.PRIVACY).sort()).toEqual([
			"NSBluetoothAlwaysUsageDescription",
			"NSBluetoothPeripheralUsageDescription",
			"NSCameraUsageDescription",
			"NSMicrophoneUsageDescription",
		]);
	});

	it("ships an explicit transport policy that leaves ATS on and excepts loopback", () => {
		// A stray NSAllowsArbitraryLoads turns TLS enforcement off app-wide; the stats server is the only cleartext
		// origin, and it is local. Pin both halves instead of trusting the default.
		expect(bundleInfo.appInfo("1.0.0").NSAppTransportSecurity).toEqual({
			NSAllowsArbitraryLoads: false,
			NSAllowsLocalNetworking: true,
		});
	});

	it("fails a macOS bundle whose Info.plist drops the identity or the policy the app depends on", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-bundle-policy-"));
		const afterPack = require(AFTER_PACK).afterPack as AfterPackHook;
		const plistPath = path.join(directory, "OMPdesk.app", "Contents", "Info.plist");
		const run = () =>
			afterPack({
				electronPlatformName: "darwin",
				appOutDir: directory,
				packager: { appInfo: { productFilename: "OMPdesk" } },
			});
		const info = bundleInfo.appInfo("9.9.9") as PlistObject;
		try {
			await fakeShellPack(directory, "darwin");
			await fakeAiMemory(directory, "darwin");
			await fakeAgentDesktop(directory, "darwin");
			await fakeNative(directory, "darwin");
			await expect(run()).resolves.toBeUndefined();
			const broken: [string, PlistObject, RegExp][] = [
				["another bundle id", { ...info, CFBundleIdentifier: "com.example.other" }, /not com\.seuput\.ompdesk/],
				["no omp scheme", { ...info, CFBundleURLTypes: [] }, /no omp:\/\/ scheme/],
				[
					"arbitrary loads",
					{ ...info, NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } },
					/no explicit transport policy/,
				],
				[
					"an anonymous prompt",
					{ ...info, NSCameraUsageDescription: "This app needs access to the camera" },
					/does not name OMPdesk/,
				],
			];
			for (const [name, plist, message] of broken) {
				await savePlistFile(plistPath, plist);
				await expect(run(), name).rejects.toThrow(message);
			}
			expect(await parsePlistFile(plistPath)).not.toEqual(info);
		} finally {
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps only CEF's en-US and ko locales on both platforms, and the package fails otherwise", async () => {
		const win = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8")) as BuilderConfig;
		// electron-builder keeps a file whose name equals a listed language or prefixes it: `en` alone matches
		// no `en-US.pak` and deleted all of them once (issue #12, a blank window on Windows).
		expect(win.electronLanguages).toEqual(["en-US", "ko"]);
		expect(win.afterPack).toBe("scripts/after-pack.cjs");
		const afterPack = require(AFTER_PACK).afterPack as AfterPackHook;
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-locales-"));
		const run = (platform: string) =>
			afterPack({
				electronPlatformName: platform,
				appOutDir: directory,
				packager: { appInfo: { productFilename: "OMPdesk" } },
			});
		try {
			for (const platform of ["win32", "darwin"]) {
				await fakeShellPack(directory, platform);
				await fakeAiMemory(directory, platform);
				await fakeAgentDesktop(directory, platform);
				await fakeNative(directory, platform);
			}
			await expect(run("win32")).resolves.toBeUndefined();
			await expect(run("darwin")).resolves.toBeUndefined();
			for (const names of [["ko"], [], ["de", "en-US", "ko"]]) {
				await fakeLocales(directory, "win32", names);
				await expect(run("win32"), names.join(",")).rejects.toThrow(/expected exactly en-US\.pak, ko\.pak/);
			}
			await fakeLocales(directory, "darwin", ["en_GB", "en", "ko"]);
			await expect(run("darwin")).rejects.toThrow(/expected exactly en\.lproj, ko\.lproj/);
		} finally {
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});

	describe("the shell, Node and the app folder", () => {
		const afterPack = require(AFTER_PACK).afterPack as AfterPackHook;

		it("fails the package unless CEF and the shell are the bytes the shell build's record names", async () => {
			for (const platform of ["darwin", "win32"]) {
				const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-shell-pack-"));
				const run = () =>
					afterPack({
						electronPlatformName: platform,
						appOutDir: directory,
						packager: { appInfo: { productFilename: "OMPdesk" } },
					});
				try {
					await fakeShellPack(directory, platform);
					await fakeAiMemory(directory, platform);
					await fakeAgentDesktop(directory, platform);
					await fakeNative(directory, platform);
					await expect(run(), `${platform} as staged`).resolves.toBeUndefined();
					const where = packedPaths(directory, platform);
					const cefFile = path.join(
						where.frameworks,
						platform === "darwin" ? `${bundleInfo.FRAMEWORK}/Versions/A/Libraries/libEGL.dylib` : "libcef.dll",
					);
					await fs.promises.writeFile(cefFile, "other bytes");
					await expect(run(), `${platform} with another CEF file`).rejects.toThrow(
						/hashes to [0-9a-f]{64}; its build record expects/,
					);
					await fakeShell(directory, platform);
					await fs.promises.rm(cefFile);
					await expect(run(), `${platform} without a CEF file`).rejects.toThrow(
						/is missing; run `bun run build:shell`/,
					);
					await fakeShell(directory, platform);
					await fs.promises.rm(where.record);
					await expect(run(), `${platform} without the record`).rejects.toThrow(
						/ompdesk-shell\.build\.json is missing/,
					);
					await fakeShell(directory, platform, { record: { cef: { version: "x" } } });
					await expect(run(), `${platform}, a record without the CEF archive hash`).rejects.toThrow(
						/names no CEF version/,
					);
					await fakeShell(directory, platform, {
						record: { platform: platform === "darwin" ? "win32" : "darwin" },
					});
					await expect(run(), `${platform}, another platform's record`).rejects.toThrow(/describes/);
					if (platform === "darwin" && process.platform !== "win32") {
						await fakeShell(directory, platform, { mode: 0o644 });
						await expect(run(), "darwin, not executable").rejects.toThrow(/is not executable/);
					}
					await fakeShell(directory, platform);
					await expect(run(), `${platform} restored`).resolves.toBeUndefined();
				} finally {
					await fs.promises.rm(directory, { recursive: true, force: true });
				}
			}
		}, 60_000);

		it("needs every helper app of the macOS bundle to be a copy of the shell executable", async () => {
			const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-helpers-pack-"));
			const run = () =>
				afterPack({
					electronPlatformName: "darwin",
					appOutDir: directory,
					packager: { appInfo: { productFilename: "OMPdesk" } },
				});
			try {
				await fakeShellPack(directory, "darwin");
				await fakeAiMemory(directory, "darwin");
				await fakeAgentDesktop(directory, "darwin");
				await fakeNative(directory, "darwin");
				const gpu = path.join(
					directory,
					"OMPdesk.app/Contents/Frameworks/OMPdesk Helper (GPU).app/Contents/MacOS/OMPdesk Helper (GPU)",
				);
				await fs.promises.writeFile(gpu, "another program");
				await expect(run()).rejects.toThrow(/is not a copy of the shell executable/);
				await fs.promises.rm(gpu);
				await expect(run()).rejects.toThrow(/CEF starts its helper.GPU process from that name|is missing/);
			} finally {
				await fs.promises.rm(directory, { recursive: true, force: true });
			}
		}, 60_000);

		it("fails the package without the pinned Node, with another version or with other bytes than its record", async () => {
			for (const platform of ["darwin", "win32"]) {
				const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-node-pack-"));
				const run = () =>
					afterPack({
						electronPlatformName: platform,
						appOutDir: directory,
						packager: { appInfo: { productFilename: "OMPdesk" } },
					});
				try {
					await fakeShellPack(directory, platform);
					await fakeAiMemory(directory, platform);
					await fakeAgentDesktop(directory, platform);
					await fakeNative(directory, platform);
					const nodeDir = path.join(packedPaths(directory, platform).resources, "node");
					await fs.promises.rm(nodeDir, { recursive: true });
					await expect(run(), `${platform} without it`).rejects.toThrow(
						/no Node build record or LICENSE; run `bun run build:node`/,
					);
					await fakeNode(directory, platform, { record: { version: "0.0.1" } });
					await expect(run(), `${platform}, another version`).rejects.toThrow(/not the pinned/);
					await fakeNode(directory, platform, { record: { archiveSha256: "b".repeat(64) } });
					await expect(run(), `${platform}, another archive`).rejects.toThrow(/not the pinned/);
					const file = await fakeNode(directory, platform);
					await fs.promises.writeFile(file, "other bytes");
					await expect(run(), `${platform}, other bytes`).rejects.toThrow(/hashes to [0-9a-f]{64}/);
					if (platform === "darwin" && process.platform !== "win32") {
						await fakeNode(directory, platform, { mode: 0o644 });
						await expect(run(), "darwin, not executable").rejects.toThrow(/is not executable/);
					}
					await fakeNode(directory, platform);
					await expect(run(), `${platform} with the pinned Node`).resolves.toBeUndefined();
				} finally {
					await fs.promises.rm(directory, { recursive: true, force: true });
				}
			}
		}, 60_000);

		it("fails the package unless the app is a plain folder holding the main, the page's preload and the renderer, with the notices beside it", async () => {
			for (const platform of ["darwin", "win32"]) {
				const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-app-pack-"));
				const run = () =>
					afterPack({
						electronPlatformName: platform,
						appOutDir: directory,
						packager: { appInfo: { productFilename: "OMPdesk" } },
					});
				try {
					await fakeAiMemory(directory, platform);
					await fakeAgentDesktop(directory, platform);
					await fakeNative(directory, platform);
					for (const name of [
						"app/package.json",
						"app/out/main/index.js",
						"app/out/preload/shell.js",
						"app/out/renderer/index.html",
					]) {
						await fakeShellPack(directory, platform);
						await fs.promises.rm(path.join(packedPaths(directory, platform).resources, name));
						await expect(run(), `${platform} without ${name}`).rejects.toThrow(
							/the shell starts the main from a plain/,
						);
					}
					for (const name of ["LICENSES.chromium.html", "LICENSE.cef.txt", "THIRD_PARTY_NOTICES.txt"]) {
						await fakeShellPack(directory, platform);
						await fs.promises.rm(path.join(packedPaths(directory, platform).resources, name));
						await expect(run(), `${platform} without ${name}`).rejects.toThrow(
							/run `bun run stage:cef-licenses`/,
						);
					}
					await fakeShellPack(directory, platform);
					await fs.promises.writeFile(path.join(packedPaths(directory, platform).resources, "app.asar"), "");
					await expect(run(), `${platform} with an asar`).rejects.toThrow(/does not read asar archives/);
				} finally {
					await fs.promises.rm(directory, { recursive: true, force: true });
				}
			}
		}, 60_000);
	});

	describe("the macOS bundle script", () => {
		it("assembles OMPdesk.app from the staged inputs, with the helpers CEF names, and the packaging check accepts it", async () => {
			const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-mac-assemble-"));
			const out = path.join(repo, "dist", "mac-arm64");
			try {
				const put = async (name: string, bytes: Uint8Array | string = name) => {
					await fs.promises.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
					await fs.promises.writeFile(path.join(repo, name), bytes);
				};
				await put(
					"package.json",
					JSON.stringify({ name: "ompdesk", version: "9.9.9", main: "./out/main/index.js" }),
				);
				await put("out/main/index.js");
				await put("out/preload/shell.js");
				await put("out/renderer/index.html");
				await put("out/.build-stamp.json");
				const staged = "resources/ompdesk-shell/darwin-arm64";
				const files: Record<string, string> = { "ompdesk-shell": sha256(FAKE_SHELL) };
				await put(`${staged}/ompdesk-shell`, FAKE_SHELL);
				for (const name of [
					`${bundleInfo.FRAMEWORK}/Versions/A/Chromium Embedded Framework`,
					`${bundleInfo.FRAMEWORK}/Versions/A/Resources/en.lproj/locale.pak`,
					`${bundleInfo.FRAMEWORK}/Versions/A/Resources/ko.lproj/locale.pak`,
				]) {
					await put(`${staged}/${name}`, name);
					files[name] = sha256(Buffer.from(name));
				}
				await put(
					`${staged}/ompdesk-shell.build.json`,
					JSON.stringify({
						version: "0.1.0",
						platform: "darwin",
						arch: "arm64",
						binary: "ompdesk-shell",
						files,
						cef: { version: "156.0.26", archiveSha256: "a".repeat(64) },
					}),
				);
				for (const [from] of RESOURCE_COPIES) {
					if (!fs.existsSync(path.join(repo, from)))
						await put(
							from === "resources/gui-bridge" ||
								from.includes("-bin/") ||
								from.endsWith("darwin-arm64") ||
								from === "LICENSES" ||
								from === "resources/omp-builtin"
								? `${from}/marker`
								: from,
						);
				}
				const app = assembleBundle(repo, out);
				const resources = path.join(app, "Contents", "Resources");
				expect(fs.readFileSync(path.join(app, "Contents", "MacOS", "OMPdesk"))).toEqual(FAKE_SHELL);
				expect(fs.existsSync(path.join(resources, "app", "out", ".build-stamp.json"))).toBe(false);
				expect(fs.existsSync(path.join(resources, "app", "out", "preload", "shell.js"))).toBe(true);
				const info = await parsePlistFile(path.join(app, "Contents", "Info.plist"));
				expect(info).toMatchObject({
					CFBundleIdentifier: "com.seuput.ompdesk",
					CFBundleExecutable: "OMPdesk",
					CFBundleShortVersionString: "9.9.9",
				});
				for (const helper of bundleInfo.HELPERS) {
					const name = `OMPdesk Helper${helper.suffix}`;
					const helperPlist = await parsePlistFile(
						path.join(app, "Contents", "Frameworks", `${name}.app`, "Contents", "Info.plist"),
					);
					expect(helperPlist).toMatchObject({
						CFBundleExecutable: name,
						CFBundleIdentifier: `com.seuput.ompdesk.${helper.id}`,
						LSUIElement: true,
					});
				}
				// The pack's own check passes on what the script assembled, once the binaries it does not stage are faked.
				await fakeAiMemory(out, "darwin");
				await fakeAgentDesktop(out, "darwin");
				await fakeNative(out, "darwin");
				await fakeNode(out, "darwin");
				await fs.promises.rm(path.join(resources, "node"), { recursive: true });
				await fakeNode(out, "darwin");
				await expect(
					(require(AFTER_PACK).afterPack as AfterPackHook)({
						electronPlatformName: "darwin",
						appOutDir: out,
						packager: { appInfo: { productFilename: "OMPdesk" } },
					}),
				).resolves.toBeUndefined();
			} finally {
				await fs.promises.rm(repo, { recursive: true, force: true });
			}
		});

		it("signs with OMPdesk's pinned certificate and refuses to sign ad hoc when a release requires it", () => {
			const script = fs.readFileSync(path.join(PACKAGE_ROOT, "scripts/package-mac.ts"), "utf8");
			expect(script).toContain("withSigningIdentity");
			expect(script).toContain("resources/entitlements.mac.plist".replace("resources/", ""));
			const signer = fs.readFileSync(path.join(PACKAGE_ROOT, "scripts/mac-sign.cjs"), "utf8");
			expect(signer).toContain("OMPDESK_MAC_SIGNING_REQUIRED");
			const pin = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "scripts/mac-signing.json"), "utf8")) as {
				certificateSha1: string;
			};
			expect(pin.certificateSha1).toMatch(/^[0-9a-f]{40}$/);
		});
	});

	describe("ai-memory binary", () => {
		it("ships each platform's own binary directory as extraResources and nothing of the other", () => {
			for (const [platform, { key }] of Object.entries(AI_MEMORY_PLATFORMS)) {
				const entries = packagedResources(platform).filter(resource =>
					resource.from.startsWith("resources/ai-memory-bin"),
				);
				expect(entries, platform).toEqual([{ from: `resources/ai-memory-bin/${key}`, to: "ai-memory-bin" }]);
			}
		});

		it("builds from the vendored source's version for both platforms and keeps the binaries untracked", () => {
			const source = JSON.parse(fs.readFileSync(AI_MEMORY_SOURCE_FILE, "utf8")) as {
				version: string;
				upstreamTag: string;
			};
			expect(source.version).toMatch(/^\d+\.\d+\.\d+$/);
			expect(source.upstreamTag).toMatch(/^v\d+\.\d+\.\d+$/);
			const cargo = fs.readFileSync(path.join(PACKAGE_ROOT, "native/memory/Cargo.toml"), "utf8");
			expect(/\[workspace\.package\][^[]*?\nversion = "([^"]+)"/s.exec(cargo)?.[1]).toBe(source.version);
			const ignored = fs.readFileSync(path.join(PACKAGE_ROOT, ".gitignore"), "utf8").split("\n");
			expect(ignored).toContain("resources/ai-memory-bin/");
			expect(fs.existsSync(path.join(PACKAGE_ROOT, "native/memory/LICENSE"))).toBe(true);
		});

		it("fails the package when the platform's binary is missing, not executable or not the bytes its build record names", async () => {
			const afterPack = require(path.resolve(PACKAGE_ROOT, "scripts/after-pack.cjs")).afterPack as AfterPackHook;
			for (const platform of ["darwin", "win32"]) {
				const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-ai-memory-pack-"));
				const run = () =>
					afterPack({
						electronPlatformName: platform,
						appOutDir: directory,
						packager: { appInfo: { productFilename: "OMPdesk" } },
					});
				try {
					await fakeShellPack(directory, platform);
					await fakeAgentDesktop(directory, platform);
					await fakeNative(directory, platform);
					await expect(run(), `${platform} without the binary`).rejects.toThrow(
						/ai-memory-bin.*or its build record is missing; run `bun run build:memory`/,
					);
					await fakeAiMemory(directory, platform, Buffer.from("not the pinned bytes"));
					await expect(run(), `${platform} with other bytes`).rejects.toThrow(
						/hashes to [0-9a-f]{64}; its build record expects/,
					);
					// The execute bit exists only on a POSIX file system (after-pack.cjs checks it there only).
					if (platform === "darwin" && process.platform !== "win32") {
						await fakeAiMemory(directory, platform, FAKE_AI_MEMORY, 0o644);
						await expect(run(), "darwin, not executable").rejects.toThrow(/is not executable/);
					}
					await fakeAiMemory(directory, platform);
					await expect(run(), `${platform} with the pinned binary`).resolves.toBeUndefined();
				} finally {
					await fs.promises.rm(directory, { recursive: true, force: true });
				}
			}
		});
	});

	describe("native binaries", () => {
		it("ships each platform's own ompdesk-bin directory as extraResources and keeps the binaries untracked", () => {
			for (const [platform, { key }] of Object.entries(AI_MEMORY_PLATFORMS)) {
				const entries = packagedResources(platform).filter(resource =>
					resource.from.startsWith("resources/ompdesk-bin"),
				);
				expect(entries, platform).toEqual([{ from: `resources/ompdesk-bin/${key}`, to: "ompdesk-bin" }]);
			}
			const ignored = fs.readFileSync(path.join(PACKAGE_ROOT, ".gitignore"), "utf8").split("\n");
			expect(ignored).toContain("resources/ompdesk-bin/");
		});

		it("fails the package when a binary is missing, not executable or not the bytes its build record names", async () => {
			const afterPack = require(path.resolve(PACKAGE_ROOT, "scripts/after-pack.cjs")).afterPack as AfterPackHook;
			for (const platform of ["darwin", "win32"]) {
				const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-native-pack-"));
				const run = () =>
					afterPack({
						electronPlatformName: platform,
						appOutDir: directory,
						packager: { appInfo: { productFilename: "OMPdesk" } },
					});
				const folder =
					platform === "darwin"
						? path.join(directory, "OMPdesk.app", "Contents", "Resources", "ompdesk-bin")
						: path.join(directory, "resources", "ompdesk-bin");
				const cli = path.join(folder, platform === "darwin" ? "ompdesk" : "ompdesk.exe");
				try {
					await fakeShellPack(directory, platform);
					await fakeAiMemory(directory, platform);
					await fakeAgentDesktop(directory, platform);
					await expect(run(), `${platform} without the folder`).rejects.toThrow(
						/ompdesk-bin has no build record; run `bun run build:native`/,
					);
					await fakeNative(directory, platform);
					await fs.promises.rm(cli);
					await expect(run(), `${platform} without the binary`).rejects.toThrow(
						/is missing; run `bun run build:native`/,
					);
					await fakeNative(directory, platform, Buffer.from("other bytes"));
					await expect(run(), `${platform} with other bytes`).rejects.toThrow(
						/hashes to [0-9a-f]{64}; its build record expects/,
					);
					// The execute bit exists only on a POSIX file system (after-pack.cjs checks it there only).
					if (platform === "darwin" && process.platform !== "win32") {
						await fakeNative(directory, platform, FAKE_AI_MEMORY, 0o644);
						await expect(run(), "darwin, not executable").rejects.toThrow(/is not executable/);
					}
					await fakeNative(directory, platform);
					await expect(run(), `${platform} with the built binaries`).resolves.toBeUndefined();
				} finally {
					await fs.promises.rm(directory, { recursive: true, force: true });
				}
			}
		});
	});

	describe("agent-desktop", () => {
		it("ships each platform's pinned agent-desktop as extraResources, kept out of git, with upstream's license", () => {
			for (const platform of Object.keys(AI_MEMORY_PLATFORMS)) {
				const entries = packagedResources(platform).filter(resource =>
					resource.from.startsWith("resources/agent-desktop-bin"),
				);
				expect(entries, platform).toEqual([
					{ from: `resources/agent-desktop-bin/${AGENT_DESKTOP_KEYS[platform]}`, to: "agent-desktop-bin" },
				]);
			}
			const ignored = fs.readFileSync(path.join(PACKAGE_ROOT, ".gitignore"), "utf8").split("\n");
			expect(ignored).toContain("resources/agent-desktop-bin/");
			expect(fs.readFileSync(path.join(PACKAGE_ROOT, "LICENSES/agent-desktop-LICENSE"), "utf8")).toContain(
				"Apache License",
			);
		});

		it("fails the package without the pinned release, with another version or with other bytes than its record", async () => {
			const afterPack = require(path.resolve(PACKAGE_ROOT, "scripts/after-pack.cjs")).afterPack as AfterPackHook;
			for (const platform of ["darwin", "win32"]) {
				const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-agent-desktop-pack-"));
				const run = () =>
					afterPack({
						electronPlatformName: platform,
						appOutDir: directory,
						packager: { appInfo: { productFilename: "OMPdesk" } },
					});
				try {
					await fakeShellPack(directory, platform);
					await fakeAiMemory(directory, platform);
					await fakeNative(directory, platform);
					await expect(run(), `${platform} without it`).rejects.toThrow(
						/no agent-desktop build record or LICENSE; run `bun run build:agent-desktop`/,
					);
					await fakeAgentDesktop(directory, platform, { version: "0.0.1" });
					await expect(run(), `${platform}, another version`).rejects.toThrow(/not the pinned/);
					const folder = await fakeAgentDesktop(directory, platform);
					const cli = AGENT_DESKTOP_PIN.targets[AGENT_DESKTOP_KEYS[platform] ?? ""]?.binaries[0] ?? "";
					await fs.promises.writeFile(path.join(folder, cli), "other bytes");
					await expect(run(), `${platform}, other bytes`).rejects.toThrow(/hashes to [0-9a-f]{64}/);
					if (platform === "darwin" && process.platform !== "win32") {
						await fakeAgentDesktop(directory, platform, {}, 0o644);
						await expect(run(), "darwin, not executable").rejects.toThrow(/is not executable/);
					}
					await fakeAgentDesktop(directory, platform);
					await expect(run(), `${platform} with the pinned release`).resolves.toBeUndefined();
				} finally {
					await fs.promises.rm(directory, { recursive: true, force: true });
				}
			}
		});
	});
});

describe("product identity", () => {
	it("every package config ships OMPdesk under one bundle id", () => {
		for (const file of fs.readdirSync(PACKAGE_ROOT).filter(name => /^electron-builder.*\.yml$/.test(name))) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			expect(config.productName, file).toBe("OMPdesk");
			expect(config.appId, file).toBe("com.seuput.ompdesk");
		}
	});

	it("keeps the versioned artifact names the legacy update feed serves by exact name", () => {
		const mac = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.yml"), "utf8")) as BuilderConfig;
		// electron-builder macros (`${version}`) matched literally; v0.17.x's updater
		// requests `ompdesk-<v>-arm64-mac.zip` / `ompdesk-<v>-arm64.dmg` / `ompdesk-<v>-setup.exe`.
		expect(mac.mac?.artifactName).toMatch(/^ompdesk-\$\{version\}-\$\{arch\}-mac\.\$\{ext\}$/);
		expect(mac.dmg?.artifactName).toMatch(/^ompdesk-\$\{version\}-\$\{arch\}\.\$\{ext\}$/);
		const win = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8")) as BuilderConfig;
		expect(win.nsis?.artifactName).toMatch(/^ompdesk-\$\{version\}-setup\.\$\{ext\}$/);
	});
});

describe("release assets", () => {
	const workflow = fs.readFileSync(path.join(PACKAGE_ROOT, ".github", "workflows", "release.yml"), "utf8");
	const release = parse(workflow) as ReleaseWorkflow;

	it("stages exactly the two version-free installers the updater resolves", () => {
		const staged = (job: string) =>
			release.jobs[job]?.steps
				.find(step => step.name === "Stage assets")
				?.run?.match(/release\/ompdesk-[\w-]+\.\w+/g);
		expect(staged("mac")).toEqual([`release/${UPDATE_ASSETS.mac}`]);
		expect(staged("win")).toEqual([`release/${UPDATE_ASSETS.windows}`]);
		const publish = release.jobs.publish?.steps.map(step => step.run ?? "").join("\n") ?? "";
		expect(publish).toContain(`entry ${UPDATE_ASSETS.mac}`);
		expect(publish).toContain(`entry ${UPDATE_ASSETS.windows}`);
		expect(publish).toContain(`"${UPDATE_ASSETS.mac} ${UPDATE_ASSETS.windows}"`);
	});

	it("keeps the legacy update feed behind one explicit top-level switch", () => {
		expect(["true", "false"]).toContain(release.env.LEGACY_UPDATE_FEED);
	});

	it("puts the memory binary and the pinned agent-desktop in place before packaging on both platforms and verifies them in the package", () => {
		for (const job of ["mac", "win"]) {
			const steps = release.jobs[job]?.steps ?? [];
			const pack = steps.findIndex(step => step.name === "Package");
			for (const command of ["bun run build:memory", "bun run build:agent-desktop"]) {
				const index = steps.findIndex(step => step.run === command);
				expect(index, `${job}: ${command}`).toBeGreaterThanOrEqual(0);
				expect(index, `${job}: ${command}`).toBeLessThan(pack);
			}
		}
		const verify = (name: string) =>
			release.jobs[name === "mac" ? "mac" : "win"]?.steps.find(step => step.name?.startsWith("Verify"))?.run ?? "";
		expect(verify("mac")).toContain("ai-memory-bin/ai-memory");
		expect(verify("mac")).toContain("codesign --verify --strict");
		// The stable identity TCC checks the staged server against across updates (ai-memory/service.ts AI_MEMORY_REQUIREMENT): the
		// signing identifier and OMPdesk's pinned certificate, never a cdhash that changes with every build.
		expect(verify("mac")).toContain(
			String.raw`-R "=identifier \"ai-memory\" and certificate root = H\"$SHA1\"" "$AIM"`,
		);
		expect(verify("win")).toContain("ai-memory-bin/ai-memory.exe");
		// The shipped agent-desktop runs and is the pinned release; on macOS both of its binaries carry the app's signature.
		expect(verify("mac")).toContain("Resources/agent-desktop-bin");
		expect(verify("mac")).toContain("agent-desktop-macos-helper");
		expect(verify("mac")).toContain("agent-desktop-pin.json");
		expect(verify("win")).toContain("agent-desktop-bin/agent-desktop.exe");
		expect(verify("win")).toContain("agent-desktop-pin.json");
		// OMPdesk's own Rust (bun run build:native, in .github/actions/install): the shipped CLI runs, signed on macOS.
		expect(verify("mac")).toContain("Resources/ompdesk-bin/ompdesk");
		expect(verify("mac")).toContain('codesign --verify --strict --verbose=2 "$CLI"');
		expect(verify("win")).toContain("ompdesk-bin/ompdesk.exe help");
		// The core process answers ready from the package on both platforms.
		expect(verify("mac")).toContain('codesign --verify --strict --verbose=2 "$CORE"');
		for (const name of ["mac", "win"]) expect(verify(name), name).toContain(`| grep -F '"event":"ready"'`);
	});
});

describe("Windows package config", () => {
	it("ships the gui-bridge extension and only the x64 NSIS installer", () => {
		const file = "electron-builder.win.yml";
		const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
		expect(
			config.protocols?.flatMap(protocol => protocol.schemes ?? []),
			`${file} ships no URL scheme`,
		).toContain("omp");
		expect(config.extraResources).toContainEqual({ from: "resources/gui-bridge", to: "gui-bridge" });
		expect(config.win?.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
	});

	it("packs the CEF shell as a custom electronDist: its exe becomes OMPdesk.exe, the app is a plain folder under resources/, nothing is rebuilt", () => {
		const config = parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8"),
		) as BuilderConfig;
		// The folder `bun run build:shell` stages; `afterExtract` names its exe `electron.exe` and electron-builder
		// renames that to <productName>.exe. A projectName other than "electron" (`electronBranding`) makes
		// electron-builder lay the app out beside the exe instead of under resources/ (isElectronBased).
		expect(config.electronDist).toBe("resources/ompdesk-shell/win32-x64");
		expect(config.afterExtract).toBe("scripts/after-pack.cjs");
		expect(config.electronBranding).toBeUndefined();
		// The shell starts <resources>/node/node.exe on <resources>/app/out/main/index.js: no archive to read.
		expect(config.asar).toBe(false);
		expect(config.npmRebuild).toBe(false);
		expect(config.extraResources).toContainEqual({ from: "resources/node/win32-x64", to: "node" });
		expect(fs.readFileSync(path.join(PACKAGE_ROOT, ".gitignore"), "utf8").split("\n")).toEqual(
			expect.arrayContaining(["resources/node/", "resources/ompdesk-shell/", "resources/shell-licenses/"]),
		);
		const pin = JSON.parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "native/ompdesk/crates/shell/cef-pin.json"), "utf8"),
		) as {
			cefVersion: string;
		};
		expect(String((config as { electronVersion?: unknown }).electronVersion)).toBe(pin.cefVersion);
	});

	it("keeps the identity v0.127.0's NSIS update installs over: the same app id, no custom uninstall GUID, no per-machine install", () => {
		const config = parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8"),
		) as BuilderConfig;
		// electron-builder derives the uninstall key from the appId (UUID v5): com.seuput.ompdesk →
		// e6f1f351-4346-5a64-a104-9a02672ef1bc, the entry and InstallLocation the Electron app wrote. A `guid` (only the
		// dry run's `scripts/shell-move` passes one, on the command line) would make a second install.
		expect(config.appId).toBe("com.seuput.ompdesk");
		expect(config.nsis).not.toHaveProperty("guid");
		expect(config.nsis).not.toHaveProperty("perMachine", true);
		// The derivation NsisTarget uses (its namespace is a constant of app-builder-lib); the GUID is what the released
		// app's uninstall entry and `HKCU\\Software\\<guid>` InstallLocation are named.
		expect(UUID.v5(config.appId ?? "", UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"))).toBe(
			"e6f1f351-4346-5a64-a104-9a02672ef1bc",
		);
	});

	it("installs per user in one click: no page, no question, no UAC, a progress bar, then OMPdesk starts", () => {
		const config = parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.win.yml"), "utf8"),
		) as BuilderConfig;
		expect(config.nsis).toMatchObject({
			oneClick: true,
			perMachine: false,
			runAfterFinish: true,
			deleteAppDataOnUninstall: false,
			createDesktopShortcut: true,
			createStartMenuShortcut: true,
			shortcutName: "OMPdesk",
			include: "resources/installer.nsh",
		});
		// Assisted-installer options electron-builder refuses (or ignores) with oneClick.
		for (const key of ["allowToChangeInstallationDirectory", "allowElevation", "selectPerMachineByDefault"]) {
			expect(config.nsis, key).not.toHaveProperty(key);
		}
	});

	it("removes an all-users copy from the assisted installer first, and only that", () => {
		const script = fs.readFileSync(path.join(PACKAGE_ROOT, "resources/installer.nsh"), "utf8");
		const init = /!macro customInit\n([\s\S]*?)!macroend/.exec(script)?.[1] ?? "";
		// `${NAME}` as NSIS writes it (a define or macro), built so it never reads as a template slot.
		const nsis = (name: string) => `$${"{"}${name}}`;
		const lines = [
			// Only an HKLM registration (the assisted installer's "Anyone who uses this computer") triggers it.
			`ReadRegStr $R1 HKLM "${nsis("UNINSTALL_REGISTRY_KEY")}" UninstallString`,
			`ReadRegStr $R0 HKLM "${nsis("INSTALL_REGISTRY_KEY")}" InstallLocation`,
			// Its own uninstaller, from a temp copy, elevated once, all-users mode, app data kept; waited for.
			`CopyFiles /SILENT "$R0\\${nsis("UNINSTALL_FILENAME")}" "$PLUGINSDIR\\all-users-uninstaller.exe"`,
			`${nsis("StdUtils.ExecShellWaitEx")} $R2 $R3 "$PLUGINSDIR\\all-users-uninstaller.exe" "runas" "/S /allusers /KEEP_APP_DATA _?=$R0"`,
			`${nsis("StdUtils.WaitForProcEx")} $R4 $R3`,
		];
		for (const line of lines) expect(init).toContain(line);
		// Asked first only when someone is watching; a copy that is still registered stops the install.
		expect(init).toMatch(/\$\{IfNot\} \$\{Silent\}\n\s+MessageBox MB_OKCANCEL/);
		expect(init).toMatch(/SetErrorLevel 2\n\s+Quit/);
		expect(script).not.toMatch(/customInstallMode|RequestExecutionLevel admin/);
	});
});

describe("workflows", () => {
	const workflows = fs
		.readdirSync(path.join(PACKAGE_ROOT, ".github", "workflows"))
		.map(name => ({ name, text: fs.readFileSync(path.join(PACKAGE_ROOT, ".github", "workflows", name), "utf8") }));
	// The composite actions the workflows call: what they `uses` is pinned the same way.
	const actions = fs.readdirSync(path.join(PACKAGE_ROOT, ".github", "actions")).map(name => ({
		name: `actions/${name}`,
		text: fs.readFileSync(path.join(PACKAGE_ROOT, ".github", "actions", name, "action.yml"), "utf8"),
	}));

	it("pins every action to a commit SHA", () => {
		for (const { name, text } of [...workflows, ...actions]) {
			for (const [, ref] of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
				// A reusable workflow or composite action of this repo runs at the caller's commit.
				if (ref?.startsWith("./.github/workflows/") || ref?.startsWith("./.github/actions/")) continue;
				expect(ref, name).toMatch(/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/);
			}
		}
	});

	it("checks the built setup on Windows silently, as a double-click and over an all-users install", () => {
		const ci = parse(workflows.find(entry => entry.name === "ci.yml")?.text ?? "") as {
			on: { workflow_dispatch: { inputs: Record<string, unknown> } };
			jobs: Record<string, { "runs-on": string; if?: string; steps: { run?: string }[] }>;
		};
		expect(ci.on.workflow_dispatch.inputs).toHaveProperty("installer_check");
		const job = ci.jobs["installer-check"];
		expect(job?.if).toBe("!cancelled() && inputs.installer_check");
		expect(job?.["runs-on"]).toBe("windows-latest");
		const runs = job?.steps.map(step => step.run ?? "").join("\n") ?? "";
		expect(runs).toContain("ompdesk-windows-setup.exe");
		for (const mode of ["silent", "ui", "legacy"]) {
			expect(runs).toContain(`scripts/windows-installer-check.ps1 -Setup ompdesk-windows-setup.exe -Mode ${mode}`);
		}
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "scripts/windows-installer-check.ps1"))).toBe(true);
	});

	it("runs formal verification by hand on any branch and stamps only through a branch", () => {
		const formal = parse(workflows.find(entry => entry.name === "formal.yml")?.text ?? "") as {
			on: { workflow_dispatch: { inputs: Record<string, unknown> } };
			permissions: Record<string, string>;
			concurrency: { group: string };
			jobs: Record<
				string,
				{
					if?: string;
					concurrency?: { group: string; "cancel-in-progress": boolean };
					steps: { run?: string; if?: string }[];
				}
			>;
		};
		expect(Object.keys(formal.on.workflow_dispatch.inputs)).toEqual(["only", "tier", "stamp", "skip_mutations"]);
		expect(formal.permissions).toEqual({ contents: "write" });
		expect(formal.concurrency.group).toContain("github.ref");
		expect(formal.concurrency.group).toContain("inputs.only");
		const steps = formal.jobs.formal?.steps ?? [];
		expect(steps[0]?.if).toBe("inputs.stamp && github.ref == 'refs/heads/main'");
		const runs = steps.map(step => step.run ?? "").join("\n");
		expect(runs).toContain("ompdesk-formal-verify/scripts/verify-all.ts");
		// Verification runs side by side; publication is serial per ref and checks the covered code again.
		const publish = formal.jobs.publish;
		expect(publish?.if).toBe("inputs.stamp");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched as written
		expect(publish?.concurrency).toEqual({ group: "formal-publish-${{ github.ref }}", "cancel-in-progress": false });
		const publishRuns = publish?.steps.map(step => step.run ?? "").join("\n") ?? "";
		expect(publishRuns).toContain("scripts/formal-publish.ts");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell variables the publish step expands
		expect(publishRuns).toContain("chore(formal): stamp ${ids} on ${sha7}");
		expect(publishRuns).not.toContain("rebase");
	});

	it("runs the @smoke e2e on every Windows release, and offers it by hand with captures and the omp update lock check", () => {
		const release = parse(workflows.find(entry => entry.name === "release.yml")?.text ?? "") as ReleaseWorkflow;
		const runs = (job: string) => release.jobs[job]?.steps.map(step => step.run ?? "") ?? [];
		// Every @smoke spec runs against the job's packaged out/.
		expect(runs("win")).toContain('bunx playwright test --grep "@smoke"');
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "scripts/omp-update-lock-check.ts"))).toBe(true);

		const ci = parse(workflows.find(entry => entry.name === "ci.yml")?.text ?? "") as {
			on: { workflow_dispatch: { inputs: Record<string, unknown> } };
			jobs: Record<string, { "runs-on": string; if?: string; steps: { run?: string; with?: { path?: string } }[] }>;
		};
		expect(ci.on.workflow_dispatch.inputs).toHaveProperty("win_e2e");
		const job = ci.jobs["win-e2e"];
		expect(job?.if).toBe("!cancelled() && inputs.win_e2e");
		expect(job?.["runs-on"]).toBe("windows-latest");
		const manual = job?.steps.map(step => step.run ?? "") ?? [];
		expect(manual).toContain("bun scripts/omp-update-lock-check.ts");
		expect(manual.some(run => run.includes("bunx playwright test --grep"))).toBe(true);
		expect(job?.steps.some(step => step.with?.path?.includes("captures/"))).toBe(true);
	});

	it("gives a manual batch run every Linux and Windows job a push to main runs, and the macOS jobs only with mac", () => {
		const ci = parse(workflows.find(entry => entry.name === "ci.yml")?.text ?? "") as {
			on: { workflow_dispatch: { inputs: Record<string, unknown> } };
			jobs: Record<string, { if?: string; uses?: string; strategy?: { matrix?: { include?: string } } }>;
		};
		expect(ci.on.workflow_dispatch.inputs).toHaveProperty("batch");
		expect(ci.on.workflow_dispatch.inputs).toHaveProperty("mac");
		expect(ci.jobs["win-platform"]?.if).toContain("inputs.batch");
		// mac-smoke, mac-native, memory and `native` on macOS are one unit (mac-checks.yml): a push to main starts it, a
		// dispatch only with mac (and the queue gate's admission, see ci-queue.test.ts).
		expect(ci.jobs.mac?.uses).toBe("./.github/workflows/mac-checks.yml");
		expect(ci.jobs.mac?.if).toContain("inputs.mac");
		expect(ci.jobs.mac?.if).not.toContain("inputs.batch");
		// The native job's Windows leg comes with batch; Linux always runs; the macOS leg is in mac-checks.yml.
		const legs = ci.jobs.native?.strategy?.matrix?.include ?? "";
		expect(legs).toMatch(/inputs\.batch\) && ',\{"os":"windows-latest"/);
		expect(legs).not.toContain("macos");
		for (const job of ["static", "check", "build", "native"]) {
			expect(ci.jobs[job]?.if ?? "", job).not.toContain("workflow_dispatch'");
		}
	});
});

/**
 * The shipped CSP is the only thing between model output and an outbound
 * request, and nothing in the renderer enforces it — so it is read back off the
 * HTML head that actually ships.
 */
describe("renderer content security policy", () => {
	function sources(directive: string): string[] {
		const html = fs.readFileSync(path.join(PACKAGE_ROOT, "src/renderer/index.html"), "utf8");
		const content = /http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/.exec(html)?.[1];
		if (!content) throw new Error("index.html declares no Content-Security-Policy");
		const entry = content
			.split(";")
			.map(part => part.trim())
			.find(part => part.split(" ")[0] === directive);
		if (!entry) throw new Error(`CSP declares no ${directive}`);
		return entry.split(" ").slice(1);
	}

	it("cannot fetch a remote image for markdown a model wrote", () => {
		// Explicit, not inherited: without img-src the policy falls back to
		// default-src, and a later relaxation there would silently re-open this.
		expect(sources("img-src")).toEqual(["'self'", "data:", "blob:"]);
	});

	it("keeps script execution and network calls inside the app", () => {
		expect(sources("script-src")).toEqual(["'self'"]);
		expect(sources("connect-src")).toEqual(["'self'"]);
	});

	it("plays media only from the app, blobs and main's token-gated omp-media streams", () => {
		expect(sources("media-src")).toEqual(["'self'", "blob:", "omp-media:"]);
	});
});
