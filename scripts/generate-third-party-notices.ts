/**
 * Writes THIRD_PARTY_NOTICES.txt: the license and copyright text of every third-party
 * component the packaged app ships. `--check` fails when the checked-in file is stale
 * (`bun run licenses:check`); `bun run gen:licenses` rewrites it.
 *
 * What ships: electron-builder packs `out/**` and no node_modules, so a package is in
 * the app when main, preload or the renderer bundle it. The shipped set is taken as the
 * production closure of package.json `dependencies` (plus `optionalDependencies` that
 * are installed), read from node_modules, and Electron itself. This is a superset of
 * what Rollup tree-shook into `out/`, never a subset. The few devDependencies the
 * bundles import are type-only (unified, remark-parse, micromark-*), so none are added.
 *
 * Dependency-free and deterministic: sorted names, no dates, LF line endings.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "THIRD_PARTY_NOTICES.txt");

interface PackageJson {
	name: string;
	version: string;
	license?: string | { type?: string };
	licenses?: { type?: string }[];
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

interface Component {
	name: string;
	version: string;
	spdx: string;
	text: string;
	dir: string;
}

/** SPDX ids (or `OR` alternatives containing one) that may be distributed inside an Apache-2.0 product. MPL-2.0 is weak copyleft: allowed, reported in the audit. */
const PERMISSIVE = new Set([
	"MIT",
	"MIT-0",
	"ISC",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"0BSD",
	"Apache-2.0",
	"BlueOak-1.0.0",
	"MPL-2.0",
	"Unlicense",
	"CC0-1.0",
	"Python-2.0",
	"OFL-1.1",
	"Zlib",
	"CC-BY-4.0",
	"WTFPL",
]);

const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.|-|$)/i;

function readJson(file: string): PackageJson {
	return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
}

/** Node resolution of a package directory: `from/node_modules/<name>`, then each parent's. */
function findPackageDir(name: string, from: string): string | undefined {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function declaredLicense(pkg: PackageJson): string {
	if (typeof pkg.license === "string") return pkg.license;
	if (pkg.license?.type) return pkg.license.type;
	const legacy = pkg.licenses?.map(entry => entry.type).filter(Boolean);
	if (legacy?.length) return legacy.join(" OR ");
	return "UNKNOWN";
}

/** The package's license and notice files, in name order, joined; empty when it has none. */
function licenseText(dir: string): string {
	const files = readdirSync(dir)
		.filter(name => LICENSE_FILE.test(name))
		.sort();
	const parts: string[] = [];
	for (const name of files) {
		const full = join(dir, name);
		try {
			parts.push(readFileSync(full, "utf8").replace(/\r\n?/g, "\n").trim());
		} catch {
			// A directory such as `licenses/`: not a file text.
		}
	}
	return parts.filter(Boolean).join("\n\n");
}

function collect(): { components: Component[]; missing: string[] } {
	const rootPkg = readJson(join(ROOT, "package.json"));
	const seen = new Map<string, Component>();
	const missing: string[] = [];

	const visit = (name: string, from: string, optional: boolean): void => {
		const dir = findPackageDir(name, from);
		if (!dir) {
			if (!optional) missing.push(name);
			return;
		}
		const pkg = readJson(join(dir, "package.json"));
		const key = `${pkg.name}@${pkg.version}`;
		if (seen.has(key)) return;
		seen.set(key, {
			name: pkg.name,
			version: pkg.version,
			spdx: declaredLicense(pkg),
			text: licenseText(dir),
			dir: dir.slice(ROOT.length + 1),
		});
		for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false);
		for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true);
	};

	for (const dep of Object.keys(rootPkg.dependencies ?? {})) visit(dep, ROOT, false);
	for (const dep of Object.keys(rootPkg.optionalDependencies ?? {})) visit(dep, ROOT, true);
	const components = [...seen.values()].sort((a, b) =>
		a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
	);
	return { components, missing };
}

function electronComponent(): Component {
	const dir = join(ROOT, "node_modules", "electron");
	const pkg = readJson(join(dir, "package.json"));
	const license = join(dir, "dist", "LICENSE");
	if (!existsSync(license)) throw new Error("node_modules/electron/dist/LICENSE is missing; run bun install");
	return {
		name: "electron",
		version: pkg.version,
		spdx: declaredLicense(pkg),
		text: readFileSync(license, "utf8").replace(/\r\n?/g, "\n").trim(),
		dir: "node_modules/electron",
	};
}

/** First line that states a copyright, to head a group with. */
function copyrightLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => /copyright|\(c\)|©/i.test(line) && line.length < 200);
}

function isPermissive(spdx: string): boolean {
	const ids = spdx
		.replace(/[()]/g, " ")
		.split(/\s+(?:OR|AND)\s+/)
		.map(id => id.trim());
	return ids.some(id => PERMISSIVE.has(id));
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

function vendoredSections(): string {
	const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n?/g, "\n").trim();
	const reaLicense = read("resources/omp-builtin/rea/skills/reverse-engineer-anything/LICENSE");
	const lobeLicense = read("LICENSES/MIT-lobe-icons.txt");
	return [
		[
			"Mixdog (https://github.com/tribgames/mixdog)",
			"Copyright (c) 2026 tribgames. Licensed under the Apache License, Version 2.0",
			"(LICENSES/Apache-2.0.txt). Adapted, modified source files are listed in NOTICE.",
		].join("\n"),
		[
			"reverse-engineer-anything skill from REA (rea-agents, https://github.com/morluto/rea)",
			"Shipped in resources/omp-builtin/rea/skills/reverse-engineer-anything/.",
			"",
			reaLicense,
		].join("\n"),
		[
			"AI provider brand symbols of @lobehub/icons (@lobehub/icons-static-svg 1.95.1,",
			"https://github.com/lobehub/lobe-icons), shipped in src/renderer/assets/provider-marks/.",
			"The symbols are trademarks or logos of their owners and identify those providers only.",
			"",
			lobeLicense,
		].join("\n"),
		[
			"OMPdesk application icon, tray icons, mark and wordmark (resources/icon.*, resources/brand/,",
			"src/renderer/public/icons/)",
			"Copyright 2026 SeuPut. Original work, licensed under the Apache License, Version 2.0 (LICENSE).",
		].join("\n"),
	].join(`\n\n${THIN}\n\n`);
}

function generate(): { text: string; flagged: string[] } {
	const { components, missing } = collect();
	if (missing.length) throw new Error(`dependencies not installed (run bun install): ${missing.join(", ")}`);
	const all = [electronComponent(), ...components];

	const groups = new Map<string, Component[]>();
	const flagged: string[] = [];
	const unlicensed: Component[] = [];
	for (const component of all) {
		if (!isPermissive(component.spdx)) flagged.push(`${component.name}@${component.version}: ${component.spdx}`);
		if (!component.text) {
			unlicensed.push(component);
			continue;
		}
		const list = groups.get(component.text) ?? [];
		list.push(component);
		groups.set(component.text, list);
	}

	const ordered = [...groups.entries()].sort(([, a], [, b]) => {
		const x = `${a[0].name}@${a[0].version}`;
		const y = `${b[0].name}@${b[0].version}`;
		return x.localeCompare(y);
	});

	const out: string[] = [];
	out.push(
		"OMPdesk third-party notices",
		"",
		"OMPdesk itself is Copyright 2026 SeuPut and licensed under the Apache License, Version 2.0",
		"(LICENSE, NOTICE). The app is built from the components below; each is used under the",
		"license shown. This file is generated by scripts/generate-third-party-notices.ts from",
		"node_modules (bun run gen:licenses); do not edit it by hand.",
		"",
		"Electron (MIT) bundles Chromium and its third-party components, whose notices ship in",
		"LICENSES.chromium.html beside this file.",
		"",
		`${all.length} npm components, in ${groups.size + unlicensed.length} license texts.`,
		"",
		RULE,
		"1. Components bundled with the app (npm)",
		RULE,
		"",
	);
	for (const [text, list] of ordered) {
		for (const component of list) out.push(`${component.name} ${component.version} (${component.spdx})`);
		const copyrights = [...new Set(list.flatMap(component => copyrightLines(component.text)))];
		if (copyrights.length > 1 && list.length > 1) out.push("", ...copyrights);
		out.push("", text, "", THIN, "");
	}
	for (const component of unlicensed) {
		out.push(
			`${component.name} ${component.version} (${component.spdx})`,
			"",
			`This package ships no license file; its package.json declares ${component.spdx}.`,
			"",
			THIN,
			"",
		);
	}
	out.push(RULE, "2. Vendored and bundled non-npm components", RULE, "", vendoredSections(), "");
	return { text: `${out.join("\n").replace(/\n{4,}/g, "\n\n\n")}`, flagged };
}

const { text, flagged } = generate();
for (const entry of flagged) console.warn(`license needs review: ${entry}`);

if (process.argv.includes("--check")) {
	const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
	if (current !== text) {
		console.error("THIRD_PARTY_NOTICES.txt is stale: run `bun run gen:licenses` and commit it.");
		process.exit(1);
	}
	console.log("THIRD_PARTY_NOTICES.txt is up to date.");
} else {
	writeFileSync(OUTPUT, text);
	console.log(`Wrote THIRD_PARTY_NOTICES.txt (${text.length} bytes).`);
}
