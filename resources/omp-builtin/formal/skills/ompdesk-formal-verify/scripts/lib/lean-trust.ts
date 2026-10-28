import fs from "node:fs";
import path from "node:path";
import { type LeanEnv, prepareLean } from "./lean-env";
import { type RunResult, run, Unavailable } from "./proc";

export interface SourceFinding {
	kind: "sorry" | "admit" | "axiom" | "native_decide" | "unsafe" | "implemented_by" | "extern";
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
	theorems: TheoremAudit[];
	/** Theorems and declarations that failed to build or carry a bad axiom, qualified and short names. */
	violated: string[];
	detail: string;
	log: string;
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

const SCANS: { kind: SourceFinding["kind"]; pattern: RegExp; blocking: boolean }[] = [
	{ kind: "sorry", pattern: /(?<![\w.'])sorry(?![\w'])/, blocking: true },
	{ kind: "admit", pattern: /(?<![\w.'])admit(?![\w'])/, blocking: true },
	{ kind: "axiom", pattern: /^\s*(?:private\s+|protected\s+)?axiom\s/, blocking: true },
	{ kind: "native_decide", pattern: /native_decide/, blocking: true },
	{ kind: "unsafe", pattern: /(?:^|\s)unsafe\s/, blocking: false },
	{ kind: "implemented_by", pattern: /@\[[^\]]*implemented_by/, blocking: false },
	{ kind: "extern", pattern: /@\[[^\]]*\bextern\b/, blocking: false },
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
				const blocking = scan.kind === "native_decide" ? !allowNative : scan.blocking;
				findings.push({ kind: scan.kind, file, line: index + 1, text: (original[index] ?? "").trim(), blocking });
			}
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
		if (/^\s*section\b/.test(text)) {
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

export function leanLibraries(projectDir: string): string[] {
	const names: string[] = [];
	for (const file of ["lakefile.toml", "lakefile.lean"]) {
		let text: string;
		try {
			text = fs.readFileSync(path.join(projectDir, file), "utf8");
		} catch {
			continue;
		}
		if (file.endsWith(".toml")) {
			for (const block of text.split(/^\[\[lean_lib\]\]/m).slice(1)) {
				const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
				if (name) names.push(name);
			}
		} else {
			for (const match of text.matchAll(/^\s*lean_lib\s+(?:«([^»]+)»|(\w+))/gm))
				names.push((match[1] ?? match[2]) as string);
		}
	}
	return names;
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
    if n.isInternal then continue
    let some idx := env.getModuleIdxFor? n | continue
    let modName := env.header.moduleNames[idx.toNat]!
    if roots.any (·.isPrefixOf modName) then
      if let .thmInfo _ := ci then
        let axs ← liftCoreM <| Lean.collectAxioms n
        rows := rows.push s!"{n}\\t{",".intercalate (axs.toList.map toString)}"
  for r in rows.qsort (· < ·) do IO.println r
`;
}

const GENERATED = /^(eq_\d+|eq_def|sizeOf_spec|inj|injEq|brecOn|ofNat_ctorIdx|ctorIdx|congr_simp|noConfusion\w*)$/;

export function flagAxioms(axioms: string[], allowNative: boolean): string | undefined {
	let flag: string | undefined;
	for (const axiom of axioms) {
		if (STANDARD_AXIOMS.includes(axiom)) continue;
		if (axiom === "sorryAx") return "SORRY";
		if (/native_decide|ofReduceBool/.test(axiom)) {
			if (!allowNative) flag ??= "NATIVE";
		} else flag ??= `AXIOM:${axiom}`;
	}
	return flag;
}

export interface LeanCheckOptions {
	/** Lean files (relative to the project) to scan and audit instead of every library module. */
	files?: string[];
	allowNative?: boolean;
	/** Module-name roots to audit; default: the project's `lean_lib` names. */
	roots?: string[];
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
}

/** `lake build`, then a trust audit: sorry/admit/axiom/native_decide in sources and axioms of every theorem. */
export async function checkLean(projectDir: string, options: LeanCheckOptions = {}): Promise<LeanCheck> {
	const project = path.resolve(projectDir);
	const allowNative = options.allowNative === true;
	const base: LeanCheck = {
		status: "error",
		buildOk: false,
		errors: [],
		findings: [],
		theorems: [],
		violated: [],
		detail: "",
		log: "",
	};
	if (!fs.existsSync(path.join(project, "lakefile.toml")) && !fs.existsSync(path.join(project, "lakefile.lean"))) {
		return { ...base, detail: `${project} has no lakefile.toml or lakefile.lean` };
	}
	let lean: LeanEnv;
	try {
		lean = await prepareLean({ env: options.env, log: options.log });
	} catch (error) {
		if (error instanceof Unavailable) return { ...base, status: "unavailable", detail: error.message };
		throw error;
	}
	base.toolchain = `${lean.leanVersion} (${lean.toolchain})`;
	const files = options.files?.length ? options.files.map(file => path.resolve(project, file)) : sourceFiles(project);
	const missing = files.filter(file => !fs.existsSync(file));
	if (missing.length > 0)
		return { ...base, detail: `no such file: ${missing.map(file => path.relative(project, file)).join(", ")}` };
	const findings = files.flatMap(file =>
		scanSource(path.relative(project, file).replace(/\\/g, "/"), fs.readFileSync(file, "utf8"), allowNative),
	);
	const modules = options.files?.length
		? files.map(file =>
				path
					.relative(project, file)
					.replace(/\.lean$/, "")
					.split(path.sep)
					.join("."),
			)
		: leanLibraries(project);
	if (modules.length === 0)
		return { ...base, findings, detail: "no lean_lib found in the lakefile; pass the .lean files to check" };
	const roots = options.roots?.length ? options.roots : options.files?.length ? modules : leanLibraries(project);
	const built = await run(lean.lake, ["build", ...(options.files?.length ? modules : [])], {
		cwd: project,
		env: lean.env,
		timeoutMs: 45 * 60_000,
	});
	const log = `${built.stdout}${built.stderr}`;
	if (built.spawnError) return { ...base, findings, detail: `lake could not start: ${built.spawnError.message}` };
	const errors = parseBuildErrors(log, project);
	const buildOk = built.code === 0;
	const violated = new Set<string>();
	for (const error of errors) if (error.decl) for (const name of nameVariants(error.decl)) violated.add(name);
	const result: LeanCheck = { ...base, toolchain: base.toolchain, findings, buildOk, errors, violated: [], log };
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
		return {
			...result,
			status: "error",
			detail: `the axiom audit did not run:\n${(audit.stdout + audit.stderr).trim().split(/\r?\n/).slice(0, 15).join("\n")}`,
		};
	}
	const theorems: TheoremAudit[] = [];
	for (const row of audit.stdout.split(/\r?\n/)) {
		const [name, axioms = ""] = row.split("\t");
		if (!name || GENERATED.test(name.split(".").pop() as string)) continue;
		const list = axioms.split(",").filter(Boolean);
		const flag = flagAxioms(list, allowNative);
		theorems.push({ name, axioms: list, ...(flag ? { flag } : {}) });
		if (flag) for (const variant of nameVariants(name)) violated.add(variant);
	}
	for (const finding of findings) {
		if (finding.blocking) {
			const decl = enclosingDeclaration(fs.readFileSync(path.join(project, finding.file), "utf8"), finding.line);
			if (decl) for (const variant of nameVariants(decl)) violated.add(variant);
		}
	}
	const blocking = findings.filter(finding => finding.blocking);
	const flagged = theorems.filter(theorem => theorem.flag);
	const problems: string[] = [
		...blocking.map(finding => `${finding.kind} at ${finding.file}:${finding.line}: ${finding.text}`),
		...flagged.map(theorem => `${theorem.flag} ${theorem.name} [${theorem.axioms.join(", ")}]`),
	];
	return {
		...result,
		status: problems.length === 0 ? "pass" : "fail",
		theorems,
		violated: [...violated],
		detail: problems.join("\n"),
	};
}
