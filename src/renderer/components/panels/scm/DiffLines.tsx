/**
 * Virtualized rows and the repository diff body shared by the Changes list
 * and the commit history: old/new gutters, add/remove tint and syntax colour
 * by the file's language (both sides highlighted as whole texts, so a block
 * comment or template string spanning lines keeps its colour).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import type { HLJSApi } from "highlight.js";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import type { DiffLine } from "../../../lib/diff";
import { cx, languageFromPath } from "../../../lib/format";
import {
	getLoadedHljs,
	HIGHLIGHT_CHAR_CAP,
	type HighlightToken,
	loadHljs,
	splitHighlightedLines,
} from "../../../lib/highlight";
import { Skeleton } from "../../common";

/**
 * Rows of a long list inside `scroller`, mounted only near its viewport. A
 * checkout's 1,000 changed files or a diff's thousands of lines, all mounted,
 * made one 65–180 ms frame when the list or the diff opened.
 */
export function VirtualRows<T>({
	items,
	scroller,
	estimate,
	itemKey,
	children,
}: {
	items: readonly T[];
	/** The scrolling ancestor; state, so the rows mount once it is attached. */
	scroller: HTMLElement | null;
	estimate: number;
	itemKey: (item: T, index: number) => string | number;
	children: (item: T, index: number) => ReactNode;
}) {
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scroller,
		estimateSize: () => estimate,
		getItemKey: index => itemKey(items[index] as T, index),
		// The overscan (12 rows, 240+ px) also covers what precedes the rows in the
		// scroller (a search field or the sticky header, under 60 px), so no scroll
		// margin is read from layout.
		overscan: 12,
		// Sizes come from the ResizeObserver entry, after layout: reading a row's
		// rect while its commit mounts it would lay out the whole window inside the
		// commit. A row under a hidden list (display: none) reports 0; it keeps its estimate.
		measureElement: (element, entry, instance) =>
			entry
				? entry.borderBoxSize[0]?.blockSize || estimate
				: (instance.measurementsCache[instance.indexFromElement(element)]?.size ?? estimate),
	});
	return (
		<div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
			{virtualizer.getVirtualItems().map(item => (
				<div
					data-index={item.index}
					key={item.key}
					ref={virtualizer.measureElement}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						transform: `translateY(${item.start}px)`,
					}}
				>
					{children(items[item.index] as T, item.index)}
				</div>
			))}
		</div>
	);
}

/**
 * Tokens per diff line: the new side (context + added) and the old side
 * (removed) each highlighted as one text, then handed back line by line.
 * Null when the language is unknown or the diff is too large to colour.
 */
export function highlightDiffLines(
	lines: readonly DiffLine[],
	hljs: HLJSApi,
	language: string,
): (HighlightToken[] | undefined)[] | null {
	if (language === "plaintext" || !hljs.getLanguage(language)) return null;
	const sides = { new: [] as number[], old: [] as number[] };
	let size = 0;
	lines.forEach((line, index) => {
		(line.type === "remove" ? sides.old : sides.new).push(index);
		size += line.content.length + 1;
	});
	if (size > HIGHLIGHT_CHAR_CAP * 5) return null;
	const tokens: (HighlightToken[] | undefined)[] = new Array(lines.length);
	for (const indices of [sides.new, sides.old]) {
		if (indices.length === 0) continue;
		try {
			const code = indices.map(index => lines[index]!.content).join("\n");
			const perLine = splitHighlightedLines(hljs.highlight(code, { language, ignoreIllegals: true }).value);
			indices.forEach((lineIndex, k) => {
				tokens[lineIndex] = perLine[k];
			});
		} catch {
			// A grammar error leaves this side plain.
		}
	}
	return tokens;
}

const DIFF_SKELETON_WIDTHS = [90, 72, 84, 60, 78, 66, 88, 50] as const;

/** A diff on its way: code lines as flat bars, so the rows land where they were. */
export function DiffSkeleton({ label }: { label: string }) {
	return (
		<div aria-label={label} className="flex flex-col gap-2 p-3" role="status">
			{DIFF_SKELETON_WIDTHS.map((width, index) => (
				<Skeleton className="h-3" key={`${index}-${width}`} style={{ width: `${width}%` }} />
			))}
		</div>
	);
}

/** The diff body: virtualized rows under `scroller` (the preview's scrolling ancestor). */
export function DiffLines({
	lines,
	path,
	scroller,
}: {
	lines: readonly DiffLine[];
	/** File path the language comes from. */
	path: string;
	scroller: HTMLElement | null;
}) {
	const language = languageFromPath(path);
	const [hljs, setHljs] = useState(getLoadedHljs);
	useEffect(() => {
		if (hljs || language === "plaintext") return;
		let cancelled = false;
		void loadHljs().then(loaded => {
			if (!cancelled) setHljs(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, [hljs, language]);
	const tokens = useMemo(() => (hljs ? highlightDiffLines(lines, hljs, language) : null), [lines, hljs, language]);
	// Both gutters fit the longest line number, so a 4-digit number never wraps.
	const gutterDigits = String(
		lines.reduce((max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0), 0),
	).length;
	return (
		<div
			className="omp-pane-diff font-mono text-sc-xs leading-(--sc-leading-relaxed)"
			data-highlighted={tokens ? "true" : undefined}
			data-language={language}
			style={{ "--omp-gutter-digits": gutterDigits } as CSSProperties}
		>
			<VirtualRows estimate={20} itemKey={(_, index) => index} items={lines} scroller={scroller}>
				{(line, index) => {
					const lineTokens = tokens?.[index];
					return (
						<div
							className={cx(
								"flex items-start px-2",
								line.type === "add" && "bg-(--sc-success-soft)",
								line.type === "remove" && "bg-(--sc-danger-soft)",
							)}
						>
							<span
								aria-hidden
								className="omp-pane-gutter shrink-0 select-none pr-2 text-right text-(--sc-text-subtle)"
							>
								{line.oldLine}
							</span>
							<span
								aria-hidden
								className="omp-pane-gutter shrink-0 select-none pr-2 text-right text-(--sc-text-subtle)"
							>
								{line.newLine}
							</span>
							<span aria-hidden className="shrink-0 pr-2 text-(--sc-text-subtle)">
								{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
							</span>
							<span className="min-w-0 whitespace-pre-wrap break-words text-(--sc-text)">
								{lineTokens
									? lineTokens.map((token, k) =>
											token.className ? (
												<span className={token.className} key={k}>
													{token.text}
												</span>
											) : (
												token.text
											),
										)
									: line.content}
							</span>
						</div>
					);
				}}
			</VirtualRows>
		</div>
	);
}
