import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PORTABLE_GIT } from "../src/main/setup/plans";
import { type Answer, type Mirror, startMirror } from "../src/main/setup/test-mirror";
import agentDesktopPin from "./agent-desktop-pin.json" with { type: "json" };
import { checkAsset, healthReport, type PinnedAsset, pinnedAssets } from "./setup-assets-health";

/** The agent-desktop release the app ships, as `bun run build:agent-desktop` downloads it: no lookup involved. */
const SHIPPED = Object.entries(agentDesktopPin.targets).map(([key, target]) => ({
	label: `agent-desktop ${agentDesktopPin.version} shipped in the app (${key})`,
	url: `https://github.com/vercel-labs/agent-desktop/releases/download/v${agentDesktopPin.version}/${target.file}`,
	sha256: target.sha256,
}));

const bytes = new TextEncoder().encode("PortableGit bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const asset: PinnedAsset = { label: "PortableGit 2.56.0.2 (x64)", url: "https://example.test/git.7z.exe", sha256: sha };
const noWait = async () => {};

/** The mirrors started by a test (the core reads every address from one), closed after it. */
const started: Mirror[] = [];
afterEach(async () => {
	await Promise.all(started.splice(0).map(mirror => mirror.close()));
});
async function serve(answer: (url: string) => Answer): Promise<Mirror> {
	const mirror = await startMirror(answer);
	started.push(mirror);
	return mirror;
}

/** nodejs.org and GitHub, as `resolveArchiveRelease` and `resolveAgentDesktopRelease` read them. */
function listings(overrides: Record<string, string> = {}): Promise<Mirror> {
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
		"https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest": JSON.stringify({ tag_name: "v1.2.0" }),
		"https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/checksums.txt": [
			`${"e".repeat(64)}  agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz`,
			`${"f".repeat(64)}  agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz`,
			`${"1".repeat(64)}  agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz`,
		].join("\n"),
		...overrides,
	};
	return serve(url => pages[url]);
}

describe("pinnedAssets", () => {
	it("lists both pinned PortableGits, the gh, Node and agent-desktop archives the app would download and the agent-desktop it ships, with their checksums", async () => {
		const { assets, failures } = await pinnedAssets({ mirror: (await listings()).url });
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
			{
				label: "agent-desktop 1.2.0 (macOS arm64)",
				url: "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz",
				sha256: "e".repeat(64),
			},
			{
				label: "agent-desktop 1.2.0 (macOS x64)",
				url: "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz",
				sha256: "f".repeat(64),
			},
			{
				label: "agent-desktop 1.2.0 (Windows x64)",
				url: "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz",
				sha256: "1".repeat(64),
			},
			...SHIPPED,
		]);
	});

	it("reports a release lookup that no longer resolves, or a file its checksum list leaves out", async () => {
		const { assets, failures } = await pinnedAssets({
			mirror: (
				await listings({
					"https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_checksums.txt": `${"c".repeat(64)}  other.zip`,
					"https://nodejs.org/dist/index.json": "[]",
					"https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/checksums.txt": `${"e".repeat(64)}  other.tar.gz`,
				})
			).url,
		});
		expect(assets.map(entry => entry.label)).toEqual([
			"PortableGit 2.56.0.2 (x64)",
			"PortableGit 2.56.0.2 (arm64)",
			...SHIPPED.map(entry => entry.label),
		]);
		expect(failures).toEqual([
			"Node.js lookup (macOS arm64): nodejs.org lists no supported LTS release",
			"Node.js lookup (macOS x64): nodejs.org lists no supported LTS release",
			"GitHub CLI lookup (macOS arm64): No published SHA-256 for gh_2.83.0_macOS_arm64.zip",
			"GitHub CLI lookup (macOS amd64): No published SHA-256 for gh_2.83.0_macOS_amd64.zip",
			"agent-desktop lookup (macOS arm64): No published SHA-256 for agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz",
			"agent-desktop lookup (macOS x64): No published SHA-256 for agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz",
			"agent-desktop lookup (Windows x64): No published SHA-256 for agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz",
		]);
	});
});

describe("checkAsset", () => {
	it("passes a file that downloads in full and matches its pinned SHA-256", async () => {
		const mirror = await serve(() => ({ body: bytes }));
		expect(await checkAsset(asset, mirror.url, noWait)).toEqual({ ok: true, bytes: bytes.byteLength });
	});

	it("fails a checksum mismatch at once, without retrying", async () => {
		const mirror = await serve(() => ({ body: bytes }));
		const result = await checkAsset({ ...asset, sha256: "0".repeat(64) }, mirror.url, noWait);
		expect(result).toEqual({ ok: false, error: `SHA-256 mismatch: expected ${"0".repeat(64)}, got ${sha}` });
		expect(mirror.asked).toHaveLength(1);
	});

	it("retries a refused download three times before calling it broken", async () => {
		const waits: number[] = [];
		const gone = await serve(() => ({ status: 404, body: "gone" }));
		const result = await checkAsset(asset, gone.url, async ms => {
			waits.push(ms);
		});
		expect(result).toEqual({ ok: false, error: "https://example.test/git.7z.exe answered 404" });
		expect(gone.asked).toHaveLength(3);
		expect(waits).toEqual([2000, 4000]);
		let flaky = 0;
		const flakyMirror = await serve(() => {
			flaky += 1;
			return flaky === 1 ? { status: 502, body: "" } : { body: bytes };
		});
		expect(await checkAsset(asset, flakyMirror.url, noWait)).toEqual({ ok: true, bytes: bytes.byteLength });
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
