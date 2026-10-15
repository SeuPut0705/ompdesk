/**
 * Bare file-path mentions in replies ("see src/app.ts:42", `retry.mjs` (line
 * 269), "output/ 폴더에", "269번 줄") become path links, so a reply that never
 * wrote a markdown link still opens the file. The grammar is adapted from
 * Mixdog's `markdown-plugins.ts` (Apache-2.0, see NOTICE): a path with folders
 * anywhere in prose, a bare file name with a known extension or name inside
 * inline code only, a folder with a trailing separator, and a trailing line
 * reference. Existing links, code blocks and math stay untouched.
 *
 * Runs after sanitize: the `<a data-path>` it creates is renderer-owned and has
 * no href, so nothing navigates before `PathMentionLink` (lib/markdown.tsx) has
 * checked that the path exists for the tab.
 */
import type { Element, ElementContent, Root, Text } from "hast";

const SEGMENT = "[\\p{L}\\p{N}_.@+-]+";
const PATH_PREFIX = "(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|~[\\\\/]|[\\\\/](?![\\\\/]))";
const EXTENSION = "\\.[A-Za-z][A-Za-z0-9]{0,11}";
const LOCATION =
	"(?::(?<line>\\d+)(?::(?<column>\\d+))?(?:-\\d+)?" +
	"|#L(?<hashLine>\\d+)(?:C(?<hashColumn>\\d+))?(?:-L?\\d+(?:C\\d+)?)?)?";
/**
 * Prose: a file needs an extension plus a folder or a `./` `../` `~/` `/` `X:\`
 * prefix; a folder needs a trailing separator and must end the word, because
 * "입력/출력" is a slash in running text, not a folder.
 */
const PROSE_PATH = new RegExp(
	"(?<![\\p{L}\\p{N}_./\\\\:@-])(?:" +
		`(?<file>(?:${PATH_PREFIX}(?:${SEGMENT}[\\\\/])*|(?:${SEGMENT}[\\\\/])+)(?:${SEGMENT})?${EXTENSION})` +
		`${LOCATION}(?![A-Za-z0-9_/\\\\])` +
		`|(?<folder>${PATH_PREFIX}?(?:${SEGMENT}[\\\\/])+)(?![\\p{L}\\p{N}_/\\\\]))`,
	"gu",
);
const CODE_LOCATION = new RegExp(`^(?<path>[\\s\\S]*?)${LOCATION}$`, "u");
/**
 * Line references that trail a mention: `src/a.ts`:42, "(line 269, col 5)",
 * "(269줄)", "269번 줄". A bare "12줄" is a line count, so the unparenthesised
 * Korean form needs 번/번째.
 */
const TRAILING_LOCATIONS = [
	/^:(?<line>\d+)(?::(?<column>\d+))?(?:-\d+)?(?![\p{L}\p{N}])/u,
	/^\s*\((?:line|ln|l)\.?\s*(?<line>\d+)(?:\s*[,:]\s*(?:col(?:umn)?\.?\s*)?(?<column>\d+))?\)/iu,
	/^\s*\(\s*(?<line>\d+)\s*(?:번째|번)?\s*(?:줄|행)\s*\)/u,
	/^\s+(?<line>\d+)\s*(?:번째|번)\s*(?:줄|행)(?![\p{L}\p{N}])/u,
];
/** A bare name (no folder) is a file only when its extension says so; "node.js" in prose never links. */
const BARE_FILE_EXTENSIONS = new Set(
	(
		"mjs cjs js jsx ts tsx mts cts py rs go java kt kts swift c cc cpp cxx h hh hpp cs rb php sh bash zsh ps1 bat cmd " +
		"md markdown mdx json jsonl yaml yml toml xml css scss sass less html htm vue svelte sql txt log csv tsv env ini " +
		"cfg conf lock pdf pptx docx xlsx doc ppt xls rtf odt ods odp png jpg jpeg gif webp svg bmp ico avif tif tiff " +
		"mp4 mp3 wav ogg flac m4a m4v mov webm mkv zip 7z rar tar gz tgz iso exe msi dmg"
	).split(" "),
);
/** Document formats whose names often carry spaces (`제안서 최종.pptx`). */
const DOCUMENT_EXTENSIONS = new Set(
	"pdf pptx docx xlsx doc ppt xls rtf odt ods odp csv hwp hwpx key pages numbers".split(" "),
);
/** Extensionless names that are files (dotfiles by name: `.main-panel` in chat is usually a CSS selector). */
const BARE_FILE_NAMES = new Set(
	(
		"dockerfile makefile license readme changelog contributing codeowners procfile jenkinsfile vagrantfile gemfile " +
		"rakefile brewfile justfile pipfile .gitignore .gitattributes .gitmodules .gitkeep .dockerignore .npmignore .npmrc " +
		".nvmrc .node-version .python-version .ruby-version .tool-versions .editorconfig .prettierrc .prettierignore " +
		".eslintrc .eslintignore .babelrc .env .htaccess .bashrc .zshrc .profile .vimrc .mailmap"
	).split(" "),
);

export interface PathMention {
	path: string;
	line?: number;
	column?: number;
}

function locationOf(groups: Record<string, string | undefined> | undefined): Omit<PathMention, "path"> {
	const line = Number(groups?.line || groups?.hashLine) || undefined;
	const column = Number(groups?.column || groups?.hashColumn) || undefined;
	return { ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

function trailingLocation(text: string): (Omit<PathMention, "path"> & { consumed: number }) | null {
	for (const pattern of TRAILING_LOCATIONS) {
		const match = pattern.exec(text);
		if (match?.groups?.line) return { consumed: match[0].length, ...locationOf(match.groups) };
	}
	return null;
}

/**
 * The one path inline code names (`src/a.ts:12`, `Dockerfile`, `output/`,
 * `output/제안서 최종.pptx`, `C:\Users\me\새 폴더\out`), or null.
 */
export function codePathMention(text: string): PathMention | null {
	const match = CODE_LOCATION.exec(text.trim());
	const path = match?.groups?.path?.trim() ?? "";
	const drive = /^[A-Za-z]:[\\/]/.test(path);
	const body = drive ? path.slice(3) : path;
	if (
		!path ||
		!/\p{L}/u.test(path) ||
		/\s{2,}/.test(path) ||
		/^\.{1,2}$/.test(path) ||
		!(drive ? /^[\p{L}\p{N}_.@+\-\\/ ()&',[\]~!]*$/u : /^~?[\p{L}\p{N}_.@+\-\\/ ()]*$/u).test(body)
	)
		return null;
	const folder = /[\\/]$/.test(path);
	const hasSeparator = drive || /[\\/]/.test(body);
	const name = folder ? "" : (body.split(/[\\/]/).at(-1) ?? "");
	const dot = name.lastIndexOf(".");
	const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
	// A drive path is unambiguous and Windows folders carry spaces; a relative one with spaces is a command.
	if (/\s/.test(path) && !drive && !DOCUMENT_EXTENSIONS.has(extension)) return null;
	if (folder) return hasSeparator ? { path } : null;
	// Without an extension only well-known names count: `owner/repo` and `@scope/pkg` are not files.
	const knownName = BARE_FILE_NAMES.has(name.toLowerCase()) || /^\.env\./i.test(name);
	if (drive && !extension && !knownName) return { path: `${path}${path[2]}` };
	if (!extension && !knownName) return null;
	if (!hasSeparator && !knownName && !BARE_FILE_EXTENSIONS.has(extension)) return null;
	return { path, ...locationOf(match?.groups) };
}

function mentionLink(mention: PathMention, children: ElementContent[]): Element {
	return {
		type: "element",
		tagName: "a",
		properties: {
			dataPath: mention.path,
			...(mention.line ? { dataLine: String(mention.line) } : {}),
			...(mention.column ? { dataColumn: String(mention.column) } : {}),
		},
		children,
	};
}

/** Prose text split into text and path links; null when it names no path. */
export function linkifyProse(value: string): ElementContent[] | null {
	// Every branch of PROSE_PATH needs a `/` or `\`; most text nodes have neither, and the
	// Unicode-aware lookbehind scan over them cost ~4 ms of a long session's open.
	if (!value.includes("/") && !value.includes("\\")) return null;
	const out: ElementContent[] = [];
	let last = 0;
	PROSE_PATH.lastIndex = 0;
	for (let match = PROSE_PATH.exec(value); match; match = PROSE_PATH.exec(value)) {
		const path = match.groups?.file || match.groups?.folder || "";
		let end = match.index + match[0].length;
		let location = locationOf(match.groups);
		if (!location.line && match.groups?.file) {
			const trailing = trailingLocation(value.slice(end));
			if (trailing) {
				location = { line: trailing.line, ...(trailing.column ? { column: trailing.column } : {}) };
				end += trailing.consumed;
			}
		}
		if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
		out.push(mentionLink({ path, ...location }, [{ type: "text", value: value.slice(match.index, end) }]));
		last = end;
		PROSE_PATH.lastIndex = end;
	}
	if (out.length === 0) return null;
	if (last < value.length) out.push({ type: "text", value: value.slice(last) });
	return out;
}

function skipsPathLinks(element: Element): boolean {
	if (["a", "pre", "script", "style"].includes(element.tagName)) return true;
	const className = element.properties.className;
	const names = Array.isArray(className) ? className.map(String) : [String(className ?? "")];
	return names.some(name => /katex|math/.test(name));
}

function inlineCodeLink(code: Element, next: ElementContent | undefined): Element | null {
	const only = code.children.length === 1 ? code.children[0] : undefined;
	if (only?.type !== "text") return null;
	const mention = codePathMention(only.value);
	if (!mention) return null;
	const children: ElementContent[] = [code];
	if (!mention.line && !/[\\/]$/.test(mention.path) && next?.type === "text") {
		const trailing = trailingLocation(next.value);
		if (trailing) {
			mention.line = trailing.line;
			if (trailing.column) mention.column = trailing.column;
			children.push({ type: "text", value: next.value.slice(0, trailing.consumed) });
			(next as Text).value = next.value.slice(trailing.consumed);
		}
	}
	return mentionLink(mention, children);
}

function linkChildren(parent: Root | Element): void {
	if (parent.type === "element" && skipsPathLinks(parent)) return;
	const linked: Array<Root["children"][number]> = [];
	const children = parent.children as Array<Root["children"][number]>;
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (child.type === "element" && child.tagName === "code" && !skipsPathLinks(child)) {
			// Inline code is one mention or nothing: `python scripts/run.py` never sprouts a link.
			const next = children[index + 1];
			linked.push(
				inlineCodeLink(child, next?.type === "text" || next?.type === "element" ? next : undefined) ?? child,
			);
			continue;
		}
		if (child.type === "text") {
			const parts = linkifyProse(child.value);
			if (parts) linked.push(...parts);
			else if (child.value) linked.push(child);
			continue;
		}
		if (child.type === "element") linkChildren(child);
		linked.push(child);
	}
	parent.children = linked as typeof parent.children;
}

export function rehypeLocalPaths() {
	return (tree: Root) => linkChildren(tree);
}
