import { type CodeTag, type DefinitionTags, formatTag, tagsFor } from "./code-tags";

export type Outcome =
	| "pass"
	| "invariant"
	| "deadlock"
	| "temporal"
	| "action"
	| "assert"
	| "parse-error"
	| "error"
	| "timeout";

export interface TlcStats {
	generated?: number;
	distinct?: number;
	queue?: number;
	depth?: number;
}

export interface Location {
	module: string;
	line: number;
	col: number;
	endLine: number;
	endCol: number;
}

export interface TlcState {
	index: number;
	kind: "initial" | "action" | "stuttering" | "back";
	/** `Claim(w1)`: the action as TLC names it, parameters included. */
	actionText?: string;
	/** `Claim`. */
	action?: string;
	location?: Location;
	/** For `Back to state N`. */
	backTo?: number;
	/** Variable values as TLC printed them, whitespace collapsed. */
	vars: Record<string, string>;
	order: string[];
}

export interface TlcResult {
	outcome: Outcome;
	/** The violated invariant, action property or temporal property, when TLC names it. */
	property?: string;
	message?: string;
	stats: TlcStats;
	trace: TlcState[];
	/** Temporal violations: the lasso closes by stuttering or by going back to a state. */
	lasso?: { stuttering: boolean; backTo?: number };
	errors: string[];
	warnings: string[];
}

const STATE_HEADER = /^(?:State (\d+)|Back to state (\d+)): (.*)$/;
const ACTION_HEADER = /^<(.+?) line (\d+), col (\d+) to line (\d+), col (\d+) of module (\S+)>$/;
const VARIABLE = /^(?:\/\\ )?(\w+) = (.*)$/;

function nameOf(actionText: string): string {
	const paren = actionText.indexOf("(");
	return (paren === -1 ? actionText : actionText.slice(0, paren)).trim();
}

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function parseHeader(rest: string): Pick<TlcState, "kind" | "actionText" | "action" | "location"> {
	if (rest.trim() === "Stuttering") return { kind: "stuttering" };
	if (/^<Initial predicate>$/.test(rest.trim())) return { kind: "initial" };
	const located = ACTION_HEADER.exec(rest.trim());
	if (located) {
		const text = located[1] as string;
		return {
			kind: "action",
			actionText: text,
			action: nameOf(text),
			location: {
				module: located[6] as string,
				line: Number(located[2]),
				col: Number(located[3]),
				endLine: Number(located[4]),
				endCol: Number(located[5]),
			},
		};
	}
	const bare = /^<(.*)>$/.exec(rest.trim());
	const text = bare ? (bare[1] as string) : rest.trim();
	return { kind: "action", actionText: text, action: nameOf(text) };
}

/** Parses the numbered states TLC prints for a counterexample. */
function parseTrace(lines: string[]): TlcState[] {
	const states: TlcState[] = [];
	let current: TlcState | undefined;
	let variable: string | undefined;
	let counter = 0;
	for (const line of lines) {
		const header = STATE_HEADER.exec(line);
		if (header) {
			const back = header[2] !== undefined;
			const index = back ? ++counter : Number(header[1]);
			counter = Math.max(counter, index);
			const parsed = parseHeader(header[3] as string);
			current = {
				index,
				...parsed,
				...(back ? { kind: "back" as const, backTo: Number(header[2]) } : {}),
				vars: {},
				order: [],
			};
			states.push(current);
			variable = undefined;
			continue;
		}
		if (!current) continue;
		const match = VARIABLE.exec(line);
		if (match) {
			variable = match[1] as string;
			current.vars[variable] = (match[2] as string).trim();
			current.order.push(variable);
		} else if (variable && /^\s+\S/.test(line)) {
			current.vars[variable] = squash(`${current.vars[variable]} ${line}`);
		} else if (line.trim() === "" || !/^\s/.test(line)) {
			variable = undefined;
		}
	}
	for (const state of states) for (const key of state.order) state.vars[key] = squash(state.vars[key] as string);
	return states;
}

function statsOf(text: string): TlcStats {
	const stats: TlcStats = {};
	const counts = [
		...text.matchAll(/(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue/g),
	].pop();
	if (counts) {
		stats.generated = Number(counts[1]);
		stats.distinct = Number(counts[2]);
		stats.queue = Number(counts[3]);
	}
	const depth = [...text.matchAll(/depth of the complete state graph search is (\d+)/g)].pop();
	if (depth) stats.depth = Number(depth[1]);
	return stats;
}

const ERROR_KINDS: { pattern: RegExp; outcome: Outcome; named: boolean }[] = [
	{ pattern: /^Error: Invariant (\S+) is violated\.?$/, outcome: "invariant", named: true },
	{ pattern: /^Error: Action property (\S+) is violated\.?$/, outcome: "action", named: true },
	{
		pattern: /^Error: Temporal propert(?:y|ies) (\S+) (?:was|were|is) violated\.?$/,
		outcome: "temporal",
		named: true,
	},
	{ pattern: /^Error: Temporal propert(?:y|ies) (?:was|were|is|are) violated\.?$/, outcome: "temporal", named: false },
	{ pattern: /^Error: Deadlock reached\.?$/, outcome: "deadlock", named: false },
	{
		pattern: /^Error: (?:Assertion failed|The first argument of Assert evaluated to FALSE)/,
		outcome: "assert",
		named: false,
	},
	{ pattern: /^Error: Assumption .* is (?:false|violated)/, outcome: "assert", named: false },
];

const PARSE_MARKERS = [
	/\*\*\*\s*Parse Error\s*\*\*\*/,
	/Fatal errors while parsing TLA\+ spec/,
	/Semantic errors?:/,
	/Could not parse (?:the )?config/i,
	/Error: parsing/i,
	/Was expecting/,
	/Cannot find source file for module/,
	/Unknown operator/,
	/Could not find definition|The configuration file .* does not exist/i,
	/specified in the configuration file\s+is not defined/,
];

const FALLBACK_BY_EXIT: Record<number, Outcome> = {
	10: "assert",
	11: "deadlock",
	12: "invariant",
	13: "temporal",
	14: "error",
};

/** Reads TLC's text output (and its exit code, when known) into a structured result. Never throws. */
export function parseTlcOutput(text: string, exitCode?: number | null): TlcResult {
	const lines = text.split(/\r?\n/);
	const errors = lines.filter(line => line.startsWith("Error:")).map(line => line.replace(/^Error:\s*/, ""));
	const warnings = lines.filter(line => line.startsWith("Warning:")).map(line => line.replace(/^Warning:\s*/, ""));
	const stats = statsOf(text);
	let outcome: Outcome | undefined;
	let property: string | undefined;
	for (const line of lines) {
		for (const kind of ERROR_KINDS) {
			const match = kind.pattern.exec(line);
			if (!match) continue;
			outcome = kind.outcome;
			if (kind.named) property = match[1];
			break;
		}
		if (outcome) break;
	}
	const firstState = lines.findIndex(line => /^State 1: /.test(line));
	const trace = firstState === -1 ? [] : parseTrace(lines.slice(firstState));
	if (!outcome) {
		if (
			exitCode === 0 ||
			(exitCode === undefined && /Model checking completed\. No error has been found/.test(text))
		) {
			outcome = "pass";
		} else if (
			PARSE_MARKERS.some(marker => marker.test(text)) ||
			(exitCode !== undefined && exitCode !== null && exitCode >= 150)
		) {
			outcome = "parse-error";
		} else if (exitCode !== undefined && exitCode !== null && FALLBACK_BY_EXIT[exitCode]) {
			outcome = FALLBACK_BY_EXIT[exitCode];
		} else if (errors.length > 0 || (exitCode !== undefined && exitCode !== null && exitCode !== 0)) {
			outcome = "error";
		} else {
			outcome = "pass";
		}
	}
	const last = trace[trace.length - 1];
	const lasso =
		outcome === "temporal" && last
			? last.kind === "stuttering"
				? { stuttering: true }
				: last.kind === "back"
					? { stuttering: false, backTo: last.backTo as number }
					: undefined
			: undefined;
	const message =
		errors.find(
			error =>
				!/^The behavior up to this point is:?$|^The following behavior constitutes a counter-example:?$/.test(
					error,
				),
		) ?? undefined;
	return {
		outcome,
		...(property ? { property } : {}),
		...(message ? { message } : {}),
		stats,
		trace,
		...(lasso ? { lasso } : {}),
		errors,
		warnings,
	};
}

export interface TraceRow {
	n: number;
	/** `Init`, `Claim(w1)`, `Stuttering`, `Back to state 3`. */
	step: string;
	action?: string;
	location?: Location;
	/** `path:lines` of the `@code` tags of the action. */
	code: string[];
	/** Variables whose value changed (all of them in the first row). */
	changed: Record<string, { from?: string; to: string }>;
	violation?: boolean;
}

/** One row per state: the action, the code it stands for, and only the variables that changed. */
export function reduceTrace(
	trace: TlcState[],
	options: { definitions?: (module: string | undefined) => DefinitionTags[]; outcome?: Outcome } = {},
): TraceRow[] {
	const rows: TraceRow[] = [];
	let previous: TlcState | undefined;
	for (const state of trace) {
		const changed: TraceRow["changed"] = {};
		for (const key of state.order) {
			const to = state.vars[key] as string;
			if (!previous) changed[key] = { to };
			else if (previous.vars[key] !== to) changed[key] = { from: previous.vars[key], to };
		}
		let step: string;
		if (state.kind === "initial") step = "Init";
		else if (state.kind === "stuttering") step = "Stuttering";
		else if (state.kind === "back")
			step = `Back to state ${state.backTo}${state.actionText ? `: ${state.actionText}` : ""}`;
		else step = state.actionText ?? "?";
		let code: CodeTag[] = [];
		if (state.kind === "action" || state.kind === "back") {
			const defs = options.definitions?.(state.location?.module);
			if (defs) code = tagsFor(defs, state.action, state.location?.line);
		}
		rows.push({
			n: state.index,
			step,
			...(state.action ? { action: state.action } : {}),
			...(state.location ? { location: state.location } : {}),
			code: code.map(formatTag),
			changed,
		});
		if (state.kind !== "stuttering") previous = state;
	}
	const failing = options.outcome && options.outcome !== "pass" && options.outcome !== "temporal";
	if (failing) {
		const last = rows[rows.length - 1];
		if (last) last.violation = true;
	} else if (options.outcome === "temporal") {
		const stateRows = rows.filter(row => row.step !== "Stuttering" && !row.step.startsWith("Back to state"));
		const last = stateRows[stateRows.length - 1];
		if (last) last.violation = true;
	}
	return rows;
}

const VIOLATION_LABEL: Record<Outcome, string> = {
	pass: "pass",
	invariant: "invariant violated",
	deadlock: "deadlock",
	temporal: "temporal property violated",
	action: "action property violated",
	assert: "assertion or assumption failed",
	"parse-error": "parse or configuration error",
	error: "TLC error",
	timeout: "timed out (no verdict)",
};

export function describeOutcome(result: TlcResult): string {
	const label = VIOLATION_LABEL[result.outcome];
	return result.property ? `${label}: ${result.property}` : label;
}

export function formatStats(stats: TlcStats): string {
	const parts: string[] = [];
	if (stats.distinct !== undefined) parts.push(`${stats.distinct} distinct states`);
	if (stats.generated !== undefined) parts.push(`${stats.generated} generated`);
	if (stats.depth !== undefined) parts.push(`depth ${stats.depth}`);
	return parts.join(", ");
}

/** The trace as aligned text: one block per step. */
export function formatTrace(rows: TraceRow[], result: TlcResult): string {
	const out: string[] = [];
	for (const row of rows) {
		const head = `  #${row.n}  ${row.step}${row.code.length ? `   [${row.code.join(", ")}]` : ""}${row.violation ? "   <-- violation" : ""}`;
		out.push(head);
		for (const [name, change] of Object.entries(row.changed)) {
			out.push(
				change.from === undefined
					? `        ${name} = ${change.to}`
					: `        ${name}: ${change.from}  ->  ${change.to}`,
			);
		}
	}
	if (result.lasso) {
		out.push(
			result.lasso.stuttering
				? "  (the behavior then stutters forever: no further step happens)"
				: `  (the behavior then repeats from state ${result.lasso.backTo})`,
		);
	}
	return out.join("\n");
}
