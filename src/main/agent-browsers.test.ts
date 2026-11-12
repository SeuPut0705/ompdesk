/**
 * Which Chromium browsers this computer has and whether each one's own copy of the omp Browser Relay extension is
 * loaded in one of its profiles, over a temp HOME with fake bundles and preference files; and the install that binds
 * a copy to its browser's own relay port. Every case runs through the core process
 * (`native/ompdesk/crates/core/src/browsers/`): the relays are loopback servers of this test and omp is a stand-in
 * executable the core runs. Binding the port alone is a Rust table (`browsers/captured.json`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROMIUM_BROWSER_IDS, type ChromiumBrowserId } from "../shared/default-browser";
import {
	type BrowserPlaces,
	detectChromiumBrowsers,
	findChromiumBrowsers,
	installRelayExtension,
} from "./agent-browsers";
import { CoreProcess } from "./core/process";
import type { OmpRuntime } from "./local/types";
import { nativeBinPath } from "./native-bin";

let root: string;
let home: string;
const servers: Server[] = [];

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
/** Where `id`'s own copy lives, as a profile records loading it. */
const relayExtensionDir = (id: ChromiumBrowserId) => join(home, ".omp", "browser-relay", `extension-${id}`);

/** A loopback relay answering `/json/version` with `status`; `asked` counts the asks. */
async function relay(status: number): Promise<{ port: number; asked: () => number }> {
	let asked = 0;
	const server = createServer((request, response) => {
		if (request.url === "/json/version") asked += 1;
		response.writeHead(status).end("{}");
	});
	servers.push(server);
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", resolve);
	await promise;
	return { port: (server.address() as AddressInfo).port, asked: () => asked };
}

/** Every browser's relay port at one relay still waiting for its extension (503): never connected. */
async function waiting(): Promise<Record<ChromiumBrowserId, number>> {
	const { port } = await relay(503);
	return Object.fromEntries(CHROMIUM_BROWSER_IDS.map(id => [id, port])) as Record<ChromiumBrowserId, number>;
}

/** Whether `id`, installed in `places`, has a profile that loaded its own copy. */
async function loaded(id: ChromiumBrowserId, places: BrowserPlaces = mac()): Promise<boolean> {
	const browsers = await detectChromiumBrowsers(places, await waiting());
	return browsers.find(browser => browser.id === id)?.relayInstalled ?? false;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agent-browsers-"));
	home = join(root, "home");
	mkdirSync(home, { recursive: true });
});
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
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
		place(join(support("Google", "Chrome"), "Default", "Preferences"), prefsNaming(relayExtensionDir("chrome")));
		// Edge loaded Chrome's copy, Brave loaded the old shared folder: neither is its own copy.
		place(join(support("Microsoft Edge"), "Default", "Preferences"), prefsNaming(relayExtensionDir("chrome")));
		place(
			join(support("BraveSoftware", "Brave-Browser"), "Default", "Preferences"),
			prefsNaming(join(home, ".omp", "browser-relay", "extension")),
		);
		expect(await detectChromiumBrowsers(mac(), await waiting())).toEqual([
			{ id: "chrome", name: "Google Chrome", relayInstalled: true, relayConnected: false },
			{ id: "edge", name: "Microsoft Edge", relayInstalled: false, relayConnected: false },
			{ id: "brave", name: "Brave", relayInstalled: false, relayConnected: false },
		]);
	});

	it("does not take Chrome's folder for Chromium's, whose name begins with it", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		const data = support("Google", "Chrome");
		place(join(data, "Default", "Preferences"), prefsNaming(relayExtensionDir("chromium")));
		expect(await loaded("chrome")).toBe(false);
		place(join(data, "Default", "Secure Preferences"), prefsNaming(relayExtensionDir("chrome")));
		expect(await loaded("chrome")).toBe(true);
	});

	it("probes the connection of an installed copy at its own port, and only of an installed one", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		place(join(root, "Applications", "Microsoft Edge.app"));
		place(join(support("Google", "Chrome"), "Default", "Preferences"), prefsNaming(relayExtensionDir("chrome")));
		const chrome = await relay(200);
		const others = await relay(200);
		const ports = { ...(await waiting()), edge: others.port, brave: others.port, chrome: chrome.port };
		const browsers = await detectChromiumBrowsers(mac(), ports);
		expect([chrome.asked(), others.asked()]).toEqual([1, 0]);
		expect(browsers.map(browser => [browser.id, browser.relayInstalled, browser.relayConnected])).toEqual([
			["chrome", true, true],
			["edge", false, false],
		]);
	});

	it("is not installed without any profile files", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		expect(await detectChromiumBrowsers(mac(), await waiting())).toEqual([
			{ id: "chrome", name: "Google Chrome", relayInstalled: false, relayConnected: false },
		]);
	});

	it("reads the profiles Local State lists, and Secure Preferences too", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		const data = support("Google", "Chrome");
		place(join(data, "Local State"), JSON.stringify({ profile: { info_cache: { Default: {}, "Profile 2": {} } } }));
		place(join(data, "Default", "Preferences"), "{}");
		place(join(data, "Profile 2", "Secure Preferences"), prefsNaming(relayExtensionDir("chrome")));
		expect(await loaded("chrome")).toBe(true);
	});

	it("looks in Default when Local State is missing or has no profile list, and ignores profiles it does not list", async () => {
		place(join(root, "Applications", "Google Chrome.app"));
		place(join(root, "Applications", "Brave Browser.app"));
		const data = support("Google", "Chrome");
		place(join(data, "Local State"), "not json");
		place(join(data, "Default", "Preferences"), relayExtensionDir("chrome"));
		expect(await loaded("chrome")).toBe(true);

		const other = support("BraveSoftware", "Brave-Browser");
		place(join(other, "Local State"), JSON.stringify({ profile: { info_cache: { Default: {} } } }));
		place(join(other, "Default", "Preferences"), "{}");
		place(join(other, "Profile 9", "Preferences"), relayExtensionDir("brave"));
		expect(await loaded("brave")).toBe(false);
	});

	it("matches a Windows path as JSON escapes it", async () => {
		// The core joins with this host's separator: on Windows the folder holds `\`, which the file escapes.
		const localAppData = join(root, "Local");
		const programFiles = join(root, "Program Files");
		place(join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"), "");
		place(
			join(localAppData, "Microsoft", "Edge", "User Data", "Default", "Preferences"),
			JSON.stringify({ path: relayExtensionDir("edge") }),
		);
		const places: BrowserPlaces = { platform: "win32", home, appDirs: [], programDirs: [programFiles], localAppData };
		expect(await loaded("edge", places)).toBe(true);
	});
});

describe("installRelayExtension", () => {
	const STOCK_FILES: Record<string, string> = {
		"background.js": "var DEFAULT_PORT = 9224;\nconst stored = { port: DEFAULT_PORT };\n",
		"options.js": "const DEFAULT_PORT = 9224;\n",
		"manifest.json": '{"name":"OMP Browser Relay"}',
	};

	/** What the stand-in omp runs: it records its arguments and, when it succeeds, writes the files to `--dir`. */
	const FAKE_OMP = `const fs = require("node:fs");
const path = require("node:path");
const [spec, ...argv] = process.argv.slice(2);
const { files, code, stderr, calls } = JSON.parse(fs.readFileSync(spec, "utf8"));
fs.appendFileSync(calls, JSON.stringify(argv) + "\\n");
if (code === 0) {
	const dir = argv[argv.indexOf("--dir") + 1];
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}
process.stderr.write(stderr, () => process.exit(code));
`;

	let made = 0;

	/** A stock omp whose `browser-relay install --dir <dir>` writes `files` there; `calls` reads its argument lists. */
	function runtime(
		files: Record<string, string>,
		result: { code?: number; stderr?: string } = {},
	): { omp: OmpRuntime; calls: () => string[][] } {
		made += 1;
		const dir = join(root, `omp-${made}`);
		mkdirSync(dir, { recursive: true });
		const script = join(dir, "omp.cjs");
		const spec = join(dir, "spec.json");
		const calls = join(dir, "calls.jsonl");
		writeFileSync(script, FAKE_OMP);
		writeFileSync(spec, JSON.stringify({ files, code: result.code ?? 0, stderr: result.stderr ?? "", calls }));
		const node = process.execPath;
		const bin = join(dir, process.platform === "win32" ? "omp.cmd" : "omp");
		if (process.platform === "win32") writeFileSync(bin, `@"${node}" "${script}" "${spec}" %*\r\n`);
		else writeFileSync(bin, `#!/bin/sh\nexec "${node}" "${script}" "${spec}" "$@"\n`, { mode: 0o755 });
		const omp: OmpRuntime = {
			bin,
			version: "18.12.6",
			run: async () => {
				throw new Error("the core process runs omp");
			},
		};
		const read = () =>
			existsSync(calls)
				? readFileSync(calls, "utf8")
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line) as string[])
				: [];
		return { omp, calls: read };
	}

	it("writes the browser's own copy with its own port in both files, and nothing else changed", async () => {
		const { omp, calls } = runtime(STOCK_FILES);
		const dir = await installRelayExtension(omp, "edge", home);
		expect(dir).toBe(join(home, ".omp", "browser-relay", "extension-edge"));
		expect(calls()).toHaveLength(1);
		expect(calls()[0]?.slice(0, 3)).toEqual(["browser-relay", "install", "--dir"]);
		expect(readFileSync(join(dir, "background.js"), "utf8")).toBe(
			"var DEFAULT_PORT = 9232;\nconst stored = { port: DEFAULT_PORT };\n",
		);
		expect(readFileSync(join(dir, "options.js"), "utf8")).toBe("const DEFAULT_PORT = 9232;\n");
		expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(STOCK_FILES["manifest.json"]);
		// The staging folder is gone, and another browser's copy is its own.
		expect(existsSync(`${dir}.new`)).toBe(false);
		expect(existsSync(relayExtensionDir("chrome"))).toBe(false);
	});

	it("rebinds an earlier copy in place", async () => {
		await installRelayExtension(runtime(STOCK_FILES).omp, "chrome", home);
		const dir = await installRelayExtension(runtime(STOCK_FILES).omp, "chrome", home);
		expect(readFileSync(join(dir, "background.js"), "utf8")).toContain("DEFAULT_PORT = 9231;");
	});

	it("fails when stock's asset cannot be bound, leaving no unbound copy", async () => {
		const changed = { ...STOCK_FILES, "background.js": "const port = 9224;\n" };
		await expect(installRelayExtension(runtime(changed).omp, "chrome", home)).rejects.toThrow(
			"background.js has no single DEFAULT_PORT",
		);
		expect(existsSync(relayExtensionDir("chrome"))).toBe(false);
		expect(existsSync(`${relayExtensionDir("chrome")}.new`)).toBe(false);
	});

	it("fails with omp's own words", async () => {
		await expect(
			installRelayExtension(runtime({}, { code: 1, stderr: "disk full\n" }).omp, "chrome", home),
		).rejects.toThrow("disk full");
		expect(existsSync(relayExtensionDir("chrome"))).toBe(false);
	});
});

describe.runIf(process.platform === "win32")("openExtensionsPage on Windows", () => {
	it("starts the browser outside the core's job and off its pipes: it outlives the core, and main sees the core end", async () => {
		// The browser's stand-in: node running a script that writes its pid and stays (60 s at most).
		const script = join(root, "browser.cjs");
		const pidFile = join(root, "browser.pid");
		writeFileSync(
			script,
			`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000);`,
		);
		const core = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core"), log: () => {} });
		let browser = 0;
		try {
			await core.call("browsers.openExtensions", { app: process.execPath, url: script });
			browser = await vi.waitFor(() => Number(readFileSync(pidFile, "utf8")), { timeout: 10_000 });
			const first = core.pid as number;
			// Rejected only by the core's `close`: a core whose pipes the browser held would end this in a timeout.
			const waiting = core.call("core.echo", { waitFor: "never" }, { timeoutMs: 5_000 });
			process.kill(first, "SIGKILL");
			await expect(waiting).rejects.toMatchObject({ code: "core_exited" });
			const again = await core.call<{ value: unknown }>("core.echo", { value: 2 }, { timeoutMs: 5_000 });
			expect(again.result.value).toBe(2);
			expect(core.pid).not.toBe(first);
			expect(() => process.kill(browser, 0)).not.toThrow();
		} finally {
			if (browser) process.kill(browser);
			await core.stop();
		}
	});
});
