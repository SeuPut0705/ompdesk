import { AUTOPILOT_AREAS, type AutopilotCycleRecord } from "../../resources/gui-bridge/modes/autopilot-contracts";

/**
 * The autopilot log as Markdown: the Autopilot screen's "Copy as Markdown" and the body main gives the draft pull
 * request. Pure and dependency-free so both sides format one way. English: the log leaves the app (a PR, a clipboard).
 */

const SHORT_SHA = 7;
const SUMMARY_MAX = 400;

const SECTION_ORDER = [...AUTOPILOT_AREAS, "user", "release", "unreported"] as const;
type Section = (typeof SECTION_ORDER)[number];

const SECTION_TITLE: Record<Section, string> = {
	design: "Design",
	performance: "Performance",
	features: "Features",
	refactoring: "Refactoring",
	tests: "Tests",
	bugs: "Bugs",
	docs: "Docs",
	user: "Your requests",
	release: "Release",
	unreported: "Unreported",
};

export function autopilotLogTitle(branch: string, cycles: number): string {
	return `${branch}: ${cycles} ${cycles === 1 ? "cycle" : "cycles"}`;
}

function short(sha: string): string {
	return sha.slice(0, SHORT_SHA);
}

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

function cycleLines(cycle: AutopilotCycleRecord): string[] {
	const verify = cycle.verify === "unreported" ? "no report" : cycle.verify;
	const parts = [`**#${cycle.n}** ${cycle.title.trim() || "(untitled)"} — ${verify}`];
	if (cycle.commit) parts.push(`\`${short(cycle.commit)}\``);
	if (cycle.reverted) parts.push("reverted");
	const lines = [`- ${parts.join(" · ")}`];
	if (cycle.summary.trim()) lines.push(`  ${clip(cycle.summary)}`);
	for (const followup of cycle.followups) lines.push(`  - Follow-up: ${followup}`);
	for (const child of cycle.children) {
		lines.push(`  - Child \`${child.branch}\`: ${child.outcome}${child.sha ? ` \`${short(child.sha)}\`` : ""}`);
	}
	if (cycle.ship)
		lines.push(`  - Released ${cycle.ship.version}${cycle.ship.runUrl ? ` (${cycle.ship.runUrl})` : ""}`);
	return lines;
}

/** The log of `cycles` (any order): a count line, one section per area (newest cycle first), then every open follow-up once. */
export function formatAutopilotLog(input: { branch: string; cycles: readonly AutopilotCycleRecord[] }): string {
	const { branch, cycles } = input;
	const commits = cycles.filter(cycle => cycle.commit).length;
	const red = cycles.filter(cycle => cycle.verify === "red").length;
	const out = [
		`# ${autopilotLogTitle(branch, cycles.length)}`,
		"",
		`${cycles.length} ${cycles.length === 1 ? "cycle" : "cycles"} · ${commits} ${commits === 1 ? "commit" : "commits"} · ${red} red`,
	];
	for (const section of SECTION_ORDER) {
		const inSection = cycles.filter(cycle => cycle.area === section).sort((a, b) => b.n - a.n);
		if (inSection.length === 0) continue;
		out.push("", `## ${SECTION_TITLE[section]}`, ...inSection.flatMap(cycleLines));
	}
	const followups = [...new Set(cycles.flatMap(cycle => cycle.followups))];
	if (followups.length > 0) out.push("", "## Open follow-ups", ...followups.map(followup => `- ${followup}`));
	return `${out.join("\n")}\n`;
}
