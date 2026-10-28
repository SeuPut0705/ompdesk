#!/usr/bin/env bun
// Runs TLC on a TLA+ spec and explains what it found: PASS or FAIL, distinct states and depth, and for a
// violation, deadlock or liveness failure the counterexample reduced to the variables that changed, with every
// step tied to code through `\* @code path:line` comments next to the actions in the spec.
//
//   bun tlc.ts <spec.tla> [--config X.cfg] [--matrix matrix.json] [--workers N|auto] [--no-deadlock]
//              [--coverage] [--sany-only] [--out DIR] [--json FILE] [--code-root DIR] [--timeout SEC]
//              [--trace] [-- extra TLC args]
//   bun tlc.ts --from-log <tlc-output.txt> [--spec Spec.tla] [--json FILE]    (explain a saved TLC output)
//
// A run without --timeout stops after DEFAULT_TIMEOUT_SEC (10 minutes) with "timed out (no verdict)"; --timeout 0 means
// no limit. While TLC runs, its `Progress(...)` lines and a "still running" line are printed.
//
// Exit: 0 PASS (every matrix run ended as expected), 1 a check ran and failed, 2 usage, 3 UNAVAILABLE.
import fs from "node:fs";
import path from "node:path";
import { checkTags, extractTags, findCodeRoot, type TagProblem } from "./lib/code-tags";
import { type FindingsTraceRow, toFindingsTrace } from "./lib/findings";
import { readJson } from "./lib/json";
import { judge, type MatrixRun, matrixWarnings, parseMatrix } from "./lib/matrix";
import { EXIT, Unavailable, UsageError } from "./lib/proc";
import { prepareTla, type TlaEnv } from "./lib/tla-env";
import {
	describeOutcome,
	formatStats,
	formatTrace,
	parseTlcOutput,
	reduceTrace,
	type TlcResult,
	type TraceRow,
} from "./lib/tlc-parse";
import { deadActions, definitionLoader, runSany, runTlc } from "./lib/tlc-run";

/** A run with no `--timeout` ends after this long: an unbounded run looks like a hang and nobody can tell which. */
export const DEFAULT_TIMEOUT_SEC = 600;
/** Seconds of silence before "still running" is printed. */
const HEARTBEAT_SEC = 30;

export interface Args {
	spec?: string;
	config?: string;
	matrix?: string;
	workers?: string;
	noDeadlock: boolean;
	coverage: boolean;
	sanyOnly: boolean;
	out?: string;
	json?: string;
	codeRoot?: string;
	timeoutSec?: number;
	trace: boolean;
	fromLog?: string;
	extra: string[];
}

const USAGE = [
	"usage: bun tlc.ts <spec.tla> [--config X.cfg] [--matrix file.json] [--workers N|auto] [--no-deadlock]",
	"                   [--coverage] [--sany-only] [--out DIR] [--json FILE] [--code-root DIR] [--timeout SEC]",
	"                   [--trace] [-- extra TLC args]",
	"       bun tlc.ts --from-log <tlc-output.txt> [--spec Spec.tla] [--json FILE]",
].join("\n");

export function parseArgs(argv: string[]): Args {
	const args: Args = { noDeadlock: false, coverage: false, sanyOnly: false, trace: false, extra: [] };
	const value = (index: number, flag: string): string => {
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value\n${USAGE}`);
		return next;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--") {
			args.extra = argv.slice(i + 1);
			break;
		}
		if (arg === "--config") args.config = value(i++, arg);
		else if (arg === "--matrix") args.matrix = value(i++, arg);
		else if (arg === "--workers") args.workers = value(i++, arg);
		else if (arg === "--out") args.out = value(i++, arg);
		else if (arg === "--json") args.json = value(i++, arg);
		else if (arg === "--code-root") args.codeRoot = value(i++, arg);
		else if (arg === "--from-log") args.fromLog = value(i++, arg);
		else if (arg === "--spec") args.spec = value(i++, arg);
		else if (arg === "--timeout") {
			const seconds = Number(value(i++, arg));
			if (!Number.isFinite(seconds) || seconds < 0)
				throw new UsageError(`--timeout needs a number of seconds (0 means no limit)`);
			args.timeoutSec = seconds;
		} else if (arg === "--no-deadlock") args.noDeadlock = true;
		else if (arg === "--coverage") args.coverage = true;
		else if (arg === "--sany-only") args.sanyOnly = true;
		else if (arg === "--trace") args.trace = true;
		else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}\n${USAGE}`);
		else if (args.spec === undefined) args.spec = arg;
		else throw new UsageError(`unexpected argument ${arg}\n${USAGE}`);
	}
	if (args.workers !== undefined && args.workers !== "auto" && !/^[1-9]\d*$/.test(args.workers)) {
		throw new UsageError("--workers takes a positive integer or auto");
	}
	if (!args.spec && !args.fromLog) throw new UsageError(USAGE);
	if (args.matrix && args.config)
		throw new UsageError("--matrix and --config are exclusive: put the config in the matrix runs");
	return args;
}

interface RunReport {
	name?: string;
	config?: string;
	outcome: TlcResult["outcome"];
	property?: string;
	ok?: boolean;
	expect?: string;
	stats: TlcResult["stats"];
	durationMs?: number;
	/** The counterexample as `trace[]` of assets/findings.schema.json: paste it into a finding as it is. */
	trace: FindingsTraceRow[];
	/** The same states as `TraceRow`s (state number, step text, `code` list, `{from, to}` changes). */
	rows: TraceRow[];
	lasso?: TlcResult["lasso"];
	message?: string;
	tlcVersion?: string;
	logPath?: string;
	deadActions?: string[];
}

function reportOf(result: TlcResult, rows: TraceRow[], extra: Partial<RunReport>): RunReport {
	return {
		...extra,
		outcome: result.outcome,
		...(result.property ? { property: result.property } : {}),
		stats: result.stats,
		trace: toFindingsTrace(rows),
		rows,
		...(result.tlcVersion ? { tlcVersion: result.tlcVersion } : {}),
		...(result.lasso ? { lasso: result.lasso } : {}),
		...(result.message ? { message: result.message } : {}),
	};
}

function printTags(problems: TagProblem[]): void {
	for (const problem of problems) {
		console.log(`WARN  @code ${path.basename(problem.file)}:${problem.tag.line}: ${problem.problem}`);
	}
}

function printFailure(result: TlcResult, rows: TraceRow[], text: string): void {
	const verdict =
		result.outcome === "invariant" ||
		result.outcome === "action" ||
		result.outcome === "temporal" ||
		result.outcome === "deadlock" ||
		result.outcome === "assert";
	if (!verdict) {
		console.log("  No verdict about the model: TLC did not finish checking it.");
		if (result.message) console.log(`  ${result.message}`);
	}
	if (rows.length > 0) {
		console.log(`Trace (${rows.length} states, shortest first):`);
		console.log(formatTrace(rows, result));
		return;
	}
	const detail = result.errors.length
		? result.errors
		: text
				.split(/\r?\n/)
				.filter(line => line.trim())
				.slice(-25);
	for (const line of detail.slice(0, 25)) console.log(`  ${line}`);
}

async function explainLog(args: Args): Promise<number> {
	const file = path.resolve(args.fromLog as string);
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw new UsageError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const result = parseTlcOutput(text);
	const rows = reduceTrace(result.trace, {
		outcome: result.outcome,
		...(args.spec ? { definitions: definitionLoader(args.spec) } : {}),
	});
	const verdict = result.outcome === "pass" ? "PASS" : "FAIL";
	console.log(`${verdict}  ${describeOutcome(result)}  (${formatStats(result.stats) || "no statistics in the log"})`);
	if (result.outcome !== "pass") printFailure(result, rows, text);
	if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(reportOf(result, rows, {}), null, 2)}\n`);
	return result.outcome === "pass" ? EXIT.ok : EXIT.failed;
}

/**
 * SANY alone accepts what TLC then rejects: an operator from a module the spec did not EXTEND (`-1` without
 * `EXTENDS Integers`, `\\div`, `Len`) parses, and TLC fails while it loads the module ("Could not find declaration or
 * definition of symbol '-.'"). So after SANY this also starts TLC for one simulated step of depth 1: it loads the
 * module exactly as a real run does, and a rejection fails here too. A config is needed for that; without one the
 * result says the TLC load check did not run.
 */
async function sanyOnly(tla: TlaEnv, spec: string, specDir: string, run: MatrixRun | undefined): Promise<number> {
	const name = path.basename(spec);
	const sany = await runSany(tla, spec);
	if (sany.code !== 0) {
		console.log(`FAIL  SANY found errors: ${name}`);
		console.log(
			sany.text
				.split(/\r?\n/)
				.filter(line => !/^(Parsing file|Semantic processing)/.test(line) && line.trim())
				.slice(0, 40)
				.join("\n"),
		);
		return EXIT.failed;
	}
	const config = path.resolve(specDir, run?.config ?? `${path.basename(spec, ".tla")}.cfg`);
	if (!fs.existsSync(config)) {
		console.log(`PASS  SANY parsed and level-checked: ${name}`);
		console.log(
			"WARN  no config, so TLC's own load check did not run: SANY does not catch an operator whose module is not EXTENDed (`-1` needs Integers). Add a config and rerun.",
		);
		return EXIT.ok;
	}
	const load = await runTlc({
		tla,
		spec,
		config,
		constants: run?.constants,
		workers: "1",
		deadlock: false,
		extraArgs: ["-simulate", "num=1", "-depth", "1"],
		timeoutMs: 60_000,
	});
	if (load.spawnError) {
		console.log(`UNAVAILABLE  java could not be started: ${load.spawnError}`);
		return EXIT.unavailable;
	}
	const { outcome } = load.result;
	if (outcome === "parse-error" || outcome === "error") {
		console.log(`FAIL  SANY passed but TLC rejects the spec: ${name}`);
		console.log(`  ${load.result.message ?? load.result.errors[0] ?? "TLC could not load the model"}`);
		console.log("  (a missing EXTENDS Integers/Sequences/FiniteSets is the usual cause: references/tla-pitfalls.md)");
		return EXIT.failed;
	}
	console.log(`PASS  SANY parsed and level-checked, and TLC loads the model: ${name}`);
	if (outcome === "timeout") console.log("WARN  the TLC load check timed out after 60 s: only SANY's verdict stands");
	return EXIT.ok;
}

/** A run's time limit in ms: the given seconds, DEFAULT_TIMEOUT_SEC when none is given, no limit for 0. */
export function timeoutMsFor(seconds: number | undefined): number | undefined {
	const limit = seconds ?? DEFAULT_TIMEOUT_SEC;
	return limit === 0 ? undefined : limit * 1000;
}

export async function main(argv: string[]): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(argv);
		if (args.fromLog) return await explainLog(args);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			return EXIT.usage;
		}
		throw error;
	}
	const spec = path.resolve(args.spec as string);
	if (!fs.existsSync(spec)) {
		console.error(`spec not found: ${spec}`);
		return EXIT.usage;
	}
	let runs: MatrixRun[];
	try {
		runs = args.matrix
			? parseMatrix(readJson(path.resolve(args.matrix)))
			: [
					{
						name: path.basename(args.config ?? `${path.basename(spec, ".tla")}.cfg`),
						expect: "pass",
						...(args.config
							? { config: fs.existsSync(path.resolve(args.config)) ? path.resolve(args.config) : args.config }
							: {}),
					},
				];
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const specDir = path.dirname(spec);
	for (const run of runs) {
		const config = path.resolve(specDir, run.config ?? `${path.basename(spec, ".tla")}.cfg`);
		if (!args.sanyOnly && !fs.existsSync(config)) {
			console.error(`config not found: ${config}`);
			return EXIT.usage;
		}
	}
	const codeRoot = args.codeRoot ? path.resolve(args.codeRoot) : findCodeRoot(specDir);
	let tla: TlaEnv;
	try {
		tla = await prepareTla();
	} catch (error) {
		if (error instanceof Unavailable) {
			console.log(`UNAVAILABLE  TLC could not be prepared: ${error.message}`);
			console.log("  Report this check as not run. Install Java 11+ or retry with network access.");
			return EXIT.unavailable;
		}
		throw error;
	}
	if (args.sanyOnly) return sanyOnly(tla, spec, specDir, runs[0]);
	for (const warning of matrixWarnings(args.matrix ? runs : [])) console.log(`WARN  ${warning}`);
	const definitions = definitionLoader(spec);
	printTags(checkTags(extractTags(fs.readFileSync(spec, "utf8")), spec, codeRoot));
	console.log(
		`TLC (tla2tools release ${tla.tlaVersion})  java ${tla.javaMajor} (${tla.javaSource})  spec ${path.basename(spec)}`,
	);
	let bannerShown = false;
	const reports: RunReport[] = [];
	let bad = 0;
	for (const run of runs) {
		const runStarted = Date.now();
		let lastOutput = runStarted;
		const heartbeat = setInterval(() => {
			if (Date.now() - lastOutput < HEARTBEAT_SEC * 1000) return;
			lastOutput = Date.now();
			console.log(`  ... ${run.name} still running (${Math.round((Date.now() - runStarted) / 1000)} s)`);
		}, 5000);
		const tlcRun = await runTlc({
			tla,
			spec,
			config: path.resolve(specDir, run.config ?? `${path.basename(spec, ".tla")}.cfg`),
			constants: run.constants,
			workers: run.workers ?? args.workers,
			deadlock: run.deadlock === false || args.noDeadlock ? false : undefined,
			coverage: args.coverage,
			extraArgs: [...(run.args ?? []), ...args.extra],
			timeoutMs: timeoutMsFor(run.timeoutSec ?? args.timeoutSec),
			outDir: args.out ? path.resolve(args.out) : undefined,
			onProgress: line => {
				// TLC prints one last Progress line when a short run ends: noise unless the run took a while.
				if (Date.now() - runStarted < 10_000) return;
				lastOutput = Date.now();
				console.log(`  ${line}`);
			},
		}).finally(() => clearInterval(heartbeat));
		if (tlcRun.spawnError) {
			console.log(`UNAVAILABLE  java could not be started: ${tlcRun.spawnError}`);
			return EXIT.unavailable;
		}
		const { result } = tlcRun;
		if (!bannerShown && result.tlcVersion) {
			bannerShown = true;
			console.log(`  TLC reports itself as version ${result.tlcVersion}`);
		}
		if (result.outcome === "timeout") {
			const limit = run.timeoutSec ?? args.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
			result.message = `stopped after ${limit} s without a verdict${args.timeoutSec === undefined && run.timeoutSec === undefined ? " (the default limit)" : ""}: raise --timeout SEC, use --timeout 0 for no limit, or shrink the bounds`;
		}
		const rows = reduceTrace(result.trace, { definitions, outcome: result.outcome });
		const seconds = (tlcRun.durationMs / 1000).toFixed(1);
		const stats = formatStats(result.stats);
		const dead = args.coverage ? deadActions(tlcRun.text) : undefined;
		const judged = judge(run, result);
		const matrixMode = Boolean(args.matrix);
		if (!matrixMode) {
			console.log(
				`${result.outcome === "pass" ? "PASS" : "FAIL"}  ${describeOutcome(result)}  (${stats || "no statistics"}, ${seconds}s)`,
			);
			if (result.outcome !== "pass") printFailure(result, rows, tlcRun.text);
			if (result.outcome === "pass" && result.warnings.length)
				for (const warning of result.warnings) console.log(`WARN  ${warning}`);
		} else {
			const label = judged.ok ? "ok  " : "FAIL";
			console.log(`${label}  ${run.name}: ${judged.reason}  (${stats || "no statistics"}, ${seconds}s)`);
			if (!judged.ok || args.trace) {
				if (result.outcome !== "pass") printFailure(result, rows, tlcRun.text);
			}
		}
		if (dead?.length) console.log(`WARN  actions never enabled (dead code in the model?): ${dead.join(", ")}`);
		if (tlcRun.logPath) console.log(`log: ${tlcRun.logPath}`);
		if (!judged.ok) bad++;
		reports.push(
			reportOf(result, rows, {
				name: run.name,
				config: path.relative(specDir, tlcRun.configUsed),
				ok: judged.ok,
				expect: run.expect,
				durationMs: tlcRun.durationMs,
				...(tlcRun.logPath ? { logPath: tlcRun.logPath } : {}),
				...(dead ? { deadActions: dead } : {}),
			}),
		);
	}
	if (args.matrix) {
		console.log(
			bad === 0
				? `PASS  matrix: all ${runs.length} runs ended as expected`
				: `FAIL  matrix: ${bad} of ${runs.length} runs did not end as expected`,
		);
	}
	if (args.json) {
		fs.writeFileSync(
			path.resolve(args.json),
			`${JSON.stringify(args.matrix ? { spec, runs: reports } : { spec, ...reports[0] }, null, 2)}\n`,
		);
	}
	return bad === 0 ? EXIT.ok : EXIT.failed;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
