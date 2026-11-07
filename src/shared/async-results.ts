import type { AgentMessage } from "./rpc-types";

/**
 * One delivered background job of stock's async-result notice (session/async-job-delivery.ts
 * `details.jobs`). `status` is the job manager's verdict: a bash job whose command exits
 * non-zero is "failed" (tools/bash.ts re-throws the completed result).
 */
export interface AsyncResultJob {
	jobId?: string;
	/** A task job's subagent (its id is the job's, stock's `details.jobs[].agentId`). */
	agentId?: string;
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
				agentId: text(job, "agentId"),
				type: text(job, "type"),
				status: text(job, "status"),
				label: text(job, "label"),
				durationMs: typeof job.durationMs === "number" ? job.durationMs : undefined,
			},
		];
	});
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
