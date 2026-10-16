/**
 * Finding the Tailscale CLI (design §4.1) and telling which Tailscale it belongs to.
 *
 * macOS, in order: the override (env `OMP_GUI_TAILSCALE`, which never falls through to another install, then the
 * pref `mobileWeb.tailscaleBin`), the app's own binary (a CLI only with `TAILSCALE_BE_CLI=1`), the Standalone
 * app's "CLI integration" in `/usr/local/bin`, Homebrew's `/opt/homebrew/bin/tailscale` (on a Mac with the app it is
 * a wrapper that execs the app), then the login shell's PATH. Windows: the override, `%ProgramFiles%` and
 * `%ProgramFiles(x86)%`, then PATH.
 */
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TailscaleVariant } from "../../shared/mobile-web";
import { executableName, isExecutableFile } from "../spawn";
import type { TailscaleExecutor } from "./cli";

export interface LocatedTailscale {
	/** The executable used for every call. */
	path: string;
	variant: TailscaleVariant;
	/** The app bundle on macOS (the binary itself, or the one a wrapper script execs); null for a CLI-only daemon. */
	app: string | null;
	/** Added to every call's environment (`TAILSCALE_BE_CLI=1` for a macOS app binary). */
	env: Record<string, string>;
}

export const MAC_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const MAC_APP_STORE_ID = "io.tailscale.ipn.macos";
const MAC_STANDALONE_ID = "io.tailscale.ipn.macsys";
/** A wrapper script is a few lines; only this much of a file is read to look for the app it execs. */
const WRAPPER_HEAD_BYTES = 8 * 1024;

export interface LocateDeps {
	platform: "darwin" | "win32";
	/** Environment variables (`OMP_GUI_TAILSCALE`, `ProgramFiles`). */
	env: NodeJS.ProcessEnv;
	/** Pref `mobileWeb.tailscaleBin`. */
	pref: string | null;
	/** The login shell's PATH. */
	pathEnv: () => Promise<string>;
	isExecutable: (file: string) => boolean;
	/** The start of a text file, or null for a binary or unreadable one. */
	readHead: (file: string) => string | null;
	realpath: (file: string) => string;
	/** `CFBundleIdentifier` of the app bundle at `app`, or null. */
	bundleId: (app: string) => Promise<string | null>;
}

/** The bundle of an app binary path (`…/Tailscale.app/Contents/MacOS/Tailscale`), or null. */
function bundleOfBinary(file: string): string | null {
	return /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(file)?.[1] ?? null;
}

/** The app a wrapper script execs (`exec /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@"`), or null. */
function bundleOfWrapper(text: string): string | null {
	return /(\/[^\s"'$]+\.app)\/Contents\/MacOS\/Tailscale\b/.exec(text)?.[1] ?? null;
}

/** App Store (`io.tailscale.ipn.macos`), Standalone (`io.tailscale.ipn.macsys`); any other bundle id is `other`. */
export function macVariantOfBundle(id: string | null): TailscaleVariant {
	if (id === MAC_APP_STORE_ID) return "mac-app-store";
	if (id === MAC_STANDALONE_ID) return "mac-standalone";
	return "other";
}

async function classifyMac(file: string, deps: LocateDeps): Promise<LocatedTailscale> {
	let real = file;
	try {
		real = deps.realpath(file);
	} catch {
		// A broken link still runs (and fails) as itself.
	}
	const app = bundleOfBinary(real) ?? bundleOfBinary(file) ?? bundleOfWrapper(deps.readHead(file) ?? "");
	if (!app) return { path: file, variant: "mac-cli", app: null, env: {} };
	return { path: file, variant: macVariantOfBundle(await deps.bundleId(app)), app, env: { TAILSCALE_BE_CLI: "1" } };
}

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
	return [env.ProgramFiles, env["ProgramFiles(x86)"]]
		.filter((root): root is string => Boolean(root))
		.map(root => join(root, "Tailscale", "tailscale.exe"));
}

/** The Tailscale CLI of this machine, or null when there is none. */
export async function locateTailscale(deps: LocateDeps): Promise<LocatedTailscale | null> {
	const { platform, env } = deps;
	const classify = (file: string): Promise<LocatedTailscale> =>
		platform === "darwin"
			? classifyMac(file, deps)
			: Promise.resolve({ path: file, variant: "windows", app: null, env: {} });
	// A test's (or developer's) own CLI is the only candidate: falling through would run the user's Tailscale.
	const forced = env.OMP_GUI_TAILSCALE?.trim();
	if (forced) return deps.isExecutable(forced) ? classify(forced) : null;
	const preferred = deps.pref?.trim();
	if (preferred && deps.isExecutable(preferred)) return classify(preferred);
	const fixed =
		platform === "darwin"
			? [MAC_APP_BINARY, "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
			: windowsCandidates(env);
	for (const file of fixed) if (deps.isExecutable(file)) return classify(file);
	const dirs = (await deps.pathEnv()).split(platform === "win32" ? ";" : delimiter).filter(Boolean);
	const found = dirs.map(dir => join(dir, executableName("tailscale", platform))).find(deps.isExecutable);
	return found ? classify(found) : null;
}

/** The first bytes of `file` as text; null when it holds a NUL (a binary) or cannot be read. */
function readHead(file: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(WRAPPER_HEAD_BYTES);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, length);
		return head.includes(0) ? null : head.toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** The real dependencies; `bundleId` reads an app's Info.plist (macOS only). */
export function systemLocateDeps(
	platform: "darwin" | "win32",
	pref: string | null,
	pathEnv: () => Promise<string>,
	bundleId: (app: string) => Promise<string | null>,
): LocateDeps {
	return {
		platform,
		env: process.env,
		pref,
		pathEnv,
		isExecutable: file => isExecutableFile(file, platform),
		readHead,
		realpath: realpathSync,
		bundleId,
	};
}

/** `CFBundleIdentifier` of the app at `app`, read with `plutil` (it reads binary and XML plists alike). */
export async function readBundleId(app: string, exec: TailscaleExecutor): Promise<string | null> {
	const result = await exec("/usr/bin/plutil", [
		"-extract",
		"CFBundleIdentifier",
		"raw",
		"-o",
		"-",
		join(app, "Contents", "Info.plist"),
	]);
	return result.code === 0 ? result.stdout.trim() || null : null;
}
