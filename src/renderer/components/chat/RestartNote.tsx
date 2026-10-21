import { RotateCcw } from "lucide-react";
import {
	RESTART_JOBS_MESSAGE,
	RESTART_SUBAGENTS_MESSAGE,
	RESTART_TURN_MESSAGE,
	type RestartDetails,
} from "../../../../resources/gui-bridge/restart-core";
import type { AgentMessage } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { asRecord } from "../../lib/wire-value";

/** The relaunch follow-ups the transcript shows as muted lines (restart-core.ts `restartFollowUp`). */
export function isRestartNote(customType: string | undefined): boolean {
	return (
		customType === RESTART_JOBS_MESSAGE ||
		customType === RESTART_SUBAGENTS_MESSAGE ||
		customType === RESTART_TURN_MESSAGE
	);
}

/** The ids and intents the message names under `key` (a job's command never reaches the transcript). */
function listed(message: AgentMessage, key: keyof RestartDetails): RestartDetails["jobs"] {
	const items = asRecord(message.details)?.[key];
	if (!Array.isArray(items)) return [];
	return items.flatMap(item => {
		const record = asRecord(item);
		if (typeof record?.id !== "string") return [];
		return [typeof record.intent === "string" ? { id: record.id, intent: record.intent } : { id: record.id }];
	});
}

function NoteLine({
	items,
	label,
	kind,
}: {
	items: RestartDetails["jobs"];
	label: string;
	kind: "jobs" | "subagents" | "turn";
}) {
	const intents = items.flatMap(item => (item.intent ? [item.intent] : []));
	return (
		<div
			className="omp-restart-jobs-note flex items-center gap-2 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-1.5 text-sc-sm text-(--sc-text-subtle)"
			data-restart-jobs={kind === "jobs" ? "" : undefined}
			data-restart-subagents={kind === "subagents" ? "" : undefined}
			data-restart-turn={kind === "turn" ? "" : undefined}
			title={intents.length > 0 ? intents.join("\n") : undefined}
		>
			<RotateCcw aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			<span>{label}</span>
		</div>
	);
}

/**
 * A relaunch's follow-up as the transcript shows it: one small muted line per kind, never a message bubble. The
 * model gets the full text (restart-core.ts `restartFollowUp`); here only that a cut-off turn goes on, how many
 * background jobs the restart stopped and how many subagents go on, with their intents as the hover title.
 */
export function RestartNote({ message }: { message: AgentMessage }) {
	const t = useT();
	const jobs = listed(message, "jobs");
	const subagents = listed(message, "subagents");
	const turn = asRecord(message.details)?.turn === true;
	// An older journal's jobs notice may carry no details: it still reads as the jobs line.
	const showJobs = jobs.length > 0 || (message.customType === RESTART_JOBS_MESSAGE && subagents.length === 0);
	return (
		<>
			{turn && <NoteLine items={[]} kind="turn" label={t("chat.restartTurn")} />}
			{showJobs && (
				<NoteLine items={jobs} kind="jobs" label={t("chat.restartJobs", { count: Math.max(1, jobs.length) })} />
			)}
			{subagents.length > 0 && (
				<NoteLine
					items={subagents}
					kind="subagents"
					label={t("chat.restartSubagents", { count: subagents.length })}
				/>
			)}
		</>
	);
}
