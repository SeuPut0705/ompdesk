/**
 * The daily skill-pack bump (`.github/workflows/skills-bump.yml`, `scripts/skill-packs.ts`) moves pstack, ECC and REA
 * to upstream's newest release and commits to main when the pack's tests pass. These checks run with every pack's
 * bump, so an upstream release cannot quietly undo the built-in formal-verification skill: bring back a second skill
 * for the same job, point at the pstack skills it replaced, or drop the routing that sends race and state bugs to it.
 * A failure commits nothing and opens the bump's "Skill pack bump failed" issue.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const BUILTIN = path.join(ROOT, "resources/omp-builtin");
const SKILL = "ompdesk-formal-verify";
const SKILL_FILE = path.join(BUILTIN, "formal/skills", SKILL, "SKILL.md");
/** The packs a bump rewrites, and the always-on pstack text generated from them. */
const BUMPED_PACKS = ["pstack", "ecc", "rea"].map(name => path.join(BUILTIN, name));
const PSTACK_TEXT = path.join(ROOT, "resources/gui-bridge/modes/pstack-text.ts");
/** What a skill for the same job says about itself. */
const SAME_JOB =
	/formal[- ]?verif|model[- ]check|\btla\+|\btlc\b|tlaplus|\blean ?4\b|\bkani\b|statechart|proof[- ]simplif/i;
/** The pstack skills the built-in skill replaced (`SKIPPED_SKILLS` in scripts/sync-pstack.ts). */
const REPLACED =
	/create-formal-verification-skill|maintain-formal-verification-skill|skill:\/\/statechart\b|\/statechart\b/;

function files(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap(entry => {
		const full = path.join(dir, entry);
		return statSync(full).isDirectory() ? files(full) : [full];
	});
}

function frontmatter(text: string): { name: string; description: string } {
	const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	const field = (key: string) =>
		(new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
	return { name: field("name"), description: field("description") };
}

const packFiles = BUMPED_PACKS.flatMap(files);
const textFiles = [...packFiles.filter(file => /\.(md|ts|mjs|js|json|txt)$/.test(file)), PSTACK_TEXT];

describe("the built-in formal-verification skill across skill-pack bumps", () => {
	it("is the one skill for the job: no bumped pack ships another", () => {
		const rivals = packFiles
			.filter(file => path.basename(file) === "SKILL.md")
			.flatMap(file => {
				const { name, description } = frontmatter(readFileSync(file, "utf8"));
				return SAME_JOB.test(name) || SAME_JOB.test(description) ? [path.relative(ROOT, file)] : [];
			});
		expect(rivals).toEqual([]);
	});

	it("no bumped pack names a skill it replaced", () => {
		const stale = textFiles.flatMap(file =>
			readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) => (REPLACED.test(line) ? [`${path.relative(ROOT, file)}:${index + 1}`] : [])),
		);
		expect(stale).toEqual([]);
	});

	it("keeps routing race, ordering, retry and state bugs to it, in the always-on text and the bug-fix playbook", () => {
		const route = `skill://${SKILL}`;
		expect(readFileSync(PSTACK_TEXT, "utf8")).toContain(route);
		expect(readFileSync(path.join(BUILTIN, "pstack/adapter.md"), "utf8")).toContain(route);
		expect(readFileSync(path.join(BUILTIN, "pstack/skills/poteto-mode/playbooks/bug-fix.md"), "utf8")).toContain(
			SKILL,
		);
	});

	it("every skill:// link to it resolves to the skill itself", () => {
		expect(frontmatter(readFileSync(SKILL_FILE, "utf8")).name).toBe(SKILL);
		const links = textFiles.flatMap(file =>
			[...readFileSync(file, "utf8").matchAll(/skill:\/\/(ompdesk-formal-verify)([^\s`)"'\]]*)/g)].map(match => ({
				file,
				rest: match[2] ?? "",
			})),
		);
		expect(links.length).toBeGreaterThan(0);
		for (const { file, rest } of links) {
			const target = rest.replace(/^\//, "").replace(/[.,;:]+$/, "");
			if (target) expect(existsSync(path.join(path.dirname(SKILL_FILE), target)), `${file} → ${rest}`).toBe(true);
		}
	});

	it("the skill itself is no bumped pack's: no pin or sync rewrites it", () => {
		const formal = path.join(BUILTIN, "formal");
		expect(BUMPED_PACKS).not.toContain(formal);
		const packs = readFileSync(path.join(ROOT, "scripts/skill-packs.ts"), "utf8");
		expect(packs).not.toMatch(/config:\s*"resources\/omp-builtin\/formal/);
	});
});
