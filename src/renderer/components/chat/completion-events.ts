import type { AgentMessage } from "../../../shared/rpc-types";

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
