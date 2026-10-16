import { describe, expect, it } from "vitest";
import changelogMarkdown from "../../../CHANGELOG.md?raw";
import { changelogReleases, changelogSection, whatsNewAction } from "./whats-new";

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

const BILINGUAL = `# Changelog

## [0.5.0] - 2026-10-16

### 추가
- 새 기능

<!-- en -->
### Added
- A new feature

## [0.4.0] - 2026-10-15

- 한국어만

## [0.3.9] - 2026-10-14

- 마지막
<!-- en -->
`;

describe("changelog languages", () => {
	it("shows the English part in en and the Korean part in ko, never both", () => {
		expect(changelogSection(BILINGUAL, "0.5.0", "en")).toBe("### Added\n- A new feature");
		expect(changelogSection(BILINGUAL, "0.5.0", "ko")).toBe("### 추가\n- 새 기능");
		expect(changelogSection(BILINGUAL, "0.5.0")).toBe("### 추가\n- 새 기능");
	});

	it("falls back to Korean when a release has no English part, or an empty one", () => {
		expect(changelogSection(BILINGUAL, "0.4.0", "en")).toBe("- 한국어만");
		expect(changelogSection(BILINGUAL, "0.3.9", "en")).toBe("- 마지막");
	});

	it("localizes the whole list release by release", () => {
		const en = changelogReleases(BILINGUAL, "en");
		expect(en).toBe(
			"## [0.5.0] - 2026-10-16\n\n### Added\n- A new feature\n\n## [0.4.0] - 2026-10-15\n\n- 한국어만\n\n## [0.3.9] - 2026-10-14\n\n- 마지막",
		);
		expect(changelogReleases(BILINGUAL, "ko")).not.toContain("A new feature");
		expect(changelogReleases(BILINGUAL, "ko")).not.toContain("<!-- en -->");
	});

	it("gives every release from 0.26 on an English part", () => {
		const versions = [...changelogMarkdown.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)].filter(
			([, major, minor]) => Number(major) > 0 || Number(minor) >= 26,
		);
		expect(versions.length).toBeGreaterThanOrEqual(9);
		for (const [, major, minor, patch] of versions) {
			const version = `${major}.${minor}.${patch}`;
			const english = changelogSection(changelogMarkdown, version, "en");
			expect(english, version).not.toBe(changelogSection(changelogMarkdown, version, "ko"));
			expect(english, version).not.toMatch(/[가-힣]{4,}/);
		}
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
