import type { AgentMessage } from "../../../shared/rpc-types";
import { resultDetails, resultText } from "../../lib/format";
import type { ToolEntry } from "../../stores/tools";

export interface LaunchCompletionDaemon {
	name: string;
	state?: string;
	exitCode?: number;
	startedAt?: number;
	exitedAt?: number;
}

export function isCompletionMessage(message: AgentMessage): boolean {
	return message.customType === "async-result" || message.customType === "launch-completion";
}

export function launchCompletionDaemons(message: AgentMessage): LaunchCompletionDaemon[] {
	if (message.customType !== "launch-completion") return [];
	if (typeof message.details !== "object" || message.details === null) return [];
	const daemons = (message.details as Record<string, unknown>).daemons;
	if (!Array.isArray(daemons)) return [];
	return daemons.flatMap(value => {
		if (typeof value !== "object" || value === null) return [];
		const daemon = value as Record<string, unknown>;
		if (typeof daemon.name !== "string" || daemon.name.trim() === "") return [];
		return [
			{
				name: daemon.name.trim(),
				state: typeof daemon.state === "string" ? daemon.state : undefined,
				exitCode: typeof daemon.exitCode === "number" ? daemon.exitCode : undefined,
				startedAt: typeof daemon.startedAt === "number" ? daemon.startedAt : undefined,
				exitedAt: typeof daemon.exitedAt === "number" ? daemon.exitedAt : undefined,
			},
		];
	});
}

/**
 * One delivered background job of stock's async-result notice (session/async-job-delivery.ts
 * `details.jobs`). `status` is the job manager's verdict: a bash job whose command exits
 * non-zero is "failed" (tools/bash.ts re-throws the completed result).
 */
export interface AsyncResultJob {
	jobId?: string;
	type?: string;
	status?: string;
	label?: string;
	durationMs?: number;
}

export function asyncResultJobs(message: AgentMessage): AsyncResultJob[] {
	if (message.customType !== "async-result" || typeof message.details !== "object" || message.details === null)
		return [];
	const jobs = "jobs" in message.details ? message.details.jobs : undefined;
	if (!Array.isArray(jobs)) return [];
	const text = (record: Record<string, unknown>, key: string) =>
		typeof record[key] === "string" ? record[key] : undefined;
	return jobs.flatMap(value => {
		if (typeof value !== "object" || value === null) return [];
		const job = value as Record<string, unknown>;
		return [
			{
				jobId: text(job, "jobId"),
				type: text(job, "type"),
				status: text(job, "status"),
				label: text(job, "label"),
				durationMs: typeof job.durationMs === "number" ? job.durationMs : undefined,
			},
		];
	});
}

/**
 * Failures a completion notice reports: failed supervised processes and failed background jobs.
 * A task job's own agent lane already reports its failure, so it is not counted twice.
 */
export function completionFailureCount(message: AgentMessage): number {
	return (
		launchCompletionDaemons(message).filter(
			daemon => daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0),
		).length + asyncResultJobs(message).filter(job => job.status === "failed" && job.type !== "task").length
	);
}

/** Stock's failure notice at the end of a failed bash job's delivered text (pi-tui tools/bash.ts `formatExitCodeNotice`). */
export function exitCodeOf(output: string | undefined): number | undefined {
	const code = output?.match(/Command exited with code (\d+)/)?.[1];
	return code === undefined ? undefined : Number(code);
}

/** Human delivery text shared by completion previews and expanded result parsing. */
export function completionNoticeText(content: string) {
	return content.replace(/<\/?system-notice\s*>/g, "").trim();
}

/**
 * Recover each job's result text from the agent-facing message content (a
 * `<system-notice>` block; multi-job batches split on `── Job <id> ──`
 * section headers). Best-effort: jobs without a recoverable section just
 * render their status row.
 */
export function asyncJobResults(content: string, jobs: AsyncResultJob[]): Map<string, string> {
	const results = new Map<string, string>();
	const body = completionNoticeText(content);
	if (!body) return results;
	const sectionRe = /^── Job (\S+)(?:\s+\([^)]*\))? ──\s*$/gm;
	const matches = [...body.matchAll(sectionRe)];
	if (matches.length > 0) {
		for (let i = 0; i < matches.length; i++) {
			const match = matches[i];
			const start = (match.index ?? 0) + match[0].length;
			const next = matches[i + 1];
			const end = next ? (next.index ?? body.length) : body.length;
			const text = body.slice(start, end).trim();
			if (text && match[1]) results.set(match[1], text);
		}
		return results;
	}
	// Single job: the first line is the notice sentence, the rest is the result.
	const firstBreak = body.indexOf("\n");
	const text = (firstBreak === -1 ? "" : body.slice(firstBreak + 1)).trim();
	const onlyId = jobs.length === 1 ? jobs[0].jobId : undefined;
	if (onlyId && text) results.set(onlyId, text);
	return results;
}

export interface BackgroundJobVerdict {
	failed: boolean;
	/** The job's delivered output (stock's notice sentence dropped). */
	text: string;
	/** The exit code stock recorded, when the delivery carries one (a `wait` snapshot). */
	exitCode?: number;
	/** Its omp process ended before the job reported (an app restart): nothing says how the command went. */
	lost?: true;
}

const LOST: BackgroundJobVerdict = { failed: false, text: "", lost: true };
const settled = (status: unknown) => status === "completed" || status === "failed";

/**
 * Stock numbers background jobs per omp process (`bg_1` again after every restart), and a job's result names only that
 * id. The call that opened a job is therefore the newest one to have opened its id before the result. `seesAll`: every
 * delivery is in view (a transcript's messages), so a job whose id was opened again before it reported, or that an omp
 * restart ended, never reports; a subagent's entries show only what it waited for, so its silent job may well have
 * been delivered out of sight and is only unknown.
 */
function jobBook<K>(verdicts: Map<K, BackgroundJobVerdict>, seesAll: boolean) {
	const openedBy = new Map<string, K>();
	const unreported = new Set<K>();
	return {
		open(jobId: string, opener: K) {
			const previous = openedBy.get(jobId);
			if (seesAll && previous !== undefined && unreported.delete(previous)) verdicts.set(previous, LOST);
			openedBy.set(jobId, opener);
			unreported.add(opener);
		},
		openerOf: (jobId: string): K | undefined => openedBy.get(jobId),
		settle(jobId: string, verdict: BackgroundJobVerdict) {
			const opener = openedBy.get(jobId);
			if (opener === undefined) return;
			verdicts.set(opener, verdict);
			unreported.delete(opener);
		},
		restart() {
			for (const opener of unreported) verdicts.set(opener, LOST);
			unreported.clear();
			openedBy.clear();
		},
	};
}

/** The job a call's result says it opened (stock tools/bash.ts `#buildBackgroundStartResult`, task). */
function openedJobId(details: Record<string, unknown> | undefined): string | undefined {
	const async = details?.async;
	const jobId = typeof async === "object" && async !== null && "jobId" in async ? async.jobId : undefined;
	return typeof jobId === "string" ? jobId : undefined;
}

/** The jobs a stock `wait` result settled: its `details.jobs[]` snapshots with their verdicts. */
function waitedJobs(details: Record<string, unknown> | undefined): { id: string; verdict: BackgroundJobVerdict }[] {
	const jobs = details?.jobs;
	return (Array.isArray(jobs) ? (jobs as Record<string, unknown>[]) : []).flatMap(job => {
		if (typeof job?.id !== "string" || !settled(job.status)) return [];
		const text = typeof job.resultText === "string" ? job.resultText : job.errorText;
		return [
			{
				id: job.id,
				verdict: {
					failed: job.status === "failed",
					text: typeof text === "string" ? text : "",
					...(typeof job.exitCode === "number" ? { exitCode: job.exitCode } : {}),
				},
			},
		];
	});
}

/** Stock's placeholder reply, journaled when it opens a session whose previous process ended mid-turn. */
export function isRestartNotice(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		typeof message.errorMessage === "string" &&
		message.errorMessage.startsWith("Previous OMP process exited")
	);
}

interface JobLedger {
	verdicts: ReadonlyMap<string, BackgroundJobVerdict>;
	/** Per delivery message: each job id it names, with the call that opened it. */
	deliveries: WeakMap<AgentMessage, ReadonlyMap<string, string>>;
}

const ledgersByList = new WeakMap<readonly AgentMessage[], JobLedger>();
const NO_CALLS: ReadonlyMap<string, string> = new Map();

/**
 * One pass over a transcript, in order: stock delivers a job's outcome either as an `async-result` message or, when
 * the agent waited for it, in its `wait` call's result (tools/wait.ts, `details.jobs[]` job snapshots with `status`,
 * `exitCode`, `resultText`/`errorText`; a result `wait` consumed is not delivered again). Memoized per message list, so
 * every work card of a transcript reads one scan.
 */
function jobLedger(messages: readonly AgentMessage[]): JobLedger {
	const cached = ledgersByList.get(messages);
	if (cached) return cached;
	const verdicts = new Map<string, BackgroundJobVerdict>();
	const deliveries = new WeakMap<AgentMessage, ReadonlyMap<string, string>>();
	const book = jobBook(verdicts, true);
	for (const message of messages) {
		if (isRestartNotice(message)) {
			book.restart();
			continue;
		}
		if (message.role === "toolResult") {
			if (message.toolName === "wait") {
				for (const job of waitedJobs(resultDetails(message))) book.settle(job.id, job.verdict);
				continue;
			}
			const jobId = openedJobId(resultDetails(message));
			if (jobId && message.toolCallId) book.open(jobId, message.toolCallId);
			continue;
		}
		const jobs = asyncResultJobs(message);
		if (jobs.length === 0) continue;
		const texts = asyncJobResults(resultText(message.content), jobs);
		const calls = new Map<string, string>();
		for (const job of jobs) {
			if (!job.jobId) continue;
			const opener = book.openerOf(job.jobId);
			if (opener !== undefined) calls.set(job.jobId, opener);
			if (settled(job.status))
				book.settle(job.jobId, { failed: job.status === "failed", text: texts.get(job.jobId) ?? "" });
		}
		deliveries.set(message, calls);
	}
	const ledger = { verdicts, deliveries };
	ledgersByList.set(messages, ledger);
	return ledger;
}

/** Every settled background job of a session by the id of the call that opened it. */
export function backgroundJobVerdicts(messages: readonly AgentMessage[]): ReadonlyMap<string, BackgroundJobVerdict> {
	return jobLedger(messages).verdicts;
}

/** The call that opened each job a delivery message names, by job id (empty for a message that is no delivery). */
export function deliveredJobCalls(
	messages: readonly AgentMessage[],
	delivery: AgentMessage,
): ReadonlyMap<string, string> {
	return jobLedger(messages).deliveries.get(delivery) ?? NO_CALLS;
}

/**
 * The same ledger for the calls of one agent seen only as tool entries, in call order (a subagent's: its surface keeps
 * no transcript messages): what its own `wait` calls settled, by the entry that opened the job.
 */
export function waitedJobVerdicts(entries: readonly ToolEntry[]): ReadonlyMap<ToolEntry, BackgroundJobVerdict> {
	const verdicts = new Map<ToolEntry, BackgroundJobVerdict>();
	const book = jobBook(verdicts, false);
	for (const entry of entries) {
		const details = resultDetails(entry.result);
		if (entry.toolName === "wait") {
			for (const job of waitedJobs(details)) book.settle(job.id, job.verdict);
			continue;
		}
		const jobId = openedJobId(details);
		if (jobId) book.open(jobId, entry);
	}
	return verdicts;
}
