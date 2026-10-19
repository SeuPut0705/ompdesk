import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULES_FILE_BYTES, readRulesText, rulesIndex, statedByRules } from "./rules-file";

const AGENTS = [
	"# Rules",
	"- Packaged apps keep only Electron's en-US and ko locales; never en alone, which blanks the window.",
	"- Settings rows read icon + label + control. Every string description sits behind its info glyph.",
].join("\n");

describe("statedByRules", () => {
	const index = rulesIndex(AGENTS);
	const page = (gist: string) => ({ title: "제목", body: "본문은 한국어로 쓴다", gist });

	it("matches a gist one sentence of the rules file holds most of, whatever the wording's endings", () => {
		expect(statedByRules(index, page("Packaged builds keep only the en-US and ko Electron locales."))).toBe(true);
		expect(statedByRules(index, page("Every settings description sits behind an info glyph."))).toBe(true);
	});

	it("leaves a page alone that shares a word or two, or is spread over several sentences", () => {
		expect(statedByRules(index, page("Settings changes need a relaunch of the window."))).toBe(false);
		expect(statedByRules(index, page("Packaged settings rows keep the glyph locales."))).toBe(false);
		expect(statedByRules(rulesIndex(""), page("Packaged builds keep only the en-US and ko Electron locales."))).toBe(
			false,
		);
	});
});

describe("readRulesText", () => {
	let root = "";
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "rules-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads AGENTS.md and CLAUDE.md at the root of the repository the folder is in, whole up to the bound", async () => {
		await mkdir(join(root, ".git"));
		await mkdir(join(root, "packages", "app"), { recursive: true });
		await writeFile(join(root, "AGENTS.md"), `${"a".repeat(RULES_FILE_BYTES)}TAIL`);
		await writeFile(join(root, "CLAUDE.md"), "claude rules");
		await writeFile(join(root, "packages", "app", "AGENTS.md"), "nested, not the root's");
		const text = await readRulesText(join(root, "packages", "app"));
		expect(text).toContain("claude rules");
		expect(text).not.toContain("TAIL");
		expect(text).not.toContain("nested");
	});

	it("a rule stated deep in a long rules file (OMPdesk's is over 400 KB) still counts", async () => {
		const filler = "- Unrelated filler line about window chrome and tray icons.\n".repeat(5000);
		await writeFile(
			join(root, "AGENTS.md"),
			`${filler}- Packaged apps keep only Electron's en-US and ko locales; never en alone.\n`,
		);
		expect(filler.length).toBeGreaterThan(250 * 1024);
		const index = rulesIndex(await readRulesText(root));
		const gist = "Packaged builds keep only the en-US and ko Electron locales.";
		expect(statedByRules(index, { title: "제목", body: "본문", gist })).toBe(true);
	});

	it("is empty without a folder or a rules file, and reads the folder itself outside a repository", async () => {
		expect(await readRulesText("")).toBe("");
		expect(await readRulesText(join(root, "missing"))).toBe("");
		await writeFile(join(root, "AGENTS.md"), "here");
		expect(await readRulesText(root)).toBe("here");
	});
});
