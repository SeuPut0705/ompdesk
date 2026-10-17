import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectReleaseProcedure, findReleaseAnchors } from "./release-detect";

const dirs: string[] = [];
async function repo(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "release-detect-"));
	dirs.push(root);
	for (const [name, text] of Object.entries(files)) {
		await mkdir(join(root, name, ".."), { recursive: true });
		await writeFile(join(root, name), text);
	}
	return root;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("findReleaseAnchors", () => {
	it("anchors a heading that names a release, in any of the keywords' languages", () => {
		expect(findReleaseAnchors("# Title\n\n## Release\nbump and tag\n\n## Style\nx\n")).toEqual(["Release"]);
		expect(findReleaseAnchors("# 제목\n\n## 릴리스 절차\n1. 태그\n")).toEqual(["릴리스 절차"]);
		expect(findReleaseAnchors("# T\n\n### 배포\n1. 푸시\n")).toEqual(["배포"]);
		expect(findReleaseAnchors("# T\n\n## Publishing to npm\nnpm publish\n")).toEqual(["Publishing to npm"]);
	});

	it("also anchors the workflow section right before a release section when it talks about releasing", () => {
		const text = [
			"# Rules",
			"## Change workflow",
			"Commit locally. When asked to release, run the gate.",
			"## Release",
			"1. Bump the version.",
			"## Code conventions",
			"No any.",
		].join("\n");
		expect(findReleaseAnchors(text)).toEqual(["Change workflow", "Release"]);
	});

	it("does not anchor the previous section when it never mentions a release", () => {
		expect(findReleaseAnchors("## Style\nuse tabs\n## Release\nbump\n")).toEqual(["Release"]);
	});

	it("ignores headings inside code fences and prose that merely mentions releases", () => {
		const text = "# T\n\n```md\n## Release\n```\n\nWe release often.\n\n## Testing\nrun it\n";
		expect(findReleaseAnchors(text)).toEqual([]);
	});

	it("returns nothing for a file without release headings", () => {
		expect(findReleaseAnchors("# A\n\n## B\n\ntext\n")).toEqual([]);
	});
});

describe("detectReleaseProcedure", () => {
	it("reads AGENTS.md first, then CLAUDE.md, CONTRIBUTING.md, RELEASING.md and docs/release*", async () => {
		const root = await repo({
			"CONTRIBUTING.md": "## Release\nx\n",
			"CLAUDE.md": "## Releasing\nx\n",
			"AGENTS.md": "# a\n## Nothing\n",
		});
		expect(await detectReleaseProcedure(root)).toEqual({ file: "CLAUDE.md", anchors: ["Releasing"] });
	});

	it("takes the whole file of RELEASING.md and docs/release*.md as the procedure", async () => {
		const root = await repo({ "RELEASING.md": "# How we ship\n\n1. tag\n" });
		expect(await detectReleaseProcedure(root)).toEqual({ file: "RELEASING.md", anchors: ["How we ship"] });
		const docs = await repo({ "docs/release-process.md": "No heading, just steps.\n" });
		expect(await detectReleaseProcedure(docs)).toEqual({
			file: "docs/release-process.md",
			anchors: ["release-process"],
		});
	});

	it("is null when no rules file defines a release procedure", async () => {
		expect(
			await detectReleaseProcedure(await repo({ "AGENTS.md": "# a\n## Style\nx\n", "README.md": "## Release\n" })),
		).toBeNull();
		expect(await detectReleaseProcedure(await repo({}))).toBeNull();
	});

	it("finds this repository's own Change workflow and Release sections", async () => {
		const found = await detectReleaseProcedure(resolve(__dirname, "../.."));
		expect(found?.file).toBe("AGENTS.md");
		expect(found?.anchors).toEqual(["Change workflow", "Release"]);
	});
});
