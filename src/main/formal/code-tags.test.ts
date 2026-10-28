import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	checkTags,
	extractTags,
	findCodeRoot,
	formatTag,
	indexDefinitions,
	parseTagLine,
	tagsFor,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/code-tags";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-tags-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe("@code tags", () => {
	it("reads a path with a line, a range, a note, and Lean or block-comment spellings", () => {
		expect(parseTagLine("\\* @code src/worker.ts:12-13 db.claim, one UPDATE", 3)).toEqual({
			path: "src/worker.ts",
			startLine: 12,
			endLine: 13,
			note: "db.claim, one UPDATE",
			line: 3,
		});
		expect(parseTagLine("  \\* @code a/b.py:7", 1)).toMatchObject({ path: "a/b.py", startLine: 7 });
		expect(parseTagLine("\\* @code README.md", 1)).toEqual({ path: "README.md", line: 1 });
		expect(parseTagLine("(* @code x.go:1-2 *)", 1)).toMatchObject({ path: "x.go", startLine: 1, endLine: 2 });
		expect(parseTagLine("  /-- @code src/queue.ts:8-10 push: a full queue refuses -/", 4)).toMatchObject({
			path: "src/queue.ts",
			startLine: 8,
			endLine: 10,
		});
		expect(parseTagLine("-- @code lib/q.rs:3", 1)).toMatchObject({ path: "lib/q.rs", startLine: 3 });
		expect(parseTagLine("Claim(w) == x \\* no tag here", 1)).toBeNull();
		expect(formatTag({ path: "a.ts", startLine: 1, endLine: 4, line: 1 })).toBe("a.ts:1-4");
	});

	const spec = [
		"---- MODULE M ----",
		"\\* @code a.ts:1-2 first",
		"First ==",
		"    /\\ x' = 1",
		"",
		"Second ==",
		"    \\* @code b.ts:5 inside the body",
		"    /\\ x' = 2",
		"\\* @code c.ts:9",
		"\\* @code c.ts:10",
		"Third == x' = 3",
		"====",
	].join("\n");

	it("gives each definition the tags above it and inside it, never the next definition's", () => {
		const defs = indexDefinitions(spec);
		expect(defs.map(def => [def.name, def.tags.map(formatTag)])).toEqual([
			["First", ["a.ts:1-2"]],
			["Second", ["b.ts:5"]],
			["Third", ["c.ts:9", "c.ts:10"]],
		]);
		expect(tagsFor(defs, "Third", undefined)).toHaveLength(2);
		expect(tagsFor(defs, undefined, 8).map(formatTag)).toEqual(["b.ts:5"]);
		expect(tagsFor(defs, "Missing", undefined)).toEqual([]);
	});

	it("flags a missing file, a range past the end, a bad range and a path that leaves the code root", () => {
		fs.writeFileSync(path.join(temp, "real.ts"), "one\ntwo\nthree\n");
		const tags = extractTags(
			[
				"\\* @code real.ts:1-3",
				"\\* @code real.ts:3",
				"\\* @code real.ts:2-9",
				"\\* @code gone.ts:1",
				"\\* @code real.ts:3-1",
				"\\* @code ../outside.ts:1",
				"\\* @code real.ts",
			].join("\n"),
		);
		const problems = checkTags(tags, "M.tla", temp).map(problem => problem.problem);
		expect(problems).toHaveLength(4);
		expect(problems[0]).toContain("runs past the end");
		expect(problems[1]).toContain("does not exist");
		expect(problems[2]).toContain("not a valid line range");
		expect(problems[3]).toContain("outside the code root");
	});

	it("takes the code root from the nearest manifest.json, else the nearest .git", () => {
		const repo = path.join(temp, "repo");
		fs.mkdirSync(path.join(repo, "formal", "c", "tla"), { recursive: true });
		fs.mkdirSync(path.join(repo, ".git"));
		expect(findCodeRoot(path.join(repo, "formal", "c", "tla"))).toBe(repo);
		fs.writeFileSync(
			path.join(repo, "formal", "manifest.json"),
			JSON.stringify({ version: 1, codeRoot: "../svc", models: [] }),
		);
		expect(findCodeRoot(path.join(repo, "formal", "c", "tla"))).toBe(path.join(repo, "svc"));
	});
});
