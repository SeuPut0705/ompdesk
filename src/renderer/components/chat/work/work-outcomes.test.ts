import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKOUT_REFUSAL_PREFIX } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { ToolEntry } from "../../../stores/tools";
import { workFilePathKey } from "../../tools/edit-args";
import { workOutcomes } from "./work-view";

let sequence = 0;
function entry(toolName: string, args: Record<string, unknown>, details: Record<string, unknown> = {}): ToolEntry {
	return {
		toolName,
		args,
		status: "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text: "Success" }], details },
		isError: false,
		startTime: ++sequence,
		endTime: sequence + 1,
	};
}
function write(path = "tools/_menu_shot.gd") {
	// Stock write returns resolvedPath, but no diff or creation flag.
	return entry("write", { path, content: "alpha\nbeta\ngamma\n" }, { resolvedPath: `/project/${path}` });
}

describe("work outcome evidence", () => {
	it.each(["rm tools/_menu_shot.gd", "rm -f tools/_menu_shot.gd", "git rm -f -- tools/_menu_shot.gd"])(
		"marks a plain write deleted when a later successful command removes it: %s",
		command => {
			expect(workOutcomes([write(), entry("bash", { command })]).files).toEqual([
				{ path: "tools/_menu_shot.gd", deleted: true },
			]);
		},
	);
	it.each(["rm tools/_menu_shot.gd", "rm -f tools/_menu_shot.gd", "git rm -- tools/_menu_shot.gd"])(
		"drops only certainly created files after %s",
		command => {
			const create = entry("edit", {}, { path: "tools/_menu_shot.gd", op: "create", diff: "+alpha" });
			expect(workOutcomes([create, entry("bash", { command })]).files).toEqual([]);
		},
	);
	// Installed stock has no shipped tokenizer tests. Mirror shell-tokenize.ts's
	// documented quoted-word cases and its expansion/operator rejection classes.
	it.each(["rm 'notes with spaces.txt'", 'rm "notes with spaces.txt"'])(
		"recognizes stock documented literal quoted words: %s",
		command => {
			expect(workOutcomes([write("notes with spaces.txt"), entry("bash", { command })]).files).toEqual([
				{ path: "notes with spaces.txt", deleted: true },
			]);
		},
	);
	it.each([
		"rm tools/_menu_shot.gd.bak",
		"echo rm tools/_menu_shot.gd",
		"rm tools/*.gd",
		"git rm --cached tools/_menu_shot.gd",
		"false && rm tools/_menu_shot.gd",
		'rm "$FILE"',
		"rm $(printf tools/_menu_shot.gd)",
		"rm `printf tools/_menu_shot.gd`",
		"(rm tools/_menu_shot.gd)",
		"rm tools/_menu_shot.gd # comment",
		"rm tools/_menu_shot.gd > output.txt",
		"FILE=tools/_menu_shot.gd rm $FILE",
		"sh -c 'rm tools/_menu_shot.gd'",
		"rm tools/_menu_shot.gd; true",
		"rm tools/_menu_shot.gd | cat",
		"rm tools/_menu_shot.gd || true",
	])("does not guess a deletion from %s", command => {
		expect(workOutcomes([write(), entry("bash", { command })]).files).toEqual([
			{ path: "tools/_menu_shot.gd", added: 3, removed: 0 },
		]);
	});
	it("keeps writes when removal failed, was interrupted, ran elsewhere, or happened first", () => {
		const failed = { ...entry("bash", { command: "rm tools/_menu_shot.gd" }, { exitCode: 1 }), isError: true };
		expect(workOutcomes([write(), failed]).files).toHaveLength(1);
		const aborted = { ...entry("bash", { command: "rm tools/_menu_shot.gd" }), status: "aborted" as const };
		expect(workOutcomes([write(), aborted]).files).toHaveLength(1);
		expect(
			workOutcomes([write(), entry("bash", { command: "rm tools/_menu_shot.gd", cwd: "/elsewhere" })]).files,
		).toHaveLength(1);
		expect(workOutcomes([entry("bash", { command: "rm tools/_menu_shot.gd" }), write()]).files).toHaveLength(1);
	});
	it("does not let another agent's command erase a file with the same relative path", () => {
		expect(
			workOutcomes([write(), { entry: entry("bash", { command: "rm tools/_menu_shot.gd" }), agentName: "other" }])
				.files,
		).toHaveLength(1);
	});
	it("marks child explicit aborts interrupted but never applies the parent stop to child errors", () => {
		const aborted = { ...entry("bash", { command: "child abort" }), status: "aborted" as const };
		const failed = {
			...entry("bash", { command: "child fail" }, { exitCode: 1 }),
			status: "error" as const,
			isError: true,
		};
		const outcome = workOutcomes(
			[
				{ entry: aborted, agentName: "child" },
				{ entry: failed, agentName: "child" },
			],
			2,
		);
		expect(outcome.commands[0]).toMatchObject({ status: "interrupted" });
		expect(outcome.commands[1]).toMatchObject({ status: "failed" });
	});
	it("marks a plain write deleted but drops proven creates for stock single-file and multi-file deletes", () => {
		for (const details of [
			{ path: "tools/_menu_shot.gd", op: "delete", diff: "@@ -1,3 +0,0 @@\n-alpha\n-beta\n-gamma" },
			{ perFileResults: [{ path: "tools/_menu_shot.gd", op: "delete", diff: "-alpha\n-beta\n-gamma" }] },
		]) {
			expect(workOutcomes([write(), entry("edit", {}, details)]).files).toEqual([
				{ path: "tools/_menu_shot.gd", deleted: true },
			]);
			const create = entry("apply_patch", {}, { path: "tools/_menu_shot.gd", op: "create", diff: "+alpha" });
			expect(workOutcomes([create, entry("edit", {}, details)]).files).toEqual([]);
		}
	});
	it("nets stock replacement diffs after a write instead of counting newly written lines twice", () => {
		const edit = entry(
			"edit",
			{ path: "notes.txt" },
			{ path: "notes.txt", op: "update", diff: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+updated\n gamma" },
		);
		expect(workOutcomes([write("notes.txt"), edit]).files).toEqual([{ path: "notes.txt", added: 3, removed: 0 }]);
	});
	it.each([
		["/project", "notes.txt", "/project/notes.txt"],
		["/project", "./folder/../notes.txt", "/project/./notes.txt"],
		["C:\\project", "notes.txt", "C:\\project\\notes.txt"],
	])("pairs relative write and resolved edit paths under %s", (cwd, path, resolvedPath) => {
		const created = entry("write", { path, content: "alpha\n" }, { resolvedPath });
		const edited = entry("edit", { path }, { path: resolvedPath, op: "update", diff: "-alpha\n+beta" });
		expect(workFilePathKey(path, cwd)).toBe(workFilePathKey(resolvedPath, cwd));
		expect(workOutcomes([created, edited], undefined, cwd).files).toEqual([{ path, added: 1, removed: 0 }]);
	});
	it("does not merge equal basenames in different directories", () => {
		expect(workFilePathKey("notes.txt", "/project")).not.toBe(workFilePathKey("/elsewhere/notes.txt", "/project"));
	});
	it("nets the real relative-write plus absolute-edit shape to one changed file", () => {
		const created = entry("write", { path: "notes.txt", content: "alpha\n" }, { resolvedPath: "/project/notes.txt" });
		const edited = entry(
			"edit",
			{ path: "notes.txt" },
			{ path: "/project/notes.txt", diff: "-alpha\n+beta", op: "update" },
		);
		expect(workOutcomes([created, edited], undefined, "/project").files).toEqual([
			{ path: "notes.txt", added: 1, removed: 0 },
		]);
	});
	it("keeps a removed plain write as a deleted file next to its removing command", () => {
		const outcome = workOutcomes([write(), entry("bash", { command: "rm -f tools/_menu_shot.gd" })]);
		expect(outcome.files).toEqual([{ path: "tools/_menu_shot.gd", deleted: true }]);
		expect(outcome.commands).toHaveLength(1);
	});
	it("keeps net line counts for a write followed by an edit", () => {
		const path = "a/very/long/path/notes.txt";
		expect(workOutcomes([write(path), entry("edit", { path }, { diff: "-beta\n+updated" })]).files).toEqual([
			{ path, added: 3, removed: 0 },
		]);
	});
	it.each([
		["/project/src", "../notes.txt", false],
		["/project/src", "/project/./notes.txt", false],
		["C:\\project\\src", "..\\notes.txt", true],
		["C:\\project\\src", "\\notes.txt", true],
		["\\\\server\\share\\src", "..\\notes.txt", true],
	])("pins the renderer lexical key to node:path for %s + %s", (cwd, path, windows) => {
		const expected = (windows ? win32 : posix).resolve(cwd, path).replace(/\\/g, "/");
		expect(workFilePathKey(path, cwd)).toBe(expected);
	});
	it("nets stock create and subsequent per-file diffs", () => {
		const create = entry("edit", {}, { path: "notes.txt", op: "create", diff: "@@ -0,0 +1,2 @@\n+alpha\n+beta" });
		const update = entry(
			"edit",
			{},
			{
				perFileResults: [{ path: "notes.txt", op: "update", diff: "@@ -1,2 +1,3 @@\n-alpha\n+new\n+extra\n beta" }],
			},
		);
		expect(workOutcomes([create, update]).files).toEqual([{ path: "notes.txt", added: 3, removed: 0 }]);
	});
	it("keeps normal edit churn and falls back to nonnegative sums for incomplete evidence", () => {
		const edit = () => entry("edit", { path: "notes.txt" }, { diff: "-alpha\n+new" });
		expect(workOutcomes([edit(), edit()]).files).toEqual([{ path: "notes.txt", added: 2, removed: 2 }]);
		expect(
			workOutcomes([write("notes.txt"), entry("edit", { path: "notes.txt" }, { diff: "-a\n-b\n-c\n-d" })]).files,
		).toEqual([{ path: "notes.txt", added: 3, removed: 4 }]);
	});
});

describe("skills the work read", () => {
	it("lists each skill once, first read first, the agent's own and its subagents'", () => {
		const failed = { ...entry("read", { path: "skill://absent" }), isError: true };
		expect(
			workOutcomes([
				{ entry: entry("read", { path: "skill://how" }), toolCallId: "k1" },
				{ entry: entry("read", { path: "skill://poteto-mode/playbooks/feature.md" }), agentName: "Scout" },
				{ entry: entry("read", { path: "skill://how:10-40" }), toolCallId: "k3" },
				entry("read", { path: "docs/skill.md" }),
				failed,
			]).skills,
		).toEqual([
			{ name: "how", toolCallId: "k1" },
			{ name: "poteto-mode", agentName: "Scout" },
		]);
	});

	it.each([
		["/Users/me/.claude/skills/tdd/SKILL.md", "tdd"],
		["/Applications/ompdesk.app/Contents/Resources/omp-builtin/skills/ompdesk/SKILL.md", "ompdesk"],
		[".omp/skills/review/SKILL.md", "review"],
		["skills/how/SKILL.md:1-40", "how"],
		["/Users/me/.claude/skills/tdd/SKILL.md:raw", "tdd"],
		["/Users/me/.claude/skills/tdd/SKILL.md:1-40:raw", "tdd"],
		["/Users/me/.claude/skills/tdd/SKILL.md:raw:1-40", "tdd"],
		["C:\\Users\\me\\.omp\\skills\\qa\\SKILL.md", "qa"],
	])("counts a read of %s as the skill named by its folder", (path, name) => {
		expect(workOutcomes([{ entry: entry("read", { path }), toolCallId: "k1" }]).skills).toEqual([
			{ name, toolCallId: "k1" },
		]);
	});

	it.each(["docs/skills/tdd/README.md", "/w/skills/SKILL.md", "/w/skills/tdd/notes/SKILL.md", "SKILL.md"])(
		"does not take %s for a skill",
		path => {
			expect(workOutcomes([entry("read", { path })]).skills).toEqual([]);
		},
	);

	it("names a skill once however it was read: its URI, then its file", () => {
		expect(
			workOutcomes([
				entry("read", { path: "skill://tdd" }),
				entry("read", { path: "/w/.claude/skills/tdd/SKILL.md" }),
			]).skills,
		).toEqual([{ name: "tdd" }]);
	});
});

describe("calls the shared-checkout guard refused", () => {
	const refusal = (toolName: string, args: Record<string, unknown>, what: string): ToolEntry => ({
		...entry(toolName, args),
		status: "error",
		isError: true,
		result: {
			content: [
				{ type: "text", text: `${CHECKOUT_REFUSAL_PREFIX}: ${what}.\nSettings test race changed it.\nUse edit.` },
			],
		},
	});

	it("lists each as protection by its first line, the main agent's with its call and a subagent's with its name", () => {
		const protections = workOutcomes([
			{ entry: refusal("write", { path: "a.ts" }, "writing a.ts whole would drop changes"), toolCallId: "w1" },
			{
				entry: refusal("bash", { command: "git stash" }, "`git stash`: stashing hides their work"),
				toolCallId: "b1",
			},
			{ entry: refusal("write", { path: "b.ts" }, "writing b.ts whole would drop changes"), agentName: "Scout" },
		]).protections;
		expect(protections).toEqual([
			{ what: "writing a.ts whole would drop changes", toolCallId: "w1" },
			{ what: "`git stash`: stashing hides their work", toolCallId: "b1" },
			{ what: "writing b.ts whole would drop changes", agentName: "Scout" },
		]);
	});

	it("keeps a refused write out of the files and a refused command out of the failures", () => {
		const outcome = workOutcomes([
			refusal("write", { path: "a.ts", content: "x" }, "writing a.ts whole would drop changes"),
			refusal("bash", { command: "git stash" }, "`git stash`: stashing hides their work"),
		]);
		expect(outcome.files).toEqual([]);
		expect(outcome.commands).toMatchObject([{ command: "git stash", status: "refused" }]);
	});

	it("takes only a refusal for protection: not another error, nor the same words in a call that succeeded", () => {
		const failedWrite = {
			...refusal("write", { path: "a.ts" }, "x"),
			result: { content: [{ type: "text", text: "EACCES" }] },
		};
		const talked = entry("read", { path: "docs/guard.md" });
		talked.result = { content: [{ type: "text", text: `${CHECKOUT_REFUSAL_PREFIX}: quoted in a doc` }] };
		expect(workOutcomes([failedWrite, talked]).protections).toEqual([]);
	});
});
