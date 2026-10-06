import { Bug, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { AnsiText, hasAnsi } from "../../lib/ansi";
import { cx, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * Debug wire shape: `{ content: [{ type: "text", text }], details }` where
 * `details` is `DebugToolDetails` (packages/coding-agent/src/tools/debug.ts):
 *   { action, success, snapshot?, sessions?, stackFrames?, threads?, scopes?,
 *     variables?, sources?, modules?, evaluation?, breakpoints?, output?,
 *     adapter?, state?, timedOut? }
 * Frames/variables/session state all live in `details`; the text body is a
 * human-readable rendering of the same, used as fallback.
 */

interface StackFrame {
	name: string;
	file?: string;
	line?: number;
}

interface VariableRow {
	name: string;
	value: string;
	type?: string;
}

interface BreakpointRow {
	line?: number;
	verified?: boolean;
	condition?: string;
	message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function extractFrames(details: Record<string, unknown> | undefined): StackFrame[] {
	const out: StackFrame[] = [];
	for (const f of asArray(details?.stackFrames)) {
		const fr = asRecord(f);
		if (!fr) {
			if (typeof f === "string") out.push({ name: f });
			continue;
		}
		const source = asRecord(fr.source);
		out.push({
			name: typeof fr.name === "string" ? fr.name : typeof fr.function === "string" ? fr.function : "??",
			file:
				typeof source?.path === "string"
					? source.path
					: typeof source?.name === "string"
						? source.name
						: typeof fr.file === "string"
							? fr.file
							: undefined,
			line: typeof fr.line === "number" ? fr.line : undefined,
		});
		if (out.length >= 50) break;
	}
	return out;
}

function extractVariables(details: Record<string, unknown> | undefined): VariableRow[] {
	const out: VariableRow[] = [];
	for (const v of asArray(details?.variables)) {
		const vr = asRecord(v);
		if (!vr || typeof vr.name !== "string") continue;
		out.push({
			name: vr.name,
			value: typeof vr.value === "string" ? vr.value : JSON.stringify(vr.value ?? ""),
			type: typeof vr.type === "string" ? vr.type : undefined,
		});
		if (out.length >= 100) break;
	}
	return out;
}

function extractBreakpoints(details: Record<string, unknown> | undefined): BreakpointRow[] {
	const out: BreakpointRow[] = [];
	for (const b of asArray(details?.breakpoints)) {
		const br = asRecord(b);
		if (!br) continue;
		out.push({
			line: typeof br.line === "number" ? br.line : undefined,
			verified: typeof br.verified === "boolean" ? br.verified : undefined,
			condition: typeof br.condition === "string" ? br.condition : undefined,
			message: typeof br.message === "string" ? br.message : undefined,
		});
		if (out.length >= 50) break;
	}
	return out;
}

/** Session snapshot lines, mirroring formatSessionSnapshot in debug.ts. */
function snapshotLines(snapshot: Record<string, unknown>): string[] {
	const lines: string[] = [];
	if (typeof snapshot.id === "string") lines.push(`Session ${snapshot.id}`);
	if (typeof snapshot.adapter === "string") lines.push(`Adapter: ${snapshot.adapter}`);
	if (typeof snapshot.status === "string") lines.push(`Status: ${snapshot.status}`);
	if (typeof snapshot.cwd === "string") lines.push(`CWD: ${snapshot.cwd}`);
	if (typeof snapshot.program === "string") lines.push(`Program: ${snapshot.program}`);
	if (typeof snapshot.stopReason === "string") lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (typeof snapshot.frameName === "string") lines.push(`Frame: ${snapshot.frameName}`);
	const source = asRecord(snapshot.source);
	if (typeof source?.path === "string" && typeof snapshot.line === "number") {
		const col = typeof snapshot.column === "number" ? `:${snapshot.column}` : "";
		lines.push(`Location: ${source.path}:${snapshot.line}${col}`);
	}
	if (typeof snapshot.exitCode === "number") lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

/** Debug adapter: action badge, session snapshot, stack frames, variables. */
export function DebugRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const action = (
		typeof args.action === "string" ? args.action : typeof details?.action === "string" ? details.action : "debug"
	).replaceAll("_", " ");
	const snapshot = asRecord(details?.snapshot);
	const frames = extractFrames(details);
	const variables = extractVariables(details);
	const breakpoints = extractBreakpoints(details);
	const evaluation = asRecord(details?.evaluation);
	const output = typeof details?.output === "string" ? details.output : "";
	const text = resultText(effective);
	const [varsOpen, setVarsOpen] = useState(true);
	// Only treat the snapshot as "structured" for actions whose payload IS the
	// session snapshot. threads/scopes/disassemble/etc. also return one —
	// counting it suppressed the text fallback and silently dropped the
	// operation's actual result.
	const snapshotActions = new Set(["launch", "attach", "restart", "pause", "continue", "disconnect", "terminate"]);
	const hasStructured =
		(snapshot != null && snapshotActions.has(action)) ||
		frames.length > 0 ||
		variables.length > 0 ||
		breakpoints.length > 0 ||
		evaluation != null;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Bug size={12} className="shrink-0 text-[var(--omp-warning)]" />
				<span className="font-semibold text-[var(--omp-text)]">{action}</span>
				{typeof args.program === "string" && (
					<span className="min-w-0 flex-1 truncate text-[var(--omp-dim)]">{args.program}</span>
				)}
			</div>

			{snapshot && (
				<div className="rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
					{snapshotLines(snapshot).map(line => (
						<div key={line} className="truncate text-[var(--omp-tool-output)]" title={line}>
							{line}
						</div>
					))}
				</div>
			)}

			{frames.length > 0 && (
				<div className="max-h-48 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
					{frames.map((f, i) => (
						<div key={i} className="flex gap-2 transition-colors hover:bg-[var(--omp-selected-bg)]/50">
							<span className="w-5 shrink-0 text-right tabular-nums text-[var(--omp-dim)]">{i}</span>
							<span className="min-w-0 flex-1 truncate text-[var(--omp-syntax-function)]">{f.name}</span>
							{f.file && (
								<span className="shrink-0 truncate text-[var(--omp-status-path)]">
									{f.file}
									{f.line != null ? `:${f.line}` : ""}
								</span>
							)}
						</div>
					))}
				</div>
			)}

			{evaluation && typeof evaluation.result === "string" && (
				<div className="flex gap-2 rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
					<span className="min-w-0 flex-1 truncate text-[var(--omp-tool-output)]" title={evaluation.result}>
						= {evaluation.result}
					</span>
					{typeof evaluation.type === "string" && (
						<span className="shrink-0 text-omp-xs text-[var(--omp-dim)]">{evaluation.type}</span>
					)}
				</div>
			)}

			{variables.length > 0 && (
				<div>
					<button
						type="button"
						onClick={() => setVarsOpen(v => !v)}
						className="flex items-center gap-1 text-omp-xs font-semibold uppercase tracking-wider text-[var(--omp-dim)] transition-colors hover:text-[var(--omp-text)]"
					>
						{varsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
						{t("tools.debug.variables")}
					</button>
					{varsOpen && (
						<div className="mt-0.5 max-h-40 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
							{variables.map(row => (
								<div key={row.name} className="flex gap-2">
									<span className="shrink-0 text-[var(--omp-syntax-variable)]">{row.name}</span>
									<span className="min-w-0 flex-1 truncate text-[var(--omp-muted)]" title={row.value}>
										{row.value}
									</span>
									{row.type && <span className="shrink-0 text-omp-xs text-[var(--omp-dim)]">{row.type}</span>}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{breakpoints.length > 0 && (
				<div className="max-h-32 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.6]">
					{breakpoints.map((bp, i) => (
						<div key={i} className="flex gap-2">
							<span
								className="h-1.5 w-1.5 mt-1.5 shrink-0 rounded-full"
								style={{ background: bp.verified ? "var(--omp-success)" : "var(--omp-warning)" }}
							/>
							<span className="text-[var(--omp-text)]">{t("tools.debug.line", { line: bp.line ?? "?" })}</span>
							<span className="text-[var(--omp-dim)]">
								{bp.verified ? t("tools.debug.verified") : t("tools.debug.pending")}
							</span>
							{bp.condition && (
								<span className="truncate text-[var(--omp-muted)]">
									{t("tools.debug.condition", { condition: bp.condition })}
								</span>
							)}
						</div>
					))}
				</div>
			)}

			{output && (
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-tool-output)]">
					{hasAnsi(output) ? <AnsiText text={output} /> : output}
				</pre>
			)}

			{!hasStructured && !output && text && (
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
