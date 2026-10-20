/**
 * Vendor ECC's omp/pi profile (affaan-m/ECC `pi/core`, MIT, Affaan Mustafa) at the commit pinned in
 * `resources/omp-builtin/ecc/ecc-config.json` into `resources/omp-builtin/ecc/`. Run after every pin bump:
 *
 *   bun run sync:ecc            copy + translate + regenerate (needs network, or ECC_SRC=<clone at the pin>)
 *   bun run sync:ecc -- --check list the upstream commits that touched pi/core since the pin (no files written)
 *
 * What the copy changes (decisions and reasons live in the pin's `curation`):
 * - every skill is hidden from the model's skill list (`disable-model-invocation: true`, read as `skill://<name>`);
 *   one generated index skill, `ecc`, is the only listed entry and names them by language and framework;
 * - skills that restate a pstack workflow are left out; references to them point at pstack's counterpart;
 * - the `plan` command is `ecc-plan` (`/plan` is stock omp's plan mode);
 * - a few Claude Code names and paths become omp ones.
 *
 * Owned by OMPdesk and never touched here: `ecc-config.json` (the one version pin and the curation), `README.md`.
 * Everything else under the pack is generated; `ecc-manifest.json` holds its sha256 list, which
 * `src/main/ecc/pack-drift.test.ts` checks, so a hand edit of a generated file fails there. Every translation rule
 * must match at least once, and every kept skill must sit in one index group: an upstream change a rule or the
 * index relied on fails this script instead of shipping quietly.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import config from "../resources/omp-builtin/ecc/ecc-config.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dir, "..");
const PACK = path.join(ROOT, "resources/omp-builtin/ecc");
const LICENSE_COPY = path.join(ROOT, "LICENSES/MIT-ecc.txt");
const MANIFEST = path.join(PACK, "ecc-manifest.json");
/** OMPdesk-owned files: kept as they are and never regenerated. */
const OWNED = ["ecc-config.json", "README.md"];

const DROPPED: Readonly<Record<string, { leads: string }>> = config.curation.droppedSkills;
const RENAMED_COMMANDS: Readonly<Record<string, { to: string }>> = config.curation.renamedCommands;

/** The index skill: the only ECC entry in the model's skill list. Its description is what every session pays for. */
const INDEX_NAME = "ecc";
const INDEX_DESCRIPTION =
	"Index of ECC language, framework and tool skills, read on demand: Go, Rust, Python, Django, FastAPI, Java, Spring Boot, Quarkus, Kotlin, Android, Swift, Flutter, C++, .NET, Laravel, Rails, Perl, React, Next.js, Vue, Angular, NestJS, databases, Docker, Kubernetes, security and LLM apps. Read it before writing, testing or reviewing code in one of these.";

/**
 * Index groups, in reading order. Every kept skill sits in exactly one group (the script fails otherwise), so a new
 * upstream skill is placed here, or dropped in the pin's curation, before it ships.
 */
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
	["Go", ["golang-patterns", "golang-testing"]],
	["Rust", ["rust-patterns", "rust-testing"]],
	["Python", ["python-patterns", "python-testing", "fastapi-patterns", "pytorch-patterns"]],
	["Django", ["django-patterns", "django-security", "django-tdd", "django-verification", "django-celery"]],
	[
		"Java (Spring Boot, Quarkus, JPA, MyBatis)",
		[
			"java-coding-standards",
			"springboot-patterns",
			"springboot-security",
			"springboot-tdd",
			"springboot-verification",
			"quarkus-patterns",
			"quarkus-security",
			"quarkus-tdd",
			"quarkus-verification",
			"jpa-patterns",
			"mybatis-patterns",
		],
	],
	[
		"Kotlin and Android",
		[
			"kotlin-patterns",
			"kotlin-testing",
			"kotlin-coroutines-flows",
			"kotlin-ktor-patterns",
			"kotlin-exposed-patterns",
			"android-clean-architecture",
			"compose-multiplatform-patterns",
		],
	],
	[
		"Swift and Apple platforms",
		[
			"swiftui-patterns",
			"swift-concurrency-6-2",
			"swift-actor-persistence",
			"swift-protocol-di-testing",
			"liquid-glass-design",
			"foundation-models-on-device",
		],
	],
	["Dart and Flutter", ["dart-flutter-patterns", "flutter-dart-code-review"]],
	["C++", ["cpp-coding-standards", "cpp-testing"]],
	[".NET (C#, F#)", ["dotnet-patterns", "csharp-testing", "fsharp-testing"]],
	["PHP (Laravel)", ["laravel-patterns", "laravel-security", "laravel-tdd", "laravel-verification"]],
	["Ruby (Rails)", ["rails-patterns"]],
	["Perl", ["perl-patterns", "perl-security", "perl-testing"]],
	[
		"JavaScript and TypeScript (backend, tooling)",
		["backend-patterns", "nestjs-patterns", "prisma-patterns", "bun-runtime", "vite-patterns", "mcp-server-patterns"],
	],
	[
		"Frontend (React, Next.js, Vue, Nuxt, Angular, motion)",
		[
			"frontend-patterns",
			"react-patterns",
			"react-performance",
			"react-testing",
			"react-native-patterns",
			"nextjs-turbopack",
			"nuxt4-patterns",
			"vue-patterns",
			"angular-developer",
			"motion-foundations",
			"motion-patterns",
			"motion-advanced",
		],
	],
	[
		"UI, design and accessibility",
		["accessibility", "frontend-a11y", "design-system", "make-interfaces-feel-better", "dashboard-builder"],
	],
	[
		"Databases and data",
		[
			"postgres-patterns",
			"mysql-patterns",
			"redis-patterns",
			"clickhouse-io",
			"database-migrations",
			"data-throughput-accelerator",
			"content-hash-cache-pattern",
		],
	],
	[
		"Infrastructure and production",
		["docker-patterns", "kubernetes-patterns", "deployment-patterns", "latency-critical-systems", "production-audit"],
	],
	[
		"APIs and architecture",
		[
			"api-design",
			"api-connector-builder",
			"contract-first",
			"hexagonal-architecture",
			"error-handling",
			"architecture-decision-records",
			"context-and-decisions",
		],
	],
	[
		"Testing, regression and performance",
		["e2e-testing", "test-collaboration", "module-regression", "click-path-audit", "benchmark"],
	],
	["Security", ["security-review"]],
	[
		"Conventions, git and docs",
		[
			"coding-standards",
			"inherit-legacy-style",
			"git-workflow",
			"code-tour",
			"docs-governance",
			"living-docs-governance",
		],
	],
	["Product", ["product-lens", "product-capability"]],
	[
		"AI, ML and agent apps",
		[
			"agent-architecture-audit",
			"agent-eval",
			"agent-harness-construction",
			"agent-introspection-debugging",
			"agent-security-hardening",
			"cost-aware-llm-pipeline",
			"regex-vs-llm-structured-text",
			"ml-adoption-playbook",
			"mle-workflow",
			"bengali-nlp",
		],
	],
];

type Replacer = (match: string, ...groups: string[]) => string;

interface Rule {
	id: string;
	/** Pack-relative paths (after renames) the rule applies to. */
	files: RegExp;
	from: string | RegExp;
	to: string | Replacer;
}

const rule = (id: string, files: RegExp, from: string | RegExp, to: string | Replacer): Rule => ({
	id,
	files,
	from,
	to,
});

const TEXT = /^(commands|skills)\/.*\.md$/;

const droppedNames = Object.keys(DROPPED).join("|");

const RULES: Rule[] = [
	rule("plan-command-refs", TEXT, /(?<![\w.-])\/plan(?![\w-])/g, `/${RENAMED_COMMANDS.plan?.to ?? "ecc-plan"}`),
	rule(
		"plan-description",
		/^commands\/ecc-plan\.md$/,
		" Use for a single-model inline or PRD-driven implementation plan; for a dual-model (Codex/Antigravity) plan use /multi-plan, and for visual annotate-and-approve review of the resulting plan use /plan-canvas.",
		" Use for a single-model inline or PRD-driven implementation plan.",
	),
	rule("plan-task-tool", /^commands\/ecc-plan\.md$/, "Do not call the Task tool", "Do not call the `task` tool"),
	rule("plan-canvas-visual", /^commands\/ecc-plan\.md$/, /\n> \*\*Visual review:\*\*[^\n]*\n(?:>[^\n]*\n)*/, "\n"),
	rule(
		"plan-canvas-integration",
		/^commands\/ecc-plan\.md$/,
		"- Use `/plan-canvas` to run the confirmation gate visually in the browser (annotate + approve)\n",
		"",
	),
	rule("ask-tool", /^skills\/inherit-legacy-style\/SKILL\.md$/, /AskUserQuestion/g, "ask"),
	// ECC's working files (PRDs, plans, reports, reviews) go under `.ecc/` in the project, not Claude Code's folder.
	rule("artifact-dirs", TEXT, /\.claude\/(PRPs|prds|plans|reviews|tdd)\b/g, ".ecc/$1"),
	// A kept skill or command naming a dropped skill points at the pstack skill that leads instead.
	rule(
		"dropped-skill-refs",
		TEXT,
		new RegExp(
			`\`skills\\/(${droppedNames})\\/\`|\\[(${droppedNames})\\]\\(\\.\\.\\/(?:${droppedNames})\\/SKILL\\.md\\)|\`(${droppedNames})\``,
			"g",
		),
		(_match, inPath, inLink, inTicks) => {
			const { leads } = DROPPED[inPath ?? inLink ?? inTicks];
			const ref = leads.startsWith("skill://") ? leads : `skill://${leads}`;
			return inLink ? `[${leads}](${ref})` : `\`${ref}\``;
		},
	),
];

interface Counted {
	rule: Rule;
	hits: number;
}

function applyRules(relPath: string, text: string, counted: Counted[]): string {
	let out = text;
	for (const entry of counted) {
		if (!entry.rule.files.test(relPath)) continue;
		const before = out;
		const { from, to } = entry.rule;
		if (typeof from === "string") out = out.split(from).join(typeof to === "string" ? to : to(from));
		else out = typeof to === "string" ? out.replace(from, to) : out.replace(from, to as Replacer);
		if (out !== before) entry.hits++;
	}
	return out;
}

/** Hide a skill from the model's skill list; it stays readable as `skill://<name>`. */
function hide(text: string, relPath: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(text);
	if (!match) throw new Error(`${relPath} has no frontmatter`);
	if (/^disable-model-invocation:/m.test(match[0])) return text;
	const end = match[0].length - "---\n".length;
	return `${text.slice(0, end)}disable-model-invocation: true\n${text.slice(end)}`;
}

function indexSkill(kept: readonly string[], commands: readonly string[]): string {
	const grouped = GROUPS.flatMap(([, names]) => names);
	const unplaced = kept.filter(name => !grouped.includes(name));
	const unknown = grouped.filter(name => !kept.includes(name));
	const twice = grouped.filter((name, i) => grouped.indexOf(name) !== i);
	if (unplaced.length || unknown.length || twice.length)
		throw new Error(
			`ECC index groups are stale. Not placed: ${unplaced.join(", ") || "-"}. Not shipped: ${unknown.join(", ") || "-"}. Twice: ${twice.join(", ") || "-"}.`,
		);
	return [
		"---",
		`name: ${INDEX_NAME}`,
		`description: "${INDEX_DESCRIPTION}"`,
		"---",
		"",
		"# ECC skills (OMPdesk built-in)",
		"",
		`Language, framework and tool specifics from ECC ${config.version} (Affaan Mustafa, MIT). Each skill below is hidden from the skill list: read the one that fits the code at hand with \`read skill://<name>\` before you write, test or review it, and read only what the task needs.`,
		"",
		"When the pstack section is in your prompt, its playbooks lead the workflow (planning, TDD, verification, review, decisions); these skills supply the specifics for the language or framework. Where a skill names a pstack skill (`skill://pstack-tdd`, `skill://blast-radius`, …) and pstack is off, skip that pointer.",
		"",
		...GROUPS.map(([label, names]) => `- ${label}: ${names.map(name => `\`${name}\``).join(", ")}`),
		"",
		`Prompt commands the user can type (you do not run them yourself): ${commands.map(name => `\`/${name}\``).join(", ")}.`,
		"",
	].join("\n");
}

function walk(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out.sort();
}

function upstreamSource(): { dir: string; cleanup: () => void } {
	const override = process.env.ECC_SRC;
	if (override) {
		const head = execFileSync("git", ["-C", override, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		if (head !== config.commit) throw new Error(`ECC_SRC is at ${head}, the pin is ${config.commit}`);
		return { dir: override, cleanup: () => {} };
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-src-"));
	execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${config.repo}`, tmp], {
		stdio: "inherit",
	});
	execFileSync("git", ["-C", tmp, "sparse-checkout", "set", "--no-cone", `/${config.path}/`], { stdio: "inherit" });
	execFileSync("git", ["-C", tmp, "checkout", config.commit], { stdio: "inherit" });
	return { dir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function check(): void {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-check-"));
	try {
		execFileSync("git", ["clone", "--filter=blob:none", "--bare", `https://github.com/${config.repo}`, tmp], {
			stdio: "ignore",
		});
		const log = execFileSync("git", ["-C", tmp, "log", "--oneline", `${config.commit}..HEAD`, "--", config.path], {
			encoding: "utf8",
		});
		console.log(log.trim() ? log : `${config.path}/ unchanged since ${config.commit}`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function main(): void {
	if (process.argv.includes("--check")) return check();
	const source = upstreamSource();
	try {
		const upstream = path.join(source.dir, config.path);
		const counted: Counted[] = RULES.map(entry => ({ rule: entry, hits: 0 }));
		for (const generated of fs.readdirSync(PACK)) {
			if (!OWNED.includes(generated)) fs.rmSync(path.join(PACK, generated), { recursive: true, force: true });
		}

		// Skills: the kept ones, hidden; the dropped ones must still exist upstream (else the curation is stale).
		const upstreamSkills = path.join(upstream, "skills");
		const names = fs.readdirSync(upstreamSkills).sort();
		const staleDrops = Object.keys(DROPPED).filter(name => !names.includes(name));
		if (staleDrops.length) throw new Error(`curation drops skills upstream no longer has: ${staleDrops.join(", ")}`);
		const kept = names.filter(name => !(name in DROPPED));
		if (kept.includes(INDEX_NAME)) throw new Error(`upstream now has a skill named ${INDEX_NAME}`);
		for (const rel of walk(upstreamSkills)) {
			if (rel.split("/")[0] in DROPPED) continue;
			const from = path.join(upstreamSkills, rel);
			const dest = path.join(PACK, "skills", rel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			if (!rel.endsWith(".md")) {
				fs.copyFileSync(from, dest);
				continue;
			}
			let text = applyRules(`skills/${rel}`, fs.readFileSync(from, "utf8"), counted);
			if (rel.endsWith("/SKILL.md") && rel.split("/").length === 2) text = hide(text, rel);
			fs.writeFileSync(dest, text);
			fs.chmodSync(dest, fs.statSync(from).mode & 0o777);
		}

		// Commands: renamed where a stock or OMPdesk command has the name.
		const upstreamCommands = path.join(upstream, "commands");
		const commands: string[] = [];
		const staleRenames = Object.keys(RENAMED_COMMANDS).filter(
			name => !fs.existsSync(path.join(upstreamCommands, `${name}.md`)),
		);
		if (staleRenames.length) throw new Error(`curation renames commands upstream no longer has: ${staleRenames}`);
		for (const file of fs.readdirSync(upstreamCommands).sort()) {
			if (!file.endsWith(".md")) throw new Error(`unexpected command file ${file}`);
			const base = file.slice(0, -3);
			const name = RENAMED_COMMANDS[base]?.to ?? base;
			commands.push(name);
			const rel = `commands/${name}.md`;
			const text = applyRules(rel, fs.readFileSync(path.join(upstreamCommands, file), "utf8"), counted);
			fs.mkdirSync(path.join(PACK, "commands"), { recursive: true });
			fs.writeFileSync(path.join(PACK, rel), text);
		}
		commands.sort();

		// The index skill: the one listed entry.
		fs.mkdirSync(path.join(PACK, "skills", INDEX_NAME), { recursive: true });
		fs.writeFileSync(path.join(PACK, "skills", INDEX_NAME, "SKILL.md"), indexSkill(kept, commands));

		// Upstream's own curation record and the license.
		fs.copyFileSync(path.join(upstream, "CURATION.md"), path.join(PACK, "UPSTREAM-CURATION.md"));
		const license = fs.readFileSync(path.join(upstream, "LICENSE"));
		fs.writeFileSync(path.join(PACK, "UPSTREAM-LICENSE"), license);
		fs.mkdirSync(path.dirname(LICENSE_COPY), { recursive: true });
		fs.writeFileSync(LICENSE_COPY, license);

		const unmatched = counted.filter(entry => entry.hits === 0).map(entry => entry.rule.id);
		if (unmatched.length)
			throw new Error(`ECC translation rules matched nothing (upstream reworded?): ${unmatched.join(", ")}`);

		const files = walk(PACK).filter(rel => rel !== "ecc-manifest.json");
		const manifest = Object.fromEntries(
			files.map(rel => [
				rel,
				createHash("sha256")
					.update(fs.readFileSync(path.join(PACK, rel)))
					.digest("hex"),
			]),
		);
		fs.writeFileSync(
			MANIFEST,
			`${JSON.stringify({ commit: config.commit, version: config.version, files: manifest }, null, "\t")}\n`,
		);
		console.log(
			`Vendored ECC ${config.path} ${config.version} (${config.commit.slice(0, 7)}): ${kept.length} skills + index, ${commands.length} commands, ${files.length} files, ${RULES.length} rules; owned: ${OWNED.join(", ")}`,
		);
	} finally {
		source.cleanup();
	}
}

main();
