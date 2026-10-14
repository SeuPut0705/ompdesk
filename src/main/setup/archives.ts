/**
 * Release lookup for `archive` installs (macOS without Homebrew): the current
 * Node.js LTS and GitHub CLI releases, each with the SHA-256 its publisher
 * lists next to the download (Node's SHASUMS256.txt, gh's checksums.txt).
 */
import { reaNodeSupported } from "../../shared/builtin-mcp";
import type { ArchiveRelease } from "./plans";

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
	item: ArchiveRelease["item"],
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

/** fetch() as text; a non-2xx response throws with its status. */
export async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: { "user-agent": "ompdesk-setup" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.text();
}
