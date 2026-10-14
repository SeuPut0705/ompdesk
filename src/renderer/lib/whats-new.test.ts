import { describe, expect, it } from "vitest";
import { changelogSection, whatsNewAction } from "./whats-new";

const CHANGELOG = `# Changelog

## [0.3.0] - 2026-10-14

### 추가
- 새 기능

## [0.2.1] - 2026-10-10

- 수정
`;

describe("changelogSection", () => {
	it("takes one version's section without its heading, up to the next release", () => {
		expect(changelogSection(CHANGELOG, "0.3.0")).toBe("### 추가\n- 새 기능");
		expect(changelogSection(CHANGELOG, "0.2.1")).toBe("- 수정");
	});

	it("finds nothing for a version without a section, or a prefix of another version", () => {
		expect(changelogSection(CHANGELOG, "0.4.0")).toBeNull();
		expect(changelogSection(CHANGELOG, "0.3")).toBeNull();
	});
});

describe("whatsNewAction", () => {
	it("shows the notes once after an update that has them", () => {
		expect(whatsNewAction("0.2.1", "0.3.0", true)).toBe("show");
		expect(whatsNewAction("0.3.0", "0.3.0", true)).toBe("none");
	});

	it("records the version silently on a first launch or when the release has no notes", () => {
		expect(whatsNewAction(undefined, "0.3.0", true)).toBe("record");
		expect(whatsNewAction("0.2.1", "0.3.0", false)).toBe("record");
	});
});
