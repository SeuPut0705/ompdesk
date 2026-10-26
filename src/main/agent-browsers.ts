/**
 * The browsers the Default browser setting can point agents at, as this computer has them: ego-browser (ego lite;
 * looked up on the spawn PATH like `resolveBin`, plus `~/.local/bin`, where ego's installer puts it) and the Chromium
 * browsers in their standard install places, each with whether the omp Browser Relay extension is loaded in one of
 * its profiles (stock's `omp browser-relay install` writes it; Chrome forbids installing it for the user).
 */
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "original-fs";
import {
	type AgentBrowserStatus,
	CHROMIUM_BROWSER_IDS,
	CHROMIUM_BROWSER_NAMES,
	CHROMIUM_RELAY_PORTS,
	type ChromiumBrowserId,
	type InstalledBrowser,
} from "../shared/default-browser";
import type { OmpRuntime } from "./local/types";
import { spawnPath } from "./shell-env";
import { findOnPath } from "./spawn";

const BIN = "ego-browser";

let cachedEgo: Promise<string | null> | null = null;

/** Absolute path to `ego-browser`, or null when not installed. Found once per launch; a miss is re-probed next call. */
export function resolveEgoBrowser(): Promise<string | null> {
	if (!cachedEgo) {
		const platform = process.platform;
		const names = platform === "win32" ? [`${BIN}.exe`, `${BIN}.cmd`, BIN] : [BIN];
		const localBin = join(homedir(), ".local", "bin");
		const pending = spawnPath().then(pathEnv =>
			findOnPath(
				names,
				pathEnv,
				platform,
				names.map(name => join(localBin, name)),
			),
		);
		cachedEgo = pending;
		void pending.then(
			bin => {
				if (!bin && cachedEgo === pending) cachedEgo = null;
			},
			() => {
				if (cachedEgo === pending) cachedEgo = null;
			},
		);
	}
	return cachedEgo;
}

export async function egoBrowserInstalled(): Promise<boolean> {
	return (await resolveEgoBrowser().catch(() => null)) !== null;
}

/** Where the machine keeps things; a test points these at a temp folder. */
export interface BrowserPlaces {
	platform: NodeJS.Platform;
	home: string;
	/** macOS folders holding `.app` bundles. */
	appDirs: readonly string[];
	/** Windows `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%` roots for installed exes. */
	programDirs: readonly string[];
	/** Windows `%LOCALAPPDATA%`. */
	localAppData: string;
}

export function systemBrowserPlaces(): BrowserPlaces {
	const home = homedir();
	const env = process.env;
	const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
	return {
		platform: process.platform,
		home,
		appDirs: ["/Applications", join(home, "Applications")],
		programDirs: [env.ProgramFiles, env["ProgramFiles(x86)"], localAppData].filter(
			(dir): dir is string => typeof dir === "string" && dir.length > 0,
		),
		localAppData,
	};
}

interface ChromiumDefinition {
	/** macOS bundle name. */
	app?: string;
	/** Windows exe under a program folder. */
	exe?: string;
	/** User data folder under `~/Library/Application Support` (macOS) or `%LOCALAPPDATA%` (Windows). */
	data: { mac: string; win?: string };
	/** The scheme its extensions page answers to. */
	scheme: string;
}

const DEFINITIONS: Record<ChromiumBrowserId, ChromiumDefinition> = {
	chrome: {
		app: "Google Chrome.app",
		exe: join("Google", "Chrome", "Application", "chrome.exe"),
		data: { mac: join("Google", "Chrome"), win: join("Google", "Chrome", "User Data") },
		scheme: "chrome",
	},
	edge: {
		app: "Microsoft Edge.app",
		exe: join("Microsoft", "Edge", "Application", "msedge.exe"),
		data: { mac: "Microsoft Edge", win: join("Microsoft", "Edge", "User Data") },
		scheme: "edge",
	},
	brave: {
		app: "Brave Browser.app",
		exe: join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		data: { mac: join("BraveSoftware", "Brave-Browser"), win: join("BraveSoftware", "Brave-Browser", "User Data") },
		scheme: "brave",
	},
	// Arc ships as a Store app on Windows, with no standard install place to look in.
	arc: { app: "Arc.app", data: { mac: join("Arc", "User Data") }, scheme: "arc" },
	chromium: {
		app: "Chromium.app",
		exe: join("Chromium", "Application", "chrome.exe"),
		data: { mac: "Chromium", win: join("Chromium", "User Data") },
		scheme: "chrome",
	},
};

/** A Chromium browser found on disk: what the launch and the relay check need. */
export interface FoundBrowser {
	id: ChromiumBrowserId;
	name: string;
	/** The `.app` bundle (macOS) or the exe (Windows). */
	app: string;
	dataDir: string;
	extensionsUrl: string;
}

async function isPath(file: string): Promise<boolean> {
	return fs.stat(file).then(
		() => true,
		() => false,
	);
}

async function findBrowser(id: ChromiumBrowserId, places: BrowserPlaces): Promise<FoundBrowser | undefined> {
	const def = DEFINITIONS[id];
	let app: string | undefined;
	let dataDir: string | undefined;
	if (places.platform === "darwin" && def.app) {
		for (const dir of places.appDirs) {
			if (await isPath(join(dir, def.app))) {
				app = join(dir, def.app);
				break;
			}
		}
		dataDir = join(places.home, "Library", "Application Support", def.data.mac);
	} else if (places.platform === "win32" && def.exe && def.data.win) {
		for (const dir of places.programDirs) {
			if (await isPath(join(dir, def.exe))) {
				app = join(dir, def.exe);
				break;
			}
		}
		dataDir = join(places.localAppData, def.data.win);
	}
	if (!app || !dataDir) return undefined;
	return { id, name: CHROMIUM_BROWSER_NAMES[id], app, dataDir, extensionsUrl: `${def.scheme}://extensions` };
}

/**
 * Where `id`'s own copy of the relay extension lives, and where Chrome's profile records loading it from. One copy per
 * browser, each bound to its own port: another browser's copy never counts for this one.
 */
export function relayExtensionDir(id: ChromiumBrowserId, home: string = homedir()): string {
	return join(home, ".omp", "browser-relay", `extension-${id}`);
}

async function readText(file: string): Promise<string> {
	return fs.readFile(file, "utf8").catch(() => "");
}

/** The profile folders of a user data dir: `Local State`'s list, else `Default`. */
async function profileDirs(dataDir: string): Promise<string[]> {
	try {
		const state: unknown = JSON.parse(await readText(join(dataDir, "Local State")));
		const profile = typeof state === "object" && state !== null && "profile" in state ? state.profile : undefined;
		const cache =
			typeof profile === "object" && profile !== null && "info_cache" in profile ? profile.info_cache : undefined;
		if (typeof cache === "object" && cache !== null) {
			const names = Object.keys(cache);
			if (names.length > 0) return names.map(name => join(dataDir, name));
		}
	} catch {
		// No usable Local State: the default profile is the one a fresh install has.
	}
	return [join(dataDir, "Default")];
}

/** `text` holds `dir` as a whole path (not as the start of `…/extension-chromium` when `dir` is `…/extension-chrome`). */
function namesFolder(text: string, dir: string): boolean {
	// Windows paths are JSON-escaped in the preferences files.
	for (const needle of [dir, JSON.stringify(dir).slice(1, -1)]) {
		for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
			const next = text[at + needle.length];
			if (next === undefined || !/[\w-]/.test(next)) return true;
		}
	}
	return false;
}

/** Does some profile's preferences name the extension folder (a loaded unpacked extension records its path)? */
export async function relayLoadedIn(dataDir: string, extensionDir: string): Promise<boolean> {
	for (const profile of await profileDirs(dataDir)) {
		for (const file of ["Preferences", "Secure Preferences"]) {
			if (namesFolder(await readText(join(profile, file)), extensionDir)) return true;
		}
	}
	return false;
}

/** The Chromium browsers installed in their standard places, in `auto` order. */
export async function findChromiumBrowsers(places: BrowserPlaces = systemBrowserPlaces()): Promise<FoundBrowser[]> {
	const found = await Promise.all(CHROMIUM_BROWSER_IDS.map(id => findBrowser(id, places)));
	return found.filter((browser): browser is FoundBrowser => browser !== undefined);
}

/** Is `port`'s relay serving a connected extension? Stock answers `/json/version` 200 then, 503 while it waits. */
async function relayConnected(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
		void response.body?.cancel();
		return response.status === 200;
	} catch {
		return false;
	}
}

/** The installed Chromium browsers with the state of their own relay extension copy. */
export async function detectChromiumBrowsers(
	places: BrowserPlaces = systemBrowserPlaces(),
	probe: (port: number) => Promise<boolean> = relayConnected,
): Promise<InstalledBrowser[]> {
	return Promise.all(
		(await findChromiumBrowsers(places)).map(async browser => {
			const relayInstalled = await relayLoadedIn(browser.dataDir, relayExtensionDir(browser.id, places.home));
			return {
				id: browser.id,
				name: browser.name,
				relayInstalled,
				relayConnected: relayInstalled && (await probe(CHROMIUM_RELAY_PORTS[browser.id])),
			};
		}),
	);
}

let cachedStatus: Promise<AgentBrowserStatus> | null = null;

async function probeStatus(): Promise<AgentBrowserStatus> {
	const [egoInstalled, browsers] = await Promise.all([egoBrowserInstalled(), detectChromiumBrowsers()]);
	return { egoInstalled, browsers };
}

/**
 * What this computer has, read once per launch; Settings asks `reprobeAgentBrowserStatus` instead, since the person
 * may install ego-browser or load the extension while the app runs.
 */
export function agentBrowserStatus(): Promise<AgentBrowserStatus> {
	if (!cachedStatus) {
		const pending = probeStatus();
		cachedStatus = pending;
		void pending.catch(() => {
			if (cachedStatus === pending) cachedStatus = null;
		});
	}
	return cachedStatus;
}

/** The answer without what changes by itself (a connection), which no session needs telling about. */
function resolvedKey(status: AgentBrowserStatus): string {
	return JSON.stringify([status.egoInstalled, status.browsers.map(browser => [browser.id, browser.relayInstalled])]);
}

/** Probe again; `changed` is whether what sessions are pointed at could differ from the answer held before. */
export async function reprobeAgentBrowserStatus(): Promise<{ status: AgentBrowserStatus; changed: boolean }> {
	const before = cachedStatus ? await cachedStatus.catch(() => null) : null;
	const pending = probeStatus();
	const status = await pending;
	cachedStatus = pending;
	return { status, changed: before !== null && resolvedKey(before) !== resolvedKey(status) };
}

/** Both files that name the port the extension dials; stock's asset declares it as `DEFAULT_PORT`. */
const PORT_FILES = ["background.js", "options.js"] as const;

/** `source` with its one `DEFAULT_PORT` declaration set to `port`; throws when stock's asset no longer has exactly one. */
export function bindExtensionPort(source: string, port: number, file: string): string {
	const declaration = /\b((?:var|const|let) DEFAULT_PORT = )\d+;/g;
	if (source.match(declaration)?.length !== 1) {
		throw new Error(`omp's relay extension changed: ${file} has no single DEFAULT_PORT to bind to port ${port}`);
	}
	return source.replace(declaration, `$1${port};`);
}

/**
 * Write `id`'s own copy of the relay extension, bound to its own port, and return its folder. Stock's
 * `omp browser-relay install` writes the copy to a staging folder; the copy is bound there and only then put in
 * place, so a stock asset this cannot bind (it fails with a clear error) never leaves an unbound extension behind.
 */
export async function installRelayExtension(
	omp: OmpRuntime,
	id: ChromiumBrowserId,
	home: string = homedir(),
): Promise<string> {
	const dir = relayExtensionDir(id, home);
	const staging = `${dir}.new`;
	await fs.rm(staging, { recursive: true, force: true });
	try {
		const result = await omp.run(["browser-relay", "install", "--dir", staging], { timeoutMs: 30_000 });
		if (result.code !== 0) {
			throw new Error(
				result.stderr.trim() || result.stdout.trim() || `omp browser-relay install exited ${result.code}`,
			);
		}
		for (const file of PORT_FILES) {
			const path = join(staging, file);
			await fs.writeFile(path, bindExtensionPort(await fs.readFile(path, "utf8"), CHROMIUM_RELAY_PORTS[id], file));
		}
		// Files go over the old copy one by one: a browser holding it open must not make a folder swap fail.
		await fs.mkdir(dir, { recursive: true });
		for (const name of await fs.readdir(staging)) await fs.copyFile(join(staging, name), join(dir, name));
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
	return dir;
}

/** Open `browser` at its extensions page (`open -a` on macOS; the exe itself on Windows). */
export function openExtensionsPage(browser: FoundBrowser, platform: NodeJS.Platform = process.platform): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (platform === "win32") {
		const child = spawn(browser.app, [browser.extensionsUrl], { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	} else {
		execFile("open", ["-a", browser.app, browser.extensionsUrl], error => (error ? reject(error) : resolve()));
	}
	return promise;
}
