import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { MemorySearch, resetMemorySearchForTest } from "./MemorySearch";
import {
	cleanup,
	click,
	fakeMemoryApi,
	installApi,
	mount,
	OTHER,
	PROJECT,
	q,
	qa,
	ref,
	submit,
	text,
	type,
} from "./memory-test-harness";

let api = fakeMemoryApi();

beforeEach(() => {
	resetMemorySearchForTest();
	api = fakeMemoryApi();
	api.search.mockResolvedValue([
		ref("decisions/0007-db.md", "Use sqlite", {
			kind: "decision",
			tier: "semantic",
			snippet: "we chose sqlite for the cache",
			...OTHER,
		}),
	]);
	installApi(api);
});
afterEach(cleanup);

async function search(word: string) {
	await type(q("input"), word);
	await submit(q("form"));
}

describe("Memory › Search", () => {
	it("starts with a hint and searches the project", async () => {
		await mount(<MemorySearch project={PROJECT} scope="project" />);
		expect(q("[data-memory-hint]")).not.toBeNull();
		await search("sqlite");
		expect(api.search).toHaveBeenCalledWith("sqlite", PROJECT);
	});

	it("searches every project in the all scope and names each hit's project, kind and snippet once", async () => {
		await mount(<MemorySearch project={PROJECT} scope="all" />);
		await search("sqlite");
		expect(api.search).toHaveBeenLastCalledWith("sqlite", undefined);
		const hit = text('[data-memory-hit="decisions/0007-db.md"]');
		expect(hit).toContain("Use sqlite");
		expect(hit).toContain("work / api");
		expect(hit).toContain("Decision");
		expect(hit).toContain("we chose sqlite for the cache");
		// The path is the tooltip and a decision's usual tier goes unsaid.
		expect(hit).not.toContain("decisions/0007-db.md");
		expect(q('[data-memory-hit="decisions/0007-db.md"] button')?.getAttribute("title")).toBe("decisions/0007-db.md");
		expect(hit).not.toContain("Semantic");
	});

	it("a hit opens in Pages", async () => {
		await mount(<MemorySearch project={PROJECT} scope="all" />);
		await search("sqlite");
		await click(q('[data-memory-hit="decisions/0007-db.md"] button'));
		expect(useMemoryPageStore.getState().pending).toMatchObject({ ...OTHER, path: "decisions/0007-db.md" });
		expect(useMemoryPageStore.getState().project).toEqual(OTHER);
	});

	it("says so when nothing matches and when the read fails", async () => {
		api.search.mockResolvedValueOnce([]);
		await mount(<MemorySearch project={PROJECT} scope="project" />);
		await search("zzz");
		expect(q("[data-memory-no-results]")).not.toBeNull();
		api.search.mockRejectedValueOnce(new Error("server said no"));
		await search("again");
		expect(qa("[data-inline-notice]")[0]?.textContent).toContain("server said no");
	});
});
