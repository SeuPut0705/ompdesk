/**
 * Which ignored paths of a worktree its own project can make again, from evidence the repository carries, never from
 * a folder's name alone (a hand-made `dist/` is the user's data). One rule table, first match wins:
 *
 * - `cachedir-tag`: the directory holds a `CACHEDIR.TAG` with the Cache Directory Tagging signature, which the tool
 *   that owns it wrote (Cargo's `target/`, pytest, mypy, ruff; OMPdesk's own `out/`);
 * - `lockfile-dependencies`: `node_modules/` beside a tracked `package.json` with a tracked lockfile at or above it, so
 *   the package manager installs the same tree again;
 * - `python-bytecode`: `__pycache__/` holding only `.pyc` files;
 * - `build-tool-output`: the output directory of a build tool the package depends on and names in one of its scripts
 *   (or a `--outDir`-style flag a script passes), as that tool's config sets it;
 * - `gitignore-build-section`: the tracked `.gitignore` line that ignores it sits under a comment saying it is build
 *   output, artifacts, generated files, a cache or dependencies (`# Build output`).
 *
 * Anything else ignored (`.env`, a local database, `tmp/`, a seeded config someone edited) is data no tool brings
 * back: disk care archives it privately before a worktree goes, or keeps the worktree.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gitRaw } from "../local/git/exec";

export type RegenerableReason =
	| "cachedir-tag"
	| "lockfile-dependencies"
	| "python-bytecode"
	| "build-tool-output"
	| "gitignore-build-section";

export interface IgnoredVerdict {
	/** Relative to the worktree, `/`-separated; a directory ends with `/` (as `git status` prints it). */
	path: string;
	/** Null: no evidence the project makes it again. */
	regenerable: { reason: RegenerableReason; evidence: string } | null;
}

/** What the rules read of the worktree, gathered once (`readEvidence`). */
export interface RepoEvidence {
	/** Tracked files, relative and `/`-separated. */
	tracked: ReadonlySet<string>;
	/** `git check-ignore -v` per ignored path: the file and line of the pattern that ignores it. */
	ignoredBy: ReadonlyMap<string, { source: string; line: number }>;
	readText(relative: string): Promise<string | null>;
	isCacheDirTagged(relativeDir: string): Promise<boolean>;
	/** Every file under the directory ends with `.pyc` (false past a few thousand entries). */
	onlyBytecode(relativeDir: string): Promise<boolean>;
}

const CACHEDIR_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];
/** A `.gitignore` comment that names what follows as something a tool produces. */
const BUILD_SECTION =
	/\b(?:build|builds|built|output|outputs|artifacts?|generated|caches?|dependencies|deps|compiled|bundles?|dist)\b/i;

/**
 * A build tool and the directories it writes by default. `bin` must appear in one of the package's scripts and
 * `pkg` in its dependencies; `config` names files whose literal `outDir`/`output` setting replaces the default.
 */
const BUILD_TOOLS: ReadonlyArray<{
	pkg: string;
	bin: RegExp;
	outputs: string[];
	config?: RegExp;
	configFiles?: string[];
}> = [
	{
		pkg: "electron-vite",
		bin: /\belectron-vite\b/,
		outputs: ["out"],
		config: /\boutDir\s*:\s*["'`]([^"'`]+)["'`]/,
		configFiles: ["electron.vite.config.ts", "electron.vite.config.js", "electron.vite.config.mjs"],
	},
	{
		pkg: "vite",
		bin: /(?<![\w-])vite(?![\w-])/,
		outputs: ["dist"],
		config: /\boutDir\s*:\s*["'`]([^"'`]+)["'`]/,
		configFiles: ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"],
	},
	{
		pkg: "electron-builder",
		bin: /\belectron-builder\b/,
		outputs: ["dist"],
		config: /^\s*output\s*:\s*["']?([^"'\s#]+)/m,
		configFiles: ["electron-builder.yml", "electron-builder.yaml"],
	},
	{ pkg: "next", bin: /\bnext\b/, outputs: [".next", "out"] },
	{ pkg: "nuxt", bin: /\bnuxt\b/, outputs: [".nuxt", ".output"] },
	{ pkg: "astro", bin: /\bastro\b/, outputs: ["dist", ".astro"] },
	{ pkg: "@sveltejs/kit", bin: /\b(?:svelte-kit|vite)\b/, outputs: [".svelte-kit"] },
	{ pkg: "turbo", bin: /\bturbo\b/, outputs: [".turbo"] },
	{ pkg: "parcel", bin: /\bparcel\b/, outputs: ["dist", ".parcel-cache"] },
	{ pkg: "webpack-cli", bin: /\bwebpack\b/, outputs: ["dist"] },
	{
		pkg: "typescript",
		bin: /\btsc\b/,
		outputs: [],
		config: /"outDir"\s*:\s*"([^"]+)"/,
		configFiles: ["tsconfig.json", "tsconfig.build.json"],
	},
];
/** An output directory a script names itself. */
const OUT_FLAG = /--out-?dir(?:=|\s+)["']?([^\s"'&|;]+)/gi;

const trimDir = (relative: string): string => relative.replace(/\/+$/, "");
const parentOf = (relative: string): string => {
	const parent = path.posix.dirname(trimDir(relative));
	return parent === "." ? "" : parent;
};
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
const normalizeOut = (value: string): string => path.posix.normalize(value.replace(/^\.\//, "")).replace(/\/+$/, "");

/** Tracked lockfile in `dir` or a folder above it inside the worktree. */
function lockfileFor(dir: string, tracked: ReadonlySet<string>): string | null {
	let current = dir;
	for (;;) {
		for (const name of LOCKFILES) {
			const candidate = join(current, name);
			if (tracked.has(candidate)) return candidate;
		}
		if (!current) return null;
		current = parentOf(current);
	}
}

/** The directories (relative to the package) the package's own build makes, with the evidence. */
async function declaredOutputs(dir: string, evidence: RepoEvidence): Promise<Map<string, string>> {
	const outputs = new Map<string, string>();
	const manifestPath = join(dir, "package.json");
	if (!evidence.tracked.has(manifestPath)) return outputs;
	const text = await evidence.readText(manifestPath);
	if (!text) return outputs;
	let manifest: { scripts?: Record<string, unknown>; dependencies?: object; devDependencies?: object };
	try {
		manifest = JSON.parse(text) as typeof manifest;
	} catch {
		return outputs;
	}
	const scripts = Object.values(manifest.scripts ?? {})
		.filter((value): value is string => typeof value === "string")
		.join("\n");
	const deps = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
	for (const match of scripts.matchAll(OUT_FLAG)) {
		const out = match[1] ? normalizeOut(match[1]) : "";
		if (out && !out.startsWith("..")) outputs.set(out, `${manifestPath} script passes ${match[0].trim()}`);
	}
	for (const tool of BUILD_TOOLS) {
		if (!deps.has(tool.pkg) || !tool.bin.test(scripts)) continue;
		let configured: string | null = null;
		for (const file of tool.configFiles ?? []) {
			const configPath = join(dir, file);
			if (!evidence.tracked.has(configPath) || !tool.config) continue;
			const value = (await evidence.readText(configPath))?.match(tool.config)?.[1];
			if (value) {
				configured = normalizeOut(value);
				outputs.set(configured, `${configPath} sets ${tool.pkg}'s output to ${value}`);
				break;
			}
		}
		if (configured) continue;
		for (const out of tool.outputs) outputs.set(out, `${tool.pkg} in ${manifestPath}, run by its scripts`);
	}
	return outputs;
}

/** The comment heading the `.gitignore` block that holds `line` (1-based), or null. */
function sectionComment(text: string, line: number): string | null {
	const lines = text.split(/\r?\n/);
	for (let index = line - 2; index >= 0; index--) {
		const current = (lines[index] ?? "").trim();
		if (current === "") return null;
		if (current.startsWith("#")) return current;
	}
	return null;
}

type Rule = (entry: string, evidence: RepoEvidence) => Promise<IgnoredVerdict["regenerable"]>;

const RULES: ReadonlyArray<Rule> = [
	async (entry, evidence) =>
		entry.endsWith("/") && (await evidence.isCacheDirTagged(trimDir(entry)))
			? { reason: "cachedir-tag", evidence: `${trimDir(entry)}/CACHEDIR.TAG` }
			: null,
	async (entry, evidence) => {
		if (!entry.endsWith("/") || path.posix.basename(trimDir(entry)) !== "node_modules") return null;
		const dir = parentOf(entry);
		if (!evidence.tracked.has(join(dir, "package.json"))) return null;
		const lockfile = lockfileFor(dir, evidence.tracked);
		return lockfile ? { reason: "lockfile-dependencies", evidence: lockfile } : null;
	},
	async (entry, evidence) =>
		entry.endsWith("/") &&
		path.posix.basename(trimDir(entry)) === "__pycache__" &&
		(await evidence.onlyBytecode(trimDir(entry)))
			? { reason: "python-bytecode", evidence: `${trimDir(entry)} holds only .pyc files` }
			: null,
	async (entry, evidence) => {
		if (!entry.endsWith("/")) return null;
		const target = trimDir(entry);
		// The nearest package.json above the entry owns it (a monorepo package, else the root).
		for (let dir = parentOf(entry); ; dir = parentOf(dir)) {
			if (evidence.tracked.has(join(dir, "package.json"))) {
				const relative = dir ? target.slice(dir.length + 1) : target;
				const why = (await declaredOutputs(dir, evidence)).get(relative);
				return why ? { reason: "build-tool-output", evidence: why } : null;
			}
			if (!dir) return null;
		}
	},
	async (entry, evidence) => {
		const by = evidence.ignoredBy.get(entry) ?? evidence.ignoredBy.get(trimDir(entry));
		if (!by || path.posix.basename(by.source) !== ".gitignore" || !evidence.tracked.has(by.source)) return null;
		const comment = sectionComment((await evidence.readText(by.source)) ?? "", by.line);
		return comment && BUILD_SECTION.test(comment)
			? { reason: "gitignore-build-section", evidence: `${by.source}:${by.line} under "${comment}"` }
			: null;
	},
];

/** Pure over `evidence`: each ignored entry with the first rule that proves it regenerable, or null. */
export async function classifyIgnored(entries: readonly string[], evidence: RepoEvidence): Promise<IgnoredVerdict[]> {
	const verdicts: IgnoredVerdict[] = [];
	for (const entry of entries) {
		let regenerable: IgnoredVerdict["regenerable"] = null;
		for (const rule of RULES) {
			regenerable = await rule(entry, evidence);
			if (regenerable) break;
		}
		verdicts.push({ path: entry, regenerable });
	}
	return verdicts;
}

const BYTECODE_SCAN_LIMIT = 5000;

/** Reads the evidence for `classifyIgnored` from the worktree at `root`. */
export async function readEvidence(root: string, ignored: readonly string[]): Promise<RepoEvidence> {
	const [listed, checked] = await Promise.all([
		gitRaw(root, ["ls-files", "-z"], { maxBytes: 64 * 1024 * 1024 }),
		ignored.length > 0 ? gitRaw(root, ["check-ignore", "-v", "--", ...ignored.map(trimDir)]) : Promise.resolve(null),
	]);
	if (listed.code !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
	const tracked = new Set(listed.stdout.toString("utf8").split("\0").filter(Boolean));
	const ignoredBy = new Map<string, { source: string; line: number }>();
	if (checked && checked.code === 0) {
		// `<source>:<line>:<pattern>\t<path>`, one per line (`-z` needs `--stdin`); the source is the first `:<n>:`.
		for (const record of checked.stdout.toString("utf8").split("\n")) {
			const match = /^(.*?):(\d+):[^\t]*\t(.*)$/.exec(record);
			if (match?.[1] && match[3]) ignoredBy.set(trimDir(match[3]), { source: match[1], line: Number(match[2]) });
		}
	}
	const absolute = (relative: string) => path.join(root, ...relative.split("/"));
	return {
		tracked,
		ignoredBy,
		readText: relative => fs.readFile(absolute(relative), "utf8").catch(() => null),
		isCacheDirTagged: async relative => {
			const handle = await fs.open(path.join(absolute(relative), "CACHEDIR.TAG"), "r").catch(() => null);
			if (!handle) return false;
			try {
				const buffer = Buffer.alloc(CACHEDIR_SIGNATURE.length);
				await handle.read(buffer, 0, buffer.length, 0);
				return buffer.toString("latin1") === CACHEDIR_SIGNATURE;
			} finally {
				await handle.close();
			}
		},
		onlyBytecode: async relative => {
			let seen = 0;
			const walk = async (dir: string): Promise<boolean> => {
				for (const item of await fs.readdir(dir, { withFileTypes: true })) {
					if (++seen > BYTECODE_SCAN_LIMIT) return false;
					if (item.isDirectory()) {
						if (!(await walk(path.join(dir, item.name)))) return false;
					} else if (!item.name.endsWith(".pyc")) return false;
				}
				return true;
			};
			return walk(absolute(relative)).catch(() => false);
		},
	};
}
