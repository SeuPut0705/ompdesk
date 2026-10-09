import { createHash } from "node:crypto";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { findFile } from "electron-updater/out/providers/Provider";
import { describe, expect, it } from "vitest";
import { type ReleaseFeed, releaseUpdateProvider } from "./update-provider";
import {
	NO_RELEASE_ERROR,
	type PlatformRelease,
	RELEASE_LOOKUP_ERROR,
	UPDATE_ASSETS,
	UPDATE_METADATA_ERROR,
} from "./update-release";

const API = "https://api.github.com/repos/SeuPut0705/ompdesk";
const sha512 = (bytes: string) => createHash("sha512").update(bytes).digest("base64");

const metadata = {
	version: "0.18.0",
	releaseDate: "2026-10-09T12:00:00.000Z",
	files: {
		mac: { name: UPDATE_ASSETS.mac, size: 120, sha512: sha512("mac") },
		windows: { name: UPDATE_ASSETS.windows, size: 90, sha512: sha512("windows") },
	},
};

const releasePayload = (tag = "v0.18.0", body = `Notes.\n\n<!-- ompdesk-update ${JSON.stringify(metadata)} -->`) => ({
	tag_name: tag,
	name: tag,
	body,
	draft: false,
	prerelease: tag.includes("-"),
	html_url: `https://github.com/SeuPut0705/ompdesk/releases/tag/${tag}`,
	assets: [
		{ id: 11, name: UPDATE_ASSETS.mac, size: 120, url: `${API}/releases/assets/11` },
		{ id: 12, name: UPDATE_ASSETS.windows, size: 90, url: `${API}/releases/assets/12` },
	],
});

function feedFor(response: () => Response, overrides: Partial<ReleaseFeed> = {}) {
	const requests: { url: string; headers: Record<string, string> }[] = [];
	const resolved: PlatformRelease[] = [];
	const feed: ReleaseFeed = {
		apiRepo: API,
		platform: "windows",
		allowPrerelease: false,
		apiHeaders: { accept: "application/vnd.github+json", authorization: "Bearer t" },
		downloadHeaders: { accept: "application/octet-stream", authorization: "Bearer t" },
		fetch: async (url, init) => {
			requests.push({ url, headers: init.headers });
			return response();
		},
		onResolved: release => resolved.push(release),
		...overrides,
	};
	// electron-updater's createClient runs `new updateProvider(options, updater, runtimeOptions)`.
	const ReleaseNotesProvider = releaseUpdateProvider(feed);
	const provider = new ReleaseNotesProvider({ provider: "custom" }, undefined, {
		isUseMultipleRangeRequest: false,
		platform: "win32",
		executor: new ElectronHttpExecutor(),
	});
	return { provider, requests, resolved };
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

describe("release-notes update provider", () => {
	it("builds electron-updater's UpdateInfo from the metadata comment", async () => {
		const { provider, requests, resolved } = feedFor(() => json(releasePayload()));
		const info = await provider.getLatestVersion();

		expect(requests).toEqual([
			{ url: `${API}/releases/latest`, headers: expect.objectContaining({ authorization: "Bearer t" }) },
		]);
		expect(info).toEqual({
			version: "0.18.0",
			releaseDate: "2026-10-09T12:00:00.000Z",
			releaseName: "v0.18.0",
			// The banner shows these; the comment never reaches it.
			releaseNotes: "Notes.",
			files: [{ url: UPDATE_ASSETS.windows, sha512: sha512("windows"), size: 90 }],
			path: UPDATE_ASSETS.windows,
			sha512: sha512("windows"),
		});
		expect(resolved.map(release => release.assetUrl)).toEqual([`${API}/releases/assets/12`]);
	});

	it("points the NSIS download at the API asset endpoint with the token", async () => {
		const { provider } = feedFor(() => json(releasePayload()));
		const info = await provider.getLatestVersion();
		// NsisUpdater's own lookup: the `.exe` file of resolveFiles().
		const file = findFile(provider.resolveFiles(info), "exe");

		expect(file?.url.href).toBe(`${API}/releases/assets/12`);
		expect(file?.info).toEqual({ url: UPDATE_ASSETS.windows, sha512: sha512("windows"), size: 90 });
		expect(provider.fileExtraDownloadHeaders).toEqual({
			accept: "application/octet-stream",
			authorization: "Bearer t",
		});
	});

	it("gives macOS the DMG of the same release", async () => {
		const { provider, resolved } = feedFor(() => json(releasePayload()), { platform: "mac" });
		const info = await provider.getLatestVersion();

		expect(info.files).toEqual([{ url: UPDATE_ASSETS.mac, sha512: sha512("mac"), size: 120 }]);
		expect(resolved[0]?.assetUrl).toBe(`${API}/releases/assets/11`);
	});

	it("lists releases and takes the newest pre-release only when pre-releases are allowed", async () => {
		const pre = releasePayload(
			"v99.0.0-test.1",
			`<!-- ompdesk-update ${JSON.stringify({ ...metadata, version: "99.0.0-test.1" })} -->`,
		);
		const { provider, requests } = feedFor(() => json([pre, releasePayload()]), { allowPrerelease: true });

		expect((await provider.getLatestVersion()).version).toBe("99.0.0-test.1");
		expect(requests[0]?.url).toBe(`${API}/releases?per_page=30`);
	});

	it("fails a release without metadata instead of offering an update", async () => {
		const { provider, resolved } = feedFor(() => json(releasePayload("v0.18.0", "Notes only.")));
		await expect(provider.getLatestVersion()).rejects.toMatchObject({ code: UPDATE_METADATA_ERROR });
		expect(resolved).toEqual([]);
	});

	it("maps GitHub's answers to the codes runCheck classifies", async () => {
		await expect(
			feedFor(() => json({ message: "Not Found" }, 404)).provider.getLatestVersion(),
		).rejects.toMatchObject({
			code: NO_RELEASE_ERROR,
		});
		await expect(feedFor(() => json({ message: "oops" }, 502)).provider.getLatestVersion()).rejects.toMatchObject({
			code: RELEASE_LOOKUP_ERROR,
		});
	});

	it("refuses to resolve files for a version it did not resolve", async () => {
		const { provider } = feedFor(() => json(releasePayload()));
		const info = await provider.getLatestVersion();
		expect(() => provider.resolveFiles({ ...info, version: "0.18.1" })).toThrow(/No resolved release for 0\.18\.1/);
	});
});
