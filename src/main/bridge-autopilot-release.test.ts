import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileIo, type GuideIo } from "../../resources/gui-bridge/modes/autopilot-guide";
import {
	guideRelease,
	releaseSectionTemplate,
	releaseVerdict,
	withReleaseSection,
} from "../../resources/gui-bridge/modes/autopilot-release-core";
import { collectReleaseFacts, readWorkflow } from "../../resources/gui-bridge/modes/autopilot-release-facts";
import { withoutGitSelectors } from "../shared/git-env";

const NOW = Date.parse("2026-10-21T00:00:00Z");
const DAY = 86_400_000;
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, args: string[], at?: number): string {
	const date =
		at === undefined
			? {}
			: { GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() };
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...withoutGitSelectors(process.env), ...date },
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/** The bridge's own reads over a real checkout; no gh on a test machine's word. */
const io: GuideIo = fileIo(async (command, args, cwd) => {
	if (command !== "git") return null;
	try {
		return git(cwd, args);
	} catch {
		return null;
	}
});

async function repo(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "omp-release-facts-"));
	dirs.push(dir);
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "t@example.com"]);
	git(dir, ["config", "user.name", "T"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	git(dir, ["config", "tag.gpgsign", "false"]);
	for (const [name, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
		await fs.writeFile(path.join(dir, name), text);
	}
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "chore: seed"], NOW - 100 * DAY);
	return dir;
}

async function commit(dir: string, subject: string, daysAgo: number, tag?: string): Promise<void> {
	await fs.appendFile(path.join(dir, "log.txt"), `${subject}\n`);
	git(dir, ["add", "log.txt"]);
	git(dir, ["commit", "-q", "-m", subject], NOW - daysAgo * DAY);
	if (tag) git(dir, ["tag", tag], NOW - daysAgo * DAY);
}

describe("release facts of real repositories", () => {
	it("an npm package that tags its releases and publishes from a tag workflow", async () => {
		const dir = await repo({
			"package.json": JSON.stringify({
				name: "tiny-lib",
				version: "1.4.0",
				scripts: { test: "vitest", release: "changeset publish" },
			}),
			"CHANGELOG.md": "# Changelog\n\n## [1.4.0] - 2026-10-11\n\n- Faster.\n\n## [1.3.0] - 2026-09-21\n",
			".github/workflows/ci.yml":
				"name: CI\non:\n  push:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: npm test\n",
			".github/workflows/publish.yml": [
				"name: Publish",
				"on:",
				"  push:",
				"    tags:",
				"      - 'v*'",
				"jobs:",
				"  publish:",
				"    steps:",
				"      - run: npm publish --provenance",
				"        env:",
				`          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`,
				`          GH: \${{ secrets.GITHUB_TOKEN }}`,
				"",
			].join("\n"),
		});
		await commit(dir, "feat: parse dates", 70);
		await commit(dir, "chore(release): v1.2.0", 60, "v1.2.0");
		await commit(dir, "fix: leap years", 40);
		await commit(dir, "chore(release): v1.3.0", 30, "v1.3.0");
		await commit(dir, "feat: faster", 15);
		await commit(dir, "chore(release): v1.4.0", 10, "v1.4.0");
		const facts = await collectReleaseFacts(dir, io, { now: NOW, checks: ["npm run test"] });
		expect(facts.workflows).toEqual([
			{
				file: ".github/workflows/publish.yml",
				triggers: ["a pushed tag v*"],
				onDefaultPush: false,
				onTag: true,
				dispatch: false,
				paths: [],
				onReleaseEvent: false,
				publishes: ["npm"],
				deploys: [],
				secrets: ["NPM_TOKEN"],
			},
		]);
		expect(facts.manifests).toEqual([{ file: "package.json", version: "1.4.0" }]);
		expect(facts.publishScripts).toEqual(["package.json scripts.release: changeset publish"]);
		expect(facts.changelog).toEqual({
			file: "CHANGELOG.md",
			style: "keep-a-changelog",
			latest: "## [1.4.0] - 2026-10-11",
		});
		expect(facts.tags).toEqual({
			total: 3,
			last90: 3,
			medianGapDays: 20,
			latest: { name: "v1.4.0", date: "2026-10-11", subject: "chore(release): v1.4.0" },
		});
		expect(facts.conventional).toBe(true);
		const verdict = releaseVerdict(facts);
		expect(verdict).toMatchObject({ releases: true, via: "workflow" });
		const section = releaseSectionTemplate(facts, verdict);
		expect(guideRelease(section)).toEqual({ title: "Release", releases: true, marked: true });
		expect(section).toContain("a `feat` since the last release makes it minor");
		expect(section).toContain("bump the version in `package.json`");
		expect(section).toContain("add `## [X.Y.Z] - YYYY-MM-DD` on top of `CHANGELOG.md`");
		expect(section).toContain("`npm run test` pass");
		expect(section).toContain("touches only `package.json` and `CHANGELOG.md`, message `chore(release): vX.Y.Z`");
		expect(section).toContain("`git push origin HEAD:main` (fast-forward only), then `git tag vX.Y.Z`");
		expect(section).toContain(
			"`.github/workflows/publish.yml` publishes (npm). It reads the repository secrets NPM_TOKEN.",
		);
		expect(section).toContain(
			"3 releases in the last 90 days, about every 20 days; when this guide was written the latest was v1.4.0 on 2026-10-11.",
		);
		expect(section).not.toMatch(/npm publish|changeset publish`? *\n/);
	});

	it("an Electron app whose release workflow publishes on a version push to main", async () => {
		const dir = await repo({
			"package.json": JSON.stringify({
				name: "desk-app",
				version: "0.48.0",
				private: true,
				scripts: { "package:mac": "electron-builder --mac", test: "vitest" },
			}),
			"CHANGELOG.md": "# Changelog\n\n## [0.48.0] - 2026-10-20\n",
			".github/workflows/release.yml": [
				"name: Release",
				"on:",
				"  push:",
				"    branches: [main]",
				"    paths: [package.json]",
				"  workflow_dispatch:",
				"jobs:",
				"  mac:",
				"    steps:",
				"      - run: bun run package:mac -- --publish never",
				"        env:",
				`          CSC: \${{ secrets.MAC_SIGNING_P12_BASE64 }}`,
				"  publish:",
				"    steps:",
				'      - run: gh release create "v$VERSION" dist/*',
				"",
			].join("\n"),
		});
		await commit(dir, "release: v0.47.0", 2, "v0.47.0");
		await commit(dir, "release: v0.48.0", 1, "v0.48.0");
		const facts = await collectReleaseFacts(dir, io, { now: NOW });
		expect(facts.workflows[0]).toMatchObject({
			triggers: ["a push to main changing package.json", "manual dispatch"],
			onDefaultPush: true,
			onReleaseEvent: false,
			paths: ["package.json"],
			publishes: ["electron-builder", "GitHub release"],
			secrets: ["MAC_SIGNING_P12_BASE64"],
		});
		const verdict = releaseVerdict(facts);
		const section = releaseSectionTemplate(facts, verdict);
		expect(section).toContain(
			"Publish: push the release commit with `git push origin HEAD:main` (fast-forward only) (it runs only when the push changes `package.json`); `.github/workflows/release.yml` publishes (electron-builder, GitHub release).",
		);
		expect(section).toContain("message `release: vX.Y.Z`");
		expect(section).not.toContain("git tag");
		// A rules file's own procedure wins: the section points there and adds only the cadence.
		const ruled = releaseSectionTemplate(
			facts,
			releaseVerdict(facts, { file: "AGENTS.md", anchors: ["Change workflow", "Release"] }),
		);
		expect(ruled).toMatch(
			/^## Release\n\nReleases: yes\n- Follow `AGENTS\.md` › Change workflow › Release as written/,
		);
		expect(ruled).toContain("### Cadence\n- 2 releases in the last 90 days, about every 1 day;");
		expect(ruled).not.toContain("### Procedure");
	});

	it("a repository with no tags, no publish path and no hosting says it does not release", async () => {
		const dir = await repo({
			"README.md": "# Notes\n\nPersonal scripts.\n",
			".github/workflows/ci.yml": "on: [push]\njobs:\n  t:\n    steps:\n      - run: make test\n",
		});
		await commit(dir, "add a script", 3);
		const facts = await collectReleaseFacts(dir, io, { now: NOW });
		expect(facts).toMatchObject({
			workflows: [],
			manifests: [],
			publishScripts: [],
			deployConfigs: [],
			tags: { total: 0 },
		});
		expect(facts.conventional).toBe(false);
		const verdict = releaseVerdict(facts);
		expect(verdict).toEqual({ releases: false });
		const section = releaseSectionTemplate(facts, verdict);
		expect(guideRelease(section)).toEqual({ title: "Release", releases: false, marked: true });
		expect(section).toContain("this project does not release");
	});

	it("a GitHub Pages site and a Vercel site release by pushing main", async () => {
		const pages = await repo({
			".github/workflows/pages.yml": [
				"on:",
				"  push:",
				"    branches:",
				"      - main",
				"jobs:",
				"  deploy:",
				"    steps:",
				"      - uses: actions/upload-pages-artifact@v3",
				"      - uses: actions/deploy-pages@v4",
				"",
			].join("\n"),
			"package.json": JSON.stringify({ name: "site", scripts: { build: "astro build" } }),
		});
		const pageFacts = await collectReleaseFacts(pages, io, { now: NOW, checks: ["npm run build"] });
		const pageVerdict = releaseVerdict(pageFacts);
		expect(pageVerdict).toEqual({
			releases: true,
			via: "deploy",
			source: ".github/workflows/pages.yml (GitHub Pages)",
		});
		const pageSection = releaseSectionTemplate(pageFacts, pageVerdict);
		expect(pageSection).toContain(
			"2. Publish: a push to `main` deploys (.github/workflows/pages.yml (GitHub Pages)); release with `git push origin HEAD:main` (fast-forward only).",
		);
		expect(pageSection).not.toContain("Version:");

		const vercel = await repo({ "vercel.json": "{}\n", "index.html": "<h1>hi</h1>\n" });
		const vercelFacts = await collectReleaseFacts(vercel, io, { now: NOW });
		expect(vercelFacts.deployConfigs).toEqual(["vercel.json (Vercel)"]);
		expect(releaseVerdict(vercelFacts)).toEqual({ releases: true, via: "deploy", source: "vercel.json (Vercel)" });
	});
});

describe("workflow triggers", () => {
	it("a tag-only push never runs for a branch push; a release event and dispatch are named", () => {
		const tagOnly = readWorkflow("w/release.yml", "on:\n  push:\n    tags: ['v*']\njobs: {}\n", "main");
		expect(tagOnly).toMatchObject({ onTag: true, onDefaultPush: false });
		const event = readWorkflow(
			"w/publish.yml",
			"on:\n  release:\n    types: [published]\n  workflow_dispatch:\njobs:\n  p:\n    steps:\n      - run: cargo publish\n",
			"main",
		);
		expect(event).toMatchObject({
			triggers: ["a published GitHub release", "manual dispatch"],
			onReleaseEvent: true,
			dispatch: true,
			publishes: ["crates.io"],
		});
		expect(readWorkflow("w/lint.yml", "on: [push]\njobs: {}\n", "main")).toBeNull();
	});

	it("a job named release is no trigger, a CI build of the app publishes nothing, and a push's paths name where the version is bumped", () => {
		const ci = readWorkflow(
			"w/ci.yml",
			"on:\n  push:\n    branches: [main]\njobs:\n  release:\n    steps:\n      - run: bun run package:mac\n",
			"main",
		);
		expect(ci).toBeNull();
		const versioned = readWorkflow(
			"w/release.yml",
			"on:\n  push:\n    branches: [main]\n    paths: [build.sh]\njobs:\n  release:\n    steps:\n      - run: gh release create v1\n",
			"main",
		);
		expect(versioned).toMatchObject({ onReleaseEvent: false, onDefaultPush: true, paths: ["build.sh"] });
		if (!versioned) throw new Error("workflow");
		const facts = {
			defaultBranch: "main",
			workflows: [versioned],
			manifests: [],
			publishScripts: [],
			changelog: { file: "CHANGELOG.md", style: "versioned" as const, latest: "## 0.24.3" },
			tags: {
				total: 15,
				last90: 15,
				medianGapDays: 1,
				latest: { name: "v0.16.0", date: "2026-10-06", subject: "chore: 0.16.0" },
			},
			githubReleases: { last90: 29, latest: { tag: "v0.24.3", date: "2026-10-20" } },
			deployConfigs: [],
			conventional: true,
			checks: [],
		};
		const section = releaseSectionTemplate(facts, releaseVerdict(facts));
		expect(section).toContain("bump the version in `build.sh`");
		expect(section).toContain("touches only `build.sh` and `CHANGELOG.md`, message `chore: X.Y.Z`");
		expect(section).toContain("add `## X.Y.Z` on top of `CHANGELOG.md`");
		// GitHub's releases are newer than the local tags: the cadence names the newest.
		expect(section).toContain(
			"29 releases in the last 90 days, about every 1 day; when this guide was written the latest was v0.24.3 on 2026-10-20.",
		);
	});
});

describe("the guide's Release section", () => {
	it("finds the section by its heading, never a cadence heading, and reads its marker", () => {
		expect(guideRelease("# G\n\n## Release cadence\n\nOften.\n")).toBeNull();
		expect(guideRelease("# G\n\n## Release\n\nReleases: no\n- none\n")).toEqual({
			title: "Release",
			releases: false,
			marked: true,
		});
		expect(guideRelease("# G\n\n## Release\n\n- **Releases: yes**\n")).toMatchObject({
			releases: true,
			marked: true,
		});
		// A person's own section without the marker is a procedure.
		expect(guideRelease("# G\n\n## 배포\n\n태그를 푸시해요.\n")).toEqual({
			title: "배포",
			releases: true,
			marked: false,
		});
		expect(guideRelease("# G\n\n```\n## Release\n```\n")).toBeNull();
	});

	it("replaces a section in place or appends one", () => {
		const text = "# G\n\n## Release\n\nReleases: no\n\n## Ideas\n- x\n";
		expect(withReleaseSection(text, "## Release\n\nReleases: yes\n- tag it\n")).toBe(
			"# G\n\n## Release\n\nReleases: yes\n- tag it\n\n## Ideas\n- x\n",
		);
		expect(withReleaseSection("# G\n\nBody.\n", "## Release\n\nReleases: no\n")).toBe(
			"# G\n\nBody.\n\n## Release\n\nReleases: no\n",
		);
	});
});
