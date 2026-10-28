import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardProjectToolchain, type LeanEnv, prepareLean } from "./lean-env";
import { type RunResult, run, Unavailable } from "./proc";

export interface SourceFinding {
	kind:
		| "sorry"
		| "admit"
		| "axiom"
		| "native_decide"
		| "unsafe"
		| "implemented_by"
		| "extern"
		| "exit"
		| "skipKernelTC";
	file: string;
	line: number;
	text: string;
	/** Weakens or bypasses the kernel: the check fails. Otherwise it is only worth a review. */
	blocking: boolean;
}

export interface BuildError {
	file: string;
	line: number;
	col: number;
	message: string;
	/** The enclosing declaration, `Ns.name`, when found. */
	decl?: string;
}

/**
 * An error about a name or the syntax (an unknown identifier, an unexpected token): the model no longer says anything,
 * which is not the same as a property failing. A mutation that causes one is INVALID, never DETECTED.
 */
export function isNamingError(message: string): boolean {
	return /^(?:unknown |unexpected |expected |invalid field|invalid dotted identifier|ambiguous, possible interpretations)/i.test(
		message.trim(),
	);
}

export interface TheoremAudit {
	name: string;
	axioms: string[];
	flag?: string;
}

export interface LeanCheck {
	status: "pass" | "fail" | "error" | "unavailable";
	toolchain?: string;
	buildOk: boolean;
	errors: BuildError[];
	findings: SourceFinding[];
	/** Every definition, theorem, instance and opaque constant of the audited modules, private ones included. */
	theorems: TheoremAudit[];
	/** Build errors that are about names or syntax: the model is broken, not a property. */
	invalid: BuildError[];
	/** Theorems and declarations that failed to build or carry a bad axiom, qualified and short names. */
	violated: string[];
	detail: string;
	log: string;
	/** The input was wrong (no lakefile, no such file, a `--module` that matches nothing): a usage problem, exit 2. */
	usage?: boolean;
	/** Checks that did not run and could not make the result wrong in either direction (a toolchain without leanchecker). */
	notes: string[];
}

export const STANDARD_AXIOMS = ["propext", "Classical.choice", "Quot.sound"];

/** Replaces comments and string literals by spaces (line structure kept), so `sorry` in a docstring is not found. */
export function stripLeanComments(source: string): string {
	const out: string[] = [];
	let i = 0;
	let depth = 0;
	while (i < source.length) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (depth > 0) {
			if (ch === "/" && next === "-") {
				depth++;
				out.push("  ");
				i += 2;
			} else if (ch === "-" && next === "/") {
				depth--;
				out.push("  ");
				i += 2;
			} else {
				out.push(ch === "\n" ? "\n" : " ");
				i++;
			}
		} else if (ch === "/" && next === "-") {
			depth = 1;
			out.push("  ");
			i += 2;
		} else if (ch === "-" && next === "-") {
			while (i < source.length && source[i] !== "\n") {
				out.push(" ");
				i++;
			}
		} else if (ch === '"') {
			out.push('"');
			i++;
			while (i < source.length && source[i] !== '"') {
				if (source[i] === "\\" && i + 1 < source.length) {
					out.push(" ");
					i++;
				}
				out.push(source[i] === "\n" ? "\n" : " ");
				i++;
			}
			out.push('"');
			i++;
		} else {
			out.push(ch);
			i++;
		}
	}
	return out.join("");
}

/** `blocking`: always, never, only while native code is refused, or only once it is allowed (a lying implementation). */
const SCANS: {
	kind: SourceFinding["kind"];
	pattern: RegExp;
	blocking: "always" | "never" | "unlessNative" | "ifNative";
}[] = [
	{ kind: "sorry", pattern: /(?<![\w.'])sorry(?![\w'])/, blocking: "always" },
	{ kind: "admit", pattern: /(?<![\w.'])admit(?![\w'])/, blocking: "always" },
	{
		kind: "axiom",
		pattern: /^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|unsafe)\s+)*axiom\s/,
		blocking: "always",
	},
	{ kind: "native_decide", pattern: /native_decide/, blocking: "unlessNative" },
	// `#exit` ends the file for Lean: every theorem after it is never elaborated, so it is never audited either.
	{ kind: "exit", pattern: /^\s*#exit\b/, blocking: "always" },
	{ kind: "skipKernelTC", pattern: /skipKernelTC/, blocking: "always" },
	{ kind: "unsafe", pattern: /(?:^|\s)unsafe\s/, blocking: "never" },
	// A native proof runs the compiled code, so an implementation that differs from the definition proves a false theorem.
	{ kind: "implemented_by", pattern: /(?:@\[|\battribute\s*\[)[^\]]*implemented_by/, blocking: "ifNative" },
	{ kind: "extern", pattern: /(?:@\[|\battribute\s*\[)[^\]]*\bextern\b/, blocking: "ifNative" },
];

/** Scans Lean sources for things that weaken or bypass the kernel. `allowNative` makes native_decide non-blocking. */
export function scanSource(file: string, source: string, allowNative: boolean): SourceFinding[] {
	const findings: SourceFinding[] = [];
	const original = source.split(/\r?\n/);
	stripLeanComments(source)
		.split(/\r?\n/)
		.forEach((text, index) => {
			for (const scan of SCANS) {
				if (!scan.pattern.test(text)) continue;
				const blocking =
					scan.blocking === "always" ||
					(scan.blocking === "unlessNative" && !allowNative) ||
					(scan.blocking === "ifNative" && allowNative);
				findings.push({ kind: scan.kind, file, line: index + 1, text: (original[index] ?? "").trim(), blocking });
			}
		});
	return findings;
}

/**
 * `skipKernelTC` in a lakefile (`moreLeanArgs`, `leanOptions`): a string in a lakefile is not a Lean comment or
 * literal, so the lines are read as they are, minus whole-line comments.
 */
export function scanLakefile(file: string, source: string): SourceFinding[] {
	const findings: SourceFinding[] = [];
	source.split(/\r?\n/).forEach((text, index) => {
		if (/^\s*(?:#|--)/.test(text) || !/skipKernelTC/.test(text)) return;
		findings.push({ kind: "skipKernelTC", file, line: index + 1, text: text.trim(), blocking: true });
	});
	return findings;
}

const DECLARATION =
	/^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|partial|unsafe|nonrec)\s+)*(theorem|lemma|def|abbrev|instance|example|structure|inductive|class)\s+([^\s:({[]+)?/;

/** The declaration that encloses `line` (1-based), with namespaces applied: `BoundedQueue.inv_step`. */
export function enclosingDeclaration(source: string, line: number): string | undefined {
	const lines = stripLeanComments(source).split(/\r?\n/);
	const scopes: (string | null)[] = [];
	let current: string | undefined;
	for (let index = 0; index < Math.min(line, lines.length); index++) {
		const text = lines[index] as string;
		const namespace = /^\s*namespace\s+(\S+)/.exec(text);
		if (namespace) {
			scopes.push(namespace[1] as string);
			continue;
		}
		// Every block that an `end` closes is a scope, or its `end` pops a namespace that is still open.
		if (/^\s*(?:@\[[^\]]*\]\s*)*(?:(?:noncomputable|public|private|meta)\s+)*(?:section|mutual)\b/.test(text)) {
			scopes.push(null);
			continue;
		}
		if (/^\s*end\b/.test(text)) {
			scopes.pop();
			continue;
		}
		const declaration = DECLARATION.exec(text);
		if (declaration?.[2]) {
			const prefix = scopes.filter((scope): scope is string => scope !== null).join(".");
			current = prefix ? `${prefix}.${declaration[2]}` : declaration[2];
		} else if (declaration) current = undefined;
	}
	return current;
}

/** `error: Foo/Bar.lean:12:4: message` lines of `lake build`, with the declaration each one is in. */
export function parseBuildErrors(output: string, projectDir: string): BuildError[] {
	const errors: BuildError[] = [];
	const cache = new Map<string, string | null>();
	for (const match of output.matchAll(/^error: (.+?):(\d+):(\d+): (.*)$/gm)) {
		const file = (match[1] as string).replace(/\\/g, "/");
		const abs = path.resolve(projectDir, file);
		if (!cache.has(abs)) {
			try {
				cache.set(abs, fs.readFileSync(abs, "utf8"));
			} catch {
				cache.set(abs, null);
			}
		}
		const source = cache.get(abs);
		const line = Number(match[2]);
		const decl = source ? enclosingDeclaration(source, line) : undefined;
		errors.push({
			file,
			line,
			col: Number(match[3]),
			message: (match[4] as string).trim(),
			...(decl ? { decl } : {}),
		});
	}
	return errors;
}

/** Names that count as one declaration for matching: `A.B.c` and `c`. */
export function nameVariants(qualified: string): string[] {
	const short = qualified.split(".").pop() as string;
	return short === qualified ? [qualified] : [qualified, short];
}

/** A `lean_lib` of the lakefile: its modules are the files under `srcDir` that its `roots` (default: its name) name. */
export interface LeanLib {
	name: string;
	roots: string[];
	/** Lake globs: `A.B` one module, `A.*` the submodules of A, `A.+` A and its submodules. */
	globs: string[];
	srcDir: string;
}

const moduleName = (raw: string): string => raw.replace(/[«»]/g, "");

function tomlList(block: string, key: string): string[] {
	const list = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(block)?.[1] ?? "";
	return [...list.matchAll(/"([^"]*)"/g)].map(match => match[1] as string);
}

function leanDslList(block: string, key: string): string[] {
	const list = new RegExp(`\\b${key}\\s*:=\\s*#\\[([^\\]]*)\\]`).exec(block)?.[1] ?? "";
	const out: string[] = [];
	for (const entry of list.split(",")) {
		const match = /(?:\.|Glob\.)?(one|submodules|andSubmodules)?\s*`([^\s,\]]+)/.exec(entry);
		if (!match) continue;
		const name = moduleName(match[2] as string);
		out.push(match[1] === "submodules" ? `${name}.*` : match[1] === "andSubmodules" ? `${name}.+` : name);
	}
	return out;
}

export function leanLibs(projectDir: string): LeanLib[] {
	const libs: LeanLib[] = [];
	const read = (file: string): string | undefined => {
		try {
			return fs.readFileSync(path.join(projectDir, file), "utf8");
		} catch {
			return undefined;
		}
	};
	const toml = read("lakefile.toml");
	if (toml !== undefined) {
		for (const section of toml.split(/^\[\[lean_lib\]\]/m).slice(1)) {
			// A block ends at the next table header.
			const block = section.split(/^\s*\[/m)[0] as string;
			const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
			if (!name) continue;
			const roots = tomlList(block, "roots");
			libs.push({
				name,
				roots: roots.length ? roots : [name],
				globs: tomlList(block, "globs"),
				srcDir: /^\s*srcDir\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? ".",
			});
		}
	}
	const dsl = read("lakefile.lean");
	if (dsl !== undefined) {
		const lines = dsl.split(/\r?\n/);
		lines.forEach((line, index) => {
			const head = /^\s*lean_lib\s+(?:«([^»]+)»|(\w+))/.exec(line);
			if (!head) return;
			const name = (head[1] ?? head[2]) as string;
			const body = [line];
			for (let next = index + 1; next < lines.length && /^(?:\s|$)/.test(lines[next] as string); next++)
				body.push(lines[next] as string);
			const block = body.join("\n");
			const roots = leanDslList(block, "roots");
			libs.push({
				name,
				roots: roots.length ? roots : [name],
				globs: leanDslList(block, "globs"),
				srcDir: /\bsrcDir\s*:=\s*"([^"]*)"/.exec(block)?.[1] ?? ".",
			});
		});
	}
	return libs;
}

/** The `.lean` files under `<src>/<prefix>` as module names, `Prefix.Sub.File`. */
function modulesUnder(src: string, prefix: string[]): string[] {
	const out: string[] = [];
	const walk = (dir: string, parts: string[]): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".lake" || entry.name === ".git" || entry.name.startsWith(".ompdesk-")) continue;
			if (entry.isDirectory()) walk(path.join(dir, entry.name), [...parts, entry.name]);
			else if (entry.name.endsWith(".lean")) out.push([...parts, entry.name.slice(0, -".lean".length)].join("."));
		}
	};
	walk(path.join(src, ...prefix), prefix);
	return out;
}

/**
 * Every module of the libraries, from their source files, not from what the root imports: the root file, everything
 * under a root's folder, and what the globs name. `lake build` of the default targets builds none of the others.
 */
export function leanModules(projectDir: string, libs: LeanLib[] = leanLibs(projectDir)): string[] {
	const modules = new Set<string>();
	for (const lib of libs) {
		const src = path.resolve(projectDir, lib.srcDir);
		const add = (name: string, subtree: boolean, self: boolean): void => {
			if (self && fs.existsSync(`${path.join(src, ...name.split("."))}.lean`)) modules.add(name);
			if (subtree) for (const found of modulesUnder(src, name.split("."))) modules.add(found);
		};
		for (const root of lib.roots) add(root, true, true);
		for (const glob of lib.globs) {
			if (glob.endsWith(".*")) add(glob.slice(0, -2), true, false);
			else if (glob.endsWith(".+")) add(glob.slice(0, -2), true, true);
			else add(glob, false, true);
		}
	}
	return [...modules].sort();
}

function sourceFiles(projectDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".lake" || entry.name === ".git" || entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".lean") && !entry.name.startsWith(".ompdesk-")) out.push(full);
		}
	};
	walk(projectDir);
	return out.sort();
}

function auditProgram(modules: string[], roots: string[]): string {
	const imports = modules.map(module => `import ${module}`).join("\n");
	const rootNames = roots.map(root => JSON.stringify(root)).join(", ");
	return `import Lean
${imports}
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let roots : List Name := [${rootNames}].map String.toName
  let mut rows : Array String := #[]
  for (n, ci) in env.constants.toList do
    let some idx := env.getModuleIdxFor? n | continue
    let modName := env.header.moduleNames[idx.toNat]!
    unless roots.any (·.isPrefixOf modName) do continue
    -- A private name is \`_private.Mod.0.name\`: look at the name the author wrote. Compiler auxiliaries and generated
    -- names are marked, not dropped: only a clean one is hidden, a flagged one is a finding whatever it is called.
    let user := (privateToUserName? n).getD n
    match ci with
    | .thmInfo _ | .defnInfo _ | .opaqueInfo _ | .axiomInfo _ =>
      let axs ← liftCoreM <| Lean.collectAxioms n
      rows := rows.push s!"{user}\\t{",".intercalate (axs.toList.map toString)}\\t{if user.isInternalDetail then 1 else 0}"
    | _ => pure ()
  for r in rows.qsort (· < ·) do IO.println r
`;
}

const GENERATED = /^(eq_\d+|eq_def|sizeOf_spec|inj|injEq|brecOn|ofNat_ctorIdx|ctorIdx|congr_simp|noConfusion\w*)$/;

export function flagAxioms(axioms: string[], allowNative: boolean): string | undefined {
	let flag: string | undefined;
	for (const axiom of axioms) {
		if (STANDARD_AXIOMS.includes(axiom)) continue;
		if (axiom === "sorryAx") return "SORRY";
		if (/native_decide|ofReduceBool|\._native\./.test(axiom)) {
			if (!allowNative) flag ??= "NATIVE";
		} else flag ??= `AXIOM:${axiom}`;
	}
	return flag;
}

export interface LeanCheckOptions {
	/** Lean files (relative to the project) to scan and audit instead of every library module. */
	files?: string[];
	allowNative?: boolean;
	/** Module-name roots to audit (a module and its submodules); default: every module of the project's libraries. */
	roots?: string[];
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
}

/** Folders that a build must never write into: a signed app bundle, a read-only checkout. */
const INSIDE_BUNDLE = /(?:\.app[\\/]Contents[\\/]|[\\/]app\.asar|[\\/]resources[\\/]omp-builtin[\\/])/;

function writable(dir: string): boolean {
	const probe = path.join(dir, `.ompdesk-write-${process.pid}`);
	try {
		fs.writeFileSync(probe, "");
		fs.rmSync(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

/** True for a project that `lake build` would have to write `.lake/` into, but must not (the app bundle, read-only). */
export function needsCopy(project: string): boolean {
	return INSIDE_BUNDLE.test(project) || !writable(project);
}

/**
 * Runs `work` on the project, or on a temporary copy of it (without `.lake`) when it sits in the app bundle or is
 * read-only: a build writes `.lake/` and an audit file beside the sources, which would break the bundle's signature.
 */
export async function withBuildableCopy<T>(
	project: string,
	log: ((line: string) => void) | undefined,
	work: (dir: string) => Promise<T>,
): Promise<T> {
	if (!needsCopy(project)) return work(project);
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-lean-"));
	try {
		fs.cpSync(project, copy, { recursive: true, filter: source => path.basename(source) !== ".lake" });
		// A copy of a bundle's files can come out read-only.
		for (const entry of fs.readdirSync(copy, { recursive: true, withFileTypes: true })) {
			try {
				fs.chmodSync(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
			} catch {
				// best effort
			}
		}
		log?.(
			`checking a temporary copy of ${project}: it is inside the app bundle or read-only, and a Lean build writes .lake/ beside the sources`,
		);
		return await work(copy);
	} finally {
		fs.rmSync(copy, { recursive: true, force: true });
	}
}

const SORRY_WARNING = /^warning: (.+?):(\d+):(\d+): declaration uses [`']sorry[`']/gm;

/** `lake build`, then a trust audit of every constant of the library modules (private ones and defs included). */
export async function checkLean(projectDir: string, options: LeanCheckOptions = {}): Promise<LeanCheck> {
	const original = path.resolve(projectDir);
	if (!fs.existsSync(path.join(original, "lakefile.toml")) && !fs.existsSync(path.join(original, "lakefile.lean"))) {
		return { ...EMPTY, detail: `${original} has no lakefile.toml or lakefile.lean`, usage: true };
	}
	return withBuildableCopy(original, options.log, project => checkLeanIn(project, options));
}

const EMPTY: LeanCheck = {
	status: "error",
	buildOk: false,
	errors: [],
	invalid: [],
	findings: [],
	theorems: [],
	violated: [],
	detail: "",
	log: "",
	notes: [],
};

export interface KernelCheck {
	/** `missing`: this toolchain ships no leanchecker. `error`: it could not be located or started. */
	status: "pass" | "fail" | "missing" | "error";
	detail: string;
	/** Declarations that leanchecker names as the ones it rejected. */
	declarations: string[];
}

const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * Replays the modules' declarations through the kernel with the toolchain's own `leanchecker`. The axiom audit
 * trusts the environment as elaboration left it: `set_option debug.skipKernelTC true` plus `addDecl` puts a theorem
 * of `False` there with no axiom at all, which only a fresh kernel pass notices.
 */
export async function runKernelCheck(
	project: string,
	lean: Pick<LeanEnv, "lake" | "env">,
	modules: string[],
): Promise<KernelCheck> {
	const prefix = await run(lean.lake, ["env", "lean", "--print-prefix"], {
		cwd: project,
		env: lean.env,
		timeoutMs: 60_000,
	});
	const sysroot = prefix.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
	if (prefix.spawnError || prefix.code !== 0 || !sysroot) {
		return {
			status: "error",
			detail: `the kernel re-check did not run: could not locate the toolchain (${prefix.spawnError?.message ?? (prefix.stderr.trim() || `exit ${prefix.code}`)})`,
			declarations: [],
		};
	}
	const checker = path.join(sysroot, "bin", `leanchecker${EXE}`);
	if (!fs.existsSync(checker)) {
		return {
			status: "missing",
			detail: `this Lean toolchain has no leanchecker (${path.join(sysroot, "bin")}): the kernel was not re-run over the proofs, so a declaration added with the kernel check skipped would not be noticed here; the source scan still refuses debug.skipKernelTC`,
			declarations: [],
		};
	}
	const checked = await run(lean.lake, ["env", checker, ...modules], {
		cwd: project,
		env: lean.env,
		timeoutMs: 15 * 60_000,
	});
	if (checked.spawnError) {
		return {
			status: "error",
			detail: `the kernel re-check did not run: ${checked.spawnError.message}`,
			declarations: [],
		};
	}
	if (checked.code === 0) return { status: "pass", detail: "", declarations: [] };
	const text = `${checked.stdout}${checked.stderr}`;
	return {
		status: "fail",
		detail: `leanchecker rejected the compiled modules:\n${text.trim().split(/\r?\n/).slice(0, 15).join("\n")}`,
		declarations: [...text.matchAll(/replaying declaration '([^']+)'/g)].map(match => match[1] as string),
	};
}

/** Lake and Lean say this when an imported module has no compiled file or no library that provides it. */
const MISSING_MODULE = /object file .* does not exist|unknown module prefix|no such file or directory|unknown package/i;

async function checkLeanIn(project: string, options: LeanCheckOptions): Promise<LeanCheck> {
	const allowNative = options.allowNative === true;
	const base: LeanCheck = { ...EMPTY };
	let lean: LeanEnv;
	try {
		lean = await prepareLean({ env: options.env, log: options.log });
		guardProjectToolchain(project, lean, options.env ?? process.env);
	} catch (error) {
		if (error instanceof Unavailable) return { ...base, status: "unavailable", detail: error.message };
		throw error;
	}
	base.toolchain = `${lean.leanVersion} (${lean.toolchain})`;
	const files = options.files?.length ? options.files.map(file => path.resolve(project, file)) : sourceFiles(project);
	const missing = files.filter(file => !fs.existsSync(file));
	if (missing.length > 0) {
		return {
			...base,
			usage: true,
			detail: `no such file: ${missing.map(file => path.relative(project, file)).join(", ")}`,
		};
	}
	const findings = files.flatMap(file =>
		scanSource(path.relative(project, file).replace(/\\/g, "/"), fs.readFileSync(file, "utf8"), allowNative),
	);
	for (const lakefile of ["lakefile.toml", "lakefile.lean"]) {
		let text: string;
		try {
			text = fs.readFileSync(path.join(project, lakefile), "utf8");
		} catch {
			continue;
		}
		for (const found of scanLakefile(lakefile, text)) {
			if (
				!findings.some(known => known.file === found.file && known.line === found.line && known.kind === found.kind)
			)
				findings.push(found);
		}
	}
	const libs = options.files?.length ? [] : leanLibs(project);
	const modules = options.files?.length
		? files.map(file =>
				path
					.relative(project, file)
					.replace(/\.lean$/, "")
					.split(path.sep)
					.join("."),
			)
		: leanModules(project, libs);
	if (!options.files?.length && libs.length === 0)
		return {
			...base,
			usage: true,
			findings,
			detail: "no lean_lib found in the lakefile; pass the .lean files to check",
		};
	if (modules.length === 0)
		return {
			...base,
			status: "fail",
			findings,
			detail: `nothing audited: no .lean file belongs to the roots of ${libs.map(lib => lib.name).join(", ")}`,
		};
	const roots = options.roots?.length ? options.roots : modules;
	const unmatched = roots.filter(root => !modules.some(module => module === root || module.startsWith(`${root}.`)));
	if (unmatched.length > 0) {
		return {
			...base,
			usage: true,
			findings,
			detail: `--module ${unmatched.join(", ")} matches no module of this project (its modules: ${modules.slice(0, 12).join(", ")}${modules.length > 12 ? ", ..." : ""}); module names are case-sensitive`,
		};
	}
	// Every module is a build target of its own: `lake build` with no target builds only the default targets, and what
	// the root does not import stays unbuilt (or keeps an older .olean that no longer matches its source).
	const built = await run(lean.lake, ["build", ...modules.map(module => `+${module}`)], {
		cwd: project,
		env: lean.env,
		timeoutMs: 45 * 60_000,
	});
	const log = `${built.stdout}${built.stderr}`;
	if (built.spawnError) return { ...base, findings, detail: `lake could not start: ${built.spawnError.message}` };
	const errors = parseBuildErrors(log, project);
	const invalid = errors.filter(error => isNamingError(error.message));
	const buildOk = built.code === 0;
	const violated = new Set<string>();
	for (const error of errors) if (error.decl) for (const name of nameVariants(error.decl)) violated.add(name);
	const result: LeanCheck = { ...base, findings, buildOk, errors, invalid, log };
	if (!buildOk) {
		const unnamed = errors.length === 0 ? log.trim().split(/\r?\n/).slice(-12).join("\n") : "";
		return {
			...result,
			status: "fail",
			violated: [...violated],
			detail: errors.length
				? errors
						.map(
							error =>
								`${error.file}:${error.line}:${error.col}${error.decl ? ` [${error.decl}]` : ""}: ${error.message.split("\n")[0]}`,
						)
						.join("\n")
				: `lake build failed:\n${unnamed}`,
		};
	}
	// A proof that ends in `sorry` by a macro or an elaborator never spells it in the source: Lean says so itself.
	for (const match of log.matchAll(SORRY_WARNING)) {
		const file = (match[1] as string).replace(/\\/g, "/");
		findings.push({
			kind: "sorry",
			file,
			line: Number(match[2]),
			text: "declaration uses 'sorry' (build warning)",
			blocking: true,
		});
	}
	const auditFile = path.join(project, ".ompdesk-audit.lean");
	fs.writeFileSync(auditFile, auditProgram(modules, roots));
	let audit: RunResult;
	try {
		audit = await run(lean.lake, ["env", "lean", path.basename(auditFile)], {
			cwd: project,
			env: lean.env,
			timeoutMs: 15 * 60_000,
		});
	} finally {
		fs.rmSync(auditFile, { force: true });
	}
	if (audit.spawnError || audit.code !== 0) {
		const output = (audit.stdout + audit.stderr).trim().split(/\r?\n/).slice(0, 15).join("\n");
		// Every module was just built, so an import that finds no compiled file means a source that was not built.
		if (!audit.spawnError && MISSING_MODULE.test(output))
			return { ...result, status: "fail", detail: `a library module was not built:\n${output}` };
		return { ...result, status: "error", detail: `the axiom audit did not run:\n${output}` };
	}
	const theorems: TheoremAudit[] = [];
	for (const row of audit.stdout.split(/\r?\n/)) {
		const [name, axioms = "", internal = "0"] = row.split("\t");
		if (!name) continue;
		const list = axioms.split(",").filter(Boolean);
		const flag = flagAxioms(list, allowNative);
		// Compiler auxiliaries and generated lemmas are noise only while they are clean: a flagged one is a finding.
		if (!flag && (internal === "1" || GENERATED.test(name.split(".").pop() as string))) continue;
		theorems.push({ name, axioms: list, ...(flag ? { flag } : {}) });
		if (flag) for (const variant of nameVariants(name)) violated.add(variant);
	}
	for (const finding of findings) {
		if (finding.blocking) {
			let decl: string | undefined;
			try {
				decl = enclosingDeclaration(fs.readFileSync(path.join(project, finding.file), "utf8"), finding.line);
			} catch {
				// a warning in a file the scan did not read
			}
			if (decl) for (const variant of nameVariants(decl)) violated.add(variant);
		}
	}
	const kernel = await runKernelCheck(project, lean, modules);
	if (kernel.status === "error") return { ...result, status: "error", theorems, detail: kernel.detail };
	const notes = kernel.status === "missing" ? [kernel.detail] : [];
	for (const declaration of kernel.declarations)
		for (const variant of nameVariants(declaration)) violated.add(variant);
	const blocking = findings.filter(finding => finding.blocking);
	const flagged = theorems.filter(theorem => theorem.flag);
	const problems: string[] = [
		...blocking.map(finding => `${finding.kind} at ${finding.file}:${finding.line}: ${finding.text}`),
		...flagged.map(theorem => `${theorem.flag} ${theorem.name} [${theorem.axioms.join(", ")}]`),
		...(theorems.length === 0
			? [`nothing audited: no definition or theorem under ${roots.join(", ")} (a root that is empty proves nothing)`]
			: []),
		...(kernel.status === "fail" ? [kernel.detail] : []),
	];
	return {
		...result,
		status: problems.length === 0 ? "pass" : "fail",
		theorems,
		violated: [...violated],
		detail: problems.join("\n"),
		notes,
	};
}
