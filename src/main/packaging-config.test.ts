/**
 * Mac bundle config contract. Every mac variant ships its own electron-builder
 * file, so a key the built Info.plist depends on can exist in one and be missing
 * in another — which is how `omp://` deep links came to be dead code in every
 * installed build.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { type PlistObject, parsePlistFile, savePlistFile } from "app-builder-lib/out/util/plist";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { UPDATE_ASSETS } from "./update-release";

interface BuilderConfig {
	appId?: string;
	productName?: string;
	afterPack?: string;
	extraResources?: { from: string; to: string }[];
	protocols?: { name: string; schemes?: string[] }[];
	mac?: {
		artifactName?: string;
		extendInfo?: Record<string, unknown>;
		target?: { target?: string; arch?: string[] }[];
	};
	dmg?: { artifactName?: string };
	win?: { target?: { target?: string; arch?: string[] }[] };
	nsis?: { artifactName?: string };
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

const PRIVACY_KEYS = [
	"NSMicrophoneUsageDescription",
	"NSCameraUsageDescription",
	"NSBluetoothAlwaysUsageDescription",
	"NSBluetoothPeripheralUsageDescription",
];

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

	it("ships the gui-bridge extension outside the asar", () => {
		const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "electron-builder.yml"), "utf8")) as BuilderConfig;
		expect(config.extraResources).toContainEqual({ from: "resources/gui-bridge", to: "gui-bridge" });
	});

	it("registers the omp:// scheme that src/main/deep-link.ts handles", () => {
		for (const { file, config } of configs) {
			const schemes = (config.protocols ?? []).flatMap(protocol => protocol.schemes ?? []);
			expect(schemes, `${file} ships no URL scheme`).toContain("omp");
		}
	});

	it("names the app in every privacy prompt the bundle can trigger", () => {
		for (const { file, config } of configs) {
			const info = config.mac?.extendInfo ?? {};
			for (const key of PRIVACY_KEYS) {
				const value = info[key];
				// Electron's own default reads "This app needs access to the camera":
				// a prompt that names no product and claims a capability OMPdesk never uses.
				const namesApp = typeof value === "string" && /\bOMPdesk\b/.test(value);
				expect(namesApp, `${file} → ${key}`).toBe(true);
			}
		}
	});

	it("ships an explicit transport policy that leaves ATS on and excepts loopback", () => {
		for (const { file, config } of configs) {
			const info = config.mac?.extendInfo ?? {};
			// A stray NSAllowsArbitraryLoads in any variant turns TLS enforcement
			// off app-wide; the stats server is the only cleartext origin, and it is
			// local. Pin both halves instead of trusting the default.
			expect(info.NSAppTransportSecurity, `${file} declares no transport policy`).toMatchObject({
				NSAllowsArbitraryLoads: false,
				NSAllowsLocalNetworking: true,
			});
		}
	});

	it("restores ATS in the completed bundle after electron-builder enables arbitrary loads", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-bundle-policy-"));
		const plistPath = path.join(directory, "OMPdesk.app", "Contents", "Info.plist");
		const loopback = { NSExceptionAllowsInsecureHTTPLoads: true };
		const original: PlistObject = {
			CFBundleIdentifier: "com.seuput.ompdesk",
			CFBundleURLTypes: [{ CFBundleURLSchemes: ["omp"] }],
			NSAppTransportSecurity: {
				NSAllowsArbitraryLoads: true,
				NSAllowsLocalNetworking: true,
				NSExceptionDomains: { localhost: loopback, "127.0.0.1": loopback },
			},
		};
		try {
			await fs.promises.mkdir(path.dirname(plistPath), { recursive: true });
			for (const { file, config } of configs) {
				await savePlistFile(plistPath, original);
				const hookPath = config.afterPack;
				expect(hookPath, `${file} declares no afterPack policy hook`).toBe("scripts/after-pack.cjs");
				if (!hookPath) continue;
				const afterPack = require(path.resolve(PACKAGE_ROOT, hookPath)).afterPack as AfterPackHook;
				await afterPack({
					electronPlatformName: "darwin",
					appOutDir: directory,
					packager: { appInfo: { productFilename: config.productName ?? "" } },
				});
				expect(await parsePlistFile(plistPath), `${file} leaves arbitrary loads enabled in the bundle`).toEqual({
					...original,
					NSAppTransportSecurity: {
						NSAllowsArbitraryLoads: false,
						NSAllowsLocalNetworking: true,
						NSExceptionDomains: { localhost: loopback, "127.0.0.1": loopback },
					},
				});
			}
		} finally {
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
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
});
