/**
 * The per-project Autopilot guide (AUTOPILOT.md at the repo root): reading it (at every `begin`, from the run's
 * worktree) and making sure the guide Start commits has one. The app owns it, nobody edits it in the start sheet: a
 * repo without one gets one built, a guide without a Release section gets that section added, nothing else is rewritten.
 *
 * A new guide is ONE cheap request on stock's `smol` role (`completeOnSmol`, never the main model) over a bounded
 * prompt built from what the repo already says (rules files, README, recent commit subjects, test/build commands, the
 * release facts of `autopilot-release-facts.ts`); any failure falls back to a deterministic template built from the
 * same facts. Everything here takes its I/O as a seam (`GuideIo`) so the rules are testable without a repo or a model.
 */

import type { FileHandle } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	AUTOPILOT_GUIDE_COMMIT_MAX_BYTES,
	AUTOPILOT_GUIDE_FILE,
	AUTOPILOT_GUIDE_MAX_BYTES,
	type AutopilotEnsuredGuide,
	type AutopilotReleaseProcedure,
} from "./autopilot-contracts";
import { boundGuide } from "./autopilot-core";
import {
	guideRelease,
	type ReleaseFacts,
	type ReleaseVerdict,
	releaseSectionTemplate,
	releaseVerdict,
	withReleaseSection,
} from "./autopilot-release-core";
import { collectReleaseFacts } from "./autopilot-release-facts";

export interface GuideIo {
	/** The first `maxBytes` of a file as text, or null when it cannot be read. */
	read(path: string, maxBytes: number): Promise<string | null>;
	/** stdout of a command that exited 0, or null. */
	exec(command: string, args: string[], cwd: string): Promise<string | null>;
	/** The names in a folder; empty when it cannot be read. */
	list(dir: string): Promise<string[]>;
}

/** Real file reads; `exec` is the host's (`pi.exec`), handed in by the bridge module. */
export function fileIo(exec: GuideIo["exec"]): GuideIo {
	return {
		exec,
		async list(dir) {
			return readdir(dir).catch(() => []);
		},
		async read(path, maxBytes) {
			let handle: FileHandle | undefined;
			try {
				handle = await open(path, "r");
				const buffer = Buffer.alloc(maxBytes);
				const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
				return buffer.subarray(0, bytesRead).toString("utf8");
			} catch {
				return null;
			} finally {
				await handle?.close().catch(() => undefined);
			}
		},
	};
}

/** A parsed JSON text as a plain object (empty for anything else); never throws on bad JSON. */
function parsedObject(text: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: {};
	} catch {
		return {};
	}
}

/** The guide as `begin` passes it on: read afresh every call (an edit applies from the next cycle), bounded, null when absent or blank. */
export async function readGuide(root: string, io: GuideIo): Promise<{ text: string; truncated?: boolean } | null> {
	// One byte past the bound is enough to know it is cut; a few more cover a multi-byte cut at the edge.
	const raw = await io.read(join(root, AUTOPILOT_GUIDE_FILE), AUTOPILOT_GUIDE_MAX_BYTES + 8);
	return raw === null ? null : boundGuide(raw);
}

// ---------------------------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------------------------

const RULES_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".cursorrules"] as const;
const RULES_EXCERPT_CHARS = 1500;
const README_EXCERPT_CHARS = 1500;
const COMMITS = 15;
const SCRIPT_NAMES = /^(test|build|lint|check|typecheck|format|e2e)(:|$)/;
/** A drafted guide longer than this is cut (its Release section is put back after the cut): `begin` bounds the guide too. */
const DRAFT_MAX_CHARS = 6500;
const DRAFT_MIN_CHARS = 80;

export interface GuideFacts {
	name: string;
	rules: Array<{ file: string; excerpt: string }>;
	/** First lines of the README, markup and all. */
	readme: string;
	/** The first prose line of the README, for the template's goal. */
	summary: string;
	commits: string[];
	/** Shell-ready commands the repo's own files name (`bun run check:changed`, `cargo test`, ...). */
	commands: string[];
	/** What the repository says about releasing, and the verdict drawn from it. */
	release: ReleaseFacts;
	verdict: ReleaseVerdict;
}

function excerpt(text: string, chars: number): string {
	const clean = text.replace(/\r/g, "").trim();
	return clean.length > chars ? `${clean.slice(0, chars).trimEnd()}\n[...]` : clean;
}

function firstProse(readme: string): string {
	for (const raw of readme.split("\n")) {
		const line = raw.trim();
		if (line.length < 20 || /^[#<[!|>`\-*=]/.test(line)) continue;
		return line.length > 240 ? `${line.slice(0, 240).trimEnd()}...` : line;
	}
	return "";
}

async function commandsOf(root: string, io: GuideIo): Promise<string[]> {
	const found: string[] = [];
	const has = async (file: string) => (await io.read(join(root, file), 1)) !== null;
	const pkg = await io.read(join(root, "package.json"), 64 * 1024);
	if (pkg !== null) {
		const scripts = parsedObject(pkg).scripts;
		const names = typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : [];
		const runner =
			(await has("bun.lock")) || (await has("bun.lockb"))
				? "bun run"
				: (await has("pnpm-lock.yaml"))
					? "pnpm run"
					: (await has("yarn.lock"))
						? "yarn"
						: "npm run";
		for (const name of names) if (SCRIPT_NAMES.test(name)) found.push(`${runner} ${name}`);
	}
	if (await has("Cargo.toml")) found.push("cargo test", "cargo build");
	if (await has("go.mod")) found.push("go test ./...");
	if ((await has("pyproject.toml")) || (await has("pytest.ini"))) found.push("pytest");
	const makefile = await io.read(join(root, "Makefile"), 16 * 1024);
	if (makefile !== null) {
		for (const target of ["test", "check", "build"]) {
			if (new RegExp(`^${target}:`, "m").test(makefile)) found.push(`make ${target}`);
		}
	}
	return found.slice(0, 12);
}

/** What the repo already says about itself, each part bounded. Never throws. */
export async function collectGuideFacts(
	root: string,
	io: GuideIo,
	options: { procedure?: AutopilotReleaseProcedure | null; now?: number } = {},
): Promise<GuideFacts> {
	const rules: GuideFacts["rules"] = [];
	for (const file of RULES_FILES) {
		const text = await io.read(join(root, file), RULES_EXCERPT_CHARS * 4);
		if (text?.trim()) rules.push({ file, excerpt: excerpt(text, RULES_EXCERPT_CHARS) });
		if (rules.length === 3) break;
	}
	const readmeRaw = (await io.read(join(root, "README.md"), README_EXCERPT_CHARS * 4)) ?? "";
	const log = await io.exec("git", ["log", `-n${COMMITS}`, "--format=%s"], root);
	let name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? "this project";
	const pkg = await io.read(join(root, "package.json"), 64 * 1024);
	const declared = pkg === null ? undefined : parsedObject(pkg).name;
	if (typeof declared === "string" && declared.trim()) name = declared.trim();
	const commands = await commandsOf(root, io);
	const release = await collectReleaseFacts(root, io, {
		checks: commands,
		...(options.now ? { now: options.now } : {}),
	});
	return {
		name,
		rules,
		readme: excerpt(readmeRaw, README_EXCERPT_CHARS),
		summary: firstProse(readmeRaw),
		commits: (log ?? "")
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean)
			.slice(0, COMMITS),
		commands,
		release,
		verdict: releaseVerdict(release, options.procedure),
	};
}

/** The deterministic guide for when no model answers: the same sections, filled from what was found. */
export function templateGuide(facts: GuideFacts): string {
	const lines: string[] = [
		`# Autopilot guide: ${facts.name}`,
		"",
		"Project-wide direction for Autopilot runs, shared across sessions and computers. Edit freely: the repo's rules files (AGENTS.md etc.) win over this guide, and Autopilot's hard limits can never be lifted by it. This is direction, not a task list.",
		"",
		"## Goals and roadmap",
		facts.summary ? `- ${facts.summary}` : "- Describe what this project is for and where it is heading.",
		"",
		"## Area priorities",
		"- Fix what is broken and keep the build green before adding anything new.",
		"- Then tests, docs and polish; new features last, small and finished.",
		"",
		"## Do not touch",
		...(facts.rules.length > 0
			? [`- Anything the rules files forbid (${facts.rules.map(rule => rule.file).join(", ")}).`]
			: []),
		"- Generated files, lockfiles, vendored code, and release/CI configuration unless an item needs it.",
		"",
		"## Done means",
		...(facts.commands.length > 0
			? facts.commands.map(command => `- \`${command}\` passes for the change.`)
			: ["- The project's own tests and build pass for the change."]),
		"- One small, focused commit per change.",
		"",
		"## Taste",
		"- Boring, minimal diffs that match the surrounding code.",
		...(facts.commits.length > 0
			? [
					"- Commit messages follow the repo's history, for example:",
					...facts.commits.slice(0, 3).map(subject => `  - ${subject}`),
				]
			: []),
		"",
		...releaseSectionTemplate(facts.release, facts.verdict).trimEnd().split("\n"),
		"",
		"## Long-lived ideas",
		"- (Ideas that outlast a run go here; a run's own follow-ups live on its work board.)",
		"",
	];
	return lines.join("\n");
}

export const GUIDE_DRAFT_SYSTEM = `You write AUTOPILOT.md for a software repository: the project-wide direction an unattended coding agent follows across many sessions.
Output only the markdown file, no preamble and no code fence, at most 4500 characters. Sections, in order: Goals and roadmap; Area priorities (design/UI, performance, features, refactoring, tests, bugs, docs: say which matter most now); Do not touch (paths and kinds of change that are off limits); Done means (the exact check commands that must pass, commit style); Taste (how changes should look); Long-lived ideas. Do not write a Release section: the app adds one built from the repository's release facts.
Use only what the facts below support; where they are silent, write a short sensible default or leave a one-line placeholder. Never invent file paths, commands or names. State that the repo's rules files win over this guide. Do not list concrete backlog tasks.`;

/** The bounded request body: the same facts the template uses, as plain text. */
export function guidePrompt(facts: GuideFacts): string {
	const parts = [`Project: ${facts.name}`];
	for (const rule of facts.rules) parts.push(`--- ${rule.file} (excerpt) ---\n${rule.excerpt}`);
	if (facts.readme) parts.push(`--- README.md (excerpt) ---\n${facts.readme}`);
	if (facts.commits.length > 0) parts.push(`--- Recent commit subjects ---\n${facts.commits.join("\n")}`);
	if (facts.commands.length > 0) parts.push(`--- Test/build commands ---\n${facts.commands.join("\n")}`);
	return parts.join("\n\n");
}

/** A model reply as a guide: fences and chatter around it removed, a length bound; null when it is not usable. */
export function cleanDraft(reply: string): string | null {
	let text = reply.trim();
	const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
	if (fenced?.[1]) text = fenced[1].trim();
	if (text.length < DRAFT_MIN_CHARS || !/^#/m.test(text)) return null;
	if (text.length > DRAFT_MAX_CHARS) text = `${text.slice(0, DRAFT_MAX_CHARS).trimEnd()}\n`;
	return `${text}\n`.replace(/\n{3,}/g, "\n\n");
}

/** One smol-role answer: its text, the model that answered and what it cost. */
export interface GuideReply {
	text: string;
	model: string;
	usd?: number;
	tokens?: number;
}

/** One request to stock's `smol` role: `completeOnSmol` in the bridge, a stand-in in tests. */
export type GuideAsk = (system: string, user: string) => Promise<GuideReply>;

/**
 * The guide Start commits. A guide that exists (the agent's `text`, else the checkout's AUTOPILOT.md) is kept as it is
 * and only gets the facts' Release section when it has none (no model request); without one, one smol request drafts
 * the rest over the facts and the facts' Release section goes in (replacing any the model wrote), the template on any
 * failure. Null for a guide too large to touch. Never writes.
 */
export async function ensureGuide(
	root: string,
	io: GuideIo,
	ask: GuideAsk,
	options: { procedure?: AutopilotReleaseProcedure | null; text?: string; now?: number } = {},
): Promise<AutopilotEnsuredGuide | null> {
	const given = options.text?.trim() ? `${options.text.trim()}\n` : null;
	const file =
		given === null ? await io.read(join(root, AUTOPILOT_GUIDE_FILE), AUTOPILOT_GUIDE_COMMIT_MAX_BYTES + 1) : null;
	const base = given ?? (file?.trim() ? file : null);
	if (base !== null && new TextEncoder().encode(base).length > AUTOPILOT_GUIDE_COMMIT_MAX_BYTES) return null;
	const source = given !== null ? "given" : "file";
	const own = base === null ? null : guideRelease(base);
	if (base !== null && own) return { text: base, source, release: "kept", releases: own.releases };
	const facts = await collectGuideFacts(root, io, options);
	const releases = facts.verdict.releases;
	const section = releaseSectionTemplate(facts.release, facts.verdict);
	if (base !== null) return { text: withReleaseSection(base, section), source, release: "added", releases };
	try {
		const reply = await ask(GUIDE_DRAFT_SYSTEM, guidePrompt(facts));
		const text = cleanDraft(reply.text);
		if (text) {
			const cost = {
				model: reply.model,
				...(reply.usd !== undefined ? { usd: reply.usd } : {}),
				...(reply.tokens !== undefined ? { tokens: reply.tokens } : {}),
			};
			return { text: withReleaseSection(text, section), source: "model", release: "added", releases, cost };
		}
	} catch {
		// No smol model, no credentials, a failed or slow request: the template below.
	}
	return { text: templateGuide(facts), source: "template", release: "added", releases };
}
