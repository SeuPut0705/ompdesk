import type { HLJSApi } from "highlight.js";
import { SquareTerminal, WrapText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useScrollOverflow } from "../../hooks/use-scroll-overflow";
import { cx, escapeHtml } from "../../lib/format";
import { getLoadedHljs, HIGHLIGHT_CHAR_CAP, loadHljs } from "../../lib/highlight";
import { useT } from "../../lib/i18n";
import { runInTerminal, SHELL_LANGUAGES } from "../../lib/run-in-terminal";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { CopyButton, IconButton } from "../common";
import { FigureHeader } from "./FigureHeader";
import { LineNumberGutter } from "./LineNumberGutter";

export interface CodeBlockProps {
	/** Raw source code (highlighted client-side). */
	code?: string;
	/** Language hint for highlighting and the badge. */
	language?: string;
	/** Show the language badge. */
	showLanguage?: boolean;
	/** Show the copy button. */
	showCopy?: boolean;
	/** Show the line-number gutter. */
	showLineNumbers?: boolean;
	/** Number shown on the first gutter line (ranged reads start past 1). */
	startLine?: number;
	/** Explicit per-row numbers for non-contiguous reads. */
	lineNumbers?: readonly (number | null)[];
	/** Cap the visible height; taller blocks scroll internally. */
	maxHeightClass?: string;
	/**
	 * Guess the language with hljs when `language` is missing or unknown.
	 * Markdown fences pass false: an unlabeled fence is plain text, as in stock's TUI.
	 */
	guessLanguage?: boolean;
	/** Highlight at all; a fence still streaming stays plain until it closes. */
	highlight?: boolean;
	/** Offer the line-wrap toggle in the header. */
	showWrap?: boolean;
	/** Offer "Run in terminal" for a shell block (a finished reply fence on this machine's tab). */
	showRun?: boolean;
	/** Header label in place of the language's name ("Mermaid", "SVG", a file name). */
	title?: string;
	/** Icon actions at the start of the header's right side (a figure's Preview/Code switch). */
	headerActions?: ReactNode;
	/** Icon actions after Copy (a figure's download). */
	endActions?: ReactNode;
	/** No border, radius or fill: the block sits inside a box that already has them. */
	bare?: boolean;
	className?: string;
}

const LANGUAGE_ALIASES: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	ts: "typescript",
	tsx: "typescript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	yml: "yaml",
	md: "markdown",
	"": "plaintext",
};

function normalizeLanguage(lang: string | undefined): string {
	if (!lang) return "plaintext";
	const lower = lang.toLowerCase();
	return LANGUAGE_ALIASES[lower] ?? lower;
}

/** Names whose spelling isn't the id with a capital first letter. */
const LANGUAGE_NAMES: Record<string, string> = {
	typescript: "TypeScript",
	javascript: "JavaScript",
	json: "JSON",
	jsonc: "JSON",
	html: "HTML",
	xml: "XML",
	css: "CSS",
	scss: "SCSS",
	sql: "SQL",
	yaml: "YAML",
	toml: "TOML",
	cpp: "C++",
	csharp: "C#",
	php: "PHP",
	graphql: "GraphQL",
	powershell: "PowerShell",
	objectivec: "Objective-C",
};

/** Header label: the language's own name in sentence case ("TypeScript", "Bash"), never shouting caps. */
function languageLabel(lang: string): string {
	return LANGUAGE_NAMES[lang] ?? `${lang.charAt(0).toUpperCase()}${lang.slice(1)}`;
}

/** hljs markup for `code`; null when it stays plain (unknown language and no guessing). */
function highlightCode(hljs: HLJSApi, code: string, lang: string, guess: boolean): string | null {
	if (lang !== "plaintext" && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
	return guess ? hljs.highlightAuto(code).value : null;
}

export function CodeBlock({
	code,
	language,
	showLanguage = true,
	showCopy = true,
	showLineNumbers = true,
	startLine,
	lineNumbers,
	maxHeightClass,
	guessLanguage = true,
	highlight = true,
	showWrap = false,
	showRun = false,
	title,
	headerActions,
	endActions,
	bare = false,
	className,
}: CodeBlockProps) {
	const t = useT();
	const lang = normalizeLanguage(language);
	const [wrap, setWrap] = useState(false);
	const runtimeTabId = useRuntimeTabId();
	const tabId = useTabsStore(state => {
		const id = runtimeTabId ?? state.activeTabId;
		// A paired host's tab runs it in the host's terminal (C114).
		return state.tabs.some(tab => tab.id === id) ? id : null;
	});
	const runnable = showRun && SHELL_LANGUAGES[lang] === true && !!code?.trim() && tabId !== null;
	const highlightable = highlight && !!code && code.length <= HIGHLIGHT_CHAR_CAP;
	const [hlHtml, setHlHtml] = useState<string | null>(() => {
		if (!highlightable || !code) return null;
		const hljs = getLoadedHljs();
		return hljs ? highlightCode(hljs, code, lang, guessLanguage) : null;
	});

	useEffect(() => {
		if (!highlightable || !code) return;

		let cancelled = false;
		void loadHljs().then(hljs => {
			if (cancelled) return;
			setHlHtml(highlightCode(hljs, code, lang, guessLanguage));
		});
		return () => {
			cancelled = true;
		};
	}, [code, lang, guessLanguage, highlightable]);

	// Lazy hljs output, or escaped plain code. Over-cap or unhighlighted code must
	// ignore any cached highlight from a previous value — otherwise the old source
	// displays while Copy takes the new one.
	const html = useMemo(() => {
		if (code == null) return null;
		return highlightable ? (hlHtml ?? escapeHtml(code)) : escapeHtml(code);
	}, [hlHtml, code, highlightable]);

	const codeElement =
		html != null ? (
			// biome-ignore lint/security/noDangerouslySetInnerHtml: hljs/escapeHtml output only
			<code className={`language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
		) : (
			<code className={`language-${lang}`}>{code ?? ""}</code>
		);

	const lineCount = useMemo(() => {
		if (!code) return 0;
		let n = 1;
		for (let i = 0; i < code.length; i++) if (code[i] === "\n") n++;
		return n;
	}, [code]);
	// Wrapped rows no longer line up with one gutter number per source line,
	// so the gutter steps aside while wrapping is on.
	const gutter = showLineNumbers && lineCount > 0 && !wrap;
	// A block that runs past its box takes a tab stop, so the keyboard can scroll what it hides: the code across
	// (the <pre> scrolls sideways) and, from there or alone, down (the box scrolls). A block that fits adds none.
	const scrollRef = useRef<HTMLDivElement>(null);
	const preRef = useRef<HTMLPreElement>(null);
	// The gutter swaps the <pre> for another element: the measure follows whichever is on screen.
	const layout = `${code}\n${wrap}\n${gutter}`;
	const box = useScrollOverflow(scrollRef, layout);
	const across = useScrollOverflow(preRef, layout);
	const scrollStop = (on: boolean) =>
		on ? { "aria-label": t("codeblock.scroll"), role: "group", tabIndex: 0 } : undefined;
	const preClass = cx(
		"px-3 py-3 font-mono text-sc-sm leading-(--sc-leading-normal)",
		wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto",
	);

	return (
		<div
			className={cx(
				"omp-code-block group/code relative overflow-hidden text-(--sc-text)",
				!bare && "rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1)",
				className,
			)}
		>
			{(showLanguage || showCopy || showWrap || runnable || headerActions || endActions) && (
				<FigureHeader
					title={
						showLanguage
							? (title ?? (lang === "plaintext" ? t("codeblock.plainText") : languageLabel(lang)))
							: undefined
					}
				>
					{headerActions}
					{showWrap && (
						<IconButton
							data-code-wrap
							icon={<WrapText />}
							label={t("codeblock.wrap")}
							onClick={() => setWrap(value => !value)}
							pressed={wrap}
							size="sm"
						/>
					)}
					{runnable && tabId && (
						<IconButton
							data-code-run
							icon={<SquareTerminal />}
							label={t("codeblock.runInTerminal")}
							onClick={() =>
								void runInTerminal(tabId, code ?? "").catch(error =>
									toastError({ title: t("codeblock.runFailed"), error }),
								)
							}
							size="sm"
						/>
					)}
					{showCopy && <CopyButton label={t("chat.copyCode")} text={code ?? ""} />}
					{endActions}
				</FigureHeader>
			)}
			<div className={cx("overflow-auto", maxHeightClass)} ref={scrollRef} {...scrollStop(box.y && !across.x)}>
				{gutter ? (
					<div className="flex">
						<LineNumberGutter
							lineCount={lineCount}
							lineNumbers={lineNumbers}
							startLine={startLine}
							className="px-2.5 py-3 text-sc-sm leading-(--sc-leading-normal)"
						/>
						<pre className={cx("min-w-0 flex-1", preClass)} ref={preRef} {...scrollStop(across.x)}>
							{codeElement}
						</pre>
					</div>
				) : (
					<pre className={preClass} data-code-wrapped={wrap || undefined} ref={preRef} {...scrollStop(across.x)}>
						{codeElement}
					</pre>
				)}
			</div>
		</div>
	);
}
