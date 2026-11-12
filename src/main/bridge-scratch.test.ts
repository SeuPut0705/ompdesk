/**
 * gui-bridge scratch section (resources/gui-bridge/modes/scratch-core.ts): which sessions are told of a scratch
 * folder, and that the one they are told of is theirs.
 */
import { describe, expect, it } from "vitest";
import { scratchSection } from "../../resources/gui-bridge/modes/scratch-core";

describe("bridge scratch section", () => {
	it("names the folder main gave this omp", () => {
		const dir = "/Users/me/.cache/ompdesk/scratch/0123456789abcdef0123456789abcdef";
		expect(scratchSection(dir)).toContain(`\`${dir}\``);
	});

	it("is left out of an omp that was given no folder", () => {
		expect(scratchSection(undefined)).toBeUndefined();
		expect(scratchSection("")).toBeUndefined();
	});
});
