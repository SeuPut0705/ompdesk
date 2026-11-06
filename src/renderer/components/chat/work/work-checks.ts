/**
 * The work card's verdict: from a run's calls (each command's `CommandStatus`, `command-verdict-core.ts`, and the main
 * agent's other calls, `stepOperations`), which failures still stand at its end, which of them the work ended on (its
 * turn's `TurnScope`), what each check kind says and the one failure to show (`workVerdict`). The card's mark, head,
 * verdict blocks and chips and the work board's check row all read this one function; nothing else decides whether a
 * run's call failed.
 */
import {
	CHECK_KINDS,
	type CheckKind,
	type CommandStatus,
	checkKind,
	checkKinds,
	coveredBy,
	filtersOutput,
	isProbe,
	leadingCd,
	passedKinds,
	retriesChain,
	testCounts,
} from "../../../../../resources/gui-bridge/command-verdict-core";
import { TURN_EDIT_TOOLS } from "../../../../shared/turn-edits";
import { agentDesktopCall, agentDesktopTargetKey } from "../../../lib/agent-desktop-name";
import { xdevWriteTarget } from "../../../lib/xdev";
import { editArgumentPaths, workFilePathKey } from "../../tools/edit-args";

const ERROR_LINE = /(?:\berror\b|\bfailed\b|\bfail\b|[✕✖✗✘×❌]|\bexception\b|\bpanic\b|cannot |not found|\bTS\d{4}\b)/i;
// Runner chrome that names failure without saying what failed.
const NOISE_LINE =
	/^(?:[-=─━\s]+|\d+\s+(?:tests?\s+)?fail(?:ed|ures?)?.*|test files?.*|tests?\s*:.*|error: script ".*" exited.*|exit (?:code|status) \d+|command exited with code \d+|npm err!\s*$|wall time: .*|\[raw output: .*|\[showing .*|\[some lines truncated .*|\[command (?:aborted|cancelled)\])$/i;
const ERROR_LINE_MAX = 140;

/** The first line of a failed command's output that says what went wrong, else its last line. */
export function firstErrorLine(output: string): string | undefined {
	const lines = output
		.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	const hit =
		lines.find(line => ERROR_LINE.test(line) && !NOISE_LINE.test(line)) ??
		lines.findLast(line => !NOISE_LINE.test(line));
	if (!hit) return undefined;
	return hit.length > ERROR_LINE_MAX ? `${hit.slice(0, ERROR_LINE_MAX - 1)}…` : hit;
}

/** One command of a run, as its verdict reads it (`WorkCommandOutcome` carries more for display). */
export interface CommandCall {
	command: string;
	/** How the call ended (`commandStatus`): the only verdict of a command. */
	status: CommandStatus;
	exitCode: number | null;
	/** The tail of what a check or a failed command printed. */
	text?: string;
	/** The call's entry key (a main-agent call only). */
	toolCallId?: string;
	cwd?: string;
	agentName?: string;
	startTime?: number;
	endTime?: number;
	/** Backgrounded: a failure the transcript also reports (`failedEvents`), which nothing resolves. */
	background?: true;
	/** Stock answered the call itself with an error: a standing one counts in the head's "N failed". */
	toolError?: true;
}

export interface CheckSummary {
	kind: CheckKind;
	/** The kind's last run passed and none of its failures is unresolved. */
	passed: boolean;
	runs: number;
	exitCode: number | null;
	tests?: { passed?: number; failed?: number };
	/** Why the last failing run failed, one line. */
	cause?: string;
	/** The call to open for that failure. */
	toolCallId?: string;
}

export interface OperationCall {
	toolName: string;
	args: Record<string, unknown>;
	/** How the call settled; none while it runs, when it was cut off, refused or when its result never came. */
	outcome?: "passed" | "failed";
	exitCode?: number | null;
	/** Neither fails nor fixes anything: a read, a search, a wait. */
	inert?: boolean;
	/** A subagent's call: its success resolves only its own failures (an isolated task runs in its own checkout). */
	agentName?: string;
	startTime?: number;
	endTime?: number;
	/** A failure the transcript reports on its own (`failedEvents`): nothing resolves it. */
	reported?: boolean;
	/** A command's printed output (`CommandCall.text`, kept for failed commands): what says why it exited as it did. */
	text?: string;
}

/** A command as the settle rules compare calls: a passed or failed one has an outcome, nothing else does. */
export function commandOperation<T extends CommandCall>(command: T): T & OperationCall {
	return {
		...command,
		toolName: "bash",
		args: { command: command.command, ...(command.cwd ? { cwd: command.cwd } : {}) },
		...(command.status === "passed" || command.status === "failed" ? { outcome: command.status } : {}),
		...(command.status === "failed" && command.background ? { reported: true } : {}),
	};
}

// A hashline header's tag as the model wrote it: `#2C1F`, but also `#?`, `#ANY`, `#`, `#*`, `#2C FB`. Stock's preview
// strips only a 4-hex tag, so a rejected edit's key must drop whatever tag follows the path's last `/`.
const HASHLINE_TAG = /#[^/]*$/;

// A command's key by its folder, the session's folder and its raw text: a card's commands are settled again on every
// tool event.
const commandKeys = new Map<string, string>();

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.filter(key => key !== "i" && key !== "intent")
			.sort()
			.map(key => [key, canonical((value as Record<string, unknown>)[key])]),
	);
}

/**
 * What makes a later call the same call: a command's text (whitespace collapsed) in its folder (stock bash `cwd`, else
 * the session's, then a leading `cd <dir> &&`); each file an edit touches; an agent-desktop action, its command and the
 * element it acts on (`agentDesktopTargetKey`); any other tool, an `xd://` write included, its arguments (the model's
 * intent aside). Empty for an edit without a path: nothing resolves it.
 */
export function callKeys(call: OperationCall, cwd = ""): readonly string[] {
	const { command, cwd: folder } = call.args;
	if (call.toolName === "bash" && typeof command === "string") {
		const base = typeof folder === "string" && folder ? folder : cwd;
		const memo = `${base}\0${cwd}\0${command}`;
		let key = commandKeys.get(memo);
		if (key === undefined) {
			if (commandKeys.size >= 16_384) commandKeys.clear();
			let dir = workFilePathKey(base, cwd);
			let text = command.trim().replace(/\s+/g, " ");
			const cd = leadingCd(text);
			if (cd) {
				dir = workFilePathKey(cd.dir, dir);
				text = cd.rest;
			}
			key = `bash\0${dir}\0${text}`;
			commandKeys.set(memo, key);
		}
		return [key];
	}
	// Stock's arguments object of a call never changes once the call is made: its keys are read once per folder.
	const cached = argumentKeys.get(call.args);
	if (cached?.cwd === cwd && cached.toolName === call.toolName) return cached.keys;
	const desktop = agentDesktopCall(call.toolName, call.args);
	const keys = desktop
		? [agentDesktopTargetKey(desktop)]
		: TURN_EDIT_TOOLS.includes(call.toolName) && !xdevWriteTarget(call.args)
			? [
					...new Set(
						editArgumentPaths(call.args).map(
							path => `edit\0${workFilePathKey(path.replace(HASHLINE_TAG, ""), cwd)}`,
						),
					),
				]
			: [`${call.toolName}\0${JSON.stringify(canonical(call.args))}`];
	argumentKeys.set(call.args, { cwd, toolName: call.toolName, keys });
	return keys;
}

const argumentKeys = new WeakMap<object, { cwd: string; toolName: string; keys: readonly string[] }>();

// A command as two runs are compared: the folder `callKeys` resolved for it, its text and output.
function ran(call: OperationCall, cwd: string) {
	return {
		dir: (callKeys(call, cwd)[0] ?? "").split("\0")[1] ?? "",
		command: String(call.args.command),
		...(call.text !== undefined ? { text: call.text } : {}),
	};
}

const asksOnly = (call: OperationCall) =>
	call.toolName === "bash" &&
	typeof call.args.command === "string" &&
	isProbe(call.args.command, call.exitCode, call.text);

/**
 * The failed calls, in order, split by whether a successful call of the same call (`callKeys`; an edit, of every file
 * it touched), or for a check a later passing check that covers it (`coveredBy`), started after the failure ended: the
 * main agent's success resolves anyone's failure, a subagent's only its own. Probes and inert calls are neither
 * failures nor fixes; a reported failure is never resolved. `later`: the main agent's successes elsewhere in the turn
 * (`TurnScope.fixes`, a later card's), held to the same rules.
 */
export function settleFailures<T extends OperationCall>(
	calls: readonly T[],
	cwd = "",
	later: readonly OperationCall[] = [],
): { unresolved: T[]; recovered: T[] } {
	const unresolved: T[] = [];
	const recovered: T[] = [];
	// Only a success after a failure of the same tool can fix anything: a card without failures keys nothing.
	const counts = (call: OperationCall | undefined): call is OperationCall =>
		!!call?.outcome && !call.inert && !asksOnly(call);
	const first = calls.findIndex(call => call.outcome === "failed" && counts(call));
	if (first < 0) return { unresolved, recovered };
	const family = (call: OperationCall) =>
		TURN_EDIT_TOOLS.includes(call.toolName) && !xdevWriteTarget(call.args) ? "edit" : call.toolName;
	const failed = new Set(calls.slice(first).flatMap(call => (call.outcome === "failed" ? [family(call)] : [])));
	const fixes = new Map<string, OperationCall[]>();
	const passedChecks: OperationCall[] = [];
	const passedCommands: OperationCall[] = [];
	const fix = (call: OperationCall) => {
		if (!counts(call) || call.outcome !== "passed" || !failed.has(family(call))) return;
		for (const key of callKeys(call, cwd)) fixes.set(key, [...(fixes.get(key) ?? []), call]);
		if (call.toolName === "bash" && typeof call.args.command === "string") {
			passedCommands.push(call);
			if (checkKinds(call.args.command, true).length > 0) passedChecks.push(call);
		}
	};
	// A later card's success fixes this card's failure only when it started after the failure ended (`fixedBy`).
	for (const call of later) fix(call);
	for (let index = calls.length - 1; index >= first; index--) {
		const call = calls[index];
		if (!counts(call)) continue;
		if (call.outcome === "passed") {
			fix(call);
			continue;
		}
		const keys = callKeys(call, cwd);
		const fixedBy = (fix: OperationCall) =>
			(fix.agentName === undefined || fix.agentName === call.agentName) &&
			(fix.startTime === undefined || call.endTime === undefined || fix.startTime >= call.endTime);
		const resolved =
			!call.reported &&
			((keys.length > 0 && keys.every(key => fixes.get(key)?.some(fixedBy))) ||
				(call.toolName === "bash" &&
					typeof call.args.command === "string" &&
					(passedChecks.some(fix => fixedBy(fix) && coveredBy(ran(call, cwd), ran(fix, cwd))) ||
						passedCommands.some(fix => fixedBy(fix) && retriesChain(ran(call, cwd), ran(fix, cwd))))));
		(resolved ? recovered : unresolved).unshift(call);
	}
	return { unresolved, recovered };
}

/**
 * Where a card's run stands in its turn (the user prompt's run, every card of it). The owner's rule (6 Nov 2026, after
 * "왜 오류를 끝난 것처럼 보이게 만드냐"): a card is red only when the work ended in an error. While the turn runs, no
 * failure is. Once it ended or was stopped, only (a) the turn's last step, failed with nothing after it, (b) any failure
 * nothing fixed on the card right before a turn's own error end (a failed reply, omp's exit), and (c) a check kind's
 * last run of the turn, failed. Every other failure, fixed later or one the work went on past, is a quiet note.
 */
export interface TurnScope {
	running: boolean;
	/** The main agent's successful calls of the whole turn (`turnScope`): a later card's fixes this card's failure. */
	fixes: readonly OperationCall[];
	/** The entry key of the turn's last main-agent call: its failure is the work's end (a). */
	lastStep?: string;
	/** When each check kind's last main-agent run of the turn started (c). */
	lastRuns: ReadonlyMap<CheckKind, number>;
	/** The turn ended in an error right after this card: every failure on it nothing fixed is the work's end (b). */
	failedEnd: boolean;
}

/** The check kinds one run counts for: a failed run its one kind, a passed run each kind its exit or output proves. */
export function runKinds(command: CommandCall): CheckKind[] {
	if (command.status === "failed") {
		// A failed run names the one kind it runs: which of several failed, only its output could say.
		const kind = checkKind(command.command);
		return kind ? [kind] : [];
	}
	if (command.status !== "passed") return [];
	const kinds = checkKinds(command.command, true);
	// A run that mixes kinds is a pass of each kind its exit or output proves; a type check cut by a filter proves none.
	return (kinds.length <= 1 ? kinds : passedKinds(command.command, command.text)).filter(
		kind => !(kind === "typecheck" && filtersOutput(command.command, kind)),
	);
}

/** Whether a failure nothing fixed is the work's end (`TurnScope`); without a scope, every one is. */
function endsWork(
	operations: readonly (CommandCall & OperationCall)[],
	scope: TurnScope | undefined,
): (call: OperationCall & { toolCallId?: string }) => boolean {
	if (!scope || scope.failedEnd) return () => !scope?.running;
	if (scope.running) return () => false;
	const lastOfKind = new Map<CheckKind, OperationCall>();
	for (const operation of operations) for (const kind of runKinds(operation)) lastOfKind.set(kind, operation);
	return call => {
		if (call.toolCallId !== undefined && call.toolCallId === scope.lastStep) return true;
		const kind = call.toolName === "bash" && typeof call.args.command === "string" && checkKind(call.args.command);
		return (
			!!kind &&
			lastOfKind.get(kind) === call &&
			(scope.lastRuns.get(kind) ?? Number.NEGATIVE_INFINITY) <= (call.startTime ?? Number.POSITIVE_INFINITY)
		);
	};
}

/** One of the main agent's other calls that can decide the verdict (`stepOperations`). */
export type StepCall = OperationCall & { toolCallId: string };

export interface WorkVerdict<C extends CommandCall = CommandCall> {
	/**
	 * Per check kind, its last run, unless a failed run of it still stands: then that one. Failed first, then kind order.
	 * A kind whose last run failed without being the work's end is left out: its note says it.
	 */
	checks: CheckSummary[];
	/** Commands that failed, that no later call fixed and that the work ended on (`TurnScope`), in order. */
	failedCommands: (C & OperationCall)[];
	/** The main agent's other calls that failed, that no later call fixed and that the work ended on, in order. */
	failedSteps: StepCall[];
	/** Failures a later call fixed: the card's note and Copy summary list them. */
	recovered: OperationCall[];
	/** Failures nothing fixed that the work did not end on (the turn runs on, or went past them): a note, never red. */
	passedOver: OperationCall[];
	/** The main agent's calls stock answered with an error that the work ended on: the head's "N failed". */
	failedCalls: number;
	/** What made the run red, the failing check first, else the newest failed command, else the first failed step. */
	error?: { cause?: string; toolCallId?: string };
}

/**
 * The one verdict of a run: which failures stand at its end (`settleFailures`, commands and the main agent's other
 * calls apart), which of those the work ended on (`scope`, the card's turn; without one, every one), what each check
 * kind says, and the failure to show. A run is red when `error` is set.
 */
export function workVerdict<C extends CommandCall>(
	commands: readonly C[],
	cwd = "",
	steps: readonly StepCall[] = [],
	scope?: TurnScope,
): WorkVerdict<C> {
	const operations = commands.map(commandOperation);
	const fromCommands = settleFailures(operations, cwd, scope?.fixes);
	const fromSteps = settleFailures(steps, cwd, scope?.fixes);
	const ends = endsWork(operations, scope);
	const failedCommands = fromCommands.unresolved.filter(ends);
	const failedSteps = fromSteps.unresolved.filter(ends);
	const checks = summarize(operations, new Set<CommandCall>(failedCommands), scope !== undefined);
	const failedCheck = checks.find(check => !check.passed);
	const failure = failedCheck ? undefined : failedCommands.findLast(call => !checkKind(call.command));
	const failedStep = failedSteps[0]?.toolCallId;
	const cause = failedCheck?.cause ?? (failure?.text ? firstErrorLine(failure.text) : undefined);
	const toolCallId = failedCheck?.toolCallId ?? failure?.toolCallId ?? failedStep;
	return {
		checks,
		failedCommands,
		failedSteps,
		recovered: [...fromCommands.recovered, ...fromSteps.recovered],
		passedOver: [...fromCommands.unresolved, ...fromSteps.unresolved].filter(call => !ends(call)),
		failedCalls: failedCommands.filter(call => call.toolCallId && call.toolError).length + failedSteps.length,
		...(failedCheck || failure || failedStep
			? { error: { ...(cause ? { cause } : {}), ...(toolCallId ? { toolCallId } : {}) } }
			: {}),
	};
}

/** `judged`: a kind whose last run failed without standing (a note, `TurnScope`) says nothing. */
function summarize(
	commands: readonly CommandCall[],
	standing: ReadonlySet<CommandCall>,
	judged: boolean,
): CheckSummary[] {
	const calls = commands.flatMap(command =>
		runKinds(command).map(kind => ({ command, kind, failed: command.status === "failed" })),
	);
	const byKind = new Map<CheckKind, { entry: (typeof calls)[number]; runs: number }>();
	for (const entry of calls) {
		const seen = byKind.get(entry.kind);
		const keep = seen && standing.has(seen.entry.command) && !standing.has(entry.command);
		byKind.set(entry.kind, { entry: keep ? seen.entry : entry, runs: (seen?.runs ?? 0) + 1 });
	}
	return [...byKind.values()]
		.filter(({ entry }) => !judged || !entry.failed || standing.has(entry.command))
		.map(({ entry: { command, kind, failed }, runs }): CheckSummary => {
			const text = command.text ?? "";
			const tests = kind === "test" ? testCounts(text) : undefined;
			const cause = failed ? firstErrorLine(text) : undefined;
			return {
				kind,
				passed: !failed,
				runs,
				exitCode: command.exitCode,
				...(tests && (tests.passed !== undefined || tests.failed !== undefined) ? { tests } : {}),
				...(cause ? { cause } : {}),
				...(command.toolCallId ? { toolCallId: command.toolCallId } : {}),
			};
		})
		.sort((a, b) => Number(a.passed) - Number(b.passed) || CHECK_KINDS.indexOf(a.kind) - CHECK_KINDS.indexOf(b.kind));
}
