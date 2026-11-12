/**
 * Package OMPdesk for macOS (Apple silicon) from the CEF shell:
 *
 *   bun run package:mac [-- --no-dmg] [-- --legacy-zip]
 *
 * electron-builder cannot lay out a CEF app (its macOS pack is Electron's: the `Electron Framework`, its helper names
 * and Info.plists), so this assembles `dist/mac-arm64/OMPdesk.app` itself, holds it to `scripts/after-pack.cjs`, signs
 * it, and hands the finished bundle to electron-builder only for the DMG (`--prepackaged`: electron-builder neither
 * packs nor signs then, it lays out `dmg:` of electron-builder.yml, the window picture and the /Applications link,
 * and writes `dist/ompdesk-<version>-arm64.dmg`).
 *
 * Inputs, all gitignored and built beforehand (CI's `mac` job does it in this order): `out/` (`bun run build`),
 * `resources/ompdesk-shell/darwin-arm64/` (`bun run build:shell`), `resources/node/darwin-arm64/` (`bun run
 * build:node`), `resources/ompdesk-bin/`, `resources/ai-memory-bin/`, `resources/agent-desktop-bin/` (each for
 * darwin-arm64) and `resources/shell-licenses/darwin-arm64/` (`bun run stage:cef-licenses`).
 *
 * Signing (scripts/mac-sign.cjs): OMPdesk's own pinned certificate, so the designated requirement is `identifier
 * "com.seuput.ompdesk" and certificate root = H"…"` in every release and macOS keeps its privacy grants; ad-hoc without
 * it (an error with `OMPDESK_MAC_SIGNING_REQUIRED=1`). Every Mach-O is signed inside out with hardened runtime and
 * `resources/entitlements.mac.plist` (V8's JIT needs it in the helpers and Node), no secure timestamp (nothing is
 * notarized), then the helper apps and the app, which `stageBundleFromDmg` (src/main/updater-state.ts) verifies with
 * `codesign --verify --deep --strict` after the update.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// CommonJS modules shared with the packaging check.
const require = createRequire(import.meta.url);
interface PackContext {
	electronPlatformName: string;
	appOutDir: string;
	packager: { appInfo: { productFilename: string } };
}
interface Helper {
	suffix: string;
	id: string;
}
const plist = require("plist") as { build: (value: Record<string, unknown>) => string };
const { afterPack } = require("./after-pack.cjs") as { afterPack: (context: PackContext) => Promise<void> };
const bundle = require("./mac-bundle-info.cjs") as {
	PRODUCT: string;
	FRAMEWORK: string;
	HELPERS: Helper[];
	appInfo: (version: string) => Record<string, unknown>;
	helperInfo: (version: string, helper: Helper) => Record<string, unknown>;
};
const { withSigningIdentity } = require("./mac-sign.cjs") as {
	withSigningIdentity: (body: (signing: { identity: string; keychain: string | null }) => unknown) => Promise<unknown>;
};

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "darwin-arm64";
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function fail(message: string): never {
	console.error(`package:mac: ${message}`);
	process.exit(1);
}

/** The `Contents/Resources` entries copied as they are: [source under the repository, destination under Resources]. */
export const RESOURCE_COPIES: [string, string][] = [
	["resources/gui-bridge", "gui-bridge"],
	["resources/node/darwin-arm64", "node"],
	["resources/ompdesk-bin/darwin-arm64", "ompdesk-bin"],
	["resources/omp-builtin", "omp-builtin"],
	["resources/ai-memory-bin/darwin-arm64", "ai-memory-bin"],
	["resources/agent-desktop-bin/darwin-arm64", "agent-desktop-bin"],
	["resources/brand/app-icon.png", "app-icon.png"],
	["resources/icon.icns", "icon.icns"],
	["LICENSE", "LICENSE"],
	["NOTICE", "NOTICE"],
	["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
	["LICENSES", "LICENSES"],
	["resources/shell-licenses/darwin-arm64/LICENSES.chromium.html", "LICENSES.chromium.html"],
	["resources/shell-licenses/darwin-arm64/LICENSE.cef.txt", "LICENSE.cef.txt"],
];

const copy = (from: string, to: string) => {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	// Symlinks stay links: CEF's framework is `Versions/A` with `Current` and top-level links into it.
	fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: true });
};

/**
 * Assemble `<out>/OMPdesk.app` from the staged inputs under `repo`; returns its path. The shell executable (the CEF
 * build's `ompdesk-shell`) is the app's executable and each helper app's, copied, as CEF starts its helper processes
 * from `Contents/Frameworks/<product> Helper*.app`.
 */
export function assembleBundle(repo: string, out: string): string {
	const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
	const staged = path.join(repo, "resources", "ompdesk-shell", KEY);
	const recordFile = path.join(staged, "ompdesk-shell.build.json");
	if (!fs.existsSync(recordFile)) fail(`${recordFile} is missing; run \`bun run build:shell\``);
	const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as { binary: string; files: Record<string, string> };
	for (const name of Object.keys(record.files)) {
		if (name !== record.binary && !name.startsWith(`${bundle.FRAMEWORK}/`)) {
			fail(`${recordFile} lists ${name}; the bundle holds the executable and ${bundle.FRAMEWORK} only`);
		}
	}
	const app = path.join(out, `${bundle.PRODUCT}.app`);
	const contents = path.join(app, "Contents");
	const frameworks = path.join(contents, "Frameworks");
	const resources = path.join(contents, "Resources");
	fs.rmSync(app, { recursive: true, force: true });
	for (const dir of [path.join(contents, "MacOS"), frameworks, resources]) fs.mkdirSync(dir, { recursive: true });

	fs.copyFileSync(path.join(staged, record.binary), path.join(contents, "MacOS", bundle.PRODUCT));
	fs.chmodSync(path.join(contents, "MacOS", bundle.PRODUCT), 0o755);
	copy(path.join(staged, bundle.FRAMEWORK), path.join(frameworks, bundle.FRAMEWORK));
	fs.writeFileSync(path.join(contents, "Info.plist"), plist.build(bundle.appInfo(manifest.version)));
	for (const helper of bundle.HELPERS) {
		const name = `${bundle.PRODUCT} Helper${helper.suffix}`;
		const helperApp = path.join(frameworks, `${name}.app`, "Contents");
		fs.mkdirSync(path.join(helperApp, "MacOS"), { recursive: true });
		fs.copyFileSync(path.join(staged, record.binary), path.join(helperApp, "MacOS", name));
		fs.chmodSync(path.join(helperApp, "MacOS", name), 0o755);
		fs.writeFileSync(path.join(helperApp, "Info.plist"), plist.build(bundle.helperInfo(manifest.version, helper)));
	}
	fs.copyFileSync(recordFile, path.join(resources, "ompdesk-shell.build.json"));

	for (const [from, to] of RESOURCE_COPIES) {
		const source = path.join(repo, from);
		if (!fs.existsSync(source))
			fail(`${source} is missing (see the header of scripts/package-mac.ts for what builds it)`);
		copy(source, path.join(resources, to));
	}
	// The app folder the shell starts the main from: the repository's own package.json and the build, a plain folder.
	const appDir = path.join(resources, "app");
	if (!fs.existsSync(path.join(repo, "out", "main", "index.js")))
		fail("out/ has no main/index.js; run `bun run build`");
	fs.mkdirSync(appDir, { recursive: true });
	fs.copyFileSync(path.join(repo, "package.json"), path.join(appDir, "package.json"));
	fs.cpSync(path.join(repo, "out"), path.join(appDir, "out"), {
		recursive: true,
		filter: source => path.basename(source) !== ".build-stamp.json",
	});
	return app;
}

/** Every regular file under `dir` whose first bytes are a Mach-O (or fat) header, deepest first (children sign before parents). */
export function machOFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const file = path.join(current, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile()) {
				const handle = fs.openSync(file, "r");
				const head = Buffer.alloc(4);
				const read = fs.readSync(handle, head, 0, 4, 0);
				fs.closeSync(handle);
				if (read === 4 && MACHO_MAGIC.has(head.readUInt32BE(0))) found.push(file);
			}
		}
	};
	walk(dir);
	return found.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

function codesign(args: string[]): void {
	const run = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
	if (run.status !== 0) fail(`codesign ${args.join(" ")} failed: ${run.stderr || run.error}`);
}

/** Sign `app` inside out with the identity `withSigningIdentity` hands over. */
export function signBundle(app: string, identity: string, keychain: string | null): void {
	const options = [
		"--force",
		"--options",
		"runtime",
		"--timestamp=none",
		"--entitlements",
		path.join(REPO_ROOT, "resources", "entitlements.mac.plist"),
		"--sign",
		identity,
		...(keychain ? ["--keychain", keychain] : []),
	];
	const contents = path.join(app, "Contents");
	const framework = path.join(contents, "Frameworks", bundle.FRAMEWORK);
	// Loose Mach-O files first (Node, the Rust binaries, agent-desktop, CEF's libraries), then the framework as a
	// bundle, the helper apps and the app. The framework's own executable is sealed by signing the framework.
	const frameworkExecutable = path.join(framework, "Versions", "A", "Chromium Embedded Framework");
	for (const dir of [path.join(contents, "Resources"), path.join(framework, "Versions", "A")]) {
		for (const file of machOFiles(dir)) if (file !== frameworkExecutable) codesign([...options, file]);
	}
	codesign([...options, framework]);
	for (const helper of bundle.HELPERS) {
		codesign([...options, path.join(contents, "Frameworks", `${bundle.PRODUCT} Helper${helper.suffix}.app`)]);
	}
	codesign([...options, app]);
	codesign(["--verify", "--deep", "--strict", "--verbose=2", app]);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (process.platform !== "darwin") fail("run this on a Mac (codesign, hdiutil)");
	const out = path.join(REPO_ROOT, "dist", "mac-arm64");
	const app = assembleBundle(REPO_ROOT, out);
	await afterPack({
		electronPlatformName: "darwin",
		appOutDir: out,
		packager: { appInfo: { productFilename: bundle.PRODUCT } },
	});
	await withSigningIdentity(({ identity, keychain }) => {
		signBundle(app, identity, keychain);
	});
	if (args.includes("--no-dmg")) return;
	// The legacy update feed (release.yml's LEGACY_UPDATE_FEED) also wants the ZIP.
	const targets = args.includes("--legacy-zip") ? ["dmg", "zip"] : ["dmg"];
	const builder = spawnSync(
		"bunx",
		["electron-builder", "--mac", ...targets, "--arm64", "--publish", "never", "--prepackaged", app],
		{ cwd: REPO_ROOT, stdio: "inherit" },
	);
	if (builder.status !== 0) fail("electron-builder failed");
}

if (import.meta.main) await main();
