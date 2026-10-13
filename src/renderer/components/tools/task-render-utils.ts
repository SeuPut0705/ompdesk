/**
 * Task renderer pure helpers: wire-shape parsing/normalization for the task
 * (subagent spawn) tool card — stats, yields, review findings, missing-yield
 * warnings. Extracted verbatim from TaskRenderer.tsx.
 */

import { asArray, asNumber, asRecord, asString } from "../../lib/wire-value";

export const MAX_NESTED_DEPTH = 8;
export const OUTPUT_PREVIEW_LINES = 3;
export const YIELD_CAP = 3;
export const FINDING_CAP = 3;
export const MISSING_YIELD_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

export const PRIORITY_COLOR: Record<string, string> = {
	P0: "var(--omp-error)",
	P1: "var(--omp-warning)",
	P2: "var(--omp-muted)",
	P3: "var(--omp-accent)",
};

export const PRIORITY_ORD: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Ids are name-based with "." separating nesting levels; render as a breadcrumb. */
export function formatTaskId(id: string): string {
	const segments = id.split(".");
	return segments.length < 2 ? id : segments.join(">");
}

/** Live rows: finished agents first (runtime ascending), unfinished pinned at the bottom in dispatch order. */
export function orderProgressForDisplay(list: Record<string, unknown>[]): Record<string, unknown>[] {
	const finished: Record<string, unknown>[] = [];
	const unfinished: Record<string, unknown>[] = [];
	for (const row of list) {
		const status = asString(row.status);
		(status === "pending" || status === "running" ? unfinished : finished).push(row);
	}
	finished.sort(
		(a, b) =>
			(asNumber(a.durationMs) ?? 0) - (asNumber(b.durationMs) ?? 0) ||
			(asNumber(a.index) ?? 0) - (asNumber(b.index) ?? 0),
	);
	return finished.concat(unfinished);
}

/** Finalized rows: runtime ascending, tie-break dispatch index. */
export function orderResultsForDisplay(list: Record<string, unknown>[]): Record<string, unknown>[] {
	return [...list].sort(
		(a, b) =>
			(asNumber(a.durationMs) ?? 0) - (asNumber(b.durationMs) ?? 0) ||
			(asNumber(a.index) ?? 0) - (asNumber(b.index) ?? 0),
	);
}

export function extractMissingYieldWarning(output: string): { warning?: string; rest: string } {
	const firstLine = output.split("\n", 1)[0]?.trim() ?? "";
	if (!firstLine.startsWith(MISSING_YIELD_WARNING_PREFIX)) return { rest: output };
	return { warning: firstLine, rest: output.slice(firstLine.length).replace(/^\s*\n+/, "") };
}

// ---------------------------------------------------------------------------
// Yield data + review extraction
// ---------------------------------------------------------------------------

export interface RenderYieldItem {
	data?: unknown;
	type?: string | string[];
	status?: string;
}

/**
 * Normalize the `yield` slot of extractedToolData into records. The executor
 * always writes an array, but a stray single object is wrapped so the review
 * verdict still renders instead of crashing on `.map`.
 */
export function normalizeYieldData(value: unknown): RenderYieldItem[] {
	const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const normalized: RenderYieldItem[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const typeValue = record.type;
		let type: RenderYieldItem["type"];
		if (typeof typeValue === "string") {
			type = typeValue;
		} else if (Array.isArray(typeValue) && typeValue.every(v => typeof v === "string")) {
			type = typeValue as string[];
		}
		normalized.push({ data: record.data, type, status: asString(record.status) });
	}
	return normalized;
}

export function yieldLabels(type: RenderYieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	return type.map(v => v.trim()).filter(Boolean);
}

export interface ReviewFinding {
	title: string;
	priority: string;
	filePath: string;
	lineStart: number;
}

export function normalizeFindingPriority(value: unknown): string | undefined {
	if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
	if (value === 0 || value === 1 || value === 2 || value === 3) return `P${value}`;
	return undefined;
}

/** A finding stock's `parseFindingDetails` (pi-tui/src/tools/task.ts) accepts, reduced to what the card shows. */
export function parseFinding(value: unknown): ReviewFinding | undefined {
	const r = asRecord(value);
	if (!r) return undefined;
	const title = asString(r.title);
	const priority = normalizeFindingPriority(r.priority);
	const confidence = asNumber(r.confidence);
	const filePath = asString(r.file_path);
	const lineStart = asNumber(r.line_start);
	if (
		title === undefined ||
		asString(r.body) === undefined ||
		!priority ||
		confidence === undefined ||
		confidence < 0 ||
		confidence > 1 ||
		!filePath ||
		lineStart === undefined ||
		asNumber(r.line_end) === undefined
	) {
		return undefined;
	}
	return { title: title.replace(/^\[P\d\]\s*/, ""), priority, filePath, lineStart };
}

export interface ReviewResult {
	correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
	findings: ReviewFinding[];
}

/** Stock's REVIEWER_SECTION_SHAPES (pi-tui/src/tools/task.ts): findings always a list, verdict fields the latest yield. */
const REVIEW_SECTION_SHAPES: Readonly<Record<string, "array" | "scalar">> = {
	findings: "array",
	overall_correctness: "scalar",
	explanation: "scalar",
	confidence: "scalar",
};

/**
 * Stock `assembleYieldResult` (pi-tui/src/tools/task-yield-assembly.ts) as
 * stock's task renderer calls it for a review: reviewer section shapes and no
 * last-assistant-turn fallback. The renderer cannot load stock modules, so
 * this copy is pinned to stock by task-review-stock.test.ts. An explicit
 * terminal payload (the last non-incremental yield, when it carries data)
 * wins; otherwise incremental (array-typed) sections merge.
 */
export function assembleReviewYield(items: RenderYieldItem[]): unknown {
	const incremental = (item: RenderYieldItem): boolean => Array.isArray(item.type) && item.type.length > 0;
	let terminal: RenderYieldItem | undefined;
	for (let index = items.length - 1; index >= 0 && !terminal; index--) {
		if (!incremental(items[index])) terminal = items[index];
	}
	if (terminal?.data !== undefined) return terminal.data;
	const sections: Record<string, unknown> = {};
	const counts = new Map<string, number>();
	for (const item of items) {
		if (item.status === "aborted" || !incremental(item)) continue;
		for (const label of yieldLabels(item.type)) {
			const shape = REVIEW_SECTION_SHAPES[label];
			const count = counts.get(label) ?? 0;
			const existing = sections[label];
			if (shape === "scalar") sections[label] = item.data;
			else if (count === 0) sections[label] = shape === "array" ? [item.data] : item.data;
			else sections[label] = Array.isArray(existing) ? [...existing, item.data] : [existing, item.data];
			counts.set(label, count + 1);
		}
	}
	return counts.size > 0 ? sections : undefined;
}

/** The review verdict stock's task renderer shows, or undefined when the yields carry none. */
export function extractReviewResult(items: RenderYieldItem[]): ReviewResult | undefined {
	const record = asRecord(assembleReviewYield(items));
	if (!record) return undefined;
	const correctness = record.overall_correctness;
	const explanation = record.explanation;
	const confidence = record.confidence;
	if (
		(correctness !== "correct" && correctness !== "incorrect") ||
		typeof explanation !== "string" ||
		typeof confidence !== "number"
	) {
		return undefined;
	}
	return {
		correctness,
		explanation,
		confidence,
		findings: asArray(record.findings)
			.map(parseFinding)
			.filter((f): f is ReviewFinding => f != null),
	};
}

// ---------------------------------------------------------------------------
// Shared row fragments
// ---------------------------------------------------------------------------

/** Dim `⟨agent⟩`-style badge for a non-default agent type. */
