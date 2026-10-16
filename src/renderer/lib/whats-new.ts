/**
 * "What's new" after an update: the bundled CHANGELOG.md section of the
 * version now running, shown once. Prefs `whatsNewSeenVersion` holds the last
 * version whose notes were shown (or recorded without showing). It is written
 * only once the notice is on screen, so a launch that ends before then shows
 * it again next time.
 */

export const WHATS_NEW_PREF = "whatsNewSeenVersion";

/**
 * A release section is Korean first; its English summary follows a line holding only this marker
 * (release.yml turns the marker into a rule for the GitHub notes). A release with no marker has no English.
 */
export const ENGLISH_MARKER = "<!-- en -->";

/** The part of one section body in `lang`; English falls back to the Korean text when there is none. */
function pick(body: string, lang: string): string {
	const lines = body.split("\n");
	const split = lines.findIndex(line => line.trim() === ENGLISH_MARKER);
	if (split < 0) return body.trim();
	const part = lang === "en" ? lines.slice(split + 1) : lines.slice(0, split);
	return part.join("\n").trim() || lines.slice(0, split).join("\n").trim();
}

/** One release's notes in `lang`, without its `## [X.Y.Z]` heading; null when it has none. */
export function changelogSection(markdown: string, version: string, lang = "ko"): string | null {
	const lines = markdown.split("\n");
	const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
	if (start < 0) return null;
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const body = pick(lines.slice(start + 1, end < 0 ? undefined : end).join("\n"), lang);
	return body || null;
}

/** The whole changelog (without its `# Changelog` title) with every release in `lang`. */
export function changelogReleases(markdown: string, lang = "ko"): string {
	const parts = markdown.replace(/^# [^\n]*\n+/, "").split(/^(?=## \[)/m);
	return parts
		.map(part => {
			const newline = part.indexOf("\n");
			if (!part.startsWith("## [") || newline < 0) return part;
			return `${part.slice(0, newline)}\n\n${pick(part.slice(newline + 1), lang)}\n\n`;
		})
		.join("")
		.trim();
}

/**
 * - `show`: an update to a version with notes the user has not seen.
 * - `record`: remember the version without a notice: the first launch (a new
 *   install is not an update), or a release without notes.
 * - `none`: already seen.
 */
export function whatsNewAction(seen: unknown, current: string, hasNotes: boolean): "show" | "record" | "none" {
	if (seen === current) return "none";
	if (typeof seen !== "string" || !hasNotes) return "record";
	return "show";
}
