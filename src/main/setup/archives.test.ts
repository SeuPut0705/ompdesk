import { afterEach, describe, expect, it } from "vitest";
import { reaNodeSupported } from "../../shared/builtin-mcp";
import { resolveAgentDesktopRelease, resolveArchiveRelease, resolveTailscaleRelease } from "./archives";
import { type Answer, type Mirror, startMirror } from "./test-mirror";

const SHA = "b".repeat(64);

/** The latest mirror `serve` started (what a test asks about), and every one, closed after each test. */
let mirror: Mirror | null = null;
const started: Mirror[] = [];
afterEach(async () => {
	await Promise.all(started.splice(0).map(each => each.close()));
	mirror = null;
});

/** A mirror serving `pages` (by real address; any other is a 404), through which the core reads every page. */
async function serve(pages: Record<string, string> | ((url: string) => Answer)): Promise<{ mirror: string }> {
	mirror = await startMirror(typeof pages === "function" ? pages : url => pages[url]);
	started.push(mirror);
	return { mirror: mirror.url };
}

const NODE_INDEX = "https://nodejs.org/dist/index.json";

/** The pages of a Node lookup that finds `version`'s checksums. */
const nodePages = (index: unknown, version: string, listing: string): Record<string, string> => ({
	[NODE_INDEX]: JSON.stringify(index),
	[`https://nodejs.org/dist/${version}/SHASUMS256.txt`]: listing,
});

describe("archive releases", () => {
	it("picks the newest LTS that REA's engines accept", async () => {
		const listing = `${SHA}  node-v24.11.0-darwin-arm64.tar.gz\n`;
		const index = [
			{ version: "v26.11.1", lts: false },
			{ version: "v24.10.0", lts: "Krypton" },
			{ version: "v24.11.0", lts: "Krypton" },
		];
		const found = await resolveArchiveRelease("node", "arm64", await serve(nodePages(index, "v24.11.0", listing)));
		expect(found.version).toBe("v24.11.0");
		for (const unsupported of [[{ version: "v20.19.0", lts: "Iron" }], { not: "a list" }]) {
			await expect(
				resolveArchiveRelease("node", "arm64", await serve({ [NODE_INDEX]: JSON.stringify(unsupported) })),
			).rejects.toThrow(/no supported LTS/);
		}
	});

	it("accepts the versions shared/builtin-mcp's reaNodeSupported accepts, and no others", async () => {
		// The core spells REA's engines range itself (`archives.rs`); this holds it to the page's one spelling.
		const versions = [
			"v22.18.9",
			"v22.19.0",
			"v22.20.1",
			"v23.9.0",
			"v24.10.9",
			"v24.11.0",
			"v25.9.9",
			"v26.0.0",
			"v100.0.0",
			"v021.19.0",
		];
		for (const version of versions) {
			const pages = nodePages([{ version, lts: "x" }], version, `${SHA}  node-${version}-darwin-x64.tar.gz`);
			const outcome = await resolveArchiveRelease("node", "x64", await serve(pages)).then(
				release => release.version,
				() => null,
			);
			expect(outcome, version).toBe(reaNodeSupported(version) ? version : null);
		}
	});

	it("reads one file's hash from a sha256sum listing, in either case, with or without the binary mark", async () => {
		const file = "node-v24.11.0-darwin-arm64.tar.gz";
		const index = [{ version: "v24.11.0", lts: "Krypton" }];
		const listing = `${"a".repeat(64)}  node-v24.11.0-darwin-x64.tar.gz\n${SHA.toUpperCase()} *${file}\n`;
		await expect(
			resolveArchiveRelease("node", "arm64", await serve(nodePages(index, "v24.11.0", listing))),
		).resolves.toMatchObject({ sha256: SHA });
		await expect(
			resolveArchiveRelease(
				"node",
				"arm64",
				await serve(nodePages(index, "v24.11.0", listing.replace("arm64.tar.gz", "arm64.tar.xz"))),
			),
		).rejects.toThrow(/No published SHA-256/);
	});

	it("names the macOS archives per architecture", async () => {
		const pages = {
			...nodePages(
				[{ version: "v24.11.0", lts: "K" }],
				"v24.11.0",
				[
					`${"1".repeat(64)}  node-v24.11.0-darwin-arm64.tar.gz`,
					`${"2".repeat(64)}  node-v24.11.0-darwin-x64.tar.gz`,
				].join("\n"),
			),
			"https://api.github.com/repos/cli/cli/releases/latest": JSON.stringify({ tag_name: "v2.102.0" }),
			"https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt": [
				`${"3".repeat(64)}  gh_2.102.0_macOS_arm64.zip`,
				`${"4".repeat(64)}  gh_2.102.0_macOS_amd64.zip`,
			].join("\n"),
		};
		const options = await serve(pages);
		const files = async (item: "gh" | "node", arch: string) =>
			(await resolveArchiveRelease(item, arch, options)).file;
		expect(await files("node", "arm64")).toBe("node-v24.11.0-darwin-arm64.tar.gz");
		expect(await files("node", "x64")).toBe("node-v24.11.0-darwin-x64.tar.gz");
		expect(await files("gh", "arm64")).toBe("gh_2.102.0_macOS_arm64.zip");
		expect(await files("gh", "x64")).toBe("gh_2.102.0_macOS_amd64.zip");
	});

	it("resolves Node and gh with their published checksums, and refuses a release without one", async () => {
		const pages: Record<string, string> = {
			...nodePages(
				[{ version: "v24.11.0", lts: "Krypton" }],
				"v24.11.0",
				`${SHA}  node-v24.11.0-darwin-arm64.tar.gz\n`,
			),
			"https://api.github.com/repos/cli/cli/releases/latest": JSON.stringify({ tag_name: "v2.102.0" }),
			"https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt": `${SHA}  gh_2.102.0_macOS_arm64.zip\n`,
		};
		const options = await serve(pages);
		await expect(resolveArchiveRelease("node", "arm64", options)).resolves.toEqual({
			item: "node",
			version: "v24.11.0",
			file: "node-v24.11.0-darwin-arm64.tar.gz",
			url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz",
			sha256: SHA,
		});
		await expect(resolveArchiveRelease("gh", "arm64", options)).resolves.toMatchObject({
			version: "2.102.0",
			url: "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_arm64.zip",
			sha256: SHA,
		});
		await expect(resolveArchiveRelease("gh", "x64", options)).rejects.toThrow(/No published SHA-256/);
		pages[NODE_INDEX] = "[]";
		await expect(resolveArchiveRelease("node", "arm64", options)).rejects.toThrow(/no supported LTS/);
		// A page the publisher does not serve reads as its status, naming the real address.
		await expect(resolveArchiveRelease("node", "arm64", await serve({}))).rejects.toThrow(
			`${NODE_INDEX} answered 404`,
		);
	});

	it("sends the GitHub token to api.github.com only, and says who is asking", async () => {
		const pages: Record<string, string> = {
			"https://api.github.com/repos/cli/cli/releases/latest": JSON.stringify({ tag_name: "v2.102.0" }),
			"https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt": `${SHA}  gh_2.102.0_macOS_arm64.zip\n`,
		};
		const options = await serve(pages);
		await resolveArchiveRelease("gh", "arm64", { ...options, githubToken: "secret" });
		expect(mirror?.headers.map(headers => headers.authorization)).toEqual(["Bearer secret", undefined]);
		expect(mirror?.headers.map(headers => headers["user-agent"])).toEqual(["ompdesk-setup", "ompdesk-setup"]);
	});
});

describe("agent-desktop release lookup", () => {
	const API = "https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest";
	const SUMS = "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/checksums.txt";
	const listing = [
		`${"1".repeat(64)}  agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz`,
		`${"2".repeat(64)}  agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz`,
		`${"3".repeat(64)}  agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz`,
		`${"4".repeat(64)}  agent-desktop-v1.2.0-aarch64-pc-windows-msvc.tar.gz`,
	].join("\n");
	const serveRelease = (pages: Record<string, string> = {}) =>
		serve({ [API]: JSON.stringify({ tag_name: "v1.2.0" }), [SUMS]: listing, ...pages });

	it("takes the newest release's archive for each target with the hash its checksums.txt lists", async () => {
		const base = "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0";
		const cases = [
			["darwin", "arm64", "aarch64-apple-darwin", "1"],
			["darwin", "x64", "x86_64-apple-darwin", "2"],
			["win32", "x64", "x86_64-pc-windows-msvc", "3"],
			["win32", "arm64", "aarch64-pc-windows-msvc", "4"],
		] as const;
		const options = await serveRelease();
		for (const [platform, arch, target, digit] of cases) {
			await expect(resolveAgentDesktopRelease(platform, arch, options)).resolves.toEqual({
				item: "agent-desktop",
				version: "1.2.0",
				file: `agent-desktop-v1.2.0-${target}.tar.gz`,
				url: `${base}/agent-desktop-v1.2.0-${target}.tar.gz`,
				sha256: digit.repeat(64),
			});
		}
	});

	it("refuses an architecture without a release before asking GitHub anything", async () => {
		const options = await serveRelease();
		await expect(resolveAgentDesktopRelease("win32", "ia32", options)).rejects.toThrow(/no release for win32 ia32/);
		expect(mirror?.asked).toEqual([]);
	});

	it("refuses a tag that is no plain version, and a release whose checksums.txt omits the file", async () => {
		for (const tag of ["nightly", "v1.2", "v1.2.0-rc.1", "../v1.2.0"]) {
			await expect(
				resolveAgentDesktopRelease(
					"darwin",
					"arm64",
					await serveRelease({ [API]: JSON.stringify({ tag_name: tag }) }),
				),
			).rejects.toThrow(/no agent-desktop release/);
		}
		await expect(
			resolveAgentDesktopRelease(
				"darwin",
				"arm64",
				await serveRelease({ [SUMS]: `${"1".repeat(64)}  other.tar.gz` }),
			),
		).rejects.toThrow(/No published SHA-256 for agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz/);
	});
});

describe("Tailscale release lookup", () => {
	const index = {
		MSIs: {
			amd64: "tailscale-setup-1.104.1-amd64.msi",
			arm64: "tailscale-setup-1.104.1-arm64.msi",
			x86: "tailscale-setup-1.104.1-x86.msi",
		},
		MSIsVersion: "1.104.1",
		MacZips: { universal: "Tailscale-1.104.1-macos.zip", "universal-package": "Tailscale-1.104.1-macos.pkg" },
		MacZipsVersion: "1.104.1",
		Version: "1.104.1",
	};
	const serveIndex = (overrides: Record<string, unknown> = {}, sha = `${SHA}  file\n`) =>
		serve(url => (url.endsWith(".sha256") ? sha : JSON.stringify({ ...index, ...overrides })));

	it("takes the macOS zip with the hash published beside it, from pkgs.tailscale.com only", async () => {
		const options = await serveIndex();
		await expect(resolveTailscaleRelease("darwin", null, options)).resolves.toEqual({
			version: "1.104.1",
			file: "Tailscale-1.104.1-macos.zip",
			url: "https://pkgs.tailscale.com/stable/Tailscale-1.104.1-macos.zip",
			sha256: SHA,
		});
		expect(mirror?.asked).toEqual([
			"https://pkgs.tailscale.com/stable/?mode=json",
			"https://pkgs.tailscale.com/stable/Tailscale-1.104.1-macos.zip.sha256",
		]);
	});

	it("takes the MSI of the machine's architecture", async () => {
		const options = await serveIndex();
		for (const arch of ["amd64", "arm64", "x86"] as const) {
			const release = await resolveTailscaleRelease("win32", arch, options);
			expect(release.file).toBe(`tailscale-setup-1.104.1-${arch}.msi`);
			expect(release.url).toBe(`https://pkgs.tailscale.com/stable/tailscale-setup-1.104.1-${arch}.msi`);
		}
		await expect(resolveTailscaleRelease("win32", null, options)).rejects.toThrow(/no installer for this processor/);
	});

	it("refuses an index or hash it cannot trust", async () => {
		const lookup = async (overrides: Record<string, unknown>, sha?: string) =>
			resolveTailscaleRelease("darwin", null, await serveIndex(overrides, sha));
		await expect(lookup({ MacZips: {} })).rejects.toThrow(/lists no installer/);
		await expect(lookup({ MacZips: { universal: "../../evil.zip" } })).rejects.toThrow(/lists no installer/);
		await expect(lookup({ MacZips: { universal: "https://evil.example/x.zip" } })).rejects.toThrow(
			/lists no installer/,
		);
		await expect(lookup({ MacZipsVersion: "latest", Version: "x" })).rejects.toThrow(/lists no installer/);
		await expect(lookup({}, "not a hash")).rejects.toThrow(/No published SHA-256/);
	});
});
