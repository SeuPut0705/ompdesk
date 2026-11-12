/**
 * Which unit tests `check:changed` runs (scripts/check-changed.ts). `vitest related` follows imports to any depth, so a
 * change to a file much of the app imports runs much of the suite. Measured over three days of sessions on one computer
 * (12 Nov 2026, `scripts/session-checks.ts`): 25 `check:changed` runs took 4.9 hours, ten failed, and not one of their
 * 44 failed test files was broken by the change (17 timed out or lost a temp folder under load, 7 passed when run alone
 * with nothing edited, 11 failed in other checkouts' runs too, the rest were never run again), while the sessions' own
 * runs of the tests they named found their failures and CI's `check` runs every test on each push. So a change that
 * reaches more than `RELATED_CAP` test files runs only the tests one step away (a changed test, a test that imports a
 * changed file, a test naming one) and leaves the rest to CI, in one line that says so.
 *
 * The reach is read from import statements with one `git grep`, not from vitest's module graph: a type-only import
 * counts, so it errs toward calling a file a hub, never toward running a hub's whole reach.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { withoutGitSelectors } from "../src/shared/git-env";

/**
 * Test files a change may reach and still run them all. Of the measured runs, every one over 55 test files failed on
 * load alone; the changes of 99 commits on main reach a median of 19 test files and, past the median, hundreds.
 */
export const RELATED_CAP = 40;

const TEST = /\.test\.[cm]?[jt]sx?$/;
const SOURCE = ["*.ts", "*.tsx", "*.mts", "*.mjs", "*.cjs", "*.js", "*.jsx"];
/** `from "x"`, `import "x"`, `import("x")`, `require("x")`, `vi.mock("x")`. */
const IMPORT = String.raw`(from|import|require\(|mock\()[[:space:]]*\(?[[:space:]]*["'][^"']+["']`;
const ENDINGS = ["", ".ts", ".tsx", ".mts", ".mjs", ".cjs", ".js", ".jsx", "/index.ts", "/index.tsx"];
/** tsconfig.json `paths`. */
const ALIASES: readonly (readonly [string, string])[] = [
	["@shared/", "src/shared/"],
	["@renderer/", "src/renderer/"],
];

export interface SourceImports {
	/** Every source file of the working tree, tracked or not. */
	files: Set<string>;
	/** One `[importer, specifier]` per import statement. */
	imports: (readonly [string, string])[];
}

/** The working tree's source files and their import statements. */
export function sourceImports(cwd?: string): SourceImports {
	const git = (args: string[]): string[] => {
		try {
			return execFileSync("git", args, {
				cwd,
				env: withoutGitSelectors(process.env),
				encoding: "utf8",
				maxBuffer: 256 << 20,
			})
				.split("\n")
				.filter(Boolean);
		} catch {
			// `git grep` exits 1 when nothing matches.
			return [];
		}
	};
	const imports: (readonly [string, string])[] = [];
	for (const line of git(["grep", "--untracked", "-I", "-o", "-E", IMPORT, "--", ...SOURCE])) {
		const cut = line.indexOf(":");
		const specifier = /["']([^"']+)["']$/.exec(line)?.[1];
		if (cut > 0 && specifier) imports.push([line.slice(0, cut), specifier]);
	}
	return { files: new Set(git(["ls-files", "-co", "--exclude-standard", "--", ...SOURCE])), imports };
}

function resolve(importer: string, specifier: string, files: ReadonlySet<string>): string | undefined {
	const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
	if (!alias && !specifier.startsWith(".")) return undefined;
	const base = alias
		? alias[1] + specifier.slice(alias[0].length)
		: path.posix.join(path.posix.dirname(importer), specifier);
	// `./a.js` names `a.ts` in TypeScript's ESM spelling.
	for (const stem of [base, base.replace(/\.[cm]?js$/, "")])
		for (const ending of ENDINGS) if (files.has(stem + ending)) return stem + ending;
	return undefined;
}

export interface Reach {
	/** The changed tests and the tests that import a changed file. */
	direct: string[];
	/** Every test that reaches a changed file through any chain of imports, `direct` included. */
	related: string[];
}

/** The unit tests `changed` reaches through `imports`, one step away and at any depth. */
export function reach(changed: readonly string[], { files, imports }: SourceImports): Reach {
	const importers = new Map<string, string[]>();
	for (const [importer, specifier] of imports) {
		const target = resolve(importer, specifier, files);
		if (target && target !== importer) importers.set(target, [...(importers.get(target) ?? []), importer]);
	}
	const direct = new Set(changed.filter(file => TEST.test(file)));
	const related = new Set(direct);
	const seen = new Set(changed);
	let frontier = [...changed];
	for (let depth = 1; frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const file of frontier)
			for (const importer of importers.get(file) ?? []) {
				if (seen.has(importer)) continue;
				seen.add(importer);
				next.push(importer);
				if (!TEST.test(importer)) continue;
				related.add(importer);
				if (depth === 1) direct.add(importer);
			}
		frontier = next;
	}
	return { direct: [...direct].sort(), related: [...related].sort() };
}

export interface TestPick {
	/** `related`: `vitest related` over `files`, the changed sources (their whole reach). `run`: these test files. */
	command: "related" | "run";
	files: string[];
	/** Test files that reach the change only through other files and are left to CI. */
	left: number;
}

/**
 * What vitest runs for a change: its whole reach while that is at most `RELATED_CAP` test files, else the tests one
 * step away. `readers` are the tests naming a changed file (`scripts/changed-readers.ts`); they run either way.
 */
export function pickTests(sources: readonly string[], readers: readonly string[], reached: Reach): TestPick {
	if (reached.related.length <= RELATED_CAP)
		return { command: "related", files: [...new Set([...sources, ...readers])], left: 0 };
	const files = [...new Set([...reached.direct, ...readers])];
	return { command: "run", files, left: reached.related.filter(file => !files.includes(file)).length };
}
