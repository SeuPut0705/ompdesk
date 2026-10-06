import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { deleteSessionFiles } from "./session-files";
import { projectSessionTree } from "./session-tree";
import type { SessionEntry } from "./sessions";

function at(ms: number): string {
	return new Date(ms).toISOString();
}

function message(id: string, parentId: string | null, ms: number, body: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: at(ms), message: body };
}

const user = (content: AgentMessage["content"]): AgentMessage => ({ role: "user", content, timestamp: 0 });
const assistant = (text: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: 0,
	provider: "p",
	model: "m",
	stopReason: "stop",
});
const toolResult: AgentMessage = {
	role: "toolResult",
	toolCallId: "c1",
	toolName: "read",
	content: [{ type: "text", text: "file" }],
	isError: false,
	timestamp: 0,
};

describe("projectSessionTree", () => {
	// u1 ─ a1 ─ tool ─ a2 ─ u2 (abandoned)
	//                    └─ mc ─ u3 ─ lbl (leaf)
	const entries: SessionEntry[] = [
		{ type: "thinking_level_change", id: "t0", parentId: null, timestamp: at(0), thinkingLevel: "high" },
		message("u1", "t0", 1000, user("  first\n\nquestion  ")),
		message("a1", "u1", 2000, assistant("answer")),
		message("tr", "a1", 3000, toolResult),
		message("a2", "tr", 4000, assistant("after tool")),
		message("u2", "a2", 5000, user([{ type: "text", text: "abandoned" }])),
		{ type: "model_change", id: "mc", parentId: "a2", timestamp: at(6000), model: "p/m" },
		message(
			"u3",
			"mc",
			7000,
			user([
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "live" },
			]),
		),
		{ type: "label", id: "l1", parentId: "u3", timestamp: at(8000), targetId: "a1", label: "checkpoint" },
		{ type: "label", id: "l2", parentId: "l1", timestamp: at(8100), targetId: "u2", label: "old" },
		{ type: "label", id: "l3", parentId: "l2", timestamp: at(8200), targetId: "u2" },
	];

	it("keeps user/assistant messages, re-parented onto the nearest kept ancestor", () => {
		const { tree, activeLeafId } = projectSessionTree(entries, "l3");
		expect(tree.map(node => [node.entryId, node.parentId])).toEqual([
			["u1", null],
			["a1", "u1"],
			["a2", "a1"],
			["u2", "a2"],
			["u3", "a2"],
		]);
		expect(activeLeafId).toBe("u3");
	});

	it("marks the active branch, leaves, labels in effect and collapsed previews", () => {
		const byId = new Map(projectSessionTree(entries, "l3").tree.map(node => [node.entryId, node]));
		expect(byId.get("u1")).toEqual({
			entryId: "u1",
			parentId: null,
			role: "user",
			textPreview: "first question",
			timestamp: 1000,
			onActiveBranch: true,
			isLeaf: false,
		});
		expect(byId.get("a1")?.label).toBe("checkpoint");
		// A later label entry without a label clears the earlier one.
		expect(byId.get("u2")?.label).toBeUndefined();
		expect(byId.get("u2")).toMatchObject({ onActiveBranch: false, isLeaf: true, textPreview: "abandoned" });
		expect(byId.get("u3")).toMatchObject({ onActiveBranch: true, isLeaf: true, textPreview: "live" });
		expect(byId.get("a2")?.isLeaf).toBe(false);
	});

	it("truncates long previews and sorts by timestamp", () => {
		const long = "x".repeat(300);
		const { tree } = projectSessionTree(
			[message("b", null, 2000, user("second")), message("a", "b", 1000, user(long))],
			"a",
		);
		expect(tree.map(node => node.entryId)).toEqual(["a", "b"]);
		expect(tree[0]?.textPreview).toHaveLength(200);
		expect(tree[0]?.textPreview.endsWith("…")).toBe(true);
	});

	it("survives an empty session, a null leaf and a parent cycle", () => {
		expect(projectSessionTree([], null)).toEqual({ tree: [], activeLeafId: null });
		const cyclic: SessionEntry[] = [
			{ type: "model_change", id: "x", parentId: "y", timestamp: at(0), model: "p/m" },
			{ type: "model_change", id: "y", parentId: "x", timestamp: at(0), model: "p/m" },
			message("u", "x", 1000, user("hi")),
		];
		const { tree, activeLeafId } = projectSessionTree(cyclic, "u");
		expect(tree).toMatchObject([{ entryId: "u", parentId: null, onActiveBranch: true }]);
		expect(activeLeafId).toBe("u");
	});
});

describe("deleteSessionFiles", () => {
	it("removes the session, its artifacts directory and rewrite backups only", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-gui-session-files-"));
		try {
			const session = join(dir, "s1.jsonl");
			await writeFile(session, "{}\n");
			await mkdir(join(dir, "s1", "nested"), { recursive: true });
			await writeFile(join(dir, "s1", "nested", "artifact.txt"), "a");
			await writeFile(join(dir, "s1.jsonl.123.bak"), "b");
			await writeFile(join(dir, "s10.jsonl"), "{}\n");
			await writeFile(join(dir, "s1.jsonl.123.tmp"), "t");
			await deleteSessionFiles(session);
			expect((await readdir(dir)).sort()).toEqual(["s1.jsonl.123.tmp", "s10.jsonl"]);
			// Already gone: still fine.
			await deleteSessionFiles(session);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses a path that is not a session file", async () => {
		await expect(deleteSessionFiles("/tmp/not-a-session")).rejects.toThrow("Invalid session path");
	});
});
