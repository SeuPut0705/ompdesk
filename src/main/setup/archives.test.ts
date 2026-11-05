import { describe, expect, it } from "vitest";
import {
	ghArchiveFile,
	nodeArchiveFile,
	parseShasums,
	pickNodeLts,
	resolveAgentDesktopRelease,
	resolveArchiveRelease,
	resolveTailscaleRelease,
} from "./archives";

const SHA = "b".repeat(64);

describe("archive releases", () => {
	it("picks the newest LTS that REA's engines accept", () => {
		expect(
			pickNodeLts([
				{ version: "v26.11.1", lts: false },
				{ version: "v24.10.0", lts: "Krypton" },
				{ version: "v24.11.0", lts: "Krypton" },
			]),
		).toBe("v24.11.0");
		expect(pickNodeLts([{ version: "v20.19.0", lts: "Iron" }])).toBeNull();
		expect(pickNodeLts({ not: "a list" })).toBeNull();
	});

	it("reads one file's hash from a sha256sum listing", () => {
		const listing = `${"a".repeat(64)}  node-v24.11.0-darwin-x64.tar.gz\n${SHA.toUpperCase()}  node-v24.11.0-darwin-arm64.tar.gz\n`;
		expect(parseShasums(listing, "node-v24.11.0-darwin-arm64.tar.gz")).toBe(SHA);
		expect(parseShasums(listing, "node-v24.11.0-darwin-arm64.tar.xz")).toBeNull();
	});

	it("names the macOS archives per architecture", () => {
		expect(nodeArchiveFile("v24.11.0", "arm64")).toBe("node-v24.11.0-darwin-arm64.tar.gz");
		expect(nodeArchiveFile("v24.11.0", "x64")).toBe("node-v24.11.0-darwin-x64.tar.gz");
		expect(ghArchiveFile("v2.102.0", "arm64")).toBe("gh_2.102.0_macOS_arm64.zip");
		expect(ghArchiveFile("2.102.0", "x64")).toBe("gh_2.102.0_macOS_amd64.zip");
	});

	it("resolves Node and gh with their published checksums, and refuses a release without one", async () => {
		const pages: Record<string, string> = {
			"https://nodejs.org/dist/index.json": JSON.stringify([{ version: "v24.11.0", lts: "Krypton" }]),
			"https://nodejs.org/dist/v24.11.0/SHASUMS256.txt": `${SHA}  node-v24.11.0-darwin-arm64.tar.gz\n`,
			"https://api.github.com/repos/cli/cli/releases/latest": JSON.stringify({ tag_name: "v2.102.0" }),
			"https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt": `${SHA}  gh_2.102.0_macOS_arm64.zip\n`,
		};
		const fetchText = async (url: string) => {
			const page = pages[url];
			if (page === undefined) throw new Error(`${url} answered 404`);
			return page;
		};
		await expect(resolveArchiveRelease("node", "arm64", fetchText)).resolves.toEqual({
			item: "node",
			version: "v24.11.0",
			file: "node-v24.11.0-darwin-arm64.tar.gz",
			url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz",
			sha256: SHA,
		});
		await expect(resolveArchiveRelease("gh", "arm64", fetchText)).resolves.toMatchObject({
			version: "2.102.0",
			url: "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_arm64.zip",
			sha256: SHA,
		});
		await expect(resolveArchiveRelease("gh", "x64", fetchText)).rejects.toThrow(/No published SHA-256/);
		await expect(resolveArchiveRelease("node", "arm64", async () => "[]")).rejects.toThrow(/no supported LTS/);
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
	const serve = (pages: Record<string, string> = {}) => {
		const all: Record<string, string> = { [API]: JSON.stringify({ tag_name: "v1.2.0" }), [SUMS]: listing, ...pages };
		const asked: string[] = [];
		return {
			asked,
			fetchText: async (url: string) => {
				asked.push(url);
				const page = all[url];
				if (page === undefined) throw new Error(`${url} answered 404`);
				return page;
			},
		};
	};

	it("takes the newest release's archive for each target with the hash its checksums.txt lists", async () => {
		const base = "https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0";
		const cases = [
			["darwin", "arm64", "aarch64-apple-darwin", "1"],
			["darwin", "x64", "x86_64-apple-darwin", "2"],
			["win32", "x64", "x86_64-pc-windows-msvc", "3"],
			["win32", "arm64", "aarch64-pc-windows-msvc", "4"],
		] as const;
		for (const [platform, arch, target, digit] of cases) {
			await expect(resolveAgentDesktopRelease(platform, arch, serve().fetchText)).resolves.toEqual({
				item: "agent-desktop",
				version: "1.2.0",
				file: `agent-desktop-v1.2.0-${target}.tar.gz`,
				url: `${base}/agent-desktop-v1.2.0-${target}.tar.gz`,
				sha256: digit.repeat(64),
			});
		}
	});

	it("refuses an architecture without a release before asking GitHub anything", async () => {
		const server = serve();
		await expect(resolveAgentDesktopRelease("win32", "ia32", server.fetchText)).rejects.toThrow(
			/no release for win32 ia32/,
		);
		expect(server.asked).toEqual([]);
	});

	it("refuses a tag that is no plain version, and a release whose checksums.txt omits the file", async () => {
		for (const tag of ["nightly", "v1.2", "v1.2.0-rc.1", "../v1.2.0"]) {
			await expect(
				resolveAgentDesktopRelease(
					"darwin",
					"arm64",
					serve({ [API]: JSON.stringify({ tag_name: tag }) }).fetchText,
				),
			).rejects.toThrow(/no agent-desktop release/);
		}
		await expect(
			resolveAgentDesktopRelease("darwin", "arm64", serve({ [SUMS]: `${"1".repeat(64)}  other.tar.gz` }).fetchText),
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
	const serve = (overrides: Record<string, unknown> = {}, sha = `${SHA}  file\n`) => {
		const asked: string[] = [];
		const fetchText = async (url: string) => {
			asked.push(url);
			return url.endsWith(".sha256") ? sha : JSON.stringify({ ...index, ...overrides });
		};
		return { asked, fetchText };
	};

	it("takes the macOS zip with the hash published beside it, from pkgs.tailscale.com only", async () => {
		const { asked, fetchText } = serve();
		await expect(resolveTailscaleRelease("darwin", null, fetchText)).resolves.toEqual({
			version: "1.104.1",
			file: "Tailscale-1.104.1-macos.zip",
			url: "https://pkgs.tailscale.com/stable/Tailscale-1.104.1-macos.zip",
			sha256: SHA,
		});
		expect(asked).toEqual([
			"https://pkgs.tailscale.com/stable/?mode=json",
			"https://pkgs.tailscale.com/stable/Tailscale-1.104.1-macos.zip.sha256",
		]);
	});

	it("takes the MSI of the machine's architecture", async () => {
		for (const arch of ["amd64", "arm64", "x86"] as const) {
			const release = await resolveTailscaleRelease("win32", arch, serve().fetchText);
			expect(release.file).toBe(`tailscale-setup-1.104.1-${arch}.msi`);
			expect(release.url).toBe(`https://pkgs.tailscale.com/stable/tailscale-setup-1.104.1-${arch}.msi`);
		}
		await expect(resolveTailscaleRelease("win32", null, serve().fetchText)).rejects.toThrow(
			/no installer for this processor/,
		);
	});

	it("refuses an index or hash it cannot trust", async () => {
		await expect(resolveTailscaleRelease("darwin", null, serve({ MacZips: {} }).fetchText)).rejects.toThrow(
			/lists no installer/,
		);
		await expect(
			resolveTailscaleRelease("darwin", null, serve({ MacZips: { universal: "../../evil.zip" } }).fetchText),
		).rejects.toThrow(/lists no installer/);
		await expect(
			resolveTailscaleRelease(
				"darwin",
				null,
				serve({ MacZips: { universal: "https://evil.example/x.zip" } }).fetchText,
			),
		).rejects.toThrow(/lists no installer/);
		await expect(
			resolveTailscaleRelease("darwin", null, serve({ MacZipsVersion: "latest", Version: "x" }).fetchText),
		).rejects.toThrow(/lists no installer/);
		await expect(resolveTailscaleRelease("darwin", null, serve({}, "not a hash").fetchText)).rejects.toThrow(
			/No published SHA-256/,
		);
	});
});
