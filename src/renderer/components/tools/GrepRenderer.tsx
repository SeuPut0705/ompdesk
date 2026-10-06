import { Search } from "lucide-react";
import { cx, escapeHtml, escapeRegExp, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { GREP_PREVIEW_MATCHES, PREVIEW_SCROLL_MD, PREVIEW_SCROLL_SM } from "../../lib/preview";
import { PathLink } from "./PathLink";
import type { ToolRendererProps } from "./ToolCard";

const MAX_MATCHES = GREP_PREVIEW_MATCHES;

// The grep tool result carries structured details (matches/files/truncated/
// scope) plus a `displayContent` body in the shared grouped-file format:
//   # src/tools/            ← directory header (folded path prefix)
//   ## grep.ts#tag          ← file header (#hash suffix is an edit anchor)
//    *42│const hit = …      ← match line (star marker)
//    41│const ctx = …       ← context line (space marker)
//      │...                 ← elided lines
// Single-file scopes emit bare frame lines with no headers.
const HEADER_RE = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
const HEADER_HASH_TAG_RE = /#[0-9a-f]+$/i;
const FRAME_LINE_RE = /^\s*(\*?)\s*(\d+)│(.*)$/;
const GAP_LINE_RE = /^\s*│/;

interface FrameLine {
	kind: "match" | "context" | "gap";
	line?: number;
	content?: string;
}

interface FileGroup {
	file: string;
	lines: FrameLine[];
}

interface LegacyMatch {
	file: string;
	line: number;
	content: string;
}

function joinFolded(parent: string | undefined, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

/** Parse grouped display content into per-file groups of code-frame lines. */
function parseDisplayGroups(text: string, fallbackFile: string | undefined): FileGroup[] {
	const groups: FileGroup[] = [];
	const dirAtDepth = new Map<number, string>();
	let current: FileGroup | null = null;
	const ensureCurrent = (): FileGroup => {
		if (!current) {
			current = { file: fallbackFile ?? "", lines: [] };
			groups.push(current);
		}
		return current;
	};

	for (const raw of text.split("\n")) {
		if (raw.trim() === "") continue;
		const header = HEADER_RE.exec(raw);
		if (header) {
			const depth = header[1].length;
			const rest = header[2].trimEnd();
			const parent = depth > 1 ? dirAtDepth.get(depth - 1) : undefined;
			if (rest.endsWith("/")) {
				// Directory header: record the folded prefix for nested files.
				const name = rest.slice(0, -1).replace(HEADER_SUFFIX_RE, "");
				for (const key of dirAtDepth.keys()) {
					if (key >= depth) dirAtDepth.delete(key);
				}
				dirAtDepth.set(depth, joinFolded(parent, name));
				current = null;
				continue;
			}
			const name = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
			current = { file: joinFolded(parent, name), lines: [] };
			groups.push(current);
			continue;
		}
		if (GAP_LINE_RE.test(raw)) {
			ensureCurrent().lines.push({ kind: "gap" });
			continue;
		}
		const frame = FRAME_LINE_RE.exec(raw);
		if (frame) {
			ensureCurrent().lines.push({
				kind: frame[1] === "*" ? "match" : "context",
				line: Number(frame[2]),
				content: frame[3],
			});
		}
		// Trailing notes (limits, warnings) are model-text only, not display.
	}
	return groups;
}

/** Parse legacy `file:line:content` lines (pre-grouped wire format). */
function parseLegacyMatches(text: string): LegacyMatch[] {
	const out: LegacyMatch[] = [];
	const re = /^(.+?):(\d+):(.*)$/;
	for (const raw of text.split("\n")) {
		const m = re.exec(raw.trim());
		if (!m) continue;
		out.push({ file: m[1], line: Number(m[2]), content: m[3] });
		if (out.length >= MAX_MATCHES) break;
	}
	return out;
}

function legacyToGroups(matches: LegacyMatch[]): FileGroup[] {
	const groups: FileGroup[] = [];
	const byFile = new Map<string, FileGroup>();
	for (const m of matches) {
		let group = byFile.get(m.file);
		if (!group) {
			group = { file: m.file, lines: [] };
			byFile.set(m.file, group);
			groups.push(group);
		}
		group.lines.push({ kind: "match", line: m.line, content: m.content });
	}
	return groups;
}

function countMatches(groups: FileGroup[]): number {
	let n = 0;
	for (const group of groups) {
		for (const line of group.lines) {
			if (line.kind === "match") n++;
		}
	}
	return n;
}

/** Content with the search pattern wrapped in highlight marks (HTML-safe). */
function HighlightedContent({ content, pattern }: { content: string; pattern: string }) {
	const html = pattern
		? escapeHtml(content).replace(
				new RegExp(escapeRegExp(escapeHtml(pattern)), "gi"),
				m => `<mark class="omp-hl">${m}</mark>`,
			)
		: escapeHtml(content);
	return (
		// biome-ignore lint/security/noDangerouslySetInnerHtml: content and pattern are escapeHtml'd first; only <mark> wrappers are added
		<span dangerouslySetInnerHTML={{ __html: html }} />
	);
}

/** Grep: match/file counts + truncation meta, grouped per-file match list. */
export function GrepRenderer({ args, result, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const displayContent = typeof details?.displayContent === "string" ? details.displayContent : "";
	const text = displayContent || resultText(effective);

	const files = Array.isArray(details?.files) ? details.files.filter((f): f is string => typeof f === "string") : [];
	let groups = parseDisplayGroups(text, files[0]);
	if (groups.length === 0 && text) {
		// History from before the grouped format: fall back to file:line:content.
		groups = legacyToGroups(parseLegacyMatches(text));
	}

	const parsedCount = countMatches(groups);
	const matchCount = typeof details?.matchCount === "number" ? details.matchCount : parsedCount;
	const fileCount = typeof details?.fileCount === "number" ? details.fileCount : groups.length;
	const truncated = details?.truncated === true || details?.truncation != null;
	const scope = typeof details?.scopePath === "string" ? details.scopePath : undefined;

	// Cap rendered rows — matches AND context/gap lines: a large context
	// setting (or context-only groups) previously appended unbounded rows
	// after the last budgeted match. Once the budget is spent, drop whole
	// remaining groups rather than leaving orphaned context lines.
	let budget = MAX_MATCHES;
	let shown = 0;
	const renderedGroups: FileGroup[] = [];
	for (const group of groups) {
		if (budget <= 0) break;
		const lines: FrameLine[] = [];
		for (const line of group.lines) {
			if (budget <= 0) break;
			if (line.kind === "match") shown++;
			budget--;
			lines.push(line);
		}
		if (lines.length > 0) renderedGroups.push({ ...group, lines });
	}
	const hidden = Math.max(matchCount - shown, 0);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Search size={12} className="shrink-0 text-[var(--omp-dim)]" />
				<span className="truncate text-[var(--omp-accent)]">/{pattern}/</span>
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-omp-xs text-[var(--omp-dim)]">
					{scope && (
						<span className="max-w-40 truncate" title={scope}>
							{t("tools.grep.scope", { scope })}
						</span>
					)}
					{truncated && !isPartial && (
						<span className="text-[var(--omp-warning)]">{t("tools.grep.truncated")}</span>
					)}
					<span>
						{isPartial
							? t("tools.grep.searching")
							: t("tools.grep.matches", { count: matchCount, plural: matchCount === 1 ? "" : "es" })}
					</span>
					{!isPartial && fileCount > 0 && (
						<span>{t("tools.grep.files", { count: fileCount, plural: fileCount === 1 ? "" : "s" })}</span>
					)}
				</span>
			</div>
			{renderedGroups.length > 0 && (
				<div
					className={cx(
						"rounded bg-[var(--omp-code-bg)] py-1 font-mono text-omp-sm leading-[1.5]",
						PREVIEW_SCROLL_MD,
					)}
				>
					{renderedGroups.map((group, gi) => (
						<div key={gi}>
							{group.file && (
								<PathLink path={group.file} className="block truncate px-2 pt-1 text-[var(--omp-status-path)]">
									{group.file}
								</PathLink>
							)}
							{group.lines.map((line, li) =>
								line.kind === "gap" ? (
									<div key={li} className="px-2 text-[var(--omp-dim)]">
										…
									</div>
								) : (
									<div
										key={li}
										className="flex gap-2 px-2 transition-colors hover:bg-[var(--omp-selected-bg)]/50"
									>
										<span className="w-8 shrink-0 text-right tabular-nums text-[var(--omp-dim)]">
											{line.line}
										</span>
										<span
											className={
												line.kind === "match"
													? "min-w-0 flex-1 whitespace-pre text-[var(--omp-muted)]"
													: "min-w-0 flex-1 whitespace-pre text-[var(--omp-dim)]"
											}
										>
											<HighlightedContent content={line.content ?? ""} pattern={pattern} />
										</span>
									</div>
								),
							)}
						</div>
					))}
					{hidden > 0 && (
						<div className="px-2 pt-0.5 text-[var(--omp-dim)]">
							{t("tools.read.more", { count: hidden, plural: hidden === 1 ? "" : "s" })}
						</div>
					)}
				</div>
			)}
			{renderedGroups.length === 0 &&
				!isPartial &&
				(text ? (
					<pre
						className={cx(
							"whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm text-[var(--omp-tool-output)]",
							PREVIEW_SCROLL_SM,
						)}
					>
						{text}
					</pre>
				) : (
					<div className="text-omp-sm italic text-[var(--omp-dim)]">{t("tools.grep.noMatches")}</div>
				))}
		</div>
	);
}
