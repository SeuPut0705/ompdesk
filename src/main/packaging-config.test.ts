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
import { REA_VERSION } from "../shared/builtin-mcp";
import { UPDATE_ASSETS } from "./update-release";

interface BuilderConfig {
	appId?: string;
	productName?: string;
	afterPack?: string;
	electronLanguages?: string[];
	extraResources?: { from: string; to: string }[];
	protocols?: { name: string; schemes?: string[] }[];
	mac?: {
		artifactName?: string;
		extendInfo?: Record<string, unknown>;
		target?: { target?: string; arch?: string[] }[];
	};
	dmg?: { artifactName?: string };
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

/** The directories a packaged app keeps Electron's locale files in, under `appOutDir`. */
const LOCALE_DIRS: Record<string, { dirs: string[]; ext: string }> = {
	darwin: {
		dirs: [
			"OMPdesk.app/Contents/Resources",
			"OMPdesk.app/Contents/Frameworks/Electron Framework.framework/Resources",
		],
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

	it("ships the built-in REA relay and declaration outside the asar on both platforms", () => {
		for (const file of ["electron-builder.yml", "electron-builder.win.yml"]) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			expect(config.extraResources, file).toContainEqual({ from: "resources/omp-builtin", to: "omp-builtin" });
			for (const name of [
				"rea/.mcp.json",
				"rea/rea-relay.mjs",
				"rea/rea-config.json",
				"rea/skills/reverse-engineer-anything/SKILL.md",
				"rea/skills/reverse-engineer-anything/LICENSE",
				"skills/ompdesk/SKILL.md",
			]) {
				expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/omp-builtin", name)), `${file} omits ${name}`).toBe(
					true,
				);
			}
		}
		const declaration: unknown = JSON.parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/rea/.mcp.json"), "utf8"),
		);
		expect(declaration).toEqual({
			mcpServers: { rea: { type: "stdio", command: "node", args: ["$" + "{OMP_PLUGIN_ROOT}/rea-relay.mjs"] } },
		});
	});

	it("keeps OMPdesk's own extension root to its skill, so loading it never starts REA", () => {
		// The control tools load `-e omp-builtin` on their own switch; REA is the separate `-e omp-builtin/rea`.
		const root = path.join(PACKAGE_ROOT, "resources/omp-builtin");
		expect(fs.readdirSync(root).sort()).toEqual(["rea", "skills"]);
		expect(fs.readdirSync(path.join(root, "skills"))).toEqual(["ompdesk"]);
		const skill = fs.readFileSync(path.join(root, "skills/ompdesk/SKILL.md"), "utf8");
		expect(skill).toMatch(/^---\nname: ompdesk\ndescription: \S/);
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
		for (const file of ["electron-builder.yml", "electron-builder.win.yml"]) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			expect(config.extraResources, file).toContainEqual({ from: "LICENSES", to: "LICENSES" });
			// No NOTICE file: the attribution of vendored code lives in THIRD_PARTY_NOTICES.txt.
			expect(config.extraResources, file).not.toContainEqual({ from: "NOTICE", to: "NOTICE" });
		}
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "NOTICE"))).toBe(false);
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "LICENSES/Apache-2.0.txt"))).toBe(true);
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "LICENSES/MIT-lobe-icons.txt"))).toBe(true);
		expect(fs.readdirSync(path.join(PACKAGE_ROOT, "src/renderer/assets/provider-marks")).length).toBeGreaterThan(0);
	});

	it("ships OMPdesk's MIT LICENSE and the generated third-party notices on both platforms", () => {
		for (const file of ["electron-builder.yml", "electron-builder.win.yml"]) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
				expect(config.extraResources, file).toContainEqual({ from: name, to: name });
				expect(fs.existsSync(path.join(PACKAGE_ROOT, name)), `${file}: ${name} is missing`).toBe(true);
			}
			// electron-builder leaves Chromium's notices out of a macOS bundle; Electron's MIT text and
			// Chromium's third-party licenses must travel with the app.
			expect(config.extraResources, file).toContainEqual({
				from: "node_modules/electron/dist/LICENSES.chromium.html",
				to: "LICENSES.chromium.html",
			});
			// No installer license page: the license ships as a file, not a click-through.
			expect(config.nsis, file).not.toHaveProperty("license");
		}
		const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			license?: string;
		};
		expect(manifest.license).toBe("MIT");
		expect(fs.readFileSync(path.join(PACKAGE_ROOT, "LICENSE"), "utf8")).toMatch(
			/^MIT License\n\nCopyright \(c\) 2026 SeuPut\n/,
		);
		const notices = fs.readFileSync(path.join(PACKAGE_ROOT, "THIRD_PARTY_NOTICES.txt"), "utf8");
		expect(notices).toContain("electron ");
		expect(notices).toContain("LICENSES.chromium.html");
		// The vendored code is credited here now that there is no NOTICE file.
		expect(notices).toContain("Mixdog (https://github.com/tribgames/mixdog)");
		expect(notices).toContain("LICENSES/Apache-2.0.txt");
		expect(notices).toContain("@lobehub/icons");
		expect(notices).toContain("LICENSES/MIT-lobe-icons.txt");
		expect(notices).toContain("reverse-engineer-anything skill from REA");
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "node_modules/electron/dist/LICENSES.chromium.html"))).toBe(true);
	});

	it("ships the shared auto-mode contract inside the bridge on macOS and Windows", () => {
		for (const file of ["electron-builder.yml", "electron-builder.win.yml"]) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			const bridge = config.extraResources?.find(resource => resource.to === "gui-bridge");
			expect(bridge?.from, file).toBe("resources/gui-bridge");
			const source = path.join(PACKAGE_ROOT, bridge?.from ?? "", "modes/auto-mode-contracts.ts");
			expect(fs.existsSync(source), `${file} omits modes/auto-mode-contracts.ts`).toBe(true);
			const core = fs.readFileSync(path.join(PACKAGE_ROOT, "resources/gui-bridge/modes/auto-mode-core.ts"), "utf8");
			expect(core).toContain('from "./auto-mode-contracts"');
			expect(fs.readFileSync(source, "utf8")).not.toMatch(/^\s*import\s/m);
		}
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
			await fakeLocales(directory, "darwin", ["en", "ko"]);
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

	it("keeps only Electron's en-US and ko locales on both platforms, and the package fails otherwise", async () => {
		for (const file of ["electron-builder.yml", "electron-builder.win.yml"]) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			// electron-builder keeps a file whose name equals a listed language or prefixes it: `en` alone matches
			// no `en-US.pak` and deleted all of them once (issue #12, a blank window on Windows).
			expect(config.electronLanguages, file).toEqual(["en-US", "ko"]);
			expect(config.afterPack, file).toBe("scripts/after-pack.cjs");
		}
		const afterPack = require(path.resolve(PACKAGE_ROOT, "scripts/after-pack.cjs")).afterPack as AfterPackHook;
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ompdesk-locales-"));
		const run = (platform: string) =>
			afterPack({
				electronPlatformName: platform,
				appOutDir: directory,
				packager: { appInfo: { productFilename: "OMPdesk" } },
			});
		try {
			await fakeLocales(directory, "win32", ["en-US", "ko"]);
			await expect(run("win32")).resolves.toBeUndefined();
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

	it("pins every action to a commit SHA", () => {
		for (const { name, text } of workflows) {
			for (const [, ref] of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
				// A reusable workflow of this repo is `./.github/workflows/<file>`: it runs at the caller's commit.
				if (ref?.startsWith("./.github/workflows/")) continue;
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
		expect(job?.if).toBe("inputs.installer_check");
		expect(job?.["runs-on"]).toBe("windows-latest");
		const runs = job?.steps.map(step => step.run ?? "").join("\n") ?? "";
		expect(runs).toContain("ompdesk-windows-setup.exe");
		for (const mode of ["silent", "ui", "legacy"]) {
			expect(runs).toContain(`scripts/windows-installer-check.ps1 -Setup ompdesk-windows-setup.exe -Mode ${mode}`);
		}
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "scripts/windows-installer-check.ps1"))).toBe(true);
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
		expect(job?.if).toBe("inputs.win_e2e");
		expect(job?.["runs-on"]).toBe("windows-latest");
		const manual = job?.steps.map(step => step.run ?? "") ?? [];
		expect(manual).toContain("bun scripts/omp-update-lock-check.ts");
		expect(manual.some(run => run.includes("bunx playwright test --grep"))).toBe(true);
		expect(job?.steps.some(step => step.with?.path?.includes("captures/"))).toBe(true);
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
