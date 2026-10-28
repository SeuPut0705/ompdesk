import { type CodeTag, type DefinitionTags, formatTag, tagsFor } from "./code-tags";

export type Outcome =
	| "pass"
	| "invariant"
	| "deadlock"
	| "temporal"
	| "action"
	| "assert"
	| "parse-error"
	| "unsound"
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
	/** An action property TLC names only by its source location (`Action property line 45, col 17 to ... is violated`). */
	propertyLocation?: Location;
	message?: string;
	stats: TlcStats;
	trace: TlcState[];
	/** Temporal violations: the lasso closes by stuttering or by going back to a state. */
	lasso?: { stuttering: boolean; backTo?: number };
	errors: string[];
	warnings: string[];
	/** The version TLC printed in its banner (`2026.10.28.014557`), which is not the release tag the jar is pinned by. */
	tlcVersion?: string;
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

const ERROR_KINDS: { pattern: RegExp; outcome: Outcome; named: boolean; location?: boolean }[] = [
	{
		pattern: /^Error: Invariant (\S+) is violated(?: by the initial state)?[.:]?$/,
		outcome: "invariant",
		named: true,
	},
	{
		pattern: /^Error: Action property line (\d+), col (\d+) to line (\d+), col (\d+) of module (\S+) is violated\.?$/,
		outcome: "action",
		named: false,
		location: true,
	},
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

/**
 * Warnings that mean TLC's "no error" does not cover what the config asks for: a state-level formula under PROPERTY
 * is checked only in the initial state, and SYMMETRY can make TLC miss a liveness violation.
 */
const UNSOUND_WARNINGS = [/only checked in the initial state/i, /symmetry during liveness checking is dangerous/i];

const PARSE_MARKERS = [
	/\*\*\*\s*Parse Error\s*\*\*\*/,
	/Fatal errors while parsing TLA\+ spec/,
	/Semantic errors?:/,
	/Could not parse (?:the )?config/i,
	/Error: parsing/i,
	/Was expecting/,
	/Cannot find source file for module/,
	/Unknown operator/,
	/Could not find declaration or definition of symbol/,
	/Couldn't resolve (?:prefix |infix |postfix )?operator/,
	/Could not find definition|The configuration file .* does not exist/i,
	/specified in the configuration file\s+is not defined/,
];

/** TLC's own exit codes (tlc2.output.EC): 150 and 151 are parse and configuration errors. */
const FALLBACK_BY_EXIT: Record<number, Outcome> = {
	10: "assert",
	11: "deadlock",
	12: "invariant",
	13: "temporal",
	14: "assert",
	150: "parse-error",
	151: "parse-error",
};

const COMPLETED = /Model checking completed\. No error has been found/;

/** Reads TLC's text output (and its exit code, when known) into a structured result. Never throws. */
export function parseTlcOutput(text: string, exitCode?: number | null): TlcResult {
	const lines = text.split(/\r?\n/);
	const errors = lines.filter(line => line.startsWith("Error:")).map(line => line.replace(/^Error:\s*/, ""));
	const warnings = lines.filter(line => line.startsWith("Warning:")).map(line => line.replace(/^Warning:\s*/, ""));
	const stats = statsOf(text);
	let outcome: Outcome | undefined;
	let property: string | undefined;
	let propertyLocation: Location | undefined;
	/** Index of the line `Error: Invariant X is violated by the initial state:`, whose variables follow without a `State 1:` header. */
	let initialAt = -1;
	for (const [at, line] of lines.entries()) {
		for (const kind of ERROR_KINDS) {
			const match = kind.pattern.exec(line);
			if (!match) continue;
			outcome = kind.outcome;
			if (kind.named) property = match[1];
			if (kind.location) {
				propertyLocation = {
					module: match[5] as string,
					line: Number(match[1]),
					col: Number(match[2]),
					endLine: Number(match[3]),
					endCol: Number(match[4]),
				};
			}
			if (/ by the initial state:$/.test(line)) initialAt = at;
			break;
		}
		if (outcome) break;
	}
	const firstState = lines.findIndex(line => /^State 1: /.test(line));
	let trace: TlcState[] = [];
	if (firstState !== -1) {
		trace = parseTrace(lines.slice(firstState));
	} else if (initialAt !== -1) {
		const block: string[] = [];
		for (let at = initialAt + 1; at < lines.length && (lines[at] as string).trim() !== ""; at++)
			block.push(lines[at] as string);
		trace = parseTrace(["State 1: <Initial predicate>", ...block]);
	}
	let unsound: string | undefined;
	let emptyInit = false;
	if (!outcome) {
		// A pass needs TLC's own word: exit 0, or (no exit code known, as with a saved log) its completion line.
		// A killed TLC (exit null), a truncated log and empty output give no verdict at all.
		const known = exitCode !== undefined && exitCode !== null;
		if (exitCode === 0 || (exitCode === undefined && COMPLETED.test(text))) {
			outcome = "pass";
			if (stats.distinct === 0) {
				// TLC calls a model with no initial state a success; nothing was checked.
				outcome = "error";
				emptyInit = true;
			} else {
				unsound = warnings.find(warning => UNSOUND_WARNINGS.some(pattern => pattern.test(warning)));
				if (unsound) outcome = "unsound";
			}
		} else if (PARSE_MARKERS.some(marker => marker.test(text))) {
			outcome = "parse-error";
		} else if (known && FALLBACK_BY_EXIT[exitCode]) {
			outcome = FALLBACK_BY_EXIT[exitCode];
		} else {
			outcome = "error";
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
	const parseAt = outcome === "parse-error" ? lines.findIndex(line => /\*\*\*\s*Parse Error\s*\*\*\*/.test(line)) : -1;
	const parseDetail: string[] = [];
	if (parseAt !== -1) {
		for (let at = parseAt + 1; at < lines.length && (lines[at] as string).trim() !== ""; at++)
			parseDetail.push((lines[at] as string).trim());
	}
	const resolveDetail =
		outcome === "parse-error"
			? lines.find(line =>
					/^(?:Could not find declaration or definition|Couldn't resolve|Unknown operator|Was expecting|Cannot find source file)/.test(
						line.trim(),
					),
				)
			: undefined;
	const tlcVersion = /^TLC2 Version (\S+)/m.exec(text)?.[1];
	const message =
		(emptyInit
			? "TLC found no initial state: Init is unsatisfiable (or the SPECIFICATION's initial predicate is empty), so no state was checked"
			: undefined) ??
		(unsound ? `TLC reports no violation, but its own warning says the check is not sound: ${unsound}` : undefined) ??
		(parseDetail.length ? `Parse error: ${parseDetail.join(" ")}` : undefined) ??
		(resolveDetail ? resolveDetail.trim() : undefined) ??
		errors.find(
			error =>
				!/^The behavior up to this point is:?$|^The following behavior constitutes a counter-example:?$/.test(
					error,
				),
		) ??
		undefined;
	return {
		outcome,
		...(property ? { property } : {}),
		...(propertyLocation ? { propertyLocation } : {}),
		...(message ? { message } : {}),
		stats,
		trace,
		...(lasso ? { lasso } : {}),
		errors,
		warnings,
		...(tlcVersion ? { tlcVersion } : {}),
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
	// Only a verdict about the model marks a step: an evaluation error or a killed run has no "violating" state.
	const failing =
		options.outcome === "invariant" ||
		options.outcome === "action" ||
		options.outcome === "deadlock" ||
		options.outcome === "assert";
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
	unsound: "no violation found, but TLC warns the check is unsound",
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
