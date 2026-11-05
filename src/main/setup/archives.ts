/**
 * Release lookup for the archives setup downloads itself: the current Node.js LTS and GitHub CLI releases
 * (`archive`, macOS without Homebrew) and the newest agent-desktop release (`agent-desktop-archive`, macOS and
 * Windows), each with the SHA-256 its publisher lists next to the download (Node's SHASUMS256.txt, gh's and
 * agent-desktop's checksums.txt).
 */
import { reaNodeSupported } from "../../shared/builtin-mcp";
import type { ArchiveRelease, TailscaleRelease } from "./plans";

export type FetchText = (url: string) => Promise<string>;

const VERSION = /^v?\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The newest LTS in nodejs.org's `dist/index.json` that REA's engines accept, e.g. `v24.11.0`. */
export function pickNodeLts(index: unknown): string | null {
	if (!Array.isArray(index)) return null;
	for (const entry of index) {
		if (typeof entry !== "object" || entry === null) continue;
		const version = "version" in entry ? entry.version : undefined;
		const lts = "lts" in entry ? entry.lts : undefined;
		if (typeof version === "string" && VERSION.test(version) && lts && reaNodeSupported(version)) return version;
	}
	return null;
}

/** The SHA-256 for `file` in a `sha256sum`-format listing (`<hash>  <file>`), or null. */
export function parseShasums(listing: string, file: string): string | null {
	for (const line of listing.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
		if (match?.[2] === file) return match[1]?.toLowerCase() ?? null;
	}
	return null;
}

export function nodeArchiveFile(version: string, arch: string): string {
	return `node-${version}-darwin-${arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
}

export function ghArchiveFile(version: string, arch: string): string {
	return `gh_${version.replace(/^v/, "")}_macOS_${arch === "arm64" ? "arm64" : "amd64"}.zip`;
}

function checked(item: ArchiveRelease["item"], version: string, file: string, url: string, sha: string | null) {
	if (!sha || !SHA256.test(sha)) throw new Error(`No published SHA-256 for ${file}`);
	const release: ArchiveRelease = { item, version, file, url, sha256: sha };
	return release;
}

/** Look up the release an `archive` install of `item` downloads. Throws with a readable reason. */
export async function resolveArchiveRelease(
	item: "gh" | "node",
	arch: string,
	fetchText: FetchText,
): Promise<ArchiveRelease> {
	if (item === "node") {
		const version = pickNodeLts(JSON.parse(await fetchText("https://nodejs.org/dist/index.json")));
		if (!version) throw new Error("nodejs.org lists no supported LTS release");
		const file = nodeArchiveFile(version, arch);
		const base = `https://nodejs.org/dist/${version}`;
		return checked(
			item,
			version,
			file,
			`${base}/${file}`,
			parseShasums(await fetchText(`${base}/SHASUMS256.txt`), file),
		);
	}
	const latest: unknown = JSON.parse(await fetchText("https://api.github.com/repos/cli/cli/releases/latest"));
	const tag = typeof latest === "object" && latest !== null && "tag_name" in latest ? latest.tag_name : undefined;
	if (typeof tag !== "string" || !VERSION.test(tag)) throw new Error("GitHub lists no GitHub CLI release");
	const version = tag.replace(/^v/, "");
	const file = ghArchiveFile(version, arch);
	const base = `https://github.com/cli/cli/releases/download/v${version}`;
	return checked(
		item,
		version,
		file,
		`${base}/${file}`,
		parseShasums(await fetchText(`${base}/gh_${version}_checksums.txt`), file),
	);
}

/**
 * The oldest agent-desktop OMPdesk accepts: `agent-desktop mcp` (the stdio MCP server the computer-use engine
 * runs) exists since 1.2.0. A managed copy below it is `outdated` and gets reinstalled.
 */
export const AGENT_DESKTOP_MIN_VERSION = "1.2.0";

const AGENT_DESKTOP_REPO = "vercel-labs/agent-desktop";

/** The Rust target of agent-desktop's release archive for this machine; throws for one it ships none for. */
function agentDesktopTarget(platform: "darwin" | "win32", arch: string): string {
	if (arch !== "arm64" && arch !== "x64") throw new Error(`agent-desktop has no release for ${platform} ${arch}`);
	const cpu = arch === "arm64" ? "aarch64" : "x86_64";
	return platform === "darwin" ? `${cpu}-apple-darwin` : `${cpu}-pc-windows-msvc`;
}

/**
 * The newest stable agent-desktop release (GitHub's `releases/latest`: never a draft or pre-release) for this
 * machine, with the SHA-256 its `checksums.txt` lists. No release-age hold, like gh and Node: the checksum comes
 * from the publisher's own release. Throws with a readable reason.
 */
export async function resolveAgentDesktopRelease(
	platform: "darwin" | "win32",
	arch: string,
	fetchText: FetchText,
): Promise<ArchiveRelease> {
	// An unsupported architecture is refused before any request.
	const target = agentDesktopTarget(platform, arch);
	const latest: unknown = JSON.parse(
		await fetchText(`https://api.github.com/repos/${AGENT_DESKTOP_REPO}/releases/latest`),
	);
	const tag = typeof latest === "object" && latest !== null && "tag_name" in latest ? latest.tag_name : undefined;
	if (typeof tag !== "string" || !VERSION.test(tag)) throw new Error("GitHub lists no agent-desktop release");
	const version = tag.replace(/^v/, "");
	const file = `agent-desktop-v${version}-${target}.tar.gz`;
	const base = `https://github.com/${AGENT_DESKTOP_REPO}/releases/download/v${version}`;
	return checked(
		"agent-desktop",
		version,
		file,
		`${base}/${file}`,
		parseShasums(await fetchText(`${base}/checksums.txt`), file),
	);
}

const TAILSCALE_BASE = "https://pkgs.tailscale.com/stable";
const SHA256_TOKEN = /\b[0-9a-fA-F]{64}\b/;
/** A plain file name of the index: no path, no query. */
const PACKAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(zip|msi)$/;

function indexString(table: unknown, key: string): string | null {
	if (typeof table !== "object" || table === null || !(key in table)) return null;
	const value = (table as Record<string, unknown>)[key];
	return typeof value === "string" ? value : null;
}

/**
 * Tailscale's current stable package for `platform` from the official index (`?mode=json`): the macOS zip, or
 * the MSI named for `msiArch` (`amd64`, `arm64`, `x86`), with the SHA-256 Tailscale publishes as `<file>.sha256`.
 * The index only names files; the host is always pkgs.tailscale.com. Throws with a readable reason.
 */
export async function resolveTailscaleRelease(
	platform: "darwin" | "win32",
	msiArch: "amd64" | "arm64" | "x86" | null,
	fetchText: FetchText,
): Promise<TailscaleRelease> {
	const index: unknown = JSON.parse(await fetchText(`${TAILSCALE_BASE}/?mode=json`));
	const mac = platform === "darwin";
	if (!mac && !msiArch) throw new Error("Tailscale publishes no installer for this processor");
	const file = mac
		? indexString(indexObject(index, "MacZips"), "universal")
		: indexString(indexObject(index, "MSIs"), msiArch as string);
	const version = indexString(index, mac ? "MacZipsVersion" : "MSIsVersion") ?? indexString(index, "Version");
	if (!file || !PACKAGE_FILE.test(file) || !version || !VERSION.test(version)) {
		throw new Error("pkgs.tailscale.com lists no installer for this machine");
	}
	const url = `${TAILSCALE_BASE}/${file}`;
	const sha = SHA256_TOKEN.exec(await fetchText(`${url}.sha256`))?.[0]?.toLowerCase() ?? null;
	if (!sha) throw new Error(`No published SHA-256 for ${file}`);
	return { version, file, url, sha256: sha };
}

function indexObject(index: unknown, key: string): unknown {
	return typeof index === "object" && index !== null && key in index ? (index as Record<string, unknown>)[key] : null;
}

/** fetch() as text; a non-2xx response throws with its status. */
export async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: { "user-agent": "ompdesk-setup" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.text();
}
