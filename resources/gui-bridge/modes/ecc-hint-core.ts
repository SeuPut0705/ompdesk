/**
 * The ECC pack's project hint (the pack itself is `resources/omp-builtin/ecc/`): every ECC skill is hidden from the
 * skill list and only the `ecc` index is listed, which models skip (measured 20 Oct 2026: 0 of 18 coding sessions in
 * ECC's languages read the index or any ECC skill). So a session whose folder shows a language or framework the pack
 * covers gets one short section naming the skills that fit, read from the folder's top-level names and its small
 * manifests' dependencies, once per folder: the same bytes every turn, so the prompt cache holds.
 *
 * On while main sets `OMP_GUI_ECC=1` (the pack's switch, Settings › Agent behavior); every agent kind gets it, since
 * subagents write the code. No omp imports (not even types): the GUI's vitest loads this file directly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";

/** Env main sets at spawn: `1` while the ECC pack is loaded. */
export const ECC_ENV = "OMP_GUI_ECC";

/** A folder as the rules read it: its top-level names, a reader for its small files and a check for a nested path. */
export interface EccFolder {
	names: readonly string[];
	read(name: string): string | undefined;
	/** `rel` (a `/`-separated path under the folder) exists: a source tree laid out before its build file. */
	exists(rel: string): boolean;
}

export interface EccRule {
	label: string;
	skills: readonly string[];
	/** The name the rule was seen by, or undefined. */
	marker(folder: EccFolder): string | undefined;
	/** Labels this more specific rule stands in for (Django for plain Python). */
	replaces?: readonly string[];
}

export interface EccMatch {
	label: string;
	marker: string;
	skills: readonly string[];
}

const named =
	(...names: string[]) =>
	(folder: EccFolder) =>
		names.find(name => folder.names.includes(name));
const ending =
	(...suffixes: string[]) =>
	(folder: EccFolder) =>
		folder.names.find(name => suffixes.some(suffix => name.endsWith(suffix)));
/** The first of `paths` that exists (Maven and Gradle source roots). */
const tree =
	(...paths: string[]) =>
	(folder: EccFolder) =>
		paths.find(rel => folder.exists(rel));
const either =
	(...tests: EccRule["marker"][]) =>
	(folder: EccFolder) => {
		for (const test of tests) {
			const marker = test(folder);
			if (marker) return marker;
		}
		return undefined;
	};
/** One of `files` that mentions `pattern` (a build file's plugin or dependency). */
const mentions =
	(pattern: RegExp, ...files: string[]) =>
	(folder: EccFolder) =>
		files.find(name => folder.names.includes(name) && pattern.test(folder.read(name) ?? ""));
/** `package.json` when it depends (in any dependency list) on one of `packages`. */
const dependsOn =
	(...packages: string[]) =>
	(folder: EccFolder) => {
		if (!folder.names.includes("package.json")) return undefined;
		let manifest: unknown;
		try {
			manifest = JSON.parse(folder.read("package.json") ?? "");
		} catch {
			return undefined;
		}
		if (typeof manifest !== "object" || manifest === null) return undefined;
		const lists = ["dependencies", "devDependencies", "peerDependencies"].map(key => Reflect.get(manifest, key));
		const has = lists.some(list => typeof list === "object" && list !== null && packages.some(name => name in list));
		return has ? "package.json" : undefined;
	};

const PYTHON_FILES = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"];
const JVM_BUILDS = ["pom.xml", "build.gradle", "build.gradle.kts"];

/** In the order the hint lists them; a skill name here must be one the pack ships (pinned by its test). */
export const ECC_RULES: readonly EccRule[] = [
	{
		label: "Django",
		marker: named("manage.py"),
		skills: ["django-patterns", "django-tdd", "django-security", "django-verification"],
		replaces: ["Python"],
	},
	{
		label: "FastAPI",
		marker: mentions(/fastapi/i, ...PYTHON_FILES),
		skills: ["fastapi-patterns", "python-patterns", "python-testing"],
		replaces: ["Python"],
	},
	{
		label: "Python",
		marker: either(named(...PYTHON_FILES), ending(".py")),
		skills: ["python-patterns", "python-testing"],
	},
	{ label: "Rust", marker: named("Cargo.toml"), skills: ["rust-patterns", "rust-testing"] },
	{ label: "Go", marker: named("go.mod"), skills: ["golang-patterns", "golang-testing"] },
	{
		label: "Spring Boot",
		marker: mentions(/spring-boot|org\.springframework\.boot/, ...JVM_BUILDS),
		skills: ["springboot-patterns", "springboot-tdd", "springboot-security", "java-coding-standards"],
		replaces: ["Java", "Kotlin"],
	},
	{
		label: "Quarkus",
		marker: mentions(/quarkus/, ...JVM_BUILDS),
		skills: ["quarkus-patterns", "quarkus-tdd", "quarkus-security", "java-coding-standards"],
		replaces: ["Java", "Kotlin"],
	},
	{
		label: "Android",
		marker: mentions(/com\.android\./, ...JVM_BUILDS),
		skills: ["android-clean-architecture", "kotlin-patterns", "kotlin-testing"],
		replaces: ["Java", "Kotlin"],
	},
	{
		label: "Kotlin",
		marker: either(
			named("build.gradle.kts"),
			ending(".kt"),
			mentions(/kotlin/, ...JVM_BUILDS),
			tree("src/main/kotlin"),
		),
		skills: ["kotlin-patterns", "kotlin-testing", "kotlin-coroutines-flows"],
		replaces: ["Java"],
	},
	{
		label: "Java",
		marker: either(named("pom.xml", "build.gradle"), ending(".java"), tree("src/main/java")),
		skills: ["java-coding-standards"],
	},
	{
		label: "Swift",
		marker: either(named("Package.swift"), ending(".xcodeproj", ".xcworkspace", ".swift")),
		skills: ["swift-concurrency-6-2", "swift-protocol-di-testing", "swift-actor-persistence", "swiftui-patterns"],
	},
	{ label: "Flutter", marker: named("pubspec.yaml"), skills: ["dart-flutter-patterns", "flutter-dart-code-review"] },
	{
		label: ".NET",
		marker: ending(".sln", ".slnx", ".csproj", ".fsproj"),
		skills: ["dotnet-patterns", "csharp-testing", "fsharp-testing"],
	},
	{
		label: "C++",
		marker: either(named("CMakeLists.txt", "meson.build"), ending(".cpp", ".cc", ".hpp")),
		skills: ["cpp-coding-standards", "cpp-testing"],
	},
	{
		label: "Laravel",
		marker: either(named("artisan"), mentions(/laravel/, "composer.json")),
		skills: ["laravel-patterns", "laravel-tdd", "laravel-security"],
	},
	{ label: "Rails", marker: mentions(/['"]rails['"]/, "Gemfile"), skills: ["rails-patterns"] },
	{
		label: "Perl",
		marker: either(named("cpanfile", "Makefile.PL"), ending(".pl", ".pm")),
		skills: ["perl-patterns", "perl-testing", "perl-security"],
	},
	{
		label: "Next.js",
		marker: dependsOn("next"),
		skills: ["nextjs-turbopack", "react-patterns", "react-testing"],
		replaces: ["React"],
	},
	{ label: "Nuxt", marker: dependsOn("nuxt"), skills: ["nuxt4-patterns", "vue-patterns"], replaces: ["Vue"] },
	{ label: "Vue", marker: dependsOn("vue"), skills: ["vue-patterns"] },
	{ label: "Angular", marker: dependsOn("@angular/core"), skills: ["angular-developer"] },
	{
		label: "React Native",
		marker: dependsOn("react-native"),
		skills: ["react-native-patterns", "react-patterns"],
		replaces: ["React"],
	},
	{ label: "React", marker: dependsOn("react"), skills: ["react-patterns", "react-testing", "frontend-patterns"] },
	{
		label: "NestJS",
		marker: dependsOn("@nestjs/core"),
		skills: ["nestjs-patterns", "backend-patterns"],
		replaces: ["Node.js backend"],
	},
	{ label: "Node.js backend", marker: dependsOn("express", "fastify", "koa", "hono"), skills: ["backend-patterns"] },
	{ label: "Prisma", marker: dependsOn("prisma", "@prisma/client"), skills: ["prisma-patterns"] },
	{ label: "Bun", marker: named("bun.lock", "bun.lockb", "bunfig.toml"), skills: ["bun-runtime"] },
	{
		label: "Docker",
		marker: named("Dockerfile", "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"),
		skills: ["docker-patterns"],
	},
];

/** What the folder shows, in table order, without the rules a more specific match stands in for. */
export function eccMatches(folder: EccFolder): EccMatch[] {
	const found: (EccMatch & { replaces: readonly string[] })[] = [];
	for (const rule of ECC_RULES) {
		const marker = rule.marker(folder);
		if (marker) found.push({ label: rule.label, marker, skills: rule.skills, replaces: rule.replaces ?? [] });
	}
	const replaced = new Set(found.flatMap(match => match.replaces));
	return found
		.filter(match => !replaced.has(match.label))
		.map(({ label, marker, skills }) => ({ label, marker, skills }));
}

/** The section for these matches; undefined when there are none. */
export function eccHintText(matches: readonly EccMatch[]): string | undefined {
	if (matches.length === 0) return undefined;
	const lines = matches.map(
		match => `- ${match.label} (${match.marker}): ${match.skills.map(name => `skill://${name}`).join(", ")}`,
	);
	return [
		"<ecc-skills>",
		"This project's languages have ECC skills, hidden from the skill list. Before your first edit or write here, read the ones below that fit the work:",
		...lines,
		"</ecc-skills>",
	].join("\n");
}

/** Manifests read for their dependencies stay small; a bigger file is not one. */
const MAX_MANIFEST_BYTES = 256 * 1024;

function readFolder(cwd: string): EccFolder | undefined {
	let names: string[];
	try {
		names = readdirSync(cwd);
	} catch {
		return undefined;
	}
	return {
		names,
		read(name) {
			try {
				const file = join(cwd, name);
				return statSync(file).size <= MAX_MANIFEST_BYTES ? readFileSync(file, "utf8") : undefined;
			} catch {
				return undefined;
			}
		},
		exists: rel => existsSync(join(cwd, ...rel.split("/"))),
	};
}

/** By folder: read once per process, so a session's section never changes under its prompt cache. */
const hints = new Map<string, string | undefined>();

export type EccHost = PromptSectionHost;

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: EccHost): void {
	registerPromptSection(pi, "ecc", ctx => {
		if (process.env[ECC_ENV] !== "1" || !ctx.cwd) return undefined;
		if (!hints.has(ctx.cwd)) {
			const folder = readFolder(ctx.cwd);
			hints.set(ctx.cwd, folder ? eccHintText(eccMatches(folder)) : undefined);
		}
		return hints.get(ctx.cwd);
	});
}
