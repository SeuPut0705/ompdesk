/**
 * Release lookup for the archives setup downloads itself: the current Node.js LTS and GitHub CLI releases
 * (`archive`, macOS without Homebrew), the newest agent-desktop release (`agent-desktop-archive`, macOS and Windows)
 * and Tailscale's current stable package, each with the SHA-256 its publisher lists next to the download (Node's
 * SHASUMS256.txt, gh's and agent-desktop's checksums.txt, Tailscale's `<file>.sha256`). The lookups run in the core
 * (`crates/core/src/setup/archives.rs`); this is their typed client. Each call is one request and throws, as it
 * always did, a plain Error with a readable reason.
 */
import { CoreError, core } from "../core/process";
import { NO_TIMEOUT_MS } from "./download";
import type { ArchiveRelease, TailscaleRelease } from "./plans";

export interface LookupOptions {
	/**
	 * A test's server on 127.0.0.1 standing in for every host: `https://host/path` is read from `<mirror>/host/path`.
	 * Only a test passes it.
	 */
	mirror?: string;
	/** Sent as `authorization: Bearer` to api.github.com only (60 requests an hour without one). */
	githubToken?: string;
}

/**
 * The oldest agent-desktop OMPdesk accepts: `agent-desktop mcp` (the stdio MCP server the computer-use engine
 * runs) exists since 1.2.0. A managed copy below it is `outdated` and gets reinstalled.
 */
export const AGENT_DESKTOP_MIN_VERSION = "1.2.0";

/** One lookup: the core answers the release or says why it cannot (`setup_lookup`), which is an `Error` here. */
async function lookup<T>(method: string, params: Record<string, unknown>, options: LookupOptions): Promise<T> {
	const { mirror, githubToken } = options;
	try {
		const answer = await core().call<T>(
			method,
			{ ...params, ...(mirror ? { mirror } : {}), ...(githubToken ? { githubToken } : {}) },
			// The core bounds each page it reads (30 s); the lookup is two pages at most.
			{ timeoutMs: NO_TIMEOUT_MS },
		);
		return answer.result;
	} catch (error) {
		if (error instanceof CoreError && error.code === "setup_lookup") throw new Error(error.message);
		throw error;
	}
}

/** Look up the release an `archive` install of `item` downloads. Throws with a readable reason. */
export function resolveArchiveRelease(
	item: "gh" | "node",
	arch: string,
	options: LookupOptions = {},
): Promise<ArchiveRelease> {
	return lookup("setup.resolveArchive", { item, arch }, options);
}

/**
 * The newest stable agent-desktop release (GitHub's `releases/latest`: never a draft or pre-release) for this
 * machine, with the SHA-256 its `checksums.txt` lists. No release-age hold, like gh and Node: the checksum comes
 * from the publisher's own release. An unsupported architecture is refused before any request. Throws with a
 * readable reason.
 */
export function resolveAgentDesktopRelease(
	platform: "darwin" | "win32",
	arch: string,
	options: LookupOptions = {},
): Promise<ArchiveRelease> {
	return lookup("setup.resolveAgentDesktop", { platform, arch }, options);
}

/**
 * Tailscale's current stable package for `platform` from the official index (`?mode=json`): the macOS zip, or the
 * MSI named for `msiArch` (`amd64`, `arm64`, `x86`), with the SHA-256 Tailscale publishes as `<file>.sha256`. The
 * index only names files; the host is always pkgs.tailscale.com. Throws with a readable reason.
 */
export function resolveTailscaleRelease(
	platform: "darwin" | "win32",
	msiArch: "amd64" | "arm64" | "x86" | null,
	options: LookupOptions = {},
): Promise<TailscaleRelease> {
	return lookup("setup.resolveTailscale", { platform, msiArch }, options);
}
