/**
 * The built-in pstack pack (`resources/omp-builtin/pstack/`, vendored and translated by `bun run sync:pstack`):
 * - every generated file is what the sync wrote (the manifest's checksums), the bridge's section text is what the
 *   pack yields, and the pack has no `plugin.json` (omp would treat the folder as an Agent Plugins root and drop
 *   54 of the skills for their frontmatter);
 * - skill names equal their folders, none collides with a stock or common user skill, every `skill://` path and
 *   relative link resolves inside the pack;
 * - no Cursor-only name survives translation (a new upstream term fails here until a sync rule translates it);
 * - the always-on section stays under a size cap and names only tools that exist.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assemblePstackSections, renderTextModule } from "../../../scripts/pstack-section";
import { AGENT_CONTROL_DEFINITIONS } from "../agent-control/tools";

const REPO = path.join(__dirname, "../../..");
const PACK = path.join(REPO, "resources/omp-builtin/pstack");
const SKILLS = path.join(PACK, "skills");
/** The one skill the pack points at that lives in another built-in pack (`resources/omp-builtin/formal/`). */
const FORMAL_SKILLS = path.join(REPO, "resources/omp-builtin/formal/skills");
const skillRoot = (name: string): string => (name === "ompdesk-formal-verify" ? FORMAL_SKILLS : SKILLS);

function walk(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out.sort();
}

const files = walk(PACK).filter(file => file !== "pstack-manifest.json");
const textFiles = files.filter(file => /\.(md|sh|mjs|tsv|json)$/.test(file) || file === "UPSTREAM-LICENSE");
const skillNames = readdirSync(SKILLS).sort();
const manifest = JSON.parse(readFileSync(path.join(PACK, "pstack-manifest.json"), "utf8")) as {
	commit: string;
	files: Record<string, string>;
};
const config = JSON.parse(readFileSync(path.join(PACK, "pstack-config.json"), "utf8")) as { commit: string };

function frontmatter(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	const out: Record<string, string> = {};
	for (const line of (match?.[1] ?? "").split("\n")) {
		const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
		if (pair) out[pair[1]] = pair[2].replace(/^"(.*)"$/, "$1");
	}
	return out;
}

describe("pack integrity", () => {
	it("is pinned to one 40-character commit", () => {
		expect(config.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.commit).toBe(config.commit);
	});

	it("has no plugin.json anywhere", () => {
		expect(files.filter(file => file.endsWith("plugin.json"))).toEqual([]);
		expect(existsSync(path.join(PACK, ".claude-plugin"))).toBe(false);
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
		expect(license).toContain("Copyright (c) 2026 Lauren Tan");
		expect(readFileSync(path.join(REPO, "LICENSES/MIT-pstack.txt"), "utf8")).toBe(license);
	});

	it("leaves out what is Cursor-only", () => {
		for (const gone of [
			"setup-pstack",
			"poteto-help",
			"make-bot-ui",
			"tdd",
			"teach",
			"create-formal-verification-skill",
			"maintain-formal-verification-skill",
			"statechart",
		]) {
			expect(skillNames, gone).not.toContain(gone);
		}
		expect(skillNames).toEqual(
			expect.arrayContaining(["pstack-tdd", "pstack-teach", "poteto-mode", "pstack-adapter"]),
		);
		expect(existsSync(path.join(SKILLS, "poteto-mode/scripts/watch-pr"))).toBe(false);
		expect(existsSync(path.join(SKILLS, "poteto-mode/scripts/orch"))).toBe(false);
		expect(existsSync(path.join(SKILLS, "poteto-mode/playbooks/orchestrate.md"))).toBe(false);
	});
});

/** Stock omp's bundled skills and the names users commonly install: a pack skill must not take them. */
const KNOWN_OTHER_SKILLS = [
	"tdd",
	"teach",
	"review",
	"prototype",
	"caveman",
	"ponytail",
	"qa",
	"plan",
	"debug",
	"diagnosing-bugs",
	"codebase-design",
	"design-an-interface",
	"domain-modeling",
	"grilling",
	"ompdesk",
	"reverse-engineer-anything",
	"find-skills",
	"obsidian-vault",
	"cavecrew",
	"setup-pre-commit",
	"request-refactor-plan",
	"learn",
	"recap",
];

describe("skills", () => {
	const ownedByOmpdesk = [
		...readdirSync(path.join(REPO, "resources/omp-builtin/skills")),
		...readdirSync(path.join(REPO, "resources/omp-builtin/rea/skills")),
	];

	it.each(skillNames)("%s: folder, name and description agree", skill => {
		const text = readFileSync(path.join(SKILLS, skill, "SKILL.md"), "utf8");
		const head = frontmatter(text);
		expect(head.name).toBe(skill);
		expect(skill).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		expect(skill.length).toBeLessThanOrEqual(64);
		expect(head.description?.length ?? 0).toBeGreaterThan(0);
		expect(head.description.length).toBeLessThanOrEqual(1024);
	});

	it("collides with no stock, user or other built-in skill name", () => {
		for (const skill of skillNames) {
			expect(KNOWN_OTHER_SKILLS, skill).not.toContain(skill);
			expect(ownedByOmpdesk, skill).not.toContain(skill);
		}
		expect(new Set(skillNames).size).toBe(skillNames.length);
	});

	it("keeps the renamed skills' cross references on the new names", () => {
		const text = textFiles.map(file => readFileSync(path.join(PACK, file), "utf8")).join("\n");
		expect(text).not.toMatch(/\*\*tdd\*\*|\*\*teach\*\*|\.\.\/tdd\/|\.\.\/teach\//);
	});

	it("resolves every skill:// path and relative link inside the pack", () => {
		const missing: string[] = [];
		for (const file of textFiles.filter(entry => entry.endsWith(".md"))) {
			const text = readFileSync(path.join(PACK, file), "utf8");
			for (const match of text.matchAll(/skill:\/\/([a-z0-9][a-z0-9-]*)(\/[^\s)`'"<>]*)?/g)) {
				if (text[match.index + match[0].length] === "<") continue;
				const target = path.join(skillRoot(match[1]), match[1], (match[2] ?? "").replace(/[.,;:]+$/, ""));
				if (!existsSync(target)) missing.push(`${file}: ${match[0]}`);
			}
			if (!file.startsWith("skills/")) continue;
			for (const link of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)(?:#[^)]*)?\)/g)) {
				if (!existsSync(path.resolve(path.dirname(path.join(PACK, file)), link[1])))
					missing.push(`${file}: ${link[1]}`);
			}
		}
		expect(missing).toEqual([]);
	});
});

describe("translation", () => {
	/** Cursor-only or Claude-only names that must not survive; the adapter texts name them on purpose. */
	const FORBIDDEN =
		/AskQuestion|generalPurpose|~?\/?\.cursor|\bCursor\b|Bugbot|pstack-models|claude-opus|grok-|cloud_base_branch|run_in_background|subagent_type|readonly: |agent-transcripts|`Task`|Task tool|cursor-team-kit|\/setup-pstack|poteto-help|poteto-agent|make-bot-ui|watch-pr|todolist|\bcloud agent|control-ui|control-cli/;
	const exempt = new Set([
		"skills/pstack-adapter/SKILL.md",
		"adapter.md",
		"README.md",
		"UPSTREAM-LICENSE",
		"agents/pstack-agent.md",
	]);

	it("leaves no Cursor-only term in a translated file", () => {
		const hits: string[] = [];
		for (const file of textFiles.filter(entry => !exempt.has(entry))) {
			const text = readFileSync(path.join(PACK, file), "utf8");
			const hit = FORBIDDEN.exec(text);
			if (hit) hits.push(`${file}: ${hit[0]}`);
		}
		expect(hits).toEqual([]);
	});

	it("defines the pstack-agent wrapper and a read-only comment-sicko", () => {
		const wrapper = frontmatter(readFileSync(path.join(PACK, "agents/pstack-agent.md"), "utf8"));
		expect(wrapper.name).toBe("pstack-agent");
		const sicko = frontmatter(readFileSync(path.join(PACK, "agents/comment-sicko.md"), "utf8"));
		expect(sicko.name).toBe("comment-sicko");
		expect(sicko.tools).toBe("[read, grep, glob, find]");
	});

	it("has every instruction to copy a playbook's steps into `todo` write them in the todo language the prompt sets", () => {
		// The reply-language section asks for todo items in the conversation language; "copied in verbatim" won over it
		// (real omp, Korean reply language: 0 of 36 items in Korean).
		const verbatim: string[] = [];
		for (const file of textFiles.filter(entry => entry.endsWith(".md"))) {
			const text = readFileSync(path.join(PACK, file), "utf8");
			for (const line of text.split("\n")) {
				if (!/todo/.test(line) || !/\b(copied|[Cc]opy)\b/.test(line)) continue;
				if (/verbatim|word for word(?! without)/.test(line) || !line.includes("`<reply-language>`"))
					verbatim.push(`${file}: ${line.slice(0, 120)}`);
			}
		}
		expect(verbatim).toEqual([]);
	});
});

describe("always-on section", () => {
	const sections = assemblePstackSections(PACK);
	const generated = readFileSync(path.join(REPO, "resources/gui-bridge/modes/pstack-text.ts"), "utf8");

	it("is the text the bridge module carries (run `bun run sync:pstack` after a pack change)", () => {
		expect(generated).toBe(renderTextModule(sections));
	});

	it("stays under its size cap (cost and prompt-cache stability)", () => {
		expect(Buffer.byteLength(sections.full)).toBeLessThanOrEqual(24 * 1024);
		expect(Buffer.byteLength(sections.solo)).toBeLessThanOrEqual(24 * 1024);
		expect(Buffer.byteLength(sections.autopilot)).toBeLessThanOrEqual(3 * 1024);
	});

	it("indexes every principle skill the pack has and no other", () => {
		const onDisk = skillNames.filter(name => name.startsWith("principle-"));
		expect(sections.principles).toEqual(onDisk);
		expect(onDisk).toHaveLength(24);
	});

	it("names only skill:// paths that exist", () => {
		for (const text of [sections.full, sections.solo, sections.autopilot]) {
			for (const match of text.matchAll(/skill:\/\/([a-z0-9][a-z0-9-]*)(\/[^\s)`'"<>]*)?/g)) {
				if (text[match.index + match[0].length] === "<") continue;
				const target = path.join(skillRoot(match[1]), match[1], (match[2] ?? "").replace(/[.,;:]+$/, ""));
				expect(existsSync(target), match[0]).toBe(true);
			}
		}
		expect(statSync(path.join(SKILLS, "poteto-mode/playbooks")).isDirectory()).toBe(true);
	});

	it("names only OMPdesk control tools that exist", () => {
		const defined = new Set(AGENT_CONTROL_DEFINITIONS.map(tool => tool.name));
		const named = new Set(
			[sections.full, sections.solo, sections.autopilot].flatMap(text => text.match(/\bompdesk_[a-z_]+/g) ?? []),
		);
		expect(named.size).toBeGreaterThan(0);
		for (const tool of named) expect(defined.has(tool), tool).toBe(true);
	});

	it("opens with the precedence order and carries no Cursor-only term", () => {
		expect(sections.full.indexOf("repository's rules files")).toBeGreaterThan(0);
		expect(sections.full.indexOf("repository's rules files")).toBeLessThan(sections.full.indexOf("## Adapter"));
		const withoutAdapter = sections.full.replace(/## Adapter[\s\S]*?(?=\n## Non-negotiables)/, "");
		expect(withoutAdapter).not.toMatch(/AskQuestion|generalPurpose|\.cursor|Bugbot|pstack-models|grok-|claude-opus/);
	});
});
