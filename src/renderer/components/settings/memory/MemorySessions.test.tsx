import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiMemorySession } from "../../../../shared/ai-memory";
import { MemorySessions } from "./MemorySessions";
import { button, cleanup, click, fakeMemoryApi, installApi, mount, PROJECT, q, qa, text } from "./memory-test-harness";

const SESSION: AiMemorySession = {
	id: "s-1",
	cwd: "/work/app",
	agent: "omp",
	startedAt: "2026-10-18T09:00:00Z",
	endedAt: null,
	observations: 60,
	consolidation: "failed",
};

let api = fakeMemoryApi();

beforeEach(() => {
	api = fakeMemoryApi();
	api.sessions.mockResolvedValue([SESSION]);
	api.observations.mockImplementation(async (_project, _id, offset = 0) => ({
		session: SESSION,
		observations: [
			{
				id: `o-${offset}`,
				kind: "user-prompt",
				title: "Prompt",
				body: offset === 0 ? "x".repeat(500) : "second page",
				createdAt: "2026-10-18T09:01:00Z",
			},
		],
		total: 60,
		offset,
	}));
	installApi(api);
});
afterEach(cleanup);

describe("Memory › Sessions", () => {
	it("lists sessions with folder, count and badges", async () => {
		await mount(<MemorySessions project={PROJECT} />);
		const row = text('[data-memory-session="s-1"]');
		expect(row).toContain("omp · app");
		expect(row).toContain("60");
		expect(row).toContain("Open");
		expect(row).toContain("Page failed");
	});

	it("opens the raw observations read-only, collapses long bodies and pages by 50", async () => {
		await mount(<MemorySessions project={PROJECT} />);
		await click(q('[data-memory-session="s-1"]'));
		expect(api.observations).toHaveBeenCalledWith(PROJECT, "s-1", 0);
		expect(text("[data-memory-observation]")).toContain("user-prompt");
		expect(text("[data-memory-observation] pre").endsWith("…")).toBe(true);
		await click(button("Show more"));
		expect(text("[data-memory-observation] pre").length).toBe(500);
		await click(button("Next"));
		expect(api.observations).toHaveBeenLastCalledWith(PROJECT, "s-1", 50);
		expect(text("[data-memory-observation]")).toContain("second page");
		expect(qa("[data-memory-observations-pager]")).toHaveLength(1);
	});

	it("says so when nothing was recorded", async () => {
		api.sessions.mockResolvedValue([]);
		await mount(<MemorySessions project={PROJECT} />);
		expect(text("[data-memory-empty]")).toContain("No sessions recorded yet.");
	});
});
