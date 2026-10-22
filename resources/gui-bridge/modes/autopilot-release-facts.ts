/**
 * Reads what a repository says about releasing, read-only and without a model: release/publish/deploy workflows, version
 * manifests, publish scripts, the changelog's shape, version tags and their cadence, GitHub releases (through `gh` when
 * the remote is GitHub and gh answers), and hosting configs whose Git integration deploys a push. Every read is bounded
 * and a failed one is just absent; never throws. Rules live in `autopilot-release-core.ts`.
 */

import { join } from "node:path";
import type { UnreleasedCommit } from "./autopilot-core";
import type { GuideIo } from "./autopilot-guide";
import type { ReleaseFacts, ReleaseWorkflow } from "./autopilot-release-core";

const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_BYTES = 64 * 1024;
const MAX_WORKFLOWS = 30;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
/** Version tags: `v1.2.3`, `1.2`, `pkg@1.2.3`, with a pre-release or build suffix. */
const VERSION_TAG = /^(?:[\w./-]+@)?v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/;
const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert|release)(\([^)]*\))?!?:/;

/** Publishing and deploying steps a workflow can hold, by the words it uses. */
const PUBLISHERS: Array<[RegExp, string]> = [
	[/\bnpm publish\b|JS-DevTools\/npm-publish/, "npm"],
	[/\b(?:pnpm|yarn|bun) publish\b/, "npm"],
	[/changesets\/action/, "changesets"],
	[/semantic-release/, "semantic-release"],
	[/\bcargo publish\b|katyo\/publish-crates/, "crates.io"],
	[/twine upload|pypa\/gh-action-pypi-publish|\buv publish\b|poetry publish/, "PyPI"],
	[/goreleaser/, "goreleaser"],
	[/electron-builder|\bpackage:(?:mac|win|linux)\b/, "electron-builder"],
	[/\bgh release (?:create|upload)\b|softprops\/action-gh-release|ncipollo\/release-action/, "GitHub release"],
	[/docker\/build-push-action|\bdocker push\b/, "container image"],
	[/\bvsce publish\b|\bovsx publish\b/, "VS Code extension"],
	[/\bgem push\b/, "RubyGems"],
	[/\bmvn deploy\b|gradle publish/, "Maven"],
];
const DEPLOYERS: Array<[RegExp, string]> = [
	[/actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action/, "GitHub Pages"],
	[/\bvercel\b[^\n]*(?:deploy|--prod)|amondnet\/vercel-action/, "Vercel"],
	[/netlify deploy|nwtgck\/actions-netlify/, "Netlify"],
	[/wrangler(?:-action)?[^\n]*deploy|cloudflare\/(?:wrangler-action|pages-action)/, "Cloudflare"],
	[/fly(?:ctl)? deploy|superfly\/flyctl-actions/, "Fly.io"],
	[/firebase deploy|FirebaseExtended\/action-hosting-deploy/, "Firebase Hosting"],
];
const DEPLOY_CONFIGS: Array<[string, string]> = [
	["vercel.json", "Vercel"],
	[".vercel/project.json", "Vercel"],
	["netlify.toml", "Netlify"],
	["firebase.json", "Firebase Hosting"],
	["wrangler.toml", "Cloudflare"],
	["fly.toml", "Fly.io"],
	["render.yaml", "Render"],
];
const PUBLISH_SCRIPT =
	/\b(?:npm|pnpm|yarn|bun) publish\b|changeset publish|semantic-release|--publish (?:always|onTag)|\bvsce publish\b|\bcargo publish\b|twine upload|\bgh-pages\b|vercel --prod/;

function parsedObject(text: string | null): Record<string, unknown> {
	if (text === null) return {};
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: {};
	} catch {
		return {};
	}
}

/** The YAML list right after `key:` (inline `[a, b]` or `- a` lines), unquoted. */
function yamlList(text: string, key: string): string[] | null {
	const inline = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(text);
	if (inline)
		return (inline[1] ?? "")
			.split(",")
			.map(item => item.trim().replace(/^['"]|['"]$/g, ""))
			.filter(Boolean);
	const block = new RegExp(`^(\\s*)${key}:\\s*\\n((?:\\1\\s+-[^\\n]*\\n?)+)`, "m").exec(text);
	if (!block) return null;
	return (block[2] ?? "")
		.split("\n")
		.map(line =>
			line
				.replace(/^\s*-\s*/, "")
				.trim()
				.replace(/^['"]|['"]$/g, ""),
		)
		.filter(Boolean);
}

/** The workflow's `on:` block: its own line and the indented lines under it (a job named `release` is not a trigger). */
function onBlock(text: string): string {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex(line => /^(?:on|"on"|'on'|true):/.test(line));
	if (start < 0) return "";
	const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && !line.startsWith("#"));
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** One workflow file as release facts; null when it neither publishes nor deploys nor is named for it. */
export function readWorkflow(file: string, text: string, defaultBranch: string): ReleaseWorkflow | null {
	let publishes = [...new Set(PUBLISHERS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label))];
	// Packaging alone (a CI build of the app) publishes nothing.
	if (publishes.length === 1 && publishes[0] === "electron-builder") publishes = [];
	const deploys = [...new Set(DEPLOYERS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label))];
	if (publishes.length === 0 && deploys.length === 0 && !/release|publish|deploy|pages/i.test(file)) return null;
	const on = onBlock(text);
	const inlineOn = /^\S+:\s*(.*)$/m.exec(on)?.[1]?.trim() ?? "";
	const push = /^\s{1,4}push:/m.test(on) || /\bpush\b/.test(inlineOn);
	const tagPatterns = yamlList(on, "tags");
	const branches = yamlList(on, "branches");
	const paths = yamlList(on, "paths") ?? [];
	const onTag = push && tagPatterns !== null;
	// A push with only a tag filter never runs for a branch push.
	const branchPush = push && !(onTag && branches === null);
	const onDefaultPush =
		branchPush &&
		(branches === null || branches.some(name => name === defaultBranch || name === "**" || name === "*"));
	const dispatch = /\bworkflow_dispatch\b/.test(on);
	const onReleaseEvent = /^\s{1,4}release:/m.test(on) || /\brelease\b/.test(inlineOn);
	const triggers: string[] = [];
	if (onDefaultPush)
		triggers.push(`a push to ${defaultBranch}${paths.length > 0 ? ` changing ${paths.join(", ")}` : ""}`);
	if (onTag) triggers.push(`a pushed tag ${tagPatterns.join(", ") || "(any)"}`);
	if (onReleaseEvent) triggers.push("a published GitHub release");
	if (dispatch) triggers.push("manual dispatch");
	const secrets = [...new Set([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(match => match[1] ?? ""))]
		.filter(name => name && name !== "GITHUB_TOKEN")
		.slice(0, 8);
	return { file, triggers, onDefaultPush, onTag, dispatch, onReleaseEvent, paths, publishes, deploys, secrets };
}

function isoDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

async function defaultBranchOf(root: string, io: GuideIo): Promise<string> {
	const head = (await io.exec("git", ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], root))?.trim();
	if (head) return head.replace(/^[^/]+\//, "");
	for (const name of ["main", "master"]) {
		if ((await io.exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${name}`], root)) !== null) return name;
	}
	return (await io.exec("git", ["symbolic-ref", "--short", "-q", "HEAD"], root))?.trim() || "main";
}

async function tagFacts(root: string, io: GuideIo, now: number): Promise<ReleaseFacts["tags"]> {
	const listing = await io.exec(
		"git",
		[
			"for-each-ref",
			"--sort=-creatordate",
			"--count=500",
			"--format=%(refname:short)%09%(creatordate:unix)",
			"refs/tags",
		],
		root,
	);
	const tags = (listing ?? "")
		.split("\n")
		.map(line => {
			const [name = "", seconds = ""] = line.split("\t");
			return { name: name.trim(), at: Number(seconds) * 1000 };
		})
		.filter(tag => VERSION_TAG.test(tag.name) && Number.isFinite(tag.at) && tag.at > 0);
	const latest = tags[0];
	if (!latest) return { total: 0, last90: 0 };
	const recent = tags.slice(0, 10).map(tag => tag.at);
	const gaps = recent
		.slice(1)
		.map((at, index) => ((recent[index] ?? at) - at) / DAY_MS)
		.sort((a, b) => a - b);
	const median = gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)] : undefined;
	const subject = (await io.exec("git", ["log", "-1", "--format=%s", latest.name], root))?.trim();
	return {
		total: tags.length,
		last90: tags.filter(tag => now - tag.at <= WINDOW_DAYS * DAY_MS).length,
		...(median !== undefined ? { medianGapDays: Math.max(1, Math.round(median)) } : {}),
		latest: { name: latest.name, date: isoDay(latest.at), ...(subject ? { subject } : {}) },
	};
}

async function githubReleases(root: string, io: GuideIo, now: number): Promise<ReleaseFacts["githubReleases"]> {
	const remote = await io.exec("git", ["remote", "get-url", "origin"], root);
	if (!remote || !/github\.com[:/]/.test(remote)) return null;
	const listing = await io.exec(
		"gh",
		["release", "list", "--limit", "100", "--json", "tagName,publishedAt,isDraft"],
		root,
	);
	if (listing === null) return null;
	let rows: unknown;
	try {
		rows = JSON.parse(listing);
	} catch {
		return null;
	}
	if (!Array.isArray(rows)) return null;
	const releases = (rows as unknown[])
		.map(row => (typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {}))
		.filter(row => row.isDraft !== true && typeof row.tagName === "string" && typeof row.publishedAt === "string")
		.map(row => ({ tag: String(row.tagName), at: Date.parse(String(row.publishedAt)) }))
		.filter(row => Number.isFinite(row.at))
		.sort((a, b) => b.at - a.at);
	const latest = releases[0];
	return {
		last90: releases.filter(row => now - row.at <= WINDOW_DAYS * DAY_MS).length,
		...(latest ? { latest: { tag: latest.tag, date: isoDay(latest.at) } } : {}),
	};
}

async function manifestFacts(root: string, io: GuideIo): Promise<Pick<ReleaseFacts, "manifests" | "publishScripts">> {
	const manifests: ReleaseFacts["manifests"] = [];
	const publishScripts: string[] = [];
	const pkg = parsedObject(await io.read(join(root, "package.json"), 64 * 1024));
	if (Object.keys(pkg).length > 0) {
		manifests.push({
			file: "package.json",
			...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
			...(pkg.private === true ? { private: true } : {}),
		});
		const scripts = parsedObject(JSON.stringify(pkg.scripts ?? {}));
		for (const [name, value] of Object.entries(scripts)) {
			if (typeof value !== "string") continue;
			if (/^(release|publish|deploy)(:|$)/.test(name) || PUBLISH_SCRIPT.test(value)) {
				publishScripts.push(
					`package.json scripts.${name}: ${value.length > 120 ? `${value.slice(0, 120)}...` : value}`,
				);
			}
		}
	}
	const cargo = await io.read(join(root, "Cargo.toml"), 32 * 1024);
	const cargoVersion = cargo ? /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(cargo)?.[1] : undefined;
	if (cargo !== null && /^\[package\]/m.test(cargo)) {
		manifests.push({
			file: "Cargo.toml",
			...(cargoVersion ? { version: cargoVersion } : {}),
			...(/^publish\s*=\s*false/m.test(cargo) ? { private: true } : {}),
		});
	}
	const pyproject = await io.read(join(root, "pyproject.toml"), 32 * 1024);
	if (pyproject !== null) {
		const version = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
		manifests.push({ file: "pyproject.toml", ...(version ? { version } : {}) });
	}
	if ((await io.read(join(root, "go.mod"), 1)) !== null) manifests.push({ file: "go.mod" });
	const makefile = await io.read(join(root, "Makefile"), 16 * 1024);
	for (const target of ["release", "publish", "deploy"]) {
		if (makefile && new RegExp(`^${target}:`, "m").test(makefile)) publishScripts.push(`Makefile: make ${target}`);
	}
	for (const config of [".goreleaser.yml", ".goreleaser.yaml"]) {
		if ((await io.read(join(root, config), 1)) !== null) publishScripts.push(`${config}: goreleaser`);
	}
	return { manifests, publishScripts: publishScripts.slice(0, 6) };
}

async function changelogFacts(root: string, io: GuideIo): Promise<ReleaseFacts["changelog"]> {
	for (const file of ["CHANGELOG.md", "CHANGES.md", "HISTORY.md", "NEWS.md"]) {
		const text = await io.read(join(root, file), 16 * 1024);
		if (text === null) continue;
		const heads = [...text.matchAll(/^##?\s+(.+)$/gm)].map(match => (match[0] ?? "").trim());
		const versioned = heads.find(head => /\d+\.\d+/.test(head) && !/^#\s/.test(head));
		const style =
			versioned && /^##\s+\[\d/.test(versioned) ? "keep-a-changelog" : versioned ? "versioned" : "unversioned";
		return { file, style, ...(versioned ? { latest: versioned } : {}) };
	}
	return null;
}

/** Everything the release rules read, from the repository at `root`. Never throws. */
export async function collectReleaseFacts(
	root: string,
	io: GuideIo,
	options: { now?: number; checks?: string[] } = {},
): Promise<ReleaseFacts> {
	const now = options.now ?? Date.now();
	const defaultBranch = await defaultBranchOf(root, io);
	const workflows: ReleaseWorkflow[] = [];
	const names = (await io.list(join(root, WORKFLOW_DIR)))
		.filter(name => /\.ya?ml$/i.test(name))
		.sort()
		.slice(0, MAX_WORKFLOWS);
	for (const name of names) {
		const text = await io.read(join(root, WORKFLOW_DIR, name), WORKFLOW_BYTES);
		const workflow = text === null ? null : readWorkflow(`${WORKFLOW_DIR}/${name}`, text, defaultBranch);
		if (workflow) workflows.push(workflow);
	}
	const deployConfigs: string[] = [];
	for (const [file, host] of DEPLOY_CONFIGS) {
		if ((await io.read(join(root, file), 1)) !== null) deployConfigs.push(`${file} (${host})`);
	}
	const subjects = ((await io.exec("git", ["log", "-n30", "--format=%s"], root)) ?? "")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	const conventional =
		subjects.length > 0 && subjects.filter(line => CONVENTIONAL.test(line)).length * 2 > subjects.length;
	return {
		defaultBranch,
		workflows,
		...(await manifestFacts(root, io)),
		changelog: await changelogFacts(root, io),
		tags: await tagFacts(root, io, now),
		githubReleases: await githubReleases(root, io, now),
		deployConfigs,
		conventional,
		checks: options.checks ?? [],
	};
}

/**
 * What landed on the release target since its last release: the commits of `<remote>/<branch>` (fetched first, with
 * its tags; the last fetched refs when the remote does not answer) after the newest `v*` tag reachable from it, oldest
 * first. The target, never the run's own HEAD: an unlanded run branch has nothing on it to release, and a release
 * made from another checkout is a tag on the remote, so its commits are not counted again. Undefined when neither
 * the remote's nor a local branch of that name exists.
 */
export async function unreleasedOnTarget(
	root: string,
	io: Pick<GuideIo, "exec">,
	remote: string,
	branch: string,
): Promise<{ target: string; tag?: string; commits: UnreleasedCommit[] } | undefined> {
	await io.exec("git", ["fetch", "--quiet", "--tags", remote, branch], root);
	const target = (
		await Promise.all(
			[`refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`].map(async ref =>
				(await io.exec("git", ["rev-parse", "--verify", "--quiet", ref], root)) === null ? null : ref,
			),
		)
	).find(ref => ref !== null);
	if (!target) return undefined;
	const tag = (await io.exec("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", target], root))?.trim();
	const range = tag ? [`${tag}..${target}`] : ["-n", "200", target];
	const out = await io.exec("git", ["log", "--no-merges", "--reverse", "--format=%ct%x09%s", ...range], root);
	const commits = (out ?? "").split("\n").flatMap(line => {
		const tab = line.indexOf("\t");
		const at = Number(line.slice(0, tab)) * 1000;
		return tab > 0 && Number.isFinite(at) ? [{ at, subject: line.slice(tab + 1) }] : [];
	});
	return { target, ...(tag ? { tag } : {}), commits };
}
