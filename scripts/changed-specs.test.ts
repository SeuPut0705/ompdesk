import { describe, expect, it } from "vitest";
import { phrases, specsFor, touchedClasses } from "./changed-specs";

const strings = {
	"themePicker.search": "Search themes…",
	"themePicker.empty": "No themes match.",
	"common.cancel": "Cancel",
	"queue.moved": "Moved to the end of {lane} for now",
};

const picker = 'const x = t("themePicker.search"); const y = t("common.cancel"); t("themePicker.empty");';

describe("specsFor", () => {
	const specs = new Map([
		["desktop.e2e.ts", 'await picker.getByPlaceholder("Search themes…").fill(label);'],
		["smoke.e2e.ts", 'await page.getByRole("button", { name: "Cancel" }).click();'],
		["theme-picker-dialog.e2e.ts", "// named after it"],
	]);
	const sources = { specs, read: () => picker, strings };

	it("picks a spec that drives a changed component through the text it shows", () => {
		expect(specsFor(["src/renderer/components/dialogs/ThemePickerDialog.tsx"], sources)).toEqual([
			"e2e/desktop.e2e.ts",
			"e2e/theme-picker-dialog.e2e.ts",
		]);
	});

	it("reads no text for a file outside the renderer", () => {
		expect(specsFor(["src/main/theme.ts"], { ...sources, read: () => picker })).toEqual([]);
	});

	it("keeps a changed spec and skips tests", () => {
		expect(
			specsFor(["e2e/smoke.e2e.ts", "src/renderer/components/dialogs/ThemePickerDialog.test.tsx"], sources),
		).toEqual(["e2e/smoke.e2e.ts"]);
	});
});

describe("phrases", () => {
	it("takes only distinctive text, split at placeholders", () => {
		expect(phrases(`${picker} t("queue.moved")`, strings).sort()).toEqual([
			"Moved to the end of",
			"No themes match.",
			"Search themes…",
		]);
	});
});

describe("a stylesheet change", () => {
	const css = [
		"/* .omp-not-a-rule { } */",
		".omp-composer-chip[data-active],",
		".omp-composer-chip[data-active]:hover {",
		"\tbackground: var(--sc-accent-soft);",
		"\tcolor: var(--sc-accent-on-soft);",
		"}",
		"",
		".omp-row { padding: 0; }",
	].join("\n");

	it("names the classes of the rules its changed lines touch", () => {
		expect(touchedClasses(css, [5])).toEqual(["omp-composer-chip"]);
		expect(touchedClasses(css, [8])).toEqual(["omp-row"]);
		expect(touchedClasses(css, [1, 7])).toEqual([]);
	});

	it("picks the specs of the components using a touched class, and none for shared styling", () => {
		const specs = new Map([
			["composer-toolbar.e2e.ts", "// the Run chip"],
			["smoke.e2e.ts", "nothing"],
		]);
		const read = (file: string) => (file.endsWith(".css") ? css : "");
		const users: Record<string, string[]> = {
			"omp-composer-chip": ["src/renderer/components/layout/composer/ComposerToolbar.tsx"],
			"omp-row": Array.from({ length: 12 }, (_, index) => `src/renderer/components/Row${index}.tsx`),
		};
		const sources = {
			specs,
			read,
			strings,
			changedLines: () => [5],
			usersOf: (name: string) => users[name] ?? [],
		};
		expect(specsFor(["src/renderer/styles/components.css"], sources)).toEqual(["e2e/composer-toolbar.e2e.ts"]);
		expect(specsFor(["src/renderer/styles/components.css"], { ...sources, changedLines: () => [8] })).toEqual([]);
	});
});
