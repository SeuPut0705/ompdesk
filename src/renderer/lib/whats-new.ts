/**
 * "What's new" after an update: the bundled CHANGELOG.md section of the
 * version now running, shown once. Prefs `whatsNewSeenVersion` holds the last
 * version whose notes were shown (or recorded without showing). It is written
 * only once the notice is on screen, so a launch that ends before then shows
 * it again next time.
 */

export const WHATS_NEW_PREF = "whatsNewSeenVersion";

/** One release's notes from the changelog, without its `## [X.Y.Z]` heading; null when it has none. */
export function changelogSection(markdown: string, version: string): string | null {
	const lines = markdown.split("\n");
	const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
	if (start < 0) return null;
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const body = lines
		.slice(start + 1, end < 0 ? undefined : end)
		.join("\n")
		.trim();
	return body || null;
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
