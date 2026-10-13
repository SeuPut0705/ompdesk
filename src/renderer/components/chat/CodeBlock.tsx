import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { copyText, cx, escapeHtml } from "../../lib/format";
import { getLoadedHljs, HIGHLIGHT_CHAR_CAP, loadHljs } from "../../lib/highlight";
import { useT } from "../../lib/i18n";
import { IconButton } from "../common";
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

export function CodeBlock({
	code,
	language,
	showLanguage = true,
	showCopy = true,
	showLineNumbers = true,
	startLine,
	lineNumbers,
	maxHeightClass,
	className,
}: CodeBlockProps) {
	const t = useT();
	const lang = normalizeLanguage(language);
	const [copied, setCopied] = useState(false);
	const [hlHtml, setHlHtml] = useState<string | null>(() => {
		if (!code || code.length > HIGHLIGHT_CHAR_CAP) return null;
		const hljs = getLoadedHljs();
		if (!hljs) return null;
		return lang !== "plaintext" && hljs.getLanguage(lang)
			? hljs.highlight(code, { language: lang }).value
			: hljs.highlightAuto(code).value;
	});

	useEffect(() => {
		if (!code || code.length > HIGHLIGHT_CHAR_CAP) return;

		let cancelled = false;
		void loadHljs().then(hljs => {
			if (cancelled) return;
			setHlHtml(
				lang !== "plaintext" && hljs.getLanguage(lang)
					? hljs.highlight(code, { language: lang }).value
					: hljs.highlightAuto(code).value,
			);
		});
		return () => {
			cancelled = true;
		};
	}, [code, lang]);

	// Lazy hljs output, or escaped plain code. Over-cap code must ignore any
	// cached highlight from a previous shorter value — otherwise the old source
	// displays while Copy takes the new one.
	const html = useMemo(() => {
		if (code == null) return null;
		return code.length > HIGHLIGHT_CHAR_CAP ? escapeHtml(code) : (hlHtml ?? escapeHtml(code));
	}, [hlHtml, code]);

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

	const handleCopy = () => {
		void copyText(code ?? "").then(ok => {
			if (!ok) return;
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		});
	};

	return (
		<div
			className={cx(
				"omp-code-block group/code relative overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1) text-(--sc-text)",
				className,
			)}
		>
			{(showLanguage || showCopy) && (
				<div className="flex h-8 items-center gap-2 border-b border-(--sc-divider) ps-3 pe-1">
					{showLanguage && (
						<span className="min-w-0 truncate text-sc-xs text-(--sc-text-muted)">
							{lang === "plaintext" ? t("codeblock.plainText") : languageLabel(lang)}
						</span>
					)}
					{showCopy && (
						<IconButton
							className="ms-auto"
							icon={copied ? <Check className="text-(--sc-success)" /> : <Copy />}
							label={t("chat.copyCode")}
							onClick={handleCopy}
							size="sm"
						/>
					)}
				</div>
			)}
			<div className={cx("overflow-auto", maxHeightClass)}>
				{showLineNumbers && lineCount > 0 ? (
					<div className="flex">
						<LineNumberGutter
							lineCount={lineCount}
							lineNumbers={lineNumbers}
							startLine={startLine}
							className="px-2.5 py-3 text-sc-sm leading-(--sc-leading-normal)"
						/>
						<pre className="min-w-0 flex-1 overflow-x-auto px-3 py-3 font-mono text-sc-sm leading-(--sc-leading-normal)">
							{codeElement}
						</pre>
					</div>
				) : (
					<pre className="overflow-x-auto px-3 py-3 font-mono text-sc-sm leading-(--sc-leading-normal)">
						{codeElement}
					</pre>
				)}
			</div>
		</div>
	);
}
