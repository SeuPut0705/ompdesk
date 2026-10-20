/**
 * Autopilot's own release rules for a project: what the repository's files say about releasing (`ReleaseFacts`,
 * gathered by `autopilot-release-facts.ts`), whether the project releases at all (`releaseVerdict`), the guide's
 * `## Release` section built from them (`releaseSectionTemplate`), and reading that section back (`guideRelease`),
 * which main's release detection uses when no rules file names a procedure. Pure: no I/O, imported by the bridge and
 * by main.
 *
 * The section is always built from the facts, never by a model: an unattended agent runs it as written, and a model's
 * plausible extra step can break a release (measured on a real repository: smol added pushing the version tag before a
 * workflow that skips the release when the tag already exists).
 *
 * A Release section starts with one marker line, `Releases: yes` or `Releases: no`. A section the app wrote always has
 * it; a person's own section without one counts as a procedure.
 */

/** Markdown section of a file: an ATX heading outside code fences up to the next heading of the same or a higher level. */
export interface MarkdownSection {
	title: string;
	level: number;
	body: string;
	/** Line index of the heading. */
	start: number;
	/** Line index past the section's last line. */
	end: number;
}

export function markdownSections(text: string): MarkdownSection[] {
	const lines = text.split(/\r?\n/);
	const heads: Array<{ title: string; level: number; at: number }> = [];
	let fence: string | null = null;
	lines.forEach((line, at) => {
		const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (mark) {
			if (fence === null) fence = mark[0] ?? "`";
			else if (mark[0] === fence) fence = null;
			return;
		}
		if (fence !== null) return;
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading?.[1] && heading[2]) heads.push({ title: heading[2].trim(), level: heading[1].length, at });
	});
	return heads.map((head, index) => {
		const end = heads.slice(index + 1).find(next => next.level <= head.level)?.at ?? lines.length;
		return {
			title: head.title,
			level: head.level,
			body: lines.slice(head.at + 1, end).join("\n"),
			start: head.at,
			end,
		};
	});
}

/** The guide's release heading (`## Release`); "Release cadence" and the like are not it. */
const GUIDE_RELEASE_TITLE = /^(release|releases|releasing|release procedure|release process|릴리스|릴리즈|배포)$/i;
const MARKER = /^\s*(?:[-*]\s*)?(?:\*\*)?releases:?(?:\*\*)?:?\s*(yes|no)\b/i;

export interface GuideRelease {
	title: string;
	/** `false` only for a section that says `Releases: no`. */
	releases: boolean;
	/** The section declares itself with a marker line. */
	marked: boolean;
}

/** The guide's Release section, or null when it has none. */
export function guideRelease(text: string): GuideRelease | null {
	const section = markdownSections(text).find(item => item.level <= 3 && GUIDE_RELEASE_TITLE.test(item.title));
	if (!section) return null;
	const first = section.body.split("\n").find(line => line.trim() !== "");
	const marker = first ? MARKER.exec(first)?.[1] : undefined;
	return { title: section.title, releases: marker?.toLowerCase() !== "no", marked: marker !== undefined };
}

/** `text` with its Release section replaced by `section` (appended when it has none). */
export function withReleaseSection(text: string, section: string): string {
	const lines = text.replace(/\s+$/, "").split(/\r?\n/);
	const found = markdownSections(text).find(item => item.level <= 3 && GUIDE_RELEASE_TITLE.test(item.title));
	const block = section.trim().split("\n");
	if (!found) return `${[...lines, "", ...block].join("\n")}\n`;
	const before = lines.slice(0, found.start);
	const after = lines.slice(found.end);
	return `${[...before, ...block, ...(after.length > 0 ? ["", ...after] : [])].join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Facts and the verdict
// ---------------------------------------------------------------------------------------------

export interface ReleaseWorkflow {
	/** `.github/workflows/release.yml` */
	file: string;
	/** What starts it, in words ("a push to main", "a pushed tag v*", "manual dispatch", "a published GitHub release"). */
	triggers: string[];
	onDefaultPush: boolean;
	onTag: boolean;
	dispatch: boolean;
	onReleaseEvent: boolean;
	/** The files a push to the default branch must change to start it (its `paths` filter); empty: any push. */
	paths: string[];
	/** What it publishes ("npm", "electron-builder", "GitHub release", ...). */
	publishes: string[];
	/** Where it deploys ("GitHub Pages", "Vercel", ...). */
	deploys: string[];
	/** Repository secrets it reads, GITHUB_TOKEN left out. */
	secrets: string[];
}

export interface ReleaseFacts {
	defaultBranch: string;
	workflows: ReleaseWorkflow[];
	/** Version-carrying manifests (`package.json` 1.2.3). */
	manifests: Array<{ file: string; version?: string; private?: boolean }>;
	/** Publish commands the repository runs locally (`package.json scripts.release: npm publish`). */
	publishScripts: string[];
	changelog: { file: string; style: "keep-a-changelog" | "versioned" | "unversioned"; latest?: string } | null;
	tags: {
		total: number;
		last90: number;
		/** Median days between the latest version tags (up to 10), when there are two or more. */
		medianGapDays?: number;
		latest?: { name: string; date: string; subject?: string };
	};
	githubReleases: { last90: number; latest?: { tag: string; date: string } } | null;
	/** Hosting configs whose Git integration deploys a push (`vercel.json (Vercel)`). */
	deployConfigs: string[];
	conventional: boolean;
	/** The repository's own check commands (the guide's "Done means"). */
	checks: string[];
}

export interface RulesProcedure {
	file: string;
	anchors: string[];
}

export type ReleaseVerdict =
	| { releases: false }
	| { releases: true; via: "rules"; procedure: RulesProcedure }
	| { releases: true; via: "workflow"; workflow: ReleaseWorkflow }
	| { releases: true; via: "deploy"; source: string }
	| { releases: true; via: "tag" };

/** Whether and how the project releases, read from the facts alone (a rules-file procedure wins). */
export function releaseVerdict(facts: ReleaseFacts, procedure?: RulesProcedure | null): ReleaseVerdict {
	if (procedure) return { releases: true, via: "rules", procedure };
	const publishing = facts.workflows.find(workflow => workflow.publishes.length > 0);
	if (publishing) return { releases: true, via: "workflow", workflow: publishing };
	const deploying = facts.workflows.find(workflow => workflow.deploys.length > 0);
	if (deploying)
		return { releases: true, via: "deploy", source: `${deploying.file} (${deploying.deploys.join(", ")})` };
	const config = facts.deployConfigs[0];
	if (config) return { releases: true, via: "deploy", source: config };
	if (facts.tags.total > 0 || (facts.githubReleases?.last90 ?? 0) > 0 || facts.publishScripts.length > 0) {
		return { releases: true, via: "tag" };
	}
	return { releases: false };
}

function versionOf(tag: string): string {
	return /v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)$/.exec(tag)?.[1] ?? tag;
}

/** The last release commit's subject with its version replaced by X.Y.Z, when it names the version. */
function releaseMessage(facts: ReleaseFacts): string | null {
	const latest = facts.tags.latest;
	if (!latest?.subject) return null;
	const version = versionOf(latest.name);
	return latest.subject.includes(version) ? latest.subject.replace(version, "X.Y.Z") : null;
}

function tagName(facts: ReleaseFacts): string {
	const latest = facts.tags.latest?.name;
	if (!latest) return "vX.Y.Z";
	return latest.replace(versionOf(latest), "X.Y.Z");
}

/** The history line of the cadence: how often the project has released (local tags can lag GitHub's releases). */
export function cadenceLine(facts: ReleaseFacts): string {
	const { tags, githubReleases } = facts;
	const count = Math.max(tags.last90, githubReleases?.last90 ?? 0);
	const released = githubReleases?.latest
		? { name: githubReleases.latest.tag, date: githubReleases.latest.date }
		: undefined;
	const latest = tags.latest && (!released || tags.latest.date >= released.date) ? tags.latest : released;
	if (!latest) return "No release yet: the first one comes when the project has something worth shipping.";
	const gap =
		tags.medianGapDays !== undefined
			? `, about every ${tags.medianGapDays} day${tags.medianGapDays === 1 ? "" : "s"}`
			: "";
	return `${count} release${count === 1 ? "" : "s"} in the last 90 days${gap}; the latest is ${latest.name} on ${latest.date}.`;
}

/** Where the version is bumped: the manifests that carry one, and the files a publishing workflow's push must change. */
function versionFiles(facts: ReleaseFacts, verdict: Exclude<ReleaseVerdict, { releases: false }>): string[] {
	const fromPaths =
		verdict.via === "workflow" && verdict.workflow.onDefaultPush
			? verdict.workflow.paths.filter(file => !/[*?[\]{}!]/.test(file) && file !== facts.changelog?.file)
			: [];
	return [
		...new Set([
			...facts.manifests.filter(manifest => manifest.version).map(manifest => manifest.file),
			...fromPaths,
		]),
	];
}

function versionStep(facts: ReleaseFacts, files: string[]): string {
	const rule = facts.conventional
		? "a `feat` since the last release makes it minor, only `fix`/`perf` makes it patch, a `!` or `BREAKING CHANGE` makes it major"
		: "new features make it minor, fixes only make it patch, a breaking change makes it major";
	const where =
		files.length > 0
			? `; bump the version in ${files.map(file => `\`${file}\``).join(", ")}`
			: `; the version lives in the tag \`${tagName(facts)}\``;
	return `Version: read the commits since the last release: ${rule}${where}.`;
}

function changelogStep(facts: ReleaseFacts): string {
	const log = facts.changelog;
	if (!log) return "Changelog: none in the repository; the release commit's message lists the user-visible changes.";
	const shape =
		log.style === "keep-a-changelog"
			? "`## [X.Y.Z] - YYYY-MM-DD`"
			: log.style === "versioned" && log.latest
				? `\`${log.latest.replace(/\d+\.\d+(?:\.\d+)?/, "X.Y.Z")}\``
				: "a section for the new version";
	return `Changelog: add ${shape} on top of \`${log.file}\`, covering every user-visible change since the last release.`;
}

function checksStep(facts: ReleaseFacts): string {
	return facts.checks.length > 0
		? `Before releasing: ${facts.checks.map(command => `\`${command}\``).join(", ")} pass on the commit being released.`
		: "Before releasing: the project's tests and build pass on the commit being released.";
}

function commitStep(facts: ReleaseFacts, versioned: string[]): string {
	const message = releaseMessage(facts);
	const files = [...versioned, ...(facts.changelog ? [facts.changelog.file] : [])];
	const scope =
		files.length > 0 ? `touches only ${files.map(file => `\`${file}\``).join(" and ")}` : "holds only the release";
	return `Commit: one release commit that ${scope}${message ? `, message \`${message}\` like the last release` : ""}.`;
}

function publishStep(facts: ReleaseFacts, verdict: Exclude<ReleaseVerdict, { releases: false }>): string {
	const branch = facts.defaultBranch;
	const push = `\`git push origin HEAD:${branch}\` (fast-forward only)`;
	const tag = `\`git tag ${tagName(facts)}\` on the release commit and \`git push origin ${tagName(facts)}\``;
	if (verdict.via === "deploy")
		return `Publish: a push to \`${branch}\` deploys (${verdict.source}); release with ${push}.`;
	if (verdict.via === "workflow") {
		const workflow = verdict.workflow;
		const secrets =
			workflow.secrets.length > 0 ? ` It reads the repository secrets ${workflow.secrets.join(", ")}.` : "";
		const what = `\`${workflow.file}\` publishes (${workflow.publishes.join(", ")}).${secrets}`;
		if (workflow.onDefaultPush) {
			const paths =
				workflow.paths.length > 0
					? ` (it runs only when the push changes ${workflow.paths.map(file => `\`${file}\``).join(" or ")})`
					: "";
			return `Publish: push the release commit with ${push}${paths}; ${what}`;
		}
		if (workflow.onTag) return `Publish: push the release commit with ${push}, then ${tag}; ${what}`;
		if (workflow.dispatch)
			return `Publish: push the release commit with ${push}, then \`gh workflow run ${workflow.file.split("/").pop()}\`; ${what}`;
		return `Publish: push the release commit with ${push}, then ${tag}. ${what.replace(/\.$/, "")} once a maintainer publishes the GitHub release: Autopilot never creates one.`;
	}
	const local =
		facts.publishScripts.length > 0
			? ` Publishing itself (${facts.publishScripts.join("; ")}) is the maintainer's: Autopilot never runs a publish command.`
			: "";
	return `Publish: push the release commit with ${push}, then ${tag}.${local}`;
}

/** The guide's `## Release` section, built from the facts alone. */
export function releaseSectionTemplate(facts: ReleaseFacts, verdict: ReleaseVerdict): string {
	if (!verdict.releases) {
		return [
			"## Release",
			"",
			"Releases: no",
			"- No version tags, publishing workflow, publish script or deploy configuration were found: this project does not release. Autopilot commits and pushes its own branch only.",
			"- To have Autopilot release, replace this section with the procedure (or describe it in AGENTS.md).",
			"",
		].join("\n");
	}
	const cadence = [
		"### Cadence",
		`- ${cadenceLine(facts)}`,
		"- Release when user-visible fixes or features have gathered, at about that rhythm; a defect that breaks the released product ships at once, on its own. Docs-only or internal changes wait for the next release.",
	];
	if (verdict.via === "rules") {
		return [
			"## Release",
			"",
			"Releases: yes",
			`- Follow \`${verdict.procedure.file}\` › ${verdict.procedure.anchors.join(" › ")} as written: it is the procedure and wins over this section.`,
			"- A failed release run is reported in the cycle and fixed in the next one; never forced.",
			"",
			...cadence,
			"",
		].join("\n");
	}
	const versioned = versionFiles(facts, verdict);
	const steps =
		verdict.via === "deploy" && facts.tags.total === 0
			? [checksStep(facts), publishStep(facts, verdict)]
			: [
					versionStep(facts, versioned),
					changelogStep(facts),
					checksStep(facts),
					commitStep(facts, versioned),
					publishStep(facts, verdict),
				];
	return [
		"## Release",
		"",
		"Releases: yes",
		"Drafted by OMPdesk from the repository's files; the rules files win where they differ.",
		"",
		"### Procedure",
		...steps.map((step, index) => `${index + 1}. ${step}`),
		`${steps.length + 1}. Watch: follow the run it starts to the end (\`gh run watch\`). A failed run is reported in the cycle and fixed in the next one; never forced, never published by hand.`,
		"",
		...cadence,
		"",
	].join("\n");
}
