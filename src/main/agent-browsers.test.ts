/**
 * Which Chromium browsers this computer has and whether each one's own copy of the omp Browser Relay extension is
 * loaded in one of its profiles (src/main/agent-browsers.ts), over a temp HOME with fake bundles and preference
 * files; and the install that binds a copy to its browser's own relay port.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BrowserPlaces,
	bindExtensionPort,
	detectChromiumBrowsers,
	findChromiumBrowsers,
	installRelayExtension,
	relayExtensionDir,
	relayLoadedIn,
} from "./agent-browsers";
import type { OmpRuntime } from "./local/types";

let root: string;
let home: string;

function place(path: string, content?: string): void {
	if (content === undefined) {
		mkdirSync(path, { recursive: true });
		return;
	}
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

const mac = (): BrowserPlaces => ({
	platform: "darwin",
	home,
	appDirs: [join(root, "Applications"), join(home, "Applications")],
	programDirs: [],
	localAppData: join(home, "AppData", "Local"),
});

const support = (...parts: string[]) => join(home, "Library", "Application Support", ...parts);
const prefsNaming = (dir: string) => JSON.stringify({ extensions: { settings: { abc: { path: dir } } } });
const never = async () => false;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agent-browsers-"));
	home = join(root, "home");
	mkdirSync(home, { recursive: true });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("findChromiumBrowsers", () => {
	it("lists the installed bundles from /Applications-style folders and ~/Applications, in auto order", async () => {
		place(join(home, "Applications", "Brave Browser.app"));
		place(join(root, "Applications", "Microsoft Edge.app"));
		place(join(root, "Applications", "Google Chrome.app"));
		place(join(root, "Applications", "Safari.app"));
		const found = await findChromiumBrowsers(mac());
		expect(found.map(browser => [browser.id, browser.name])).toEqual([
			["chrome", "Google Chrome"],
			["edge", "Microsoft Edge"],
			["brave", "Brave"],
		]);
		expect(found[0]?.app).toBe(join(root, "Applications", "Google Chrome.app"));
		expect(found[0]?.dataDir).toBe(support("Google", "Chrome"));
		expect(found.map(browser => browser.extensionsUrl)).toEqual([
			"chrome://extensions",
			"edge://extensions",
			"brave://extensions",
		]);
	});

	it("knows Arc and Chromium by their own bundles and data folders", async () => {
		place(join(root, "Applications", "Arc.app"));
		place(join(root, "Applications", "Chromium.app"));
		const found = await findChromiumBrowsers(mac());
		expect(found.map(browser => [browser.id, browser.dataDir, browser.extensionsUrl])).toEqual([
			["arc", support("Arc", "User Data"), "arc://extensions"],
			["chromium", support("Chromium"), "chrome://extensions"],
		]);
	});

	it("finds nothing on a machine without them", async () => {
		expect(await findChromiumBrowsers(mac())).toEqual([]);
	});

	it("reads Windows install folders (Program Files, LocalAppData) and skips Arc, which has none", async () => {
		const programFiles = join(root, "Program Files");
		const localAppData = join(root, "Local");
		place(join(programFiles, "Google", "Chrome", "Application", "chrome.exe"), "");
		place(join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"), "");
		place(join(programFiles, "Arc.app"));
		const found = await findChromiumBrowsers({
			platform: "win32",
			home,
			appDirs: [],
			programDirs: [programFiles, localAppData],
			localAppData,
		});
		expect(found.map(browser => [browser.id, browser.dataDir])).toEqual([
			["chrome", join(localAppData, "Google", "Chrome", "User Data")],
			["edge", join(localAppData, "Microsoft", "Edge", "User Data")],
		]);
	});
});

describe("relay extension detection", () => {
	it("keys the extension by browser: each browser needs a profile naming its own folder", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		place(join(root, "Applications", "Microsoft Edge.app"));
		place(join(root, "Applications", "Brave Browser.app"));
		place(
			join(support("Google", "Chrome"), "Default", "Preferences"),
			prefsNaming(relayExtensionDir("chrome", home)),
		);
		// Edge loaded Chrome's copy, Brave loaded the old shared folder: neither is its own copy.
		place(join(support("Microsoft Edge"), "Default", "Preferences"), prefsNaming(relayExtensionDir("chrome", home)));
		place(
			join(support("BraveSoftware", "Brave-Browser"), "Default", "Preferences"),
			prefsNaming(join(home, ".omp", "browser-relay", "extension")),
		);
		expect(await detectChromiumBrowsers(mac(), never)).toEqual([
			{ id: "chrome", name: "Google Chrome", relayInstalled: true, relayConnected: false },
			{ id: "edge", name: "Microsoft Edge", relayInstalled: false, relayConnected: false },
			{ id: "brave", name: "Brave", relayInstalled: false, relayConnected: false },
		]);
	});

	it("does not take Chrome's folder for Chromium's, whose name begins with it", async () => {
		const data = support("Google", "Chrome");
		place(join(data, "Default", "Preferences"), prefsNaming(relayExtensionDir("chromium", home)));
		expect(await relayLoadedIn(data, relayExtensionDir("chrome", home))).toBe(false);
		place(join(data, "Default", "Secure Preferences"), prefsNaming(relayExtensionDir("chrome", home)));
		expect(await relayLoadedIn(data, relayExtensionDir("chrome", home))).toBe(true);
	});

	it("probes the connection of an installed copy at its own port, and only of an installed one", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		place(join(root, "Applications", "Microsoft Edge.app"));
		place(
			join(support("Google", "Chrome"), "Default", "Preferences"),
			prefsNaming(relayExtensionDir("chrome", home)),
		);
		const probed: number[] = [];
		const browsers = await detectChromiumBrowsers(mac(), async port => {
			probed.push(port);
			return port === 9231;
		});
		expect(probed).toEqual([9231]);
		expect(browsers.map(browser => [browser.id, browser.relayInstalled, browser.relayConnected])).toEqual([
			["chrome", true, true],
			["edge", false, false],
		]);
	});

	it("is not installed without any profile files", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		expect(await detectChromiumBrowsers(mac(), never)).toEqual([
			{ id: "chrome", name: "Google Chrome", relayInstalled: false, relayConnected: false },
		]);
	});

	it("reads the profiles Local State lists, and Secure Preferences too", async () => {
		const data = support("Google", "Chrome");
		const dir = relayExtensionDir("chrome", home);
		place(join(data, "Local State"), JSON.stringify({ profile: { info_cache: { Default: {}, "Profile 2": {} } } }));
		place(join(data, "Default", "Preferences"), "{}");
		place(join(data, "Profile 2", "Secure Preferences"), prefsNaming(dir));
		expect(await relayLoadedIn(data, dir)).toBe(true);
	});

	it("looks in Default when Local State is missing or has no profile list, and ignores profiles it does not list", async () => {
		const data = support("Google", "Chrome");
		const dir = relayExtensionDir("chrome", home);
		place(join(data, "Local State"), "not json");
		place(join(data, "Default", "Preferences"), dir);
		expect(await relayLoadedIn(data, dir)).toBe(true);

		const other = support("BraveSoftware", "Brave-Browser");
		place(join(other, "Local State"), JSON.stringify({ profile: { info_cache: { Default: {} } } }));
		place(join(other, "Default", "Preferences"), "{}");
		place(join(other, "Profile 9", "Preferences"), dir);
		expect(await relayLoadedIn(other, dir)).toBe(false);
	});

	it("matches a Windows path as JSON escapes it", async () => {
		const data = join(root, "User Data");
		const dir = "C:\\Users\\me\\.omp\\browser-relay\\extension-edge";
		place(join(data, "Default", "Preferences"), JSON.stringify({ path: dir }));
		expect(await relayLoadedIn(data, dir)).toBe(true);
	});
});

describe("bindExtensionPort", () => {
	it("sets the one DEFAULT_PORT declaration, whichever keyword stock uses", () => {
		expect(bindExtensionPort("var DEFAULT_PORT = 9224;\nuse(DEFAULT_PORT);", 9231, "background.js")).toBe(
			"var DEFAULT_PORT = 9231;\nuse(DEFAULT_PORT);",
		);
		expect(bindExtensionPort("const DEFAULT_PORT = 9224;", 9232, "options.js")).toBe("const DEFAULT_PORT = 9232;");
	});

	it("fails clearly when stock's asset has none or several, instead of leaving it unbound", () => {
		expect(() => bindExtensionPort("const PORT = 9224;", 9231, "background.js")).toThrow(
			"background.js has no single DEFAULT_PORT",
		);
		expect(() => bindExtensionPort("var DEFAULT_PORT = 1;\nvar DEFAULT_PORT = 2;", 9231, "options.js")).toThrow(
			"options.js has no single DEFAULT_PORT",
		);
	});
});

describe("installRelayExtension", () => {
	const STOCK_FILES: Record<string, string> = {
		"background.js": "var DEFAULT_PORT = 9224;\nconst stored = { port: DEFAULT_PORT };\n",
		"options.js": "const DEFAULT_PORT = 9224;\n",
		"manifest.json": '{"name":"OMP Browser Relay"}',
	};

	/** A stock omp whose `browser-relay install --dir <dir>` writes `files` there. */
	const runtime = (
		files: Record<string, string>,
		calls: string[][],
		result: { code?: number; stderr?: string } = {},
	): OmpRuntime => ({
		bin: "omp",
		version: "18.12.6",
		run: async args => {
			calls.push(args);
			const dir = args[args.indexOf("--dir") + 1] ?? "";
			if ((result.code ?? 0) === 0) for (const [name, text] of Object.entries(files)) place(join(dir, name), text);
			return { code: result.code ?? 0, stdout: "", stderr: result.stderr ?? "" };
		},
	});

	it("writes the browser's own copy with its own port in both files, and nothing else changed", async () => {
		const calls: string[][] = [];
		const dir = await installRelayExtension(runtime(STOCK_FILES, calls), "edge", home);
		expect(dir).toBe(join(home, ".omp", "browser-relay", "extension-edge"));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(0, 3)).toEqual(["browser-relay", "install", "--dir"]);
		expect(readFileSync(join(dir, "background.js"), "utf8")).toBe(
			"var DEFAULT_PORT = 9232;\nconst stored = { port: DEFAULT_PORT };\n",
		);
		expect(readFileSync(join(dir, "options.js"), "utf8")).toBe("const DEFAULT_PORT = 9232;\n");
		expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(STOCK_FILES["manifest.json"]);
		// The staging folder is gone, and another browser's copy is its own.
		expect(existsSync(`${dir}.new`)).toBe(false);
		expect(existsSync(relayExtensionDir("chrome", home))).toBe(false);
	});

	it("rebinds an earlier copy in place", async () => {
		await installRelayExtension(runtime(STOCK_FILES, []), "chrome", home);
		const dir = await installRelayExtension(runtime(STOCK_FILES, []), "chrome", home);
		expect(readFileSync(join(dir, "background.js"), "utf8")).toContain("DEFAULT_PORT = 9231;");
	});

	it("fails when stock's asset cannot be bound, leaving no unbound copy", async () => {
		const changed = { ...STOCK_FILES, "background.js": "const port = 9224;\n" };
		await expect(installRelayExtension(runtime(changed, []), "chrome", home)).rejects.toThrow(
			"background.js has no single DEFAULT_PORT",
		);
		expect(existsSync(relayExtensionDir("chrome", home))).toBe(false);
		expect(existsSync(`${relayExtensionDir("chrome", home)}.new`)).toBe(false);
	});

	it("fails with omp's own words", async () => {
		await expect(
			installRelayExtension(runtime({}, [], { code: 1, stderr: "disk full\n" }), "chrome", home),
		).rejects.toThrow("disk full");
		expect(existsSync(relayExtensionDir("chrome", home))).toBe(false);
	});
});
