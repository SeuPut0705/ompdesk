/**
 * The built-in ECC pack (`resources/omp-builtin/ecc/`, vendored by `bun run sync:ecc`):
 * - every generated file is what the sync wrote (the manifest's checksums), and the pack has neither `plugin.json`
 *   nor `package.json` (omp reads an extension root's `skills/` and `commands/` itself);
 * - only the index skill `ecc` is listed to the model; it names every other skill exactly once, and those are hidden;
 * - the skills the pin's curation drops are gone and nothing kept still points at one;
 * - no skill or command takes a name another built-in pack, stock omp or OMPdesk uses.
 * The real omp's view of the same pack (cost, loading, `skill://` resolution, no shadowed command) is
 * `ecc-stock.test.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.join(__dirname, "../../..");
const BUILTIN = path.join(REPO, "resources/omp-builtin");
const PACK = path.join(BUILTIN, "ecc");
const SKILLS = path.join(PACK, "skills");

function walk(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out.sort();
}

function frontmatter(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	const out: Record<string, string> = {};
	for (const line of (match?.[1] ?? "").split("\n")) {
		const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
		if (pair) out[pair[1]] = pair[2].replace(/^"(.*)"$/, "$1");
	}
	return out;
}

const files = walk(PACK).filter(file => file !== "ecc-manifest.json");
const manifest = JSON.parse(readFileSync(path.join(PACK, "ecc-manifest.json"), "utf8")) as {
	commit: string;
	files: Record<string, string>;
};
const config = JSON.parse(readFileSync(path.join(PACK, "ecc-config.json"), "utf8")) as {
	commit: string;
	curation: { droppedSkills: Record<string, { leads: string }>; renamedCommands: Record<string, { to: string }> };
};
const skillNames = readdirSync(SKILLS).sort();
const commandNames = readdirSync(path.join(PACK, "commands"))
	.map(file => file.replace(/\.md$/, ""))
	.sort();
const dropped = Object.keys(config.curation.droppedSkills);
const index = readFileSync(path.join(SKILLS, "ecc/SKILL.md"), "utf8");

describe("pack integrity", () => {
	it("is pinned to one 40-character commit", () => {
		expect(config.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.commit).toBe(config.commit);
	});

	it("has no plugin.json or package.json anywhere", () => {
		expect(files.filter(file => /(^|\/)(plugin|package)\.json$/.test(file))).toEqual([]);
	});

	it("matches the sync's checksum manifest (a hand edit of a generated file fails here)", () => {
		expect(files).toEqual(Object.keys(manifest.files).sort());
		for (const file of files) {
			const hash = createHash("sha256")
				.update(readFileSync(path.join(PACK, file)))
				.digest("hex");
			expect(hash, file).toBe(manifest.files[file]);
		}
	});

	it("carries the upstream license in the pack and in LICENSES/", () => {
		const license = readFileSync(path.join(PACK, "UPSTREAM-LICENSE"), "utf8");
		expect(license).toContain("Copyright (c) 2026 Affaan Mustafa");
		expect(readFileSync(path.join(REPO, "LICENSES/MIT-ecc.txt"), "utf8")).toBe(license);
	});
});

describe("skills", () => {
	it.each(skillNames)("%s: folder, name and description agree", skill => {
		const head = frontmatter(readFileSync(path.join(SKILLS, skill, "SKILL.md"), "utf8"));
		expect(head.name).toBe(skill);
		expect(skill).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		expect(head.description?.length ?? 0).toBeGreaterThan(0);
	});

	it("lists only the index to the model; every other skill is hidden", () => {
		const listed = skillNames.filter(
			skill =>
				frontmatter(readFileSync(path.join(SKILLS, skill, "SKILL.md"), "utf8"))["disable-model-invocation"] !==
				"true",
		);
		expect(listed).toEqual(["ecc"]);
	});

	it("names every hidden skill exactly once in the index, and only shipped ones", () => {
		const named = Array.from(index.matchAll(/^- [^:\n]+: (.+)$/gm), line =>
			Array.from(line[1].matchAll(/`([a-z0-9-]+)`/g), match => match[1]),
		).flat();
		expect([...named].sort()).toEqual(skillNames.filter(skill => skill !== "ecc"));
		expect(new Set(named).size).toBe(named.length);
	});

	it("keeps the index description short: it is the pack's whole cost in every prompt", () => {
		expect(frontmatter(index).description.length).toBeLessThanOrEqual(400);
	});

	it("drops the skills the curation leaves to pstack, and nothing kept still points at one", () => {
		const pstack = readdirSync(path.join(BUILTIN, "pstack/skills"));
		for (const name of dropped) {
			expect(skillNames, name).not.toContain(name);
			const { leads } = config.curation.droppedSkills[name];
			const lead = leads.replace(/^skill:\/\//, "").split("/")[0];
			expect(pstack, `${name} leads to ${leads}`).toContain(lead);
		}
		const refs = new RegExp(`\`(?:skills/)?(${dropped.join("|")})/?\`|\\.\\./(${dropped.join("|")})/SKILL\\.md`);
		for (const file of files.filter(file => /^(skills|commands)\/.*\.md$/.test(file))) {
			expect(readFileSync(path.join(PACK, file), "utf8"), file).not.toMatch(refs);
		}
	});
});

describe("names", () => {
	const otherSkills = [
		...readdirSync(path.join(BUILTIN, "pstack/skills")),
		...readdirSync(path.join(BUILTIN, "rea/skills")),
		...readdirSync(path.join(BUILTIN, "skills")),
		// Names users commonly install (the pstack pack keeps the same list).
		"tdd",
		"teach",
		"review",
		"prototype",
		"plan",
		"debug",
		"qa",
		"learn",
		"recap",
	];

	it("takes no skill name another pack or a common user skill has", () => {
		expect(skillNames.filter(skill => otherSkills.includes(skill))).toEqual([]);
	});

	it("ships the plan command as ecc-plan (stock omp's /plan would hide it) and nothing else renamed", () => {
		expect(config.curation.renamedCommands).toEqual({ plan: expect.objectContaining({ to: "ecc-plan" }) });
		expect(commandNames).toContain("ecc-plan");
		expect(commandNames).not.toContain("plan");
		expect(commandNames).toHaveLength(24);
		expect(existsSync(path.join(PACK, "commands/plan.md"))).toBe(false);
	});

	it("names no command after a skill of the pack (a command and a /skill: entry would read alike)", () => {
		expect(commandNames.filter(name => skillNames.includes(name))).toEqual([]);
	});
});
