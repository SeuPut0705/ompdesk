import { isRecord } from "./json";
import type { TraceRow } from "./tlc-parse";

/** One element of a finding's `trace[]` in assets/findings.schema.json. */
export interface FindingsTraceRow {
	step: number;
	action: string;
	code?: string;
	changed?: Record<string, string>;
	violation?: boolean;
}

/** `tlc.ts --json` rows in the shape of the findings schema: `step` is the state number, `changed` is `"from -> to"`. */
export function toFindingsTrace(rows: TraceRow[]): FindingsTraceRow[] {
	return rows.map(row => {
		const changed: Record<string, string> = {};
		for (const [name, change] of Object.entries(row.changed)) {
			changed[name] = change.from === undefined ? change.to : `${change.from} -> ${change.to}`;
		}
		return {
			step: row.n,
			action: row.step,
			...(row.code.length > 0 ? { code: row.code.join(", ") } : {}),
			...(Object.keys(changed).length > 0 ? { changed } : {}),
			...(row.violation ? { violation: true } : {}),
		};
	});
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.to === "string")
		return typeof value.from === "string" ? `${value.from} -> ${value.to}` : value.to;
	return String(value);
}

/**
 * A trace row in either shape (the findings schema's, or a raw row of `tlc.ts`'s `rows`: `n`, `step` as text, `code`
 * as an array, `changed` as `{from, to}`) in the findings schema's shape. Anything else passes through untouched, so
 * schema validation still names the real problem.
 */
export function normalizeTraceRow(row: unknown): unknown {
	if (!isRecord(row) || typeof row.step === "number") return row;
	if (typeof row.n !== "number" || typeof row.step !== "string") return row;
	const out: Record<string, unknown> = { step: row.n, action: row.step };
	if (typeof row.actor === "string") out.actor = row.actor;
	if (Array.isArray(row.code) && row.code.length > 0) out.code = row.code.map(String).join(", ");
	else if (typeof row.code === "string" && row.code) out.code = row.code;
	if (isRecord(row.changed) && Object.keys(row.changed).length > 0) {
		out.changed = Object.fromEntries(Object.entries(row.changed).map(([name, value]) => [name, textOf(value)]));
	}
	if (row.violation === true) out.violation = true;
	return out;
}

/** One findings document's findings with every `trace` in the schema's shape. Does not modify its input. */
export function normalizeFindings(data: unknown): unknown {
	if (!isRecord(data) || !Array.isArray(data.findings)) return data;
	return {
		...data,
		findings: data.findings.map(finding =>
			isRecord(finding) && Array.isArray(finding.trace)
				? { ...finding, trace: finding.trace.map(normalizeTraceRow) }
				: finding,
		),
	};
}

/**
 * The concern documents in a findings file: the file itself, or each entry of its `concerns` array (one file for
 * several concerns). `where` names the entry in error messages.
 */
export function concernDocuments(data: unknown): { where: string; doc: unknown }[] {
	if (isRecord(data) && Array.isArray(data.concerns) && !("findings" in data)) {
		return data.concerns.map((doc, index) => ({ where: `concerns[${index}]`, doc }));
	}
	return [{ where: "", doc: data }];
}
