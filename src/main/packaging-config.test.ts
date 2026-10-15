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
				".mcp.json",
				"rea-relay.mjs",
				"rea-config.json",
				"skills/reverse-engineer-anything/SKILL.md",
				"skills/reverse-engineer-anything/LICENSE",
			]) {
				expect(fs.existsSync(path.join(PACKAGE_ROOT, "resources/omp-builtin", name)), `${file} omits ${name}`).toBe(
					true,
				);
			}
		}
		const declaration: unknown = JSON.parse(
			fs.readFileSync(path.join(PACKAGE_ROOT, "resources/omp-builtin/.mcp.json"), "utf8"),
		);
		expect(declaration).toEqual({
			mcpServers: { rea: { type: "stdio", command: "node", args: ["$" + "{OMP_PLUGIN_ROOT}/rea-relay.mjs"] } },
		});
	});

	it("vendors REA's skill from the pinned REA release (bun run sync:rea-skill after a bump)", () => {
		const skill = fs.readFileSync(
			path.join(PACKAGE_ROOT, "resources/omp-builtin/skills/reverse-engineer-anything/SKILL.md"),
			"utf8",
		);
		expect(skill).toMatch(/^---\nname: reverse-engineer-anything\ndescription: \S/);
		// Upstream's own commands name the release the skill was generated for.
		const releases = new Set(Array.from(skill.matchAll(/rea-agents@(\d+\.\d+\.\d+)/g), match => match[1]));
		expect([...releases]).toEqual([REA_VERSION]);
	});

	it("ships the third-party NOTICE and the license texts it names on both platforms", () => {
		for (const file of ["electron-builder.yml", "electron-builder.win.yml"]) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			expect(config.extraResources, file).toContainEqual({ from: "NOTICE", to: "NOTICE" });
			expect(config.extraResources, file).toContainEqual({ from: "LICENSES", to: "LICENSES" });
		}
		const notice = fs.readFileSync(path.join(PACKAGE_ROOT, "NOTICE"), "utf8");
		expect(notice).toContain("LICENSES/Apache-2.0.txt");
		expect(fs.existsSync(path.join(PACKAGE_ROOT, "LICENSES/Apache-2.0.txt"))).toBe(true);
	});

	it("ships the shared pool contract inside the bridge on macOS and Windows", () => {
		for (const file of ["electron-builder.yml", "electron-builder.win.yml"]) {
			const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
			const bridge = config.extraResources?.find(resource => resource.to === "gui-bridge");
			expect(bridge?.from, file).toBe("resources/gui-bridge");
			const source = path.join(PACKAGE_ROOT, bridge?.from ?? "", "pool-contracts.ts");
			expect(fs.existsSync(source), `${file} omits pool-contracts.ts`).toBe(true);
			const core = fs.readFileSync(path.join(PACKAGE_ROOT, "resources/gui-bridge/modes/pool-core.ts"), "utf8");
			expect(core).toContain('from "../pool-contracts"');
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
