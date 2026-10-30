/**
 * "What's new" after an update: a quiet card (WhatsNewCard) over the composer's corner offers the bundled
 * CHANGELOG.md notes of the version now running, once. Prefs `whatsNewSeenVersion` holds the last version
 * whose card was shown (or recorded without showing). It is written once the card is on screen, so a launch
 * that ends before then shows it again next time. Skipped versions fold into one card for the newest, and
 * its details list every release since the last seen one.
 */

import { useEffect, useState } from "react";

let changelog: string | null = null;
let loading: Promise<string> | null = null;

/**
 * The bundled CHANGELOG.md (~130 KB), in its own chunk: only the update decision, the card and the changelog
 * window read it, so it stays out of the first screen's main chunk. One import per page; a failed one is
 * tried again on the next call.
 */
export function loadChangelog(): Promise<string> {
	loading ??= import("../../../CHANGELOG.md?raw").then(
		module => (changelog = module.default),
		(error: unknown) => {
			loading = null;
			throw error;
		},
	);
	return loading;
}

/** The changelog markdown once loaded (at once when it already is), loading it while `enabled`; null until then. */
export function useChangelog(enabled = true): string | null {
	const [loaded, setLoaded] = useState(changelog);
	const markdown = loaded ?? changelog;
	useEffect(() => {
		if (!enabled || markdown !== null) return;
		let live = true;
		loadChangelog().then(
			text => {
				if (live) setLoaded(text);
			},
			() => {
				// Nothing to show; the next open asks again.
			},
		);
		return () => {
			live = false;
		};
	}, [enabled, markdown]);
	return markdown;
}

/** Compare dotted numeric versions ("0.33.0" vs "0.32.2"); a missing or non-numeric part counts as 0. */
function compareVersions(a: string, b: string): number {
	const left = a.split(".").map(part => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map(part => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

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
 * The notes of every release after `seen` up to and including `current`, in `lang`. One release reads as
 * its bare notes; several (skipped updates) keep their `## [X.Y.Z]` headings, newest first. A `seen` that is
 * not older than `current` (a downgrade) or has no releases in between falls back to `current`'s own notes.
 */
export function changelogSince(markdown: string, seen: string | null, current: string, lang = "ko"): string | null {
	const versions = [...markdown.matchAll(/^## \[([^\]]+)\]/gm)]
		.map(match => match[1] ?? "")
		.filter(version => seen !== null && compareVersions(version, seen) > 0 && compareVersions(version, current) <= 0);
	if (versions.length <= 1) return changelogSection(markdown, current, lang);
	const lines = markdown.split("\n");
	return versions
		.map(version => {
			const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
			const body = changelogSection(markdown, version, lang);
			return body ? `${lines[start]}\n\n${body}` : null;
		})
		.filter(part => part !== null)
		.join("\n\n");
}

/**
 * The window's markdown with each file heading `## [0.85.1] - 2026-10-30` shown as `## 0.85.1 · Oct 30, 2026`
 * (the date in `lang`): the file's own bracket-and-dash header reads as markup to a person. The file is not rewritten.
 */
export function displayReleaseHeadings(markdown: string, lang = "ko"): string {
	const format = new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" });
	return markdown.replace(/^## \[([^\]]+)\](?: - (.+?))?[ \t]*$/gm, (_heading, version: string, rest?: string) => {
		if (!rest) return `## ${version}`;
		const day = /^\d{4}-\d{2}-\d{2}$/.test(rest) ? new Date(`${rest}T00:00:00Z`) : null;
		return `## ${version} · ${day && !Number.isNaN(day.getTime()) ? format.format(day) : rest}`;
	});
}

/**
 * The one-line summary of a release's notes: its first paragraph (what the card shows), as plain text.
 * A section that opens with a list takes its first item.
 */
export function changelogSummary(notes: string): string {
	const block = notes.split(/\n\s*\n/).find(part => part.trim() !== "" && !part.trimStart().startsWith("#")) ?? "";
	const lines = block
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	const list = /^[-*]\s+/.test(lines[0] ?? "");
	return (list ? lines.slice(0, 1) : lines)
		.join(" ")
		.replace(/^[-*]\s+/, "")
		.replace(/\*\*|`/g, "")
		.trim();
}

/**
 * Whether a version's last digit is read with a final consonant (0 영, 3 삼, 6 육), so Korean takes "으로"
 * after it and "로" otherwise; picks `whatsNew.cardTitle` over `whatsNew.cardTitleRo`.
 */
export function endsWithFinalConsonant(version: string): boolean {
	return /[036]$/.test(version);
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
