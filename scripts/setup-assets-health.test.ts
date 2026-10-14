import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PORTABLE_GIT } from "../src/main/setup/plans";
import { checkAsset, healthReport, type PinnedAsset, pinnedAssets } from "./setup-assets-health";

const bytes = new TextEncoder().encode("PortableGit bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const asset: PinnedAsset = { label: "PortableGit 2.56.0.2 (x64)", url: "https://example.test/git.7z.exe", sha256: sha };
const noWait = async () => {};

/** nodejs.org and GitHub, as `resolveArchiveRelease` reads them. */
function listings(overrides: Record<string, string> = {}): (url: string) => Promise<string> {
	const pages: Record<string, string> = {
		"https://nodejs.org/dist/index.json": JSON.stringify([{ version: "v24.11.0", lts: "Krypton" }]),
		"https://nodejs.org/dist/v24.11.0/SHASUMS256.txt": [
			`${"a".repeat(64)}  node-v24.11.0-darwin-arm64.tar.gz`,
			`${"b".repeat(64)}  node-v24.11.0-darwin-x64.tar.gz`,
		].join("\n"),
		"https://api.github.com/repos/cli/cli/releases/latest": JSON.stringify({ tag_name: "v2.83.0" }),
		"https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_checksums.txt": [
			`${"c".repeat(64)}  gh_2.83.0_macOS_arm64.zip`,
			`${"d".repeat(64)}  gh_2.83.0_macOS_amd64.zip`,
		].join("\n"),
		...overrides,
	};
	return async url => {
		const page = pages[url];
		if (page === undefined) throw new Error(`${url} answered 404`);
		return page;
	};
}

describe("pinnedAssets", () => {
	it("lists both pinned PortableGits and the gh and Node archives the app would download, with their checksums", async () => {
		const { assets, failures } = await pinnedAssets(listings());
		expect(failures).toEqual([]);
		expect(assets).toEqual([
			{ label: "PortableGit 2.56.0.2 (x64)", url: PORTABLE_GIT.x64.url, sha256: PORTABLE_GIT.x64.sha256 },
			{ label: "PortableGit 2.56.0.2 (arm64)", url: PORTABLE_GIT.arm64.url, sha256: PORTABLE_GIT.arm64.sha256 },
			{
				label: "Node.js v24.11.0 (macOS arm64)",
				url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz",
				sha256: "a".repeat(64),
			},
			{
				label: "Node.js v24.11.0 (macOS x64)",
				url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-x64.tar.gz",
				sha256: "b".repeat(64),
			},
			{
				label: "GitHub CLI 2.83.0 (macOS arm64)",
				url: "https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_macOS_arm64.zip",
				sha256: "c".repeat(64),
			},
			{
				label: "GitHub CLI 2.83.0 (macOS amd64)",
				url: "https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_macOS_amd64.zip",
				sha256: "d".repeat(64),
			},
		]);
	});

	it("reports a release lookup that no longer resolves, or a file its checksum list leaves out", async () => {
		const { assets, failures } = await pinnedAssets(
			listings({
				"https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_checksums.txt": `${"c".repeat(64)}  other.zip`,
				"https://nodejs.org/dist/index.json": "[]",
			}),
		);
		expect(assets.map(entry => entry.label)).toEqual(["PortableGit 2.56.0.2 (x64)", "PortableGit 2.56.0.2 (arm64)"]);
		expect(failures).toEqual([
			"Node.js lookup (macOS arm64): nodejs.org lists no supported LTS release",
			"Node.js lookup (macOS x64): nodejs.org lists no supported LTS release",
			"GitHub CLI lookup (macOS arm64): No published SHA-256 for gh_2.83.0_macOS_arm64.zip",
			"GitHub CLI lookup (macOS amd64): No published SHA-256 for gh_2.83.0_macOS_amd64.zip",
		]);
	});
});

describe("checkAsset", () => {
	it("passes a file that downloads in full and matches its pinned SHA-256", async () => {
		expect(await checkAsset(asset, async () => new Response(bytes), noWait)).toEqual({
			ok: true,
			bytes: bytes.byteLength,
		});
	});

	it("fails a checksum mismatch at once, without retrying", async () => {
		let calls = 0;
		const result = await checkAsset(
			{ ...asset, sha256: "0".repeat(64) },
			async () => {
				calls += 1;
				return new Response(bytes);
			},
			noWait,
		);
		expect(result).toEqual({ ok: false, error: `SHA-256 mismatch: expected ${"0".repeat(64)}, got ${sha}` });
		expect(calls).toBe(1);
	});

	it("retries a refused download three times before calling it broken", async () => {
		const waits: number[] = [];
		let calls = 0;
		const result = await checkAsset(
			asset,
			async () => {
				calls += 1;
				return new Response("gone", { status: 404 });
			},
			async ms => {
				waits.push(ms);
			},
		);
		expect(result).toEqual({ ok: false, error: "https://example.test/git.7z.exe answered 404" });
		expect(calls).toBe(3);
		expect(waits).toEqual([2000, 4000]);
		let flaky = 0;
		expect(
			await checkAsset(
				asset,
				async () => {
					flaky += 1;
					return flaky === 1 ? new Response("", { status: 502 }) : new Response(bytes);
				},
				noWait,
			),
		).toEqual({ ok: true, bytes: bytes.byteLength });
	});
});

describe("healthReport", () => {
	it("names every broken asset with its URL, and the run", () => {
		expect(
			healthReport(
				[
					{ asset, result: { ok: true, bytes: 10 } },
					{
						asset: { ...asset, label: "PortableGit 2.56.0.2 (arm64)" },
						result: { ok: false, error: "answered 404" },
					},
				],
				["GitHub CLI lookup (macOS arm64): GitHub lists no GitHub CLI release"],
				"https://github.com/o/r/actions/runs/1",
			),
		).toBe(
			[
				"# Setup downloads health check failed",
				"",
				"Machine setup (src/main/setup/) downloads these on a user's first launch; a broken one means that install fails there.",
				"",
				"- PortableGit 2.56.0.2 (arm64): answered 404 (https://example.test/git.7z.exe)",
				"- GitHub CLI lookup (macOS arm64): GitHub lists no GitHub CLI release",
				"",
				"Run: https://github.com/o/r/actions/runs/1",
				"",
			].join("\n"),
		);
	});
});
