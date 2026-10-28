#!/usr/bin/env bun
// Scaffolds a Lean 4 model project (no Mathlib, no package dependencies) from assets/lean-template/.
//
//   bun new-lean.ts <dir> <Pkg>
//
// Creates <dir>/{lakefile.toml, lean-toolchain, Pkg.lean, Pkg/{Explore,System,Properties}.lean, .gitignore}. `Pkg`
// must be UpperCamelCase (it becomes the Lean namespace and the library name). Then: cd <dir> && lake build
// (or `bun lean-check.ts <dir>`, which also audits the trust base).
//
// Exit: 0 created, 2 usage or refusal (bad name, an existing lakefile or file would be overwritten).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, UsageError } from "./lib/proc";

const USAGE = "usage: bun new-lean.ts <dir> <Pkg>   (Pkg is UpperCamelCase, for example Queue or JobLease)";
const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "lean-template");
const NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** `JobLease` becomes `job_lease`: the lowercase package name used inside lakefile.toml. */
export function lowerName(pkg: string): string {
	return pkg.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function templateFiles(dir: string, prefix = ""): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".lake") continue;
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...templateFiles(path.join(dir, entry.name), relative));
		else files.push(relative);
	}
	return files.sort();
}

/** Writes the project and returns the files it created. Throws UsageError instead of overwriting anything. */
export function scaffold(dir: string, pkg: string, templateDir = TEMPLATE_DIR): string[] {
	if (!NAME_PATTERN.test(pkg)) throw new UsageError(`Pkg must be UpperCamelCase (letters and digits): got "${pkg}"`);
	if (!fs.existsSync(templateDir)) throw new UsageError(`template folder not found: ${templateDir}`);
	for (const lakefile of ["lakefile.toml", "lakefile.lean"]) {
		if (fs.existsSync(path.join(dir, lakefile)))
			throw new UsageError(`${dir} already has a ${lakefile}; not touching it`);
	}
	const lower = lowerName(pkg);
	const plan = templateFiles(templateDir).map(name => ({
		from: path.join(templateDir, name),
		to: path.join(dir, name.replaceAll("__PKG__", pkg)),
	}));
	const clash = plan.find(item => fs.existsSync(item.to));
	if (clash) throw new UsageError(`${clash.to} already exists; not overwriting it`);
	for (const item of plan) {
		fs.mkdirSync(path.dirname(item.to), { recursive: true });
		const text = fs.readFileSync(item.from, "utf8").replaceAll("__PKG__", pkg).replaceAll("__pkg__", lower);
		fs.writeFileSync(item.to, text);
	}
	const ignore = path.join(dir, ".gitignore");
	const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
	if (!existing.split(/\r?\n/).includes(".lake/")) {
		const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
		fs.writeFileSync(ignore, `${existing}${separator}.lake/\n`);
	}
	return [...plan.map(item => item.to), ignore];
}

function main(argv: string[]): number {
	const args = argv.filter(arg => !arg.startsWith("--"));
	if (argv.length !== args.length || args.length !== 2) {
		console.error(USAGE);
		return EXIT.usage;
	}
	const [dir, pkg] = args;
	try {
		scaffold(dir, pkg);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`${error.message}\n${USAGE}`);
			return EXIT.usage;
		}
		throw error;
	}
	console.log(`Created ${dir} (${pkg}). Next: cd ${dir} && lake build   (or: bun lean-check.ts ${dir})`);
	return EXIT.ok;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
