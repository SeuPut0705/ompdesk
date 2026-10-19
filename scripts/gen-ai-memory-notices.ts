/**
 * Regenerates LICENSES/ai-memory-dependencies.txt: the Rust crates statically linked into
 * the ai-memory binary OMPdesk builds from native/memory, with name, version, SPDX license expression,
 * repository, and every distinct license/NOTICE text those crates ship, reproduced once each.
 *
 * Needs `cargo` and network access (crate sources). Run it whenever native/memory/Cargo.lock changes
 * (`bun scripts/gen-ai-memory-notices.ts`), then run `bun run gen:licenses` and commit both outputs.
 * The committed file is what the app ships; `bun run licenses:check` (scripts/generate-third-party-notices.ts)
 * fails when its header's Cargo.lock SHA-256 differs from native/memory/Cargo.lock.
 *
 * Method: `cargo metadata --locked` in native/memory for each release target (aarch64-apple-darwin,
 * x86_64-pc-windows-msvc) from the crate OMPdesk builds (`cargo build --locked --release -p ai-memory-cli`,
 * scripts/build-memory.ts). The set is the union of both targets' graphs, following normal dependency edges
 * only: build-only and dev dependencies are not linked and are skipped, as are proc-macro crates (they run at
 * compile time). The workspace's own crates are covered by ai-memory's license (LICENSES/ai-memory-LICENSE).
 * Texts are read from the downloaded crate sources, so they are exactly what each crate ships.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(ROOT, "LICENSES", "ai-memory-dependencies.txt");
const TARGETS = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"];
const LICENSE_FILE = /^(licen[sc]e|copying|notice|unlicense)(\.|-|_|$)/i;
const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

interface MetaPackage {
	id: string;
	name: string;
	version: string;
	license: string | null;
	license_file: string | null;
	repository: string | null;
	manifest_path: string;
	source: string | null;
	targets: { kind: string[] }[];
}

interface MetaNode {
	id: string;
	deps: { pkg: string; dep_kinds: { kind: string | null }[] }[];
}

interface Metadata {
	packages: MetaPackage[];
	resolve: { nodes: MetaNode[] };
}

interface Crate {
	name: string;
	version: string;
	license: string;
	repository: string;
	texts: string[];
}

const SOURCE = join(ROOT, "native", "memory");

export function sourceVersion(): string {
	return (JSON.parse(readFileSync(join(SOURCE, "ompdesk.json"), "utf8")) as { version: string }).version;
}

/** SHA-256 of native/memory/Cargo.lock with line endings normalized: what the committed crate list is made for. */
export function lockHash(): string {
	return createHash("sha256")
		.update(readFileSync(join(SOURCE, "Cargo.lock"), "utf8").replace(/\r\n?/g, "\n"))
		.digest("hex");
}

function run(cmd: string, args: string[], cwd?: string): string {
	return execFileSync(cmd, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	});
}

const normalize = (text: string): string => text.replace(/\r\n?/g, "\n").trim();

function linked(meta: Metadata, root: string): Map<string, MetaPackage> {
	const byId = new Map(meta.packages.map(pkg => [pkg.id, pkg]));
	const nodes = new Map(meta.resolve.nodes.map(node => [node.id, node]));
	const start = meta.packages.find(pkg => pkg.name === "ai-memory-cli" && pkg.source === null);
	if (!start) throw new Error(`${root}: ai-memory-cli not found`);
	const seen = new Map<string, MetaPackage>();
	const stack = [start.id];
	while (stack.length) {
		const id = stack.pop() as string;
		if (seen.has(id)) continue;
		const pkg = byId.get(id);
		if (!pkg) continue;
		seen.set(id, pkg);
		for (const dep of nodes.get(id)?.deps ?? []) {
			if (dep.dep_kinds.some(kind => kind.kind === null)) stack.push(dep.pkg);
		}
	}
	return seen;
}

function texts(pkg: MetaPackage): string[] {
	const dir = dirname(pkg.manifest_path);
	const files = readdirSync(dir)
		.filter(name => LICENSE_FILE.test(name))
		.sort();
	if (pkg.license_file && !files.includes(pkg.license_file) && existsSync(join(dir, pkg.license_file))) {
		files.push(pkg.license_file);
	}
	return files.map(name => normalize(readFileSync(join(dir, name), "utf8"))).filter(text => text.length > 0);
}

function main(): void {
	const version = sourceVersion();
	{
		const src = SOURCE;
		const crates = new Map<string, Crate>();
		const members = new Set<string>();
		for (const target of TARGETS) {
			const meta = JSON.parse(
				run(
					"cargo",
					[
						"metadata",
						"--locked",
						"--format-version",
						"1",
						"--filter-platform",
						target,
						"--manifest-path",
						"crates/ai-memory-cli/Cargo.toml",
					],
					src,
				),
			) as Metadata;
			for (const pkg of linked(meta, target).values()) {
				if (pkg.source === null) {
					members.add(pkg.name);
					continue;
				}
				if (pkg.targets.some(t => t.kind.includes("proc-macro"))) continue;
				const key = `${pkg.name}@${pkg.version}`;
				if (crates.has(key)) continue;
				crates.set(key, {
					name: pkg.name,
					version: pkg.version,
					license: pkg.license ?? "UNKNOWN",
					repository: pkg.repository ?? "(none declared)",
					texts: texts(pkg),
				});
			}
		}

		const list = [...crates.values()].sort(
			(a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
		);
		const textIds = new Map<string, number>();
		for (const crate of list) {
			for (const text of crate.texts) if (!textIds.has(text)) textIds.set(text, textIds.size + 1);
		}
		const flagged = list.filter(crate => crate.texts.length === 0);
		for (const crate of flagged)
			console.warn(`no license file shipped: ${crate.name}@${crate.version} (${crate.license})`);

		const out: string[] = [
			`ai-memory ${version} statically linked Rust crates`,
			"",
			`Cargo.lock SHA-256: ${lockHash()}`,
			"",
			`The ai-memory ${version} binary OMPdesk builds from native/memory (https://github.com/akitaonrails/ai-memory)`,
			"links the crates below. Set: normal dependencies of `ai-memory-cli` for aarch64-apple-darwin and",
			"x86_64-pc-windows-msvc, per native/memory/Cargo.lock; build-only and proc-macro crates are not linked. ai-memory's",
			"own workspace crates are under ai-memory's license (LICENSES/ai-memory-LICENSE). Generated by",
			"scripts/gen-ai-memory-notices.ts; do not edit by hand.",
			"",
			`${list.length} crates, ${textIds.size} distinct license/notice texts.`,
			"",
			RULE,
			"Crates: name version (SPDX license expression) repository [license text numbers below]",
			RULE,
			"",
		];
		for (const crate of list) {
			const refs = crate.texts.map(text => textIds.get(text)).join(",");
			out.push(`${crate.name} ${crate.version} (${crate.license}) ${crate.repository} [${refs || "none shipped"}]`);
		}
		out.push("", RULE, "License and notice texts", RULE, "");
		for (const [text, id] of textIds) out.push(`[${id}]`, "", text, "", THIN, "");
		if (flagged.length) {
			out.push(
				"Crates whose published package ships no license file",
				"",
				"The following crates declare the license shown in their Cargo.toml but their package carries no",
				"license text. The standard text of that license applies (Apache-2.0: LICENSES/Apache-2.0.txt",
				"beside THIRD_PARTY_NOTICES.txt; MIT: the MIT text in this file), with the copyright of the crate's",
				"authors as stated in the repository listed above.",
				"",
				...flagged.map(crate => `- ${crate.name} ${crate.version} (${crate.license}) ${crate.repository}`),
				"",
			);
		}
		writeFileSync(
			OUTPUT,
			`${out
				.join("\n")
				.replace(/\n{4,}/g, "\n\n\n")
				.trimEnd()}\n`,
		);
		console.log(
			`Wrote ${OUTPUT}: ${list.length} crates, ${textIds.size} texts, ${flagged.length} without license file.`,
		);
		console.log(`Workspace crates skipped: ${[...members].sort().join(", ")}`);
	}
}

if (import.meta.main) main();
