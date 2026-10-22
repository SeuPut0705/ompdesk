/**
 * Source view: one row per line with its number, highlighted through the
 * shared lazy highlight.js chunk (lib/highlight.ts, the same grammars and
 * `.hljs-*` → token mapping as markdown fences), and a wrap toggle. Rows are
 * flex lines inside one <pre>, so a wrapped line keeps its number beside its
 * first visual line. Very large text skips highlighting, and very long files
 * paint in a first batch the reader can extend.
 */
import { WrapText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../lib/format";
import { getLoadedHljs, type HighlightToken, loadHljs, splitHighlightedLines } from "../../../lib/highlight";
import { useT } from "../../../lib/i18n";
import { revealAndFocus } from "../../../lib/reveal-focus";
import { Button, IconButton } from "../../common";

/** Above this many characters the view shows plain text (grammar scan cost). */
export const CODE_HIGHLIGHT_CHAR_CAP = 300_000;
/** Rows painted before the reader asks for the rest. */
const INITIAL_LINES = 5000;

function highlightLines(code: string, language: string): HighlightToken[][] | null {
	if (language === "plaintext" || code.length > CODE_HIGHLIGHT_CHAR_CAP) return null;
	const hljs = getLoadedHljs();
	if (!hljs?.getLanguage(language)) return null;
	try {
		return splitHighlightedLines(hljs.highlight(code, { language, ignoreIllegals: true }).value);
	} catch {
		return null;
	}
}

/** Wrap state plus its toolbar button; each text view owns one. */
export function useWrapToggle(): { wrap: boolean; toggle: ReactNode } {
	const t = useT();
	const [wrap, setWrap] = useState(false);
	return {
		wrap,
		toggle: (
			<IconButton
				icon={<WrapText />}
				label={t("fileViewer.wrap")}
				onClick={() => setWrap(value => !value)}
				pressed={wrap}
				size="sm"
			/>
		),
	};
}

export function CodeView({
	code,
	language,
	wrap,
	targetLine,
}: {
	code: string;
	language: string;
	wrap: boolean;
	/** 1-based line to scroll to and mark (a `path:line` link); beyond the end marks the last line. */
	targetLine?: number | null;
}) {
	const t = useT();
	const [hljsReady, setHljsReady] = useState(() => getLoadedHljs() !== null);
	const [showAll, setShowAll] = useState(false);
	const targetRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (hljsReady || language === "plaintext" || code.length > CODE_HIGHLIGHT_CHAR_CAP) return;
		let cancelled = false;
		void loadHljs().then(() => {
			if (!cancelled) setHljsReady(true);
		});
		return () => {
			cancelled = true;
		};
	}, [hljsReady, language, code.length]);

	const highlighted = useMemo(() => (hljsReady ? highlightLines(code, language) : null), [code, language, hljsReady]);
	const plainLines = useMemo(() => (highlighted ? null : code.split("\n")), [code, highlighted]);
	const lineCount = highlighted ? highlighted.length : (plainLines?.length ?? 0);
	const target = targetLine && lineCount > 0 ? Math.min(targetLine, lineCount) : null;
	const visible = showAll || (target ?? 0) > INITIAL_LINES ? lineCount : Math.min(lineCount, INITIAL_LINES);
	const gutterWidth = `calc(${String(lineCount).length}ch + 1.5rem)`;

	// Centre the marked line once it is painted; a new target (same file, another link) scrolls again.
	useEffect(() => {
		if (target !== null) targetRef.current?.scrollIntoView?.({ block: "center" });
	}, [target]);

	const rows = [];
	for (let i = 0; i < visible; i++) {
		const tokens = highlighted?.[i];
		const isTarget = target === i + 1;
		rows.push(
			<span
				className={cx("flex", isTarget && "bg-(--sc-accent-soft)")}
				data-target-line={isTarget ? "true" : undefined}
				key={i}
				ref={isTarget ? targetRef : undefined}
			>
				<span
					aria-hidden
					className={cx(
						"sticky left-0 shrink-0 select-none pr-3 pl-2 text-right",
						isTarget ? "bg-(--sc-selection) text-(--sc-text)" : "bg-(--sc-surface-2) text-(--sc-text-muted)",
					)}
					data-line-number
					style={{ width: gutterWidth }}
				>
					{i + 1}
				</span>
				<span
					className={cx(
						"pr-3",
						wrap ? "min-w-0 flex-1 [overflow-wrap:anywhere] whitespace-pre-wrap" : "whitespace-pre",
					)}
				>
					{tokens
						? tokens.map((token, k) =>
								token.className ? (
									<span className={token.className} key={k}>
										{token.text}
									</span>
								) : (
									token.text
								),
							)
						: plainLines?.[i]}
					{"\n"}
				</span>
			</span>,
		);
	}

	return (
		<>
			<pre
				className={cx(
					"m-0 py-2 font-mono text-sc-sm leading-(--sc-leading-normal) text-(--sc-text)",
					wrap ? "w-full" : "w-max min-w-full",
				)}
				data-code-view
				data-highlighted={highlighted ? "true" : undefined}
				data-language={language}
			>
				{rows}
			</pre>
			{visible < lineCount && (
				<div className="px-3 pb-3">
					<Button
						onClick={event => {
							const pre = event.currentTarget.parentElement?.previousElementSibling;
							revealAndFocus(
								event.currentTarget,
								() => setShowAll(true),
								() => pre?.children[visible],
							);
						}}
						size="sm"
						variant="ghost"
					>
						{t("fileViewer.showAllLines", { count: lineCount })}
					</Button>
				</div>
			)}
		</>
	);
}
