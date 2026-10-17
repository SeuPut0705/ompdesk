/**
 * The README checks: every local link, image and `srcset` of README.md, README.ko.md and docs/*.md resolves (anchors
 * included), every image has alt text, the two download buttons point at the release assets the updater fetches, the
 * language switch is in both READMEs, and docs/media stays within its size budgets (3 MB a file, 6 MB for the hero).
 *
 *   bun run readme:check
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const READMES = ["README.md", "README.ko.md"];
const MAX_README_LINES = 140;
const MEDIA_BUDGET_MB = 3;
const HERO_BUDGET_MB = 6;
const DOWNLOADS = [
	"https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-mac-arm64.dmg",
	"https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-windows-setup.exe",
];

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
	return heading
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/<[^>]+>/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s/g, "-");
}

function anchors(file: string): Set<string> {
	const seen = new Map<string, number>();
	const found = new Set<string>();
	let fenced = false;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (line.startsWith("```")) fenced = !fenced;
		const match = fenced ? null : /^#{1,6}\s+(.*)$/.exec(line);
		if (!match?.[1]) continue;
		const base = slug(match[1]);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		found.add(count === 0 ? base : `${base}-${count}`);
	}
	return found;
}

/** Link targets of a Markdown file: `](x)`, `href`, `src` and every URL of a `srcset`. */
function targets(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(match[1] ?? "");
	for (const match of text.matchAll(/\b(?:href|src)="([^"]+)"/g)) found.push(match[1] ?? "");
	for (const match of text.matchAll(/\bsrcset="([^"]+)"/g))
		for (const part of (match[1] ?? "").split(",")) found.push(part.trim().split(/\s+/)[0] ?? "");
	return found.filter(target => target !== "");
}

export function checkLinks(file: string): string[] {
	const problems: string[] = [];
	const text = fs.readFileSync(file, "utf8");
	const own = path.relative(ROOT, file);
	for (const target of targets(text)) {
		if (/^(https?:|mailto:)/.test(target)) continue;
		const [rawPath = "", fragment] = target.split("#");
		const resolved = rawPath === "" ? file : path.resolve(path.dirname(file), decodeURIComponent(rawPath));
		if (!fs.existsSync(resolved)) {
			problems.push(`${own}: ${target} does not exist`);
			continue;
		}
		if (fragment && resolved.endsWith(".md") && !anchors(resolved).has(fragment))
			problems.push(`${own}: ${target} has no such heading`);
	}
	return problems;
}

export function checkAlt(file: string): string[] {
	const problems: string[] = [];
	const text = fs.readFileSync(file, "utf8");
	const own = path.relative(ROOT, file);
	for (const match of text.matchAll(/<img\b[^>]*>/g)) {
		const alt = /\balt="([^"]*)"/.exec(match[0]);
		if (!alt?.[1]?.trim()) problems.push(`${own}: image without alt text: ${match[0].slice(0, 80)}`);
	}
	for (const match of text.matchAll(/!\[([^\]]*)\]\(/g))
		if (!match[1]?.trim()) problems.push(`${own}: Markdown image without alt text`);
	return problems;
}

function checkReadme(name: string): string[] {
	const file = path.join(ROOT, name);
	const text = fs.readFileSync(file, "utf8");
	const problems: string[] = [];
	const lines = text.split("\n").length;
	if (lines > MAX_README_LINES) problems.push(`${name}: ${lines} lines (limit ${MAX_README_LINES})`);
	for (const url of DOWNLOADS) if (!text.includes(url)) problems.push(`${name}: missing download link ${url}`);
	for (const button of ["download-macos.svg", "download-windows.svg"])
		if (!text.includes(`resources/brand/${button}`)) problems.push(`${name}: missing ${button}`);
	const other = name === "README.md" ? "README.ko.md" : "README.md";
	if (!text.slice(0, 600).includes(`(${other})`)) problems.push(`${name}: no language switch to ${other} at the top`);
	if (!text.includes("@SeuPut0705")) problems.push(`${name}: missing the author line`);
	return problems;
}

export function mediaSizes(): { name: string; mb: number }[] {
	const dir = path.join(ROOT, "docs/media");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.sort()
		.map(name => ({ name, mb: fs.statSync(path.join(dir, name)).size / 1_048_576 }));
}

export function checkMedia(): string[] {
	return mediaSizes()
		.filter(({ name, mb }) => mb > (name.startsWith("hero") ? HERO_BUDGET_MB : MEDIA_BUDGET_MB))
		.map(({ name, mb }) => `docs/media/${name}: ${mb.toFixed(2)} MB is over its budget`);
}

export function checkAll(): string[] {
	const docs = fs
		.readdirSync(path.join(ROOT, "docs"))
		.filter(name => name.endsWith(".md"))
		.map(name => path.join(ROOT, "docs", name));
	const files = [...READMES.map(name => path.join(ROOT, name)), ...docs];
	return [
		...READMES.flatMap(checkReadme),
		...files.flatMap(file => [...checkLinks(file), ...checkAlt(file)]),
		...checkMedia(),
	];
}

if (import.meta.main) {
	const problems = checkAll();
	const total = mediaSizes().reduce((sum, { mb }) => sum + mb, 0);
	for (const { name, mb } of mediaSizes()) console.log(`${mb.toFixed(2).padStart(6)} MB  docs/media/${name}`);
	console.log(`${total.toFixed(2).padStart(6)} MB  docs/media total`);
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) process.exit(1);
	console.log("README links, images and media are fine.");
}
