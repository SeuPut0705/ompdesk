/**
 * Pin another ai-memory release and sync it:
 *
 *   bun run bump:ai-memory [<version>|latest]
 *
 * Resolves the release through the GitHub API (plain fetch; `GITHUB_TOKEN` is used when set),
 * downloads both platform archives, checks each against its published `.sha256`, extracts the
 * binaries to hash them, rewrites `resources/omp-builtin/ai-memory/ai-memory.json` and runs
 * `sync:ai-memory`. The bundled copy changes with OMPdesk releases only (no runtime self-update).
 */
import * as fs from "node:fs";
import {
	AI_MEMORY_REPO,
	type AiMemoryPin,
	extractBinary,
	fetchArchive,
	PIN_FILE,
	PLATFORM_KEYS,
	readPin,
	sha256,
	syncAiMemory,
} from "./sync-ai-memory";

const SEMVER = /^\d+\.\d+\.\d+$/;

async function resolveVersion(request: string): Promise<string> {
	const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "ompdesk-bump" };
	if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const api = `https://api.github.com/repos/${AI_MEMORY_REPO}/releases/${request === "latest" ? "latest" : `tags/v${request}`}`;
	const response = await fetch(api, { headers });
	if (!response.ok) throw new Error(`GET ${api}: ${response.status} ${response.statusText}`);
	const release = (await response.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean };
	const version = release.tag_name?.replace(/^v/, "") ?? "";
	if (!SEMVER.test(version)) throw new Error(`release tag ${JSON.stringify(release.tag_name)} is not vX.Y.Z`);
	if (release.draft || release.prerelease) throw new Error(`v${version} is a draft or prerelease`);
	return version;
}

async function bump(request: string): Promise<void> {
	const current = readPin();
	const version = await resolveVersion(request);
	const assets = { ...current.assets };
	for (const key of PLATFORM_KEYS) {
		const entry = current.assets[key];
		const { bytes, published, actual } = await fetchArchive(version, entry.archive);
		if (published !== actual) {
			throw new Error(`${entry.archive}: published SHA-256 ${published} differs from the download ${actual}`);
		}
		const binarySha256 = sha256(extractBinary(entry.archive, bytes, entry.binary));
		assets[key] = { ...entry, archiveSha256: actual, binarySha256 };
		console.log(`${key}: ${entry.archive} ${actual}\n${" ".repeat(key.length)}  ${entry.binary} ${binarySha256}`);
	}
	const pin: AiMemoryPin = { version, repository: current.repository, assets };
	fs.writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, "\t")}\n`);
	console.log(`pinned ai-memory ${current.version} -> ${version}`);
	await syncAiMemory(pin);
	console.log(
		[
			"",
			"Next:",
			"  bun run gen:licenses && bun scripts/gen-ai-memory-notices.ts   # third-party notices for the new version",
			`  document ai-memory ${version} in the release notes (CHANGELOG.md) of the OMPdesk release that ships it`,
		].join("\n"),
	);
}

const request = process.argv[2] ?? "latest";
if (request !== "latest" && !SEMVER.test(request)) {
	console.error(`usage: bun run bump:ai-memory [<X.Y.Z>|latest] (got ${JSON.stringify(request)})`);
	process.exit(1);
}
bump(request).catch(error => {
	console.error(`bump:ai-memory failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
