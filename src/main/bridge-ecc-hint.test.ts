/**
 * gui-bridge ECC project hint (modes/ecc-hint-core.ts): a session whose folder shows a language or framework the ECC
 * pack covers gets one short section naming the hidden skills that fit. The detection is a table over the folder's
 * top-level names (plus a manifest's dependencies); `install` runs on a fake `pi` with real temp folders.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ECC_ENV,
	ECC_RULES,
	type EccHost,
	eccHintText,
	eccMatches,
	install,
} from "../../resources/gui-bridge/modes/ecc-hint-core";
import type { PromptSectionContext } from "../../resources/gui-bridge/prompt-sections";

/** A folder listing and its small manifests, as `eccMatches` reads them; a key with a `/` is a nested path. */
function folder(files: Record<string, string>) {
	const names = Object.keys(files).filter(name => !name.includes("/"));
	return { names, read: (name: string) => files[name], exists: (rel: string) => rel in files };
}
const labels = (files: Record<string, string>) => eccMatches(folder(files)).map(match => match.label);

describe("eccMatches", () => {
	it.each([
		["a Cargo manifest", { "Cargo.toml": "" }, ["Rust"]],
		["a Go module", { "go.mod": "" }, ["Go"]],
		["a Django project (not also plain Python)", { "manage.py": "", "requirements.txt": "django" }, ["Django"]],
		["a plain Python folder", { "inventory.py": "", "stock.csv": "" }, ["Python"]],
		["a Swift package", { "Package.swift": "" }, ["Swift"]],
		["a .NET solution", { "Shop.slnx": "", src: "" }, [".NET"]],
		["a Spring Boot build", { "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>" }, ["Spring Boot"]],
		["a Maven-layout tree before its build file", { src: "", "src/main/java": "" }, ["Java"]],
		["a Kotlin source tree", { src: "", "src/main/kotlin": "" }, ["Kotlin"]],
		["a plain Java build", { "pom.xml": "<artifactId>guava</artifactId>" }, ["Java"]],
		["a Kotlin Gradle build", { "build.gradle.kts": 'plugins { kotlin("jvm") }' }, ["Kotlin"]],
		["a React app", { "package.json": '{"dependencies":{"react":"^19.0.0"}}' }, ["React"]],
		[
			"a Next.js app (not also plain React)",
			{ "package.json": '{"dependencies":{"next":"15","react":"19"}}' },
			["Next.js"],
		],
		["an Express service", { "package.json": '{"dependencies":{"express":"^4"}}' }, ["Node.js backend"]],
		["a Dockerfile beside a Rust crate", { Dockerfile: "", "Cargo.toml": "" }, ["Rust", "Docker"]],
		["a Flutter app", { "pubspec.yaml": "flutter:" }, ["Flutter"]],
		["a Laravel app", { artisan: "", "composer.json": "laravel/framework" }, ["Laravel"]],
		["a Rails app", { Gemfile: "gem 'rails'" }, ["Rails"]],
	])("%s", (_name, files, expected) => {
		expect(labels(files)).toEqual(expected);
	});

	it.each([
		["an empty folder", {}],
		["only docs", { "README.md": "", docs: "" }],
		["a package.json with nothing ECC knows", { "package.json": '{"dependencies":{"left-pad":"1"}}' }],
		["a package.json that is not JSON", { "package.json": "{" }],
	])("finds nothing in %s", (_name, files) => {
		expect(eccMatches(folder(files))).toEqual([]);
		expect(eccHintText([])).toBeUndefined();
	});

	it("names only skills the pack ships", () => {
		const shipped = readdirSync(path.join(__dirname, "../../resources/omp-builtin/ecc/skills"));
		const named = ECC_RULES.flatMap(rule => rule.skills);
		expect(named.filter(name => !shipped.includes(name))).toEqual([]);
	});
});

describe("eccHintText", () => {
	it("lists each match with the marker it was seen by and its skills as skill:// paths", () => {
		const text = eccHintText(eccMatches(folder({ "Cargo.toml": "", Dockerfile: "" })));
		expect(text).toContain("Rust (Cargo.toml): skill://rust-patterns, skill://rust-testing");
		expect(text).toContain("Docker (Dockerfile): skill://docker-patterns");
		expect(text?.indexOf("Rust")).toBeLessThan(text?.indexOf("Docker") ?? 0);
	});
});

describe("install", () => {
	let root: string;
	let saved: string | undefined;
	let hook:
		| ((event: { systemPrompt: string[] }, ctx: PromptSectionContext) => { systemPrompt: string[] } | undefined)
		| undefined;
	const host: EccHost = {
		on: (_event, handler) => {
			hook = handler;
		},
	};
	const turn = (cwd: string, kind = "main") =>
		hook?.({ systemPrompt: ["base"] }, { cwd, agent: { kind }, sessionManager: { getBranch: () => [] } })
			?.systemPrompt;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "ecc-hint-"));
		saved = process.env[ECC_ENV];
		install(host);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		if (saved === undefined) delete process.env[ECC_ENV];
		else process.env[ECC_ENV] = saved;
	});

	it("adds the hint for a matching folder, to subagents too, and the same bytes every turn", () => {
		process.env[ECC_ENV] = "1";
		writeFileSync(path.join(root, "Cargo.toml"), "");
		const first = turn(root);
		expect(first?.[1]).toContain("skill://rust-patterns");
		expect(turn(root, "sub")?.[1]).toBe(first?.[1]);
		expect(turn(root)?.[1]).toBe(first?.[1]);
	});

	it("reads a manifest's dependencies", () => {
		process.env[ECC_ENV] = "1";
		const app = path.join(root, "app");
		mkdirSync(app);
		writeFileSync(path.join(app, "package.json"), '{"devDependencies":{"react":"19"}}');
		expect(turn(app)?.[1]).toContain("skill://react-patterns");
	});

	it("adds nothing with the pack off, for a folder ECC does not know, or for a folder that is gone", () => {
		writeFileSync(path.join(root, "Cargo.toml"), "");
		delete process.env[ECC_ENV];
		expect(turn(root)).toBeUndefined();
		process.env[ECC_ENV] = "1";
		const docs = path.join(root, "docs");
		mkdirSync(docs);
		writeFileSync(path.join(docs, "README.md"), "");
		expect(turn(docs)).toBeUndefined();
		expect(turn(path.join(root, "missing"))).toBeUndefined();
	});
});
