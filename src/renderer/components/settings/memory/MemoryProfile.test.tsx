import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { MemoryProfile } from "./MemoryProfile";
import { button, cleanup, click, fakeMemoryApi, installApi, mount, text } from "./memory-test-harness";

let api = fakeMemoryApi();

beforeEach(() => {
	api = fakeMemoryApi();
	installApi(api);
});
afterEach(cleanup);

describe("Memory › Profile", () => {
	it("shows the profile's status and entries by category, read-only, with Edit opening the page", async () => {
		api.profile.mockResolvedValue({
			enabled: true,
			injected: true,
			digestBytes: 120,
			scope: { workspace: "default", project: "_global" },
			entries: [
				{
					path: "profile/tools/pnpm.md",
					category: "tools",
					statement: "Use pnpm.",
					appliesTo: ["javascript"],
					enforcedBy: null,
				},
			],
		});
		await mount(<MemoryProfile />);
		expect(text("[data-memory-profile-status]")).toContain("Used in every session");
		expect(text('[data-memory-profile-group="tools"]')).toContain("Use pnpm.");
		expect(text('[data-memory-profile-group="tools"]')).toContain("javascript");
		await click(button("Edit"));
		expect(useMemoryPageStore.getState().pending).toEqual({
			workspace: "default",
			project: "_global",
			path: "profile/tools/pnpm.md",
		});
	});

	it("says it fills in when empty", async () => {
		await mount(<MemoryProfile />);
		expect(text("[data-memory-empty]")).toContain("Fills in from your sessions.");
	});
});
