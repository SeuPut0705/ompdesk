import { Braces } from "lucide-react";
import { cx, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { CodeBlock } from "../chat/CodeBlock";
import { resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * LSP wire shape: `{ content: [{ type: "text", text }], details }` where
 * `details` is `LspToolDetails` (packages/coding-agent/src/lsp/types.ts):
 *   { serverName?, action, success, request?: LspParams }
 * The structured payload (hover markdown, diagnostics, references, symbols)
 * lives in the text body — the TUI types the result by parsing it
 * (packages/coding-agent/src/lsp/render.ts); this mirrors that detection.
 */

interface DiagItem {
	file?: string;
	line: number;
	col: number;
	severity: string;
	message: string;
}

interface RefGroup {
	file: string;
	locs: Array<{ line: number; col: number }>;
}

interface SymbolItem {
	icon: string;
	name: string;
	line: number;
	indent: number;
}

type LspResult =
	| { kind: "hover"; lang: string; code: string; before: string; after: string }
	| { kind: "diagnostics"; errors: number; warnings: number; items: DiagItem[] }
	| { kind: "references"; noun: string; count: number; groups: RefGroup[] }
	| { kind: "symbols"; file: string; symbols: SymbolItem[] }
	| { kind: "generic" };

const DIAG_NOUNS: Record<string, true> = { error: true, warning: true, info: true, hint: true };
const MAX_ITEMS = 50;

const FLAT_DIAG_RE = /^(.*):(\d+):(\d+)\s+\[(\w+)\]\s*(.*)$/;
const GROUPED_DIAG_RE = /^(\d+):(\d+)\s+\[(\w+)\]\s*(.*)$/;
const GROUP_HEADER_RE = /^(#+)\s+(.+)$/;
const REF_LINE_RE = /^(.+):(\d+):(\d+)$/;
const SYMBOL_LINE_RE = /^(\s*)(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/;

function countMatch(text: string, noun: string): number {
	const m = text.match(new RegExp(`(\\d+)\\s+${noun}\\(s\\)`));
	return m ? Number.parseInt(m[1], 10) : 0;
}

function parseDiagnosticItems(lines: string[]): DiagItem[] {
	const items: DiagItem[] = [];
	const dirParts: string[] = [];
	let currentFile: string | undefined;
	for (const raw of lines) {
		const header = raw.match(GROUP_HEADER_RE);
		if (header) {
			const depth = header[1].length;
			const name = header[2];
			dirParts.length = Math.max(0, depth - 1);
			if (name.endsWith("/")) dirParts.push(name);
			else currentFile = dirParts.join("") + name;
			continue;
		}
		const line = raw.trim();
		if (!line) continue;
		const flat = line.match(FLAT_DIAG_RE);
		if (flat) {
			items.push({
				file: flat[1] || currentFile,
				line: Number.parseInt(flat[2], 10),
				col: Number.parseInt(flat[3], 10),
				severity: flat[4].toLowerCase(),
				message: flat[5],
			});
			continue;
		}
		const grouped = line.match(GROUPED_DIAG_RE);
		if (grouped) {
			items.push({
				file: currentFile,
				line: Number.parseInt(grouped[1], 10),
				col: Number.parseInt(grouped[2], 10),
				severity: grouped[3].toLowerCase(),
				message: grouped[4],
			});
		}
		if (items.length >= MAX_ITEMS) break;
	}
	return items;
}

function parseLspText(text: string): LspResult {
	const codeBlockMatch = text.match(/```(\w*)\n([\s\S]*?)```/);
	if (codeBlockMatch) {
		const index = codeBlockMatch.index ?? 0;
		return {
			kind: "hover",
			lang: codeBlockMatch[1] || "plaintext",
			code: codeBlockMatch[2].trim(),
			before: text.slice(0, index).trim(),
			after: text.slice(index + codeBlockMatch[0].length).trim(),
		};
	}

	const foundMatch = text.match(/(\d+)\s+((?:\w+\s+)?\w+)\(s\)/);
	if (foundMatch && DIAG_NOUNS[foundMatch[2]]) {
		return {
			kind: "diagnostics",
			errors: countMatch(text, "error"),
			warnings: countMatch(text, "warning"),
			items: parseDiagnosticItems(text.split("\n")),
		};
	}
	if (foundMatch) {
		const byFile = new Map<string, Array<{ line: number; col: number }>>();
		// One global budget across files: a symbol referenced once in thousands
		// of files previously created thousands of groups despite MAX_ITEMS.
		let remaining = MAX_ITEMS;
		for (const raw of text.split("\n")) {
			if (remaining <= 0) break;
			const loc = raw.trim().match(REF_LINE_RE);
			if (!loc) continue;
			const list = byFile.get(loc[1]) ?? [];
			list.push({ line: Number.parseInt(loc[2], 10), col: Number.parseInt(loc[3], 10) });
			byFile.set(loc[1], list);
			remaining--;
		}
		return {
			kind: "references",
			noun: foundMatch[2],
			count: Number.parseInt(foundMatch[1], 10),
			groups: [...byFile.entries()].map(([file, locs]) => ({ file, locs })),
		};
	}

	const symbolsMatch = text.match(/Symbols in (.+):/);
	if (symbolsMatch) {
		const symbols: SymbolItem[] = [];
		for (const raw of text.split("\n")) {
			const m = raw.match(SYMBOL_LINE_RE);
			if (m) {
				symbols.push({
					indent: m[1].length,
					icon: m[2],
					name: m[3],
					line: Number.parseInt(m[4], 10),
				});
			}
			if (symbols.length >= MAX_ITEMS) break;
		}
		return { kind: "symbols", file: symbolsMatch[1], symbols };
	}

	return { kind: "generic" };
}

const SEVERITY_COLOR: Record<string, string> = {
	error: "var(--omp-error)",
	warning: "var(--omp-warning)",
	info: "var(--omp-md-link)",
	information: "var(--omp-md-link)",
	hint: "var(--omp-dim)",
};

/** LSP: operation badge + typed result (hover / diagnostics / references / symbols). */
export function LspRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const text = resultText(effective);
	const parsed = parseLspText(text);
	const operation = (
		typeof args.action === "string"
			? args.action
			: typeof args.operation === "string"
				? args.operation
				: typeof details?.action === "string"
					? details.action
					: "lsp"
	).replace(/_/g, " ");
	const request =
		details?.request != null && typeof details.request === "object"
			? (details.request as Record<string, unknown>)
			: undefined;
	const requestFile = typeof request?.file === "string" ? request.file : undefined;
	const requestLine = typeof request?.line === "number" ? request.line : undefined;
	const requestSymbol =
		typeof request?.symbol === "string"
			? request.symbol
			: typeof request?.query === "string"
				? request.query
				: typeof args.symbol === "string"
					? args.symbol
					: undefined;

	const countLabel =
		parsed.kind === "diagnostics"
			? // Header must reflect the summary totals, not the capped preview:
				// "50 diagnostics" beside a "100 errors" badge contradicted itself.
				`${Math.max(parsed.errors + parsed.warnings, parsed.items.length)} diagnostic${Math.max(parsed.errors + parsed.warnings, parsed.items.length) === 1 ? "" : "s"}`
			: parsed.kind === "references"
				? t("tools.lsp.results", { count: parsed.count, plural: parsed.count === 1 ? "" : "s" })
				: parsed.kind === "symbols"
					? t("tools.lsp.results", {
							count: parsed.symbols.length,
							plural: parsed.symbols.length === 1 ? "" : "s",
						})
					: "";

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Braces size={12} className="shrink-0 text-[var(--omp-syntax-type)]" />
				<span className="rounded bg-[var(--omp-syntax-type)]/15 px-1 py-px text-omp-xxs font-semibold uppercase tracking-wider text-[var(--omp-syntax-type)]">
					{operation}
				</span>
				{requestFile && (
					<span className="truncate text-[var(--omp-status-path)]" title={requestFile}>
						{requestFile}
						{requestLine != null ? `:${requestLine}` : ""}
					</span>
				)}
				{requestSymbol && <span className="truncate text-[var(--omp-text)]">{requestSymbol}</span>}
				<span className="ml-auto shrink-0 text-omp-xs text-[var(--omp-dim)]">{countLabel}</span>
			</div>

			{parsed.kind === "hover" && (
				<div className="flex flex-col gap-1">
					{parsed.before && (
						<div className="whitespace-pre-wrap text-omp-sm leading-[1.45] text-[var(--omp-muted)]">
							{parsed.before}
						</div>
					)}
					<CodeBlock code={parsed.code} language={parsed.lang} maxHeightClass="max-h-56" />
					{parsed.after && (
						<div className="line-clamp-3 whitespace-pre-wrap text-omp-sm leading-[1.45] text-[var(--omp-muted)]">
							{parsed.after}
						</div>
					)}
				</div>
			)}

			{parsed.kind === "diagnostics" && (
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-1.5 font-mono text-omp-xs">
						{parsed.errors > 0 && (
							<span className="rounded bg-[var(--omp-error)]/15 px-1 py-px font-semibold text-[var(--omp-error)]">
								{t("tools.lsp.errors", { count: parsed.errors })}
							</span>
						)}
						{parsed.warnings > 0 && (
							<span className="rounded bg-[var(--omp-warning)]/15 px-1 py-px font-semibold text-[var(--omp-warning)]">
								{t("tools.lsp.warnings", { count: parsed.warnings })}
							</span>
						)}
						{parsed.errors === 0 && parsed.warnings === 0 && (
							<span className="text-[var(--omp-dim)]">{text.trim() || "OK"}</span>
						)}
					</div>
					{parsed.items.length > 0 && (
						<div className="max-h-56 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
							{parsed.items.map((item, i) => (
								<div key={i} className="flex gap-2 transition-colors hover:bg-[var(--omp-selected-bg)]/50">
									<span
										className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
										style={{ background: SEVERITY_COLOR[item.severity] ?? "var(--omp-dim)" }}
									/>
									{item.file && (
										<span className="w-44 shrink-0 truncate text-[var(--omp-status-path)]" title={item.file}>
											{item.file}:{item.line}:{item.col}
										</span>
									)}
									<span className="min-w-0 flex-1 truncate text-[var(--omp-muted)]" title={item.message}>
										{item.message}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{parsed.kind === "references" && (
				<div className="max-h-56 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
					{parsed.groups.map(group => (
						<div key={group.file}>
							<div className="flex gap-2">
								<span className="min-w-0 flex-1 truncate text-[var(--omp-md-link)]" title={group.file}>
									{group.file}
								</span>
								<span className="shrink-0 text-omp-xs text-[var(--omp-dim)]">
									{t("tools.lsp.locations", { count: group.locs.length })}
								</span>
							</div>
							{group.locs.map((loc, i) => (
								<div key={i} className="flex gap-2 pl-4 text-[var(--omp-muted)]">
									<span>{t("tools.lsp.location", { line: loc.line, column: loc.col })}</span>
								</div>
							))}
						</div>
					))}
					{parsed.groups.length === 0 && (
						<div className="whitespace-pre-wrap text-[var(--omp-muted)]">{text.trim()}</div>
					)}
				</div>
			)}

			{parsed.kind === "symbols" && (
				<div className="max-h-56 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
					{parsed.symbols.map((sym, i) => (
						<div key={i} className="flex gap-2" style={{ paddingLeft: `${Math.min(sym.indent, 8) * 10}px` }}>
							<span className="min-w-0 flex-1 truncate text-[var(--omp-md-link)]">
								{sym.icon} {sym.name}
							</span>
							<span className="shrink-0 text-omp-xs text-[var(--omp-dim)]">
								{t("tools.lsp.line", { line: sym.line })}
							</span>
						</div>
					))}
					{parsed.symbols.length === 0 && (
						<div className="whitespace-pre-wrap text-[var(--omp-muted)]">{text.trim()}</div>
					)}
				</div>
			)}

			{parsed.kind === "generic" && text && (
				<pre
					className={cx(
						"max-h-40 overflow-auto whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-omp-sm leading-[1.45]",
						isError
							? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
							: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]",
					)}
				>
					{text}
				</pre>
			)}
		</div>
	);
}
