import { describe, expect, it } from "vitest";
import changelogMarkdown from "../../../CHANGELOG.md?raw";
import {
	changelogReleases,
	changelogSection,
	changelogSince,
	changelogSummary,
	endsWithFinalConsonant,
	loadChangelog,
	whatsNewAction,
} from "./whats-new";

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

describe("changelogSince", () => {
	const THREE = `# Changelog

## [0.10.0] - 2026-10-16

열 번째.

## [0.9.0] - 2026-10-15

아홉 번째.

## [0.8.0] - 2026-10-14

여덟 번째.
`;

	it("reads one release as its bare notes", () => {
		expect(changelogSince(THREE, "0.9.0", "0.10.0")).toBe("열 번째.");
	});

	it("lists every skipped release newest first, comparing versions numerically", () => {
		expect(changelogSince(THREE, "0.8.0", "0.10.0")).toBe(
			"## [0.10.0] - 2026-10-16\n\n열 번째.\n\n## [0.9.0] - 2026-10-15\n\n아홉 번째.",
		);
	});

	it("falls back to the running version's notes without a usable last-seen version", () => {
		expect(changelogSince(THREE, null, "0.9.0")).toBe("아홉 번째.");
		expect(changelogSince(THREE, "0.10.0", "0.9.0")).toBe("아홉 번째.");
	});
});

describe("changelogSummary", () => {
	it("takes the first paragraph as plain text", () => {
		expect(changelogSummary("한 줄 요약이에요 `code`.\n\n- 항목")).toBe("한 줄 요약이에요 code.");
		expect(changelogSummary("첫 줄\n이어지는 줄\n\n- 항목")).toBe("첫 줄 이어지는 줄");
	});

	it("takes the first item of a section that opens with a list, and skips a leading heading", () => {
		expect(changelogSummary("- 하나\n- 둘")).toBe("하나");
		expect(changelogSummary("### 추가\n\n- 새 기능")).toBe("새 기능");
	});
});

describe("endsWithFinalConsonant", () => {
	it("is true for versions ending in 0, 3 or 6 (Korean 으로), false otherwise (로)", () => {
		expect(endsWithFinalConsonant("0.33.0")).toBe(true);
		expect(endsWithFinalConsonant("0.33.3")).toBe(true);
		expect(endsWithFinalConsonant("0.33.6")).toBe(true);
		expect(endsWithFinalConsonant("0.33.1")).toBe(false);
		expect(endsWithFinalConsonant("0.33.2")).toBe(false);
	});
});

describe("loadChangelog", () => {
	it("loads the bundled CHANGELOG.md once, from its own chunk", async () => {
		const first = loadChangelog();
		expect(loadChangelog()).toBe(first);
		expect(await first).toBe(changelogMarkdown);
	});
});
