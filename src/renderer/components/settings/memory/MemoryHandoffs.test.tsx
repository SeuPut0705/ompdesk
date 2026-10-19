import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryHandoffs } from "./MemoryHandoffs";
import { cleanup, click, fakeMemoryApi, handoff, installApi, mount, PROJECT, q, qa, text } from "./memory-test-harness";

let api = fakeMemoryApi();

beforeEach(() => {
	api = fakeMemoryApi();
	api.handoffs.mockResolvedValue([
		handoff("h-old", "accepted", { summary: "Already used" }),
		handoff("h-open", "open", {
			summary: "Finish the cache",
			openQuestions: ["Which db?"],
			nextSteps: ["Add the test"],
		}),
	]);
	installApi(api);
});
afterEach(cleanup);

describe("Memory › Handoffs", () => {
	it("lists open handoffs first and labels the others", async () => {
		await mount(<MemoryHandoffs project={PROJECT} />);
		expect(api.handoffs).toHaveBeenCalledWith(PROJECT);
		const rows = qa("[data-memory-handoff]");
		expect(rows.map(row => row.getAttribute("data-memory-handoff"))).toEqual(["h-open", "h-old"]);
		expect(rows[0]?.textContent).toContain("Finish the cache");
		expect(rows[1]?.textContent).toContain("Used");
	});

	it("reads one without claiming it and shows questions and next steps", async () => {
		await mount(<MemoryHandoffs project={PROJECT} />);
		await click(q('[data-memory-handoff="h-open"]'));
		const detail = text("[data-memory-handoff-detail]");
		expect(detail).toContain("From omp");
		expect(detail).toContain("Finish the cache");
		expect(detail).toContain("Which db?");
		expect(detail).toContain("Add the test");
		expect(api.cancelHandoff).not.toHaveBeenCalled();
	});

	it("cancels an open one after asking", async () => {
		await mount(<MemoryHandoffs project={PROJECT} />);
		await click(q('[data-memory-handoff="h-open"]'));
		await click(q("[data-memory-handoff-cancel]"));
		expect(api.cancelHandoff).not.toHaveBeenCalled();
		const confirm =
			qa("button")
				.filter(item => item.textContent?.trim() === "Cancel handoff")
				.at(-1) ?? null;
		await click(confirm);
		expect(api.cancelHandoff).toHaveBeenCalledWith(PROJECT, "h-open");
		expect(q("[data-memory-handoff-detail]")).toBeNull();
	});

	it("offers no Cancel for a used handoff and says so when there are none", async () => {
		await mount(<MemoryHandoffs project={PROJECT} />);
		await click(q('[data-memory-handoff="h-old"]'));
		expect(q("[data-memory-handoff-cancel]")).toBeNull();
		await cleanup();
		api.handoffs.mockResolvedValue([]);
		installApi(api);
		await mount(<MemoryHandoffs project={PROJECT} />);
		expect(text("[data-memory-empty]")).toContain("No handoffs.");
	});
});
