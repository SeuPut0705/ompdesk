/**
 * Health check for what machine setup (src/main/setup/) downloads on a user's
 * first launch: both pinned PortableGits (plans.ts) and the gh and Node.js
 * archives a Mac without Homebrew installs (archives.ts, resolved exactly the
 * way the app resolves them). Each file is downloaded in full through the
 * app's own downloader (download.ts), so it passes only when the URL still
 * resolves and its bytes still match the pinned or published SHA-256.
 *
 *   bun scripts/setup-assets-health.ts [--report <file.md>]
 *
 * Exits 1 when anything is broken, after writing the Markdown report to
 * `--report`. `.github/workflows/setup-assets-health.yml` runs it weekly and
 * keeps one GitHub issue open while it fails.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchText, resolveArchiveRelease } from "../src/main/setup/archives";
import { type DownloadFetch, downloadVerified } from "../src/main/setup/download";
import { PORTABLE_GIT } from "../src/main/setup/plans";

export interface PinnedAsset {
	label: string;
	url: string;
	sha256: string;
}

export type AssetResult = { ok: true; bytes: number } | { ok: false; error: string };

const ATTEMPTS = 3;

/** Every download machine setup can start, with its expected SHA-256; lookups that failed are listed instead. */
export async function pinnedAssets(fetchText: FetchText): Promise<{ assets: PinnedAsset[]; failures: string[] }> {
	const assets: PinnedAsset[] = [];
	const failures: string[] = [];
	for (const arch of ["x64", "arm64"] as const) {
		const pin = PORTABLE_GIT[arch];
		assets.push({ label: `PortableGit ${PORTABLE_GIT.version} (${arch})`, url: pin.url, sha256: pin.sha256 });
	}
	for (const [item, name] of [
		["node", "Node.js"],
		["gh", "GitHub CLI"],
	] as const) {
		for (const arch of ["arm64", "x64"]) {
			// Each publisher's own name for the arch, as in its file names.
			const platform = `macOS ${item === "gh" && arch === "x64" ? "amd64" : arch}`;
			try {
				const release = await resolveArchiveRelease(item, arch, fetchText);
				assets.push({
					label: `${name} ${release.version} (${platform})`,
					url: release.url,
					sha256: release.sha256,
				});
			} catch (error) {
				failures.push(`${name} lookup (${platform}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { assets, failures };
}

/** Download `asset` in full and check its SHA-256; a refused or broken download is retried, a mismatch is final. */
export async function checkAsset(
	asset: PinnedAsset,
	fetch: DownloadFetch,
	wait: (ms: number) => Promise<void>,
): Promise<AssetResult> {
	const dir = await mkdtemp(join(tmpdir(), "ompdesk-assets-health-"));
	try {
		let error = "";
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			let bytes = 0;
			try {
				await downloadVerified({
					url: asset.url,
					sha256: asset.sha256,
					file: join(dir, "asset"),
					signal: AbortSignal.timeout(300_000),
					onProgress: progress => {
						bytes = progress.received;
					},
					fetch,
				});
				return { ok: true, bytes };
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
				if (/^SHA-256 mismatch/.test(error)) break;
				if (attempt < ATTEMPTS) await wait(attempt * 2000);
			}
		}
		return { ok: false, error };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export function healthReport(
	results: { asset: PinnedAsset; result: AssetResult }[],
	lookupFailures: string[],
	runUrl: string,
): string {
	const broken = results.flatMap(({ asset, result }) =>
		result.ok ? [] : [`- ${asset.label}: ${result.error} (${asset.url})`],
	);
	return [
		"# Setup downloads health check failed",
		"",
		"Machine setup (src/main/setup/) downloads these on a user's first launch; a broken one means that install fails there.",
		"",
		...broken,
		...lookupFailures.map(failure => `- ${failure}`),
		"",
		`Run: ${runUrl}`,
		"",
	].join("\n");
}

/** fetch() as text, authenticated to api.github.com when the workflow provides a token (60 requests/h without). */
async function fetchListing(url: string): Promise<string> {
	const token = process.env.GITHUB_TOKEN;
	const response = await fetch(url, {
		headers: {
			"user-agent": "ompdesk-setup-assets-health",
			...(token && url.startsWith("https://api.github.com/") ? { authorization: `Bearer ${token}` } : {}),
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.text();
}

async function main(): Promise<number> {
	const reportIndex = process.argv.indexOf("--report");
	const reportPath = reportIndex > 0 ? process.argv[reportIndex + 1] : undefined;
	const { assets, failures } = await pinnedAssets(fetchListing);
	const results: { asset: PinnedAsset; result: AssetResult }[] = [];
	for (const asset of assets) {
		const result = await checkAsset(asset, fetch, ms => Bun.sleep(ms));
		console.log(
			result.ok ? `✓ ${asset.label}: ${result.bytes} bytes, SHA-256 matches` : `✗ ${asset.label}: ${result.error}`,
		);
		results.push({ asset, result });
	}
	for (const failure of failures) console.log(`✗ ${failure}`);
	if (failures.length === 0 && results.every(entry => entry.result.ok)) return 0;
	const run = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "local"}/actions/runs/${process.env.GITHUB_RUN_ID ?? "-"}`;
	const report = healthReport(results, failures, run);
	if (reportPath) await writeFile(reportPath, report);
	console.error(report);
	return 1;
}

if (import.meta.main) process.exit(await main());
