import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AUTOPILOT_GUIDE_COMMIT_MAX_BYTES,
	AUTOPILOT_GUIDE_FILE,
	AUTOPILOT_GUIDE_MAX_BYTES,
	DEFAULT_AUTOPILOT_SETTINGS,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { boundGuide, buildBegin, initialStateEntry } from "../../resources/gui-bridge/modes/autopilot-core";
import {
	cleanDraft,
	collectGuideFacts,
	ensureGuide,
	fileIo,
	type GuideIo,
	guidePrompt,
	readGuide,
	templateGuide,
} from "../../resources/gui-bridge/modes/autopilot-guide";
import { autopilotSection } from "../../resources/gui-bridge/modes/autopilot-prompt";
import { guideRelease } from "../../resources/gui-bridge/modes/autopilot-release-core";

let dir: string;
const noExec: GuideIo["exec"] = async () => null;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(tmpdir(), "omp-guide-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => fs.writeFile(path.join(dir, name), text);

describe("reading the guide", () => {
	it("returns the file's text, trimmed", async () => {
		await write(AUTOPILOT_GUIDE_FILE, "\n# Guide\n\nShip small.\n\n");
		expect(await readGuide(dir, fileIo(noExec))).toEqual({ text: "# Guide\n\nShip small." });
	});

	it("is null for an absent or a blank file", async () => {
		expect(await readGuide(dir, fileIo(noExec))).toBeNull();
		await write(AUTOPILOT_GUIDE_FILE, "  \n\n");
		expect(await readGuide(dir, fileIo(noExec))).toBeNull();
	});

	it("bounds a long guide to the byte limit on a character boundary and says it was cut", async () => {
		// Three-byte characters: a cut at the byte limit lands inside one.
		await write(AUTOPILOT_GUIDE_FILE, `# G\n${"가".repeat(6000)}`);
		const guide = await readGuide(dir, fileIo(noExec));
		expect(guide?.truncated).toBe(true);
		expect(new TextEncoder().encode(guide?.text ?? "").length).toBeLessThanOrEqual(AUTOPILOT_GUIDE_MAX_BYTES);
		expect(guide?.text).not.toContain("\uFFFD");
		expect(guide?.text).toContain("guide cut here");
	});

	it("passes a guide of exactly the limit through whole", () => {
		const text = "x".repeat(AUTOPILOT_GUIDE_MAX_BYTES);
		expect(boundGuide(text)).toEqual({ text });
	});

	it("reads afresh every call: an edit applies at the next begin", async () => {
		await write(AUTOPILOT_GUIDE_FILE, "# Guide\nONE");
		const io = fileIo(noExec);
		expect((await readGuide(dir, io))?.text).toContain("ONE");
		await write(AUTOPILOT_GUIDE_FILE, "# Guide\nTWO");
		expect((await readGuide(dir, io))?.text).toContain("TWO");
		await fs.rm(path.join(dir, AUTOPILOT_GUIDE_FILE));
		expect(await readGuide(dir, io)).toBeNull();
	});
});

describe("begin carries the guide", () => {
	const state = initialStateEntry({
		run: "r",
		root: "/tmp/r",
		branch: "autopilot/r",
		baseBranch: "main",
		settings: DEFAULT_AUTOPILOT_SETTINGS,
		role: "parent",
		excludedTools: [],
		now: 0,
	});
	const begin = (guide: { text: string; truncated?: boolean } | null) =>
		buildBegin({
			cycle: 1,
			settings: DEFAULT_AUTOPILOT_SETTINGS,
			records: [],
			notes: [],
			stopping: false,
			branch: "autopilot/r",
			state,
			due: false,
			used: { tokens: 0, usd: 0 },
			activeMs: 0,
			guide,
		});

	it("includes the guide, and leaves the field out when there is none", async () => {
		await write(AUTOPILOT_GUIDE_FILE, "# Guide\nONE");
		expect(begin(await readGuide(dir, fileIo(noExec))).guide?.text).toContain("ONE");
		expect("guide" in begin(null)).toBe(false);
	});

	it("shows an edit made between two cycles at the second begin", async () => {
		const io = fileIo(noExec);
		await write(AUTOPILOT_GUIDE_FILE, "# Guide\nONE");
		const first = begin(await readGuide(dir, io));
		await write(AUTOPILOT_GUIDE_FILE, "# Guide\nTWO");
		const second = begin(await readGuide(dir, io));
		expect([first.guide?.text, second.guide?.text]).toEqual(["# Guide\nONE", "# Guide\nTWO"]);
	});
});

describe("the static section", () => {
	it("ranks the guide below the rules files and below the hard limits, and is the same text every time", () => {
		const text = autopilotSection(2);
		expect(text).toContain("begin.guide");
		expect(text).toMatch(/ranks below the repository's rules files/);
		expect(text).toMatch(/never lift the HARD LIMITS|can never lift the HARD LIMITS/);
		expect(autopilotSection(2)).toBe(text);
	});
});

describe("the guide Start commits", () => {
	const files: Record<string, string> = {
		"AGENTS.md": "# Rules\n\nRun `bun run check` before every commit.",
		"README.md": "# Demo\n\nDemo is a tiny tool that turns notes into reminders for busy people.\n",
		"package.json": JSON.stringify({
			name: "demo",
			scripts: { test: "vitest", build: "tsc", dev: "vite", lint: "biome" },
		}),
		"bun.lock": "",
	};
	const io = (extra: Record<string, string> = {}): GuideIo => ({
		read: async (file, max) => {
			const content = { ...files, ...extra }[path.basename(file)];
			return content === undefined ? null : content.slice(0, max);
		},
		exec: async (_command, args) =>
			args[0] === "log" && args[1]?.startsWith("-n")
				? "fix: a bug\nfeat: a thing\ndocs: words\nchore: tidy\n"
				: null,
		list: async () => [],
	});
	const fail = async () => {
		throw new Error("no credentials");
	};

	it("collects the rules, README, commits, commands and release facts, each bounded", async () => {
		const facts = await collectGuideFacts("/work/demo", io());
		expect(facts.name).toBe("demo");
		expect(facts.rules.map(rule => rule.file)).toEqual(["AGENTS.md"]);
		expect(facts.summary).toContain("tiny tool");
		expect(facts.commits).toHaveLength(4);
		expect(facts.commands).toEqual(["bun run test", "bun run build", "bun run lint"]);
		expect(facts.verdict).toEqual({ releases: false });
		expect(guidePrompt(facts)).toContain("bun run check");
	});

	it("without a guide falls back to the deterministic template when the model fails, with a Release section", async () => {
		const ensured = await ensureGuide("/work/demo", io(), fail);
		expect(ensured).toMatchObject({ source: "template", release: "added", releases: false });
		expect(ensured?.text).toContain("# Autopilot guide: demo");
		expect(ensured?.text).toContain("`bun run test` passes");
		expect(ensured?.text).toContain("  - fix: a bug");
		expect(ensured?.text).toMatch(/rules files .* win over this guide/);
		expect(guideRelease(ensured?.text ?? "")).toEqual({ title: "Release", releases: false, marked: true });
	});

	it("falls back too when the reply is not a usable guide", async () => {
		expect(await ensureGuide("/work/demo", io(), async () => ({ text: "Sure!", model: "m/smol" }))).toMatchObject({
			source: "template",
		});
	});

	it("uses the model's guide, fence stripped, and reports what it cost; the Release section is the facts', never the model's", async () => {
		const head = `# Autopilot guide: demo\n\n## Goals and roadmap\n- ${"Reminders that work. ".repeat(6)}\n`;
		const ensured = await ensureGuide("/work/demo", io(), async () => ({
			text: `\`\`\`markdown\n${head}\n## Release\n\nReleases: yes\n1. npm publish\n\n## Long-lived ideas\n- x\n\`\`\``,
			model: "p/smol",
			usd: 0.0004,
		}));
		expect(ensured).toMatchObject({ source: "model", release: "added", cost: { model: "p/smol", usd: 0.0004 } });
		expect(ensured?.text.startsWith("# Autopilot guide: demo")).toBe(true);
		expect(ensured?.text).not.toContain("```");
		expect(ensured?.text).not.toContain("npm publish");
		expect(ensured?.text).toMatch(/## Release\n\nReleases: no\n[\s\S]*\n## Long-lived ideas\n- x\n$/);
		const missing = await ensureGuide("/work/demo", io(), async () => ({ text: head, model: "p/smol" }));
		expect(guideRelease(missing?.text ?? "")).toMatchObject({ releases: false, marked: true });
	});

	it("keeps an existing guide byte for byte when it has a Release section; asks no model", async () => {
		const own = "# Ours\n\nSmall diffs.\n\n## Release\n\nWe ship on Fridays.\n";
		let asked = 0;
		const ensured = await ensureGuide("/work/demo", io({ "AUTOPILOT.md": own }), async () => {
			asked++;
			throw new Error("x");
		});
		expect(ensured).toEqual({ text: own, source: "file", release: "kept", releases: true });
		expect(asked).toBe(0);
	});

	it("adds only the missing Release section to an existing guide, never rewriting the rest, with no model request", async () => {
		const own = "# Ours\n\nSmall diffs.\n\n## Release cadence\n\nWhen the maintainers want.\n";
		let asked = 0;
		const added = await ensureGuide("/work/demo", io({ "AUTOPILOT.md": own }), async () => {
			asked++;
			throw new Error("x");
		});
		expect(added).toMatchObject({ source: "file", release: "added", releases: false });
		expect(added?.text.startsWith(`${own}\n## Release\n\nReleases: no\n`)).toBe(true);
		expect(asked).toBe(0);
	});

	it("an agent's own text wins over the file, and only gets the Release section it lacks", async () => {
		const ensured = await ensureGuide("/work/demo", io({ "AUTOPILOT.md": "# File\n" }), fail, {
			text: "# Given\n\nGo.",
			procedure: { file: "AGENTS.md", anchors: ["Release"] },
		});
		expect(ensured).toMatchObject({ source: "given", release: "added", releases: true });
		expect(ensured?.text).toMatch(/^# Given\n\nGo\.\n\n## Release\n\nReleases: yes\n- Follow `AGENTS\.md` › Release/);
	});

	it("leaves a guide too large to commit alone", async () => {
		const huge = `# Big\n${"x".repeat(AUTOPILOT_GUIDE_COMMIT_MAX_BYTES)}`;
		expect(await ensureGuide("/work/demo", io({ "AUTOPILOT.md": huge }), fail)).toBeNull();
	});

	it("the template is deterministic and works for a repo that says nothing", async () => {
		const empty: GuideIo = { read: async () => null, exec: async () => null, list: async () => [] };
		const facts = await collectGuideFacts("/work/bare-repo", empty);
		expect(facts.name).toBe("bare-repo");
		expect(templateGuide(facts)).toBe(templateGuide(facts));
		expect(templateGuide(facts)).toContain("The project's own tests and build pass for the change.");
	});

	it("cleanDraft refuses text without a heading and bounds a long reply", () => {
		expect(cleanDraft(`${"plain words ".repeat(20)}`)).toBeNull();
		const long = cleanDraft(`# T\n${"line of text\n".repeat(1000)}`);
		expect(long?.length).toBeLessThanOrEqual(6600);
	});
});
