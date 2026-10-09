import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	type GitHubRelease,
	NO_RELEASE_ERROR,
	parseUpdateMetadata,
	pickRelease,
	RELEASE_LOOKUP_ERROR,
	ReleaseFeedError,
	resolvePlatformRelease,
	stripUpdateMetadata,
	UPDATE_ASSETS,
	UPDATE_METADATA_ERROR,
	UPDATE_PLATFORM_ERROR,
	type UpdateMetadata,
} from "./update-release";

const sha512 = (bytes: string) => createHash("sha512").update(bytes).digest("base64");

const METADATA: UpdateMetadata = {
	version: "0.18.0",
	releaseDate: "2026-10-09T12:00:00.000Z",
	files: {
		mac: { name: UPDATE_ASSETS.mac, size: 120, sha512: sha512("mac") },
		windows: { name: UPDATE_ASSETS.windows, size: 90, sha512: sha512("windows") },
	},
};

/** The comment exactly as the publish job's jq writes it. */
const comment = (metadata: unknown) => `<!-- ompdesk-update ${JSON.stringify(metadata)} -->`;
const NOTES = "### Changes\n\n- Two assets.\n\n---\n\nRequires omp **18.7.0** or newer (`omp update`).";

const release = (overrides: Partial<GitHubRelease> = {}): GitHubRelease => ({
	tag_name: "v0.18.0",
	name: "v0.18.0",
	body: `${NOTES}\n\n${comment(METADATA)}\n`,
	draft: false,
	prerelease: false,
	assets: [
		{ id: 1, name: UPDATE_ASSETS.mac, size: 120, url: "https://api.github.com/repos/o/r/releases/assets/1" },
		{ id: 2, name: UPDATE_ASSETS.windows, size: 90, url: "https://api.github.com/repos/o/r/releases/assets/2" },
	],
	...overrides,
});

const codeOf = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		return error instanceof ReleaseFeedError ? error.code : "not a ReleaseFeedError";
	}
	return "no error";
};

describe("update metadata comment", () => {
	it("round-trips through the notes and leaves them readable", () => {
		const body = `${NOTES}\n\n${comment(METADATA)}\n`;
		expect(parseUpdateMetadata(body)).toEqual(METADATA);
		expect(stripUpdateMetadata(body)).toBe(NOTES);
	});

	it("treats missing, repeated or malformed comments as unusable releases", () => {
		expect(codeOf(() => parseUpdateMetadata(NOTES))).toBe(UPDATE_METADATA_ERROR);
		expect(codeOf(() => parseUpdateMetadata(null))).toBe(UPDATE_METADATA_ERROR);
		expect(codeOf(() => parseUpdateMetadata(`${comment(METADATA)}\n${comment(METADATA)}`))).toBe(
			UPDATE_METADATA_ERROR,
		);
		expect(codeOf(() => parseUpdateMetadata("<!-- ompdesk-update {not json} -->"))).toBe(UPDATE_METADATA_ERROR);
	});

	it("names what is wrong in an invalid comment", () => {
		const hexDigest = { ...METADATA.files.mac, sha512: createHash("sha512").update("mac").digest("hex") };
		expect(() => parseUpdateMetadata(comment({ ...METADATA, files: { mac: hexDigest } }))).toThrow(
			/files\.mac\.sha512: sha512 must be a base64 SHA-512 digest/,
		);
		expect(() => parseUpdateMetadata(comment({ ...METADATA, version: "latest" }))).toThrow(
			/version: version must be semver/,
		);
		// Asset names are part of the contract: a renamed installer is not silently accepted.
		const renamed = { ...METADATA.files.windows, name: "ompdesk-windows-portable.exe" };
		expect(() => parseUpdateMetadata(comment({ ...METADATA, files: { windows: renamed } }))).toThrow(
			/files\.windows\.name/,
		);
	});
});

describe("platform release resolution", () => {
	it("hands each platform its installer with the API asset endpoint", () => {
		expect(resolvePlatformRelease(release(), "mac")).toEqual({
			version: "0.18.0",
			releaseDate: METADATA.releaseDate,
			releaseName: "v0.18.0",
			notes: NOTES,
			file: METADATA.files.mac,
			assetUrl: "https://api.github.com/repos/o/r/releases/assets/1",
		});
		expect(resolvePlatformRelease(release(), "windows").assetUrl).toBe(
			"https://api.github.com/repos/o/r/releases/assets/2",
		);
	});

	it("reports a release without this platform's installer as a platform error", () => {
		const macOnly = comment({ ...METADATA, files: { mac: METADATA.files.mac } });
		expect(codeOf(() => resolvePlatformRelease(release({ body: macOnly }), "windows"))).toBe(UPDATE_PLATFORM_ERROR);
		expect(resolvePlatformRelease(release({ body: macOnly }), "mac").file).toEqual(METADATA.files.mac);
	});

	it("rejects metadata that contradicts the release it sits in", () => {
		expect(codeOf(() => resolvePlatformRelease(release({ tag_name: "v0.18.1" }), "mac"))).toBe(UPDATE_METADATA_ERROR);
		expect(codeOf(() => resolvePlatformRelease(release({ assets: release().assets.slice(1) }), "mac"))).toBe(
			UPDATE_METADATA_ERROR,
		);
		const resized = release().assets.map(asset => ({ ...asset, size: asset.size + 1 }));
		expect(codeOf(() => resolvePlatformRelease(release({ assets: resized }), "mac"))).toBe(UPDATE_METADATA_ERROR);
	});

	it("treats a release without the comment (any release before v0.18.0) as unusable", () => {
		expect(codeOf(() => resolvePlatformRelease(release({ body: NOTES }), "mac"))).toBe(UPDATE_METADATA_ERROR);
	});
});

describe("release selection", () => {
	const stable = release();
	const pre = release({ tag_name: "v99.0.0-test.1", prerelease: true });
	const draft = release({ tag_name: "v99.0.0-draft", prerelease: true, draft: true });

	it("takes /releases/latest as is when pre-releases are off", () => {
		expect(pickRelease(stable, false)).toEqual(stable);
	});

	it("takes the newest non-draft pre-release, else the newest release, when they are on", () => {
		expect(pickRelease([draft, pre, stable], true)).toEqual(pre);
		expect(pickRelease([draft, stable], true)).toEqual(stable);
		expect(codeOf(() => pickRelease([draft], true))).toBe(NO_RELEASE_ERROR);
	});

	it("rejects payloads that are not GitHub releases", () => {
		expect(codeOf(() => pickRelease({ message: "Bad credentials" }, false))).toBe(RELEASE_LOOKUP_ERROR);
		expect(codeOf(() => pickRelease(stable, true))).toBe(RELEASE_LOOKUP_ERROR);
	});
});

interface ReleaseWorkflow {
	jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
}

// The publish job's own script on fake installers, parsed back: the workflow
// and the updater agree on the format (bash, jq and openssl as on its runner).
describe.runIf(process.platform !== "win32")("release workflow metadata step", () => {
	it("writes a comment the updater parses, with each file's real size and SHA-512", () => {
		const workflow = parse(
			fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "release.yml"), "utf8"),
		) as ReleaseWorkflow;
		const script = workflow.jobs.publish?.steps.find(step => step.name === "Append update metadata")?.run;
		expect(script).toBeDefined();

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-release-notes-"));
		try {
			fs.mkdirSync(path.join(dir, "dist"));
			fs.mkdirSync(path.join(dir, "notes"));
			fs.writeFileSync(path.join(dir, "dist", UPDATE_ASSETS.mac), "fake dmg bytes");
			fs.writeFileSync(path.join(dir, "dist", UPDATE_ASSETS.windows), "fake setup bytes, longer");
			fs.writeFileSync(path.join(dir, "notes", "notes.md"), `${NOTES}\n`);

			const result = spawnSync("bash", ["-c", script ?? ""], {
				cwd: dir,
				env: { PATH: process.env.PATH, VERSION: "0.18.0" },
				encoding: "utf8",
			});
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);

			const notes = fs.readFileSync(path.join(dir, "notes", "notes.md"), "utf8");
			const metadata = parseUpdateMetadata(notes);
			expect(metadata).toEqual({
				version: "0.18.0",
				releaseDate: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/),
				files: {
					mac: { name: UPDATE_ASSETS.mac, size: 14, sha512: sha512("fake dmg bytes") },
					windows: { name: UPDATE_ASSETS.windows, size: 24, sha512: sha512("fake setup bytes, longer") },
				},
			});
			expect(stripUpdateMetadata(notes)).toBe(NOTES);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
