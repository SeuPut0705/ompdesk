import { describe, expect, it } from "vitest";
import { runSectionShown } from "./WorkBoard";

describe("runSectionShown", () => {
	it("counts a tall section as shown once 48 px of it are in view", () => {
		expect(runSectionShown(0, 600)).toBe(false);
		expect(runSectionShown(1, 600)).toBe(false);
		expect(runSectionShown(47, 600)).toBe(false);
		expect(runSectionShown(48, 600)).toBe(true);
		expect(runSectionShown(300, 2400)).toBe(true);
	});

	it("counts a section shorter than 48 px as shown only when it is whole in view", () => {
		expect(runSectionShown(30, 30)).toBe(true);
		expect(runSectionShown(29, 30)).toBe(false);
		expect(runSectionShown(0, 0)).toBe(false);
	});
});
