/**
 * Which unit tests `check:changed` runs (scripts/check-changed.ts). `vitest related` follows imports to any depth, so a
 * change to a file much of the app imports runs much of the suite. Measured over three days of sessions on one computer
 * (12 Nov 2026, `scripts/session-checks.ts`): 25 `check:changed` runs took 4.9 hours, ten failed, and not one of their
 * 44 failed test files was broken by the change (17 timed out or lost a temp folder under load, 7 passed when run alone
 * with nothing edited, 11 failed in other checkouts' runs too, the rest were never run again), while the sessions' own
 * runs of the tests they named found their failures and CI's `check` runs every test on each push. So a change that
 * reaches more than `RELATED_CAP` test files runs only the tests one step away (a changed test, a test that imports a
 * changed file, a test naming one) and leaves the rest to CI, in one line that says so. A branch's run on a runner has
 * no such limit and runs the whole reach (`scripts/ci-plan.ts`, the same functions).
 *
 * The reach is read from import statements with one `git grep`, not from vitest's module graph: a type-only import
 * counts, so it errs toward calling a file a hub, never toward running a hub's whole reach. A second `git grep` reads
 * the repository paths a file holds as text (`resolve("resources/gui-bridge/index.ts")`, `"scripts/x.ts"` handed to
 * bun, a folder a test lists): what a test starts or reads without importing it, counted like an import, and a named
 * folder for everything under it.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { withoutGitSelectors } from "../src/shared/git-env";

/**
 * Test files a change may reach and still run them all. Of the measured runs, every one over 55 test files failed on
 * load alone; the changes of 99 commits on main reach a median of 19 test files and, past the median, hundreds.
 */
export const RELATED_CAP = 40;

export const TEST = /\.test\.[cm]?[jt]sx?$/;
const SOURCE = ["*.ts", "*.tsx", "*.mts", "*.mjs", "*.cjs", "*.js", "*.jsx"];
/** A quoted path of two or more parts; `sourceImports` keeps the ones the tree holds. */
const PATH_TEXT = String.raw`["'](\.{1,2}/)*[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@-]+)+/?["']`;
/**
 * Trees a test runs without importing or naming them, each with the one file every such test finds them through: a
 * change inside counts as a change to that file. OMPdesk's Rust reaches a test only as the binaries `native-bin.ts`
 * locates.
 */
const RUN_THROUGH: readonly (readonly [string, string])[] = [["native/ompdesk/", "src/main/native-bin.ts"]];
/** `from "x"`, `import "x"`, `import("x")`, `require("x")`, `vi.mock("x")`. */
const IMPORT = String.raw`(from|import|require\(|mock\()[[:space:]]*\(?[[:space:]]*["'][^"']+["']`;
const ENDINGS = ["", ".ts", ".tsx", ".mts", ".mjs", ".cjs", ".js", ".jsx", "/index.ts", "/index.tsx"];
/** tsconfig.json `paths`. */
const ALIASES: readonly (readonly [string, string])[] = [
	["@shared/", "src/shared/"],
	["@renderer/", "src/renderer/"],
];

export interface SourceImports {
	/** Every file of the working tree, tracked or not. */
	files: Set<string>;
	/** One `[importer, specifier]` per import statement. */
	imports: (readonly [string, string])[];
	/** One `[file, path]` per file or folder of the tree a source file holds as text. */
	paths: (readonly [string, string])[];
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
	// One `file:"text"` line per match.
	const grep = (pattern: string) =>
		git(["grep", "--untracked", "-I", "-o", "-E", pattern, "--", ...SOURCE]).flatMap(line => {
			const cut = line.indexOf(":");
			const text = /["']([^"']+)["']$/.exec(line)?.[1];
			return cut > 0 && text ? [[line.slice(0, cut), text] as const] : [];
		});
	const files = new Set(git(["ls-files", "-co", "--exclude-standard"]));
	const folders = new Set<string>();
	for (const file of files)
		for (let cut = file.lastIndexOf("/"); cut > 0; cut = file.lastIndexOf("/", cut - 1))
			folders.add(file.slice(0, cut));
	const paths = grep(PATH_TEXT)
		// `join(__dirname, "../../resources/x")` and `resolve("resources/x")` both mean the path from the root.
		.map(([file, text]) => [file, text.replace(/^(?:\.{1,2}\/)+/, "").replace(/\/$/, "")] as const)
		.filter(([file, named]) => named !== file && (files.has(named) || folders.has(named)));
	return { files, imports: grep(IMPORT), paths };
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
	/** The changed tests and the tests that import or name a changed file. */
	direct: string[];
	/** Every test that reaches a changed file through any chain of imports and named paths, `direct` included. */
	related: string[];
}

/** Every file `changed` reaches, with the changed file it was reached from and in how many steps. */
function walk(
	changed: readonly string[],
	{ files, imports, paths }: SourceImports,
): Map<string, { from: string; depth: number }> {
	const users = new Map<string, string[]>();
	const use = (target: string, user: string) => users.set(target, [...(users.get(target) ?? []), user]);
	for (const [importer, specifier] of imports) {
		const target = resolve(importer, specifier, files);
		if (target && target !== importer) use(target, importer);
	}
	for (const [file, named] of paths) use(named, file);
	const reached = new Map(changed.map(file => [file, { from: file, depth: 0 }]));
	for (const file of changed)
		for (const [tree, through] of RUN_THROUGH)
			if (file.startsWith(tree) && !reached.has(through)) reached.set(through, { from: file, depth: 0 });
	let frontier = [...reached.keys()];
	for (let depth = 1; frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const file of frontier) {
			const from = reached.get(file)?.from ?? file;
			// The file's own users, and those of every folder it is in.
			for (let target = file; target; target = target.slice(0, Math.max(0, target.lastIndexOf("/"))))
				for (const user of users.get(target) ?? []) {
					if (reached.has(user)) continue;
					reached.set(user, { from, depth });
					next.push(user);
				}
		}
		frontier = next;
	}
	return reached;
}

/** The unit tests `changed` reaches, one step away and at any depth. */
export function reach(changed: readonly string[], world: SourceImports): Reach {
	const tests = [...walk(changed, world)].filter(([file]) => TEST.test(file)).sort(([a], [b]) => (a < b ? -1 : 1));
	return {
		direct: tests.filter(([, { depth }]) => depth <= 1).map(([file]) => file),
		related: tests.map(([file]) => file),
	};
}

/** Every unit test `changed` reaches, with the changed file that reaches it: what a run's plan says of its pick. */
export function reachedTests(changed: readonly string[], world: SourceImports): Map<string, string> {
	return new Map(
		[...walk(changed, world)].filter(([file]) => TEST.test(file)).map(([file, { from }]) => [file, from]),
	);
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
