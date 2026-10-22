import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { MemoryPages } from "./MemoryPages";
import {
	cleanup,
	click,
	fakeMemoryApi,
	installApi,
	mount,
	PROJECT,
	pageOf,
	q,
	qa,
	ref,
	settle,
	text,
	type,
} from "./memory-test-harness";

let api = fakeMemoryApi();

beforeEach(() => {
	api = fakeMemoryApi();
	api.pages.mockResolvedValue([
		ref("_rules/a.md", "Rule A", { kind: "rule" }),
		ref("decisions/d.md", "Decision D", { kind: "decision" }),
		ref("notes/n.md", "Note N"),
		ref("notes/m.md", "Note M"),
		ref("sessions/s.md", "Session S", { kind: "session", tier: "episodic" }),
	]);
	installApi(api);
});
afterEach(cleanup);

describe("Memory › Pages", () => {
	it("groups pages by kind with counts and folds sessions", async () => {
		await mount(<MemoryPages project={PROJECT} />);
		expect(api.pages).toHaveBeenCalledWith(PROJECT);
		expect(text('[data-memory-group="rule"]')).toContain("Rules");
		expect(text('[data-memory-group="note"]')).toContain("2");
		expect(qa('[data-memory-group="note"] [data-memory-page]')).toHaveLength(2);
		expect(q('[data-memory-page="sessions/s.md"]')).toBeNull();
		await click(q('[data-memory-group-toggle="session"]'));
		expect(q('[data-memory-page="sessions/s.md"]')).not.toBeNull();
	});

	it("opens a page and renders its markdown", async () => {
		api.readPage.mockResolvedValue(pageOf("notes/n.md", "Note N"));
		await mount(<MemoryPages project={PROJECT} />);
		await click(q('[data-memory-page="notes/n.md"]'));
		expect(api.readPage).toHaveBeenCalledWith({ ...PROJECT, path: "notes/n.md" });
		expect(text("[data-memory-body]")).toContain("Body of Note N.");
		expect(q("[data-memory-body] strong")?.textContent).toBe("Note N");
		// The open page's row is the current item of the list, not a toggle button a screen reader reads as "pressed".
		const row = q('[data-memory-page="notes/n.md"]');
		expect(row?.getAttribute("aria-current")).toBe("true");
		expect(row?.hasAttribute("aria-pressed")).toBe(false);
	});

	it("saves an edit through writePage and keeps kind, tier, tags and pin", async () => {
		api.readPage.mockResolvedValue(pageOf("notes/n.md", "Note N", { pinned: true }));
		await mount(<MemoryPages project={PROJECT} />);
		await click(q('[data-memory-page="notes/n.md"]'));
		await click(q("[data-memory-edit]"));
		await type(q("[data-memory-editor]"), "new body");
		await click(q("[data-memory-save]"));
		expect(api.writePage).toHaveBeenCalledWith({
			...PROJECT,
			path: "notes/n.md",
			body: "new body",
			title: "Note N",
			kind: "note",
			tier: "semantic",
			tags: ["t"],
			pinned: true,
		});
		expect(q("[data-memory-editor]")).toBeNull();
	});

	it("pins an unpinned page with the same body", async () => {
		api.readPage.mockResolvedValue(pageOf("notes/n.md", "Note N"));
		await mount(<MemoryPages project={PROJECT} />);
		await click(q('[data-memory-page="notes/n.md"]'));
		await click(q("[data-memory-pin]"));
		expect(api.writePage).toHaveBeenCalledWith(
			expect.objectContaining({ path: "notes/n.md", pinned: true, body: "# Note N\n\nBody of **Note N**." }),
		);
	});

	it("rates a page", async () => {
		api.readPage.mockResolvedValue(pageOf("notes/n.md", "Note N"));
		await mount(<MemoryPages project={PROJECT} />);
		await click(q('[data-memory-page="notes/n.md"]'));
		await click(q("[data-memory-helpful]"));
		await click(q("[data-memory-not-helpful]"));
		expect(api.feedback.mock.calls).toEqual([
			[{ ...PROJECT, path: "notes/n.md" }, "helpful"],
			[{ ...PROJECT, path: "notes/n.md" }, "not_helpful"],
		]);
	});

	it("deletes after asking, lists it under Deleted, and Restore reads it back from its revision", async () => {
		api.readPage.mockResolvedValue(pageOf("notes/n.md", "Note N"));
		await mount(<MemoryPages project={PROJECT} />);
		await click(q('[data-memory-page="notes/n.md"]'));
		await click(q("[data-memory-delete]"));
		expect(api.deletePage).not.toHaveBeenCalled();
		await click(
			qa("button")
				.filter(item => item.textContent?.trim() === "Delete")
				.at(-1) ?? null,
		);
		expect(api.deletePage).toHaveBeenCalledWith({ ...PROJECT, path: "notes/n.md", title: "Note N" });
		expect(useMemoryPageStore.getState().deleted.map(item => item.path)).toEqual(["notes/n.md"]);
		expect(q("[data-memory-reader]")).toBeNull();
		expect(text('[data-memory-deleted="notes/n.md"]')).toContain("Note N");
		await click(qa('[data-memory-deleted="notes/n.md"] button')[0] ?? null);
		expect(api.restorePage).toHaveBeenCalledWith(expect.objectContaining({ path: "notes/n.md" }), "rev-1");
		expect(useMemoryPageStore.getState().deleted).toEqual([]);
	});

	it("keeps a session page read-only", async () => {
		api.readPage.mockResolvedValue(pageOf("sessions/s.md", "Session S", { kind: "session" }));
		await mount(<MemoryPages project={PROJECT} />);
		await click(q('[data-memory-group-toggle="session"]'));
		await click(q('[data-memory-page="sessions/s.md"]'));
		expect(q("[data-memory-edit]")?.hasAttribute("disabled")).toBe(true);
		expect(q("[data-memory-pin]")?.hasAttribute("disabled")).toBe(true);
		expect(q("[data-memory-delete]")?.hasAttribute("disabled")).toBe(false);
	});

	it("opens the page another section asked for", async () => {
		api.readPage.mockResolvedValue(pageOf("decisions/d.md", "Decision D", { kind: "decision" }));
		await mount(<MemoryPages project={PROJECT} />);
		await act(async () => useMemoryPageStore.getState().openPage({ ...PROJECT, path: "decisions/d.md" }));
		await settle();
		expect(api.readPage).toHaveBeenCalledWith({ ...PROJECT, path: "decisions/d.md" });
		expect(text("[data-memory-reader]")).toContain("Decision D");
		expect(useMemoryPageStore.getState().pending).toBeNull();
	});

	it("filters by title and says so when the project has no pages", async () => {
		await mount(<MemoryPages project={PROJECT} />);
		await type(q("input"), "rule a");
		expect(qa("[data-memory-page]").map(item => item.getAttribute("data-memory-page"))).toEqual(["_rules/a.md"]);
		await cleanup();
		api.pages.mockResolvedValue([]);
		installApi(api);
		await mount(<MemoryPages project={PROJECT} />);
		expect(q("[data-memory-empty]")).not.toBeNull();
	});
});
