/**
 * What a finished card's findings offer, derived from the run's ledger alone (no model call): the
 * failing step, the dev server a command started, and the plain-text summary Copy puts on the
 * clipboard. Pure; `ExecutionGroup.tsx` draws it.
 */
import { TURN_EDIT_TOOLS } from "../../../../shared/turn-edits";
import { xdevWriteTarget } from "../../../lib/xdev";
import type { ToolEntry } from "../../../stores/tools";
import { editArgumentPaths } from "../../tools/edit-args";
import { getToolActivity } from "../../tools/index";
import { isInterruptedError } from "./WorkStatus";
import { type CheckInput, type CheckSummary, firstErrorLine, type OperationCall } from "./work-checks";
import { projectPath } from "./work-run";
import { guardRefusal } from "./work-view";

export interface WorkFindings {
	/** Something failed: the cause line when the output says one, and the call to show. */
	error?: { cause?: string; toolCallId?: string };
	/** The address a dev server printed (the last one). */
	previewUrl?: string;
}

export interface FindingsInput {
	/** The card is still running: nothing is concluded yet. */
	running: boolean;
	checks: readonly CheckSummary[];
	/** Failed commands that are no check and that no later run of the same command fixed (`settleFailures`). */
	failures: readonly CheckInput[];
	commands: readonly { previewUrl?: string }[];
	/** The first unfixed failed call of another tool, for a failure that is no command's. */
	failedStep?: string;
}

export function deriveFindings({ running, checks, failures, commands, failedStep }: FindingsInput): WorkFindings {
	if (running) return {};
	const findings: WorkFindings = {};
	const failedCheck = checks.find(check => !check.passed);
	const failure = failedCheck ? undefined : failures.at(-1);
	const cause = failedCheck?.cause ?? (failure?.text ? firstErrorLine(failure.text) : undefined);
	const toolCallId = failedCheck?.toolCallId ?? failure?.toolCallId ?? failedStep;
	if (failedCheck || failure || failedStep) {
		findings.error = { ...(cause ? { cause } : {}), ...(toolCallId ? { toolCallId } : {}) };
	}
	const previewUrl = commands.findLast(command => command.previewUrl)?.previewUrl;
	if (previewUrl) findings.previewUrl = previewUrl;
	return findings;
}

/**
 * The card's main-agent calls other than commands (those come from the ledger, `commandOperation`) that can decide its
 * verdict: each settled failed call that is no read, search or `wait`, and the later calls of the same tool, the only
 * ones that can fix it. A card without such a failure has none, and costs nothing past the scan.
 */
export function stepOperations(
	entries: readonly (readonly [string, ToolEntry])[],
	stoppedAt?: number,
): (OperationCall & { toolCallId: string })[] {
	const settled = (entry: ToolEntry) =>
		entry.status !== "aborted" &&
		entry.status !== "pending" &&
		entry.status !== "running" &&
		!isInterruptedError(entry, stoppedAt);
	// A call the shared-checkout guard refused is protection: neither a failure nor a fix.
	const failure = (entry: ToolEntry) =>
		entry.toolName !== "bash" &&
		(entry.status === "error" || entry.isError) &&
		settled(entry) &&
		guardRefusal(entry) === null &&
		entry.toolName !== "wait" &&
		(TURN_EDIT_TOOLS.includes(entry.toolName) ||
			!["read", "search"].includes(getToolActivity(entry.toolName, entry.args).activity));
	const first = entries.findIndex(([, entry]) => failure(entry));
	if (first < 0) return [];
	// Every edit tool fixes a file the same way (`callKeys`): they are one tool here.
	const family = (entry: ToolEntry) =>
		TURN_EDIT_TOOLS.includes(entry.toolName) && !xdevWriteTarget(entry.args) ? "edit" : entry.toolName;
	const tools = new Set(entries.slice(first).flatMap(([, entry]) => (failure(entry) ? [family(entry)] : [])));
	return entries.slice(first).flatMap(([toolCallId, entry]) => {
		if (!tools.has(family(entry)) || !settled(entry)) return [];
		const failed = entry.status === "error" || entry.isError;
		if (failed && !failure(entry)) return [];
		return [
			{
				toolCallId,
				toolName: entry.toolName,
				args: entry.args,
				startTime: entry.startTime,
				...(entry.endTime !== null ? { endTime: entry.endTime } : {}),
				outcome: failed ? ("failed" as const) : ("passed" as const),
			},
		];
	});
}

/** A call in one line for Copy summary: the command as typed, the files an edit touched, the device written. */
export function operationLabel(call: OperationCall, cwd: string): string {
	if (typeof call.args.command === "string") {
		const command = call.args.command.trim().replace(/\s+/g, " ");
		return command.length > 80 ? `${command.slice(0, 79)}…` : command;
	}
	const device = call.toolName === "write" ? xdevWriteTarget(call.args) : null;
	if (device) return `xd://${device}`;
	const paths = editArgumentPaths(call.args).map(path => projectPath(path, cwd));
	return paths.length ? `${call.toolName} ${paths.join(", ")}` : call.toolName;
}

export interface WorkSummaryInput {
	/** The head as shown: its time and facts. */
	head: string;
	cause?: string;
	files: readonly { path: string; added?: number; removed?: number; deleted?: boolean }[];
	/** Each check as the head words it ("128 tests passed", "type check failed"). */
	checks: readonly { passed: boolean; label: string }[];
	/** Each failed call a later run of the same call fixed (`operationLabel`). */
	recovered: readonly string[];
	previewUrl?: string;
	/** Already in the UI's language. */
	labels: { cause: string; changed: string; checks: string; recovered: string; preview: string; deleted: string };
}

/** The card as plain text a person can paste into a message or a ticket. */
export function workSummaryText(input: WorkSummaryInput): string {
	const blocks = [input.head];
	if (input.cause) blocks.push(`${input.labels.cause}: ${input.cause}`);
	if (input.files.length) {
		const lines = input.files.map(file =>
			file.deleted
				? `- ${file.path} (${input.labels.deleted})`
				: file.added !== undefined
					? `- ${file.path} +${file.added} -${file.removed ?? 0}`
					: `- ${file.path}`,
		);
		blocks.push([input.labels.changed, ...lines].join("\n"));
	}
	if (input.checks.length) {
		blocks.push(
			[input.labels.checks, ...input.checks.map(check => `- ${check.passed ? "✓" : "✕"} ${check.label}`)].join("\n"),
		);
	}
	if (input.recovered.length) {
		blocks.push([input.labels.recovered, ...input.recovered.map(label => `- ✕ → ✓ ${label}`)].join("\n"));
	}
	if (input.previewUrl) blocks.push(`${input.labels.preview}: ${input.previewUrl}`);
	return blocks.join("\n\n");
}
