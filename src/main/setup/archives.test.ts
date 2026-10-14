import { describe, expect, it } from "vitest";
import { ghArchiveFile, nodeArchiveFile, parseShasums, pickNodeLts, resolveArchiveRelease } from "./archives";

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
