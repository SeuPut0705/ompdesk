/**
 * Task renderer pure helpers: wire-shape parsing/normalization for the task
 * (subagent spawn) tool card — stats, yields, review findings, missing-yield
 * warnings. Extracted verbatim from TaskRenderer.tsx.
 */

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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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

export function parseFinding(value: unknown): ReviewFinding | undefined {
	const r = asRecord(value);
	if (!r) return undefined;
	const title = asString(r.title);
	const priority = normalizeFindingPriority(r.priority);
	const filePath = asString(r.file_path);
	const lineStart = asNumber(r.line_start);
	if (!title || !priority || !filePath || lineStart == null) return undefined;
	return { title: title.replace(/^\[P\d\]\s*/, ""), priority, filePath, lineStart };
}

export interface ReviewResult {
	correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
	findings: ReviewFinding[];
}

/**
 * Assemble a review verdict from yield items: an explicit terminal payload
 * wins; otherwise incremental (array-typed) sections merge, with `findings`
 * accumulating into a list. Returns undefined when no review-shaped data.
 */
export function extractReviewResult(items: RenderYieldItem[]): ReviewResult | undefined {
	const sections: Record<string, unknown> = {};
	let hasSections = false;
	let terminal: RenderYieldItem | undefined;
	for (const item of items) {
		if (item.status === "aborted") continue;
		if (Array.isArray(item.type)) {
			for (const label of yieldLabels(item.type)) {
				if (label === "findings") {
					const prev = sections.findings;
					const acc = Array.isArray(prev) ? prev : prev !== undefined ? [prev] : [];
					acc.push(...(Array.isArray(item.data) ? item.data : [item.data]));
					sections.findings = acc;
				} else {
					sections[label] = item.data;
				}
				hasSections = true;
			}
		} else if (item.data !== undefined) {
			terminal = item;
		}
	}
	const data = terminal !== undefined ? terminal.data : hasSections ? sections : undefined;
	const record = asRecord(data);
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
