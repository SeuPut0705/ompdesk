import { describe, expect, it } from "vitest";
import type { OpenedChildRow } from "../layout/work-board/opened-children";
import { botLibrary, githubLinks } from "./bot-library";

function child(key: string, extra: Partial<OpenedChildRow> = {}): OpenedChildRow {
	return { key, tabId: key, sessionPath: `/s/${key}.jsonl`, title: `Session ${key}`, status: "done", ...extra };
}

describe("githubLinks", () => {
	it("names pull requests, issues, releases and commits once each, and nothing else", () => {
		expect(
			githubLinks(
				"See https://github.com/acme/app/pull/12 and https://github.com/acme/app/pull/12, " +
					"https://github.com/acme/app/issues/7, https://github.com/acme/app/releases/tag/v1.2.0, " +
					"https://github.com/acme/app/commit/0123456789abcdef and https://github.com/acme/app (the repo).",
			).map(entry => entry.link),
		).toEqual([
			{ repo: "acme/app", type: "pull", ref: "12" },
			{ repo: "acme/app", type: "issue", ref: "7" },
			{ repo: "acme/app", type: "release", ref: "v1.2.0" },
			{ repo: "acme/app", type: "commit", ref: "0123456" },
		]);
	});
});

describe("botLibrary", () => {
	it("collects branches, finished reports and what replies and reports name, newest first, pins on top", () => {
		const items = botLibrary({
			rows: [
				child("a", {
					at: 300,
					branch: "omp/agent/a",
					diff: { commits: 2, files: 3, added: 10, removed: 1, uncommitted: 0 },
					report: {
						kind: "done",
						at: 300,
						text: "Opened https://github.com/acme/app/pull/12. Notes in [notes](/tmp/notes.md) and [rel](docs/x.md).",
					},
				}),
				child("b", { at: 100, report: { kind: "progress", at: 100, text: "halfway" } }),
			],
			replies: [{ text: "The report is [here](/tmp/report.pdf).", at: 200 }],
			writes: [],
			pins: ["file:/tmp/report.pdf"],
		});
		expect(items.map(item => [item.key, item.pinned])).toEqual([
			["file:/tmp/report.pdf", true],
			["branch:/s/a.jsonl", false],
			["report:/s/a.jsonl", false],
			["https://github.com/acme/app/pull/12", false],
			// A session's relative path is its own worktree's: only its absolute one is collected.
			["file:/tmp/notes.md", false],
		]);
		expect(items.find(item => item.key === "https://github.com/acme/app/pull/12")).toMatchObject({
			source: { kind: "session", title: "Session a" },
		});
	});

	it("says a file was updated when the bot wrote it after naming it, and not for a write before", () => {
		const items = botLibrary({
			rows: [],
			replies: [{ text: "Draft: `out/plan.pdf`", at: 1_000 }],
			writes: [
				{ path: "/work/out/plan.pdf", at: 500 },
				{ path: "/work/out/plan.pdf", at: 4_000 },
				{ path: "/work/out/other.pdf", at: 9_000 },
			],
			pins: [],
		});
		expect(items).toMatchObject([{ kind: "file", path: "out/plan.pdf", updated: 4_000 }]);
		const before = botLibrary({
			rows: [],
			replies: [{ text: "Draft: `out/plan.pdf`", at: 1_000 }],
			writes: [{ path: "out/plan.pdf", at: 500 }],
			pins: [],
		});
		expect(before[0]).not.toHaveProperty("updated");
	});
});
