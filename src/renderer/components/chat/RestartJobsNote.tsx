import { RotateCcw } from "lucide-react";
import type { RestartJobsDetails } from "../../../../resources/gui-bridge/restart-core";
import type { AgentMessage } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { asRecord } from "../../lib/wire-value";

/** The jobs the message names (id and intent; a command never reaches the transcript). */
function restartJobs(message: AgentMessage): RestartJobsDetails["jobs"] {
	const jobs = asRecord(message.details)?.jobs;
	if (!Array.isArray(jobs)) return [];
	return jobs.flatMap(job => {
		const record = asRecord(job);
		if (typeof record?.id !== "string") return [];
		return [typeof record.intent === "string" ? { id: record.id, intent: record.intent } : { id: record.id }];
	});
}

/**
 * The restart-jobs follow-up as the transcript shows it: one small muted line, never a message bubble. The
 * model gets the full text (restart-core.ts `restartJobsNotice`); here only how many jobs, with their intents
 * as the hover title.
 */
export function RestartJobsNote({ message }: { message: AgentMessage }) {
	const t = useT();
	const jobs = restartJobs(message);
	const intents = jobs.flatMap(job => (job.intent ? [job.intent] : []));
	return (
		<div
			className="omp-restart-jobs-note flex items-center gap-2 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-1.5 text-sc-sm text-(--sc-text-subtle)"
			data-restart-jobs
			title={intents.length > 0 ? intents.join("\n") : undefined}
		>
			<RotateCcw aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			<span>{t("chat.restartJobs", { count: Math.max(1, jobs.length) })}</span>
		</div>
	);
}
