import type { AgentMessage } from "../../../shared/rpc-types";
import { resultText } from "../../lib/format";

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
}

const verdictsByList = new WeakMap<readonly AgentMessage[], ReadonlyMap<string, BackgroundJobVerdict>>();

/**
 * Every settled background job of a session by id: stock delivers a job's outcome either as an `async-result`
 * message or, when the agent waited for it, in its `wait` call's result (tools/wait.ts, `details.jobs[]` job
 * snapshots with `status`, `exitCode`, `resultText`/`errorText`; a result `wait` consumed is not delivered again).
 * Memoized per message list, so every work card of a transcript reads one scan.
 */
export function backgroundJobVerdicts(messages: readonly AgentMessage[]): ReadonlyMap<string, BackgroundJobVerdict> {
	const cached = verdictsByList.get(messages);
	if (cached) return cached;
	const verdicts = new Map<string, BackgroundJobVerdict>();
	const settled = (status: unknown) => status === "completed" || status === "failed";
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === "wait") {
			const jobs = (message.details as { jobs?: unknown } | undefined)?.jobs;
			for (const job of Array.isArray(jobs) ? (jobs as Record<string, unknown>[]) : []) {
				if (typeof job?.id !== "string" || !settled(job.status)) continue;
				const text = typeof job.resultText === "string" ? job.resultText : job.errorText;
				verdicts.set(job.id, {
					failed: job.status === "failed",
					text: typeof text === "string" ? text : "",
					...(typeof job.exitCode === "number" ? { exitCode: job.exitCode } : {}),
				});
			}
			continue;
		}
		const jobs = asyncResultJobs(message);
		if (jobs.length === 0) continue;
		const texts = asyncJobResults(resultText(message.content), jobs);
		for (const job of jobs) {
			if (!job.jobId || !settled(job.status)) continue;
			verdicts.set(job.jobId, { failed: job.status === "failed", text: texts.get(job.jobId) ?? "" });
		}
	}
	verdictsByList.set(messages, verdicts);
	return verdicts;
}
