/**
 * The bot's Library (Duet's Make tab, Grok's and Muse's Library): what its work produced, collected from what the
 * window already holds, each with where it came from. Pure. Sources:
 * - the sessions it opened: a branch with its commits and files (`diff`), and the report it finished with;
 * - its own replies and its sessions' reports: the files they name (`referencedFiles`, the rule the cards under a reply
 *   use; a session's report only by absolute path, as its relative ones are its own worktree's) and the GitHub pull
 *   requests, issues, releases and commits they link;
 * - its own write and edit calls: a file it named and wrote again later reads "Updated HH:MM".
 * Pinned items (the desk's `libraryPins`) come first, then the newest.
 */
import type { OpenedChildRow } from "../layout/work-board/opened-children";
import { type ChatFileReference, referencedFiles } from "../tools/media/chat-media";

export type LibrarySource = { kind: "reply"; at: number } | { kind: "session"; title: string; row: OpenedChildRow };

export type LibraryItem = { key: string; pinned: boolean; at: number } & (
	| { kind: "branch"; row: OpenedChildRow }
	| { kind: "report"; row: OpenedChildRow; text: string }
	| { kind: "link"; url: string; link: GitHubLink; source: LibrarySource }
	| { kind: "file"; path: string; fileKind: ChatFileReference["kind"]; source: LibrarySource; updated?: number }
);

export interface GitHubLink {
	repo: string;
	type: "pull" | "issue" | "release" | "commit";
	/** The number, tag or short sha. */
	ref: string;
}

const GITHUB = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues|releases\/tag|commit)\/([\w.\-+]+)/g;

/** The GitHub pull requests, issues, releases and commits `text` links, in order, each once. */
export function githubLinks(text: string): { url: string; link: GitHubLink }[] {
	const seen = new Set<string>();
	const links: { url: string; link: GitHubLink }[] = [];
	for (const match of text.matchAll(GITHUB)) {
		// A sentence that ends on the link puts its period after it: a tag may hold dots, never end on one.
		const [whole = "", repo = "", kind = "", rawRef = ""] = match;
		const ref = rawRef.replace(/[.]+$/, "");
		const url = whole.slice(0, whole.length - (rawRef.length - ref.length));
		if (seen.has(url)) continue;
		seen.add(url);
		const type = kind === "pull" ? "pull" : kind === "issues" ? "issue" : kind === "commit" ? "commit" : "release";
		links.push({ url, link: { repo, type, ref: type === "commit" ? ref.slice(0, 7) : ref } });
	}
	return links;
}

function isAbsolute(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** `a/b.md` and `./a/b.md` and the absolute path ending in either are one file for "Updated". */
function samePath(a: string, b: string): boolean {
	const clean = (path: string) => path.replace(/^(?:\.[\\/])+/, "").replaceAll("\\", "/");
	const x = clean(a);
	const y = clean(b);
	return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

export function botLibrary(input: {
	rows: readonly OpenedChildRow[];
	/** The bot's own replies' text, with when each came. */
	replies: readonly { text: string; at: number }[];
	/** The files the bot's own write and edit calls changed, with when each ended. */
	writes: readonly { path: string; at: number }[];
	pins: readonly string[];
}): LibraryItem[] {
	const { rows, replies, writes, pins } = input;
	const pinned = new Set(pins);
	const items = new Map<string, LibraryItem>();
	const add = (item: LibraryItem) => {
		if (!items.has(item.key)) items.set(item.key, item);
	};
	const mentions = (text: string, source: LibrarySource, at: number, absoluteOnly: boolean) => {
		for (const { url, link } of githubLinks(text))
			add({ key: url, pinned: pinned.has(url), at, kind: "link", url, link, source });
		for (const reference of referencedFiles(text)) {
			if (absoluteOnly && !isAbsolute(reference.path)) continue;
			const key = `file:${reference.path}`;
			add({
				key,
				pinned: pinned.has(key),
				at,
				kind: "file",
				path: reference.path,
				fileKind: reference.kind,
				source,
			});
		}
	};
	// Newest replies first, so an item keeps the time it was last named.
	for (const reply of replies.toSorted((a, b) => b.at - a.at))
		mentions(reply.text, { kind: "reply", at: reply.at }, reply.at, false);
	for (const row of rows) {
		const at = row.at ?? 0;
		const sessionKey = row.sessionPath ?? row.key;
		if (row.branch && (row.diff || row.merge)) {
			const key = `branch:${sessionKey}`;
			add({ key, pinned: pinned.has(key), at, kind: "branch", row });
		}
		const text = row.report?.text.trim();
		if (text && (row.report?.kind === "done" || row.report?.kind === "review")) {
			const key = `report:${sessionKey}`;
			add({ key, pinned: pinned.has(key), at, kind: "report", row, text });
			mentions(text, { kind: "session", title: row.title, row }, at, true);
		}
	}
	return [...items.values()]
		.map(item => {
			if (item.kind !== "file") return item;
			const later = writes.filter(write => write.at > item.at && samePath(write.path, item.path));
			return later.length > 0 ? { ...item, updated: Math.max(...later.map(write => write.at)) } : item;
		})
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at);
}
