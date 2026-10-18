/**
 * What a finished card's findings row offers, derived from the run's ledger alone (no model call):
 * the failing step, the passing test run, the dev server a command started, and the plain-text
 * summary the row copies. Pure; `ExecutionGroup.tsx` draws it.
 */
import { type CheckInput, type CheckSummary, firstErrorLine, firstFailure } from "./work-checks";

export interface WorkFindings {
	/** Something failed: the cause line when the output says one, and the call to show. */
	error?: { cause?: string; toolCallId?: string };
	/** The last test run passed: its count when the runner printed one. */
	tests?: { count?: number; toolCallId?: string };
	/** The address a dev server printed (the last one). */
	previewUrl?: string;
}

export interface FindingsInput {
	/** The card is still running: nothing is concluded yet. */
	running: boolean;
	checks: readonly CheckSummary[];
	commands: readonly (CheckInput & { previewUrl?: string })[];
	/** The first failed call of the card (any tool), for a failure that is no command's. */
	failedStep?: string;
}

export function deriveFindings({ running, checks, commands, failedStep }: FindingsInput): WorkFindings {
	if (running) return {};
	const findings: WorkFindings = {};
	const failedCheck = checks.find(check => !check.passed);
	const failure = failedCheck ? undefined : firstFailure(commands);
	const cause = failedCheck?.cause ?? (failure?.text ? firstErrorLine(failure.text) : undefined);
	const toolCallId = failedCheck?.toolCallId ?? failure?.toolCallId ?? failedStep;
	if (failedCheck || failure || failedStep) {
		findings.error = { ...(cause ? { cause } : {}), ...(toolCallId ? { toolCallId } : {}) };
	}
	const tests = checks.find(check => check.kind === "test" && check.passed);
	if (tests) {
		findings.tests = {
			...(tests.tests?.passed !== undefined ? { count: tests.tests.passed } : {}),
			...(tests.toolCallId ? { toolCallId: tests.toolCallId } : {}),
		};
	}
	const previewUrl = commands.findLast(command => command.previewUrl)?.previewUrl;
	if (previewUrl) findings.previewUrl = previewUrl;
	return findings;
}

export interface WorkSummaryInput {
	/** The head as shown: its time and facts. */
	head: string;
	cause?: string;
	files: readonly { path: string; added?: number; removed?: number; deleted?: boolean }[];
	/** Each check as the head words it ("128 tests passed", "type check failed"). */
	checks: readonly { passed: boolean; label: string }[];
	previewUrl?: string;
	/** Already in the UI's language. */
	labels: { cause: string; changed: string; checks: string; preview: string; deleted: string };
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
	if (input.previewUrl) blocks.push(`${input.labels.preview}: ${input.previewUrl}`);
	return blocks.join("\n\n");
}
