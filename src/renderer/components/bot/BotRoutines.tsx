/**
 * The bot's routines (Grok Bot's routines list) as rows of its work board section: one line each (name, what starts
 * it, when it next starts or what it is waiting for), the lead mark tinted by its last run. A tap opens the routine in
 * place: its prompt, its trigger in full (a webhook's ready curl command), Test / Pause / Edit / Delete, and the run
 * history under them (what fired each run and why one failed, in words). The routines are main's (`BotDeskState`); a
 * change comes back through the desk push, never from the reply of the action.
 */
import { CalendarClock, Pause, Pencil, Play, Repeat, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotRoutine } from "../../../shared/bot-desk";
import type { ScheduleRun, SchedulesRequest } from "../../../shared/schedules";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { frequencyPlace, frequencySummary, RUN_STATUS_BADGE } from "../../lib/schedule-text";
import { loadMobileWeb, useMobileWebStore } from "../../stores/mobile-web";
import { toastError } from "../../stores/toast";
import { Badge, Button, ConfirmDialog, CopyButton, PathText } from "../common";
import { BoardRow, CappedRows, KindMark, SECTION_CAP } from "../layout/work-board/board-parts";
import { useBotTab } from "./bot-tab";

type Tone = "info" | "success" | "warning" | "danger" | "muted";

/** The lead mark's tone: the last run (the newest one) as it stands. */
function lastRunTone(routine: BotRoutine): Tone {
	switch (routine.runs[0]?.status) {
		case "running":
			return "info";
		case "failed":
			return "danger";
		case "succeeded":
			return "success";
		default:
			return "muted";
	}
}

/** A once routine that ran is spent: main turns it off (or leaves no next start) after its one run. */
function isDone(routine: BotRoutine): boolean {
	return routine.frequency.kind === "once" && routine.runs.length > 0 && (!routine.enabled || routine.next === null);
}

function RoutineMeta({ routine }: { routine: BotRoutine }) {
	const t = useT();
	if (routine.runs[0]?.status === "running") return <>{t("schedules.status.running")}</>;
	if (isDone(routine)) return <>{t("botHome.routines.done")}</>;
	if (!routine.enabled) return <>{t("botHome.routines.off")}</>;
	if (routine.next !== null) return <>{formatClock(routine.next)}</>;
	return <>{routine.frequency.kind === "event" ? t("botHome.routines.onEvent") : t("botHome.routines.off")}</>;
}

/** Where a webhook routine is called: the ready command when this computer's server address is known, else the key. */
function WebhookCopy({ routine, device }: { routine: BotRoutine; device?: string }) {
	const t = useT();
	const web = useMobileWebStore(state => state.state);
	const event = routine.frequency.kind === "event" ? routine.frequency.event : null;
	const isWebhook = event?.source === "webhook";
	// A paired host's server address is the host's own, which this window does not know.
	const base = device === undefined && web?.phase === "ready" && web.url ? web.url.replace(/\/+$/, "") : null;
	const needsRead = isWebhook && device === undefined && web === null;
	useEffect(() => {
		if (needsRead) loadMobileWeb().catch(() => undefined);
	}, [needsRead]);
	if (event?.source !== "webhook") return null;
	const path = `/hooks/${routine.id}`;
	return (
		<span className="flex min-w-0 flex-col gap-0.5" data-bot-routine-webhook>
			<span className="flex min-w-0 items-center gap-1">
				<PathText className="flex-1" path={base ? `${base}${path}` : path} />
				<CopyButton
					data-bot-routine-copy={base ? "command" : "key"}
					label={base ? t("botHome.routines.webhook.copyCommand") : t("botHome.routines.webhook.copyKey")}
					text={base ? `curl -X POST ${base}${path} -H "Authorization: Bearer ${event.key}"` : event.key}
				/>
			</span>
			{base ? null : <span data-bot-routine-webhook-hint>{t("botHome.routines.webhook.hint", { path })}</span>}
		</span>
	);
}

function RunHistory({ runs }: { runs: readonly ScheduleRun[] }) {
	const t = useT();
	return (
		<div className="flex min-w-0 flex-col gap-0.5" data-bot-routine-history>
			<span className="font-medium text-(--sc-text-secondary)">{t("botHome.routines.history")}</span>
			{runs.length === 0 ? (
				<span data-bot-routine-no-runs>{t("botHome.routines.noRuns")}</span>
			) : (
				<ul className="flex min-w-0 flex-col gap-1">
					{runs.map(run => (
						<li
							className="flex min-w-0 flex-col gap-0.5"
							data-bot-routine-run={run.id}
							data-status={run.status}
							key={run.id}
						>
							<span className="flex min-w-0 items-center gap-1.5">
								<Badge
									dot={run.status === "running"}
									pulse={run.status === "running"}
									variant={RUN_STATUS_BADGE[run.status]}
								>
									{t(`schedules.status.${run.status}`)}
								</Badge>
								<span className="shrink-0 tabular-nums">{formatClock(run.startedAt)}</span>
								<span className="min-w-0 truncate">· {t(`botHome.routines.trigger.${run.trigger}`)}</span>
							</span>
							{run.detail?.split("\n").map((line, index) => (
								<span className="min-w-0 truncate pl-1" data-bot-run-detail key={index} title={line}>
									{line}
								</span>
							))}
							{run.error ? (
								<span className="min-w-0 pl-1 break-words text-(--sc-danger)" data-bot-run-error>
									{run.error}
								</span>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function RoutineRow({ routine, device }: { routine: BotRoutine; device?: string }) {
	const t = useT();
	const bot = useBotTab();
	const [open, setOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [pending, setPending] = useState(false);
	const running = routine.runs[0]?.status === "running";
	const done = isDone(routine);
	const place = frequencyPlace(routine.frequency);
	const Icon = routine.frequency.kind === "event" ? Zap : routine.frequency.kind === "once" ? CalendarClock : Repeat;

	const send = async (request: SchedulesRequest) => {
		setPending(true);
		try {
			await window.omp.schedules.command(request, device);
		} catch (error) {
			toastError({ title: t("botHome.routines.actionFailed"), error });
		} finally {
			setPending(false);
		}
	};
	// The routine is the bot's to change: the request goes to its own composer, ahead of any draft, and the bot edits it.
	const edit = () =>
		window.dispatchEvent(
			new CustomEvent("omp:fill-composer", {
				detail: {
					text: t("botHome.routines.editDraft", { name: routine.name, id: routine.id }),
					tabId: bot?.tabId,
					prepend: true,
				},
			}),
		);

	return (
		<>
			<BoardRow
				data={{
					"data-bot-routine": routine.id,
					"data-board-expands": "",
					"data-open": String(open),
					"data-last-run": routine.runs[0]?.status ?? "none",
					"aria-expanded": String(open),
				}}
				label={routine.name}
				lead={<KindMark icon={Icon} tone={lastRunTone(routine)} />}
				meta={<RoutineMeta routine={routine} />}
				onClick={() => setOpen(!open)}
				sub={frequencySummary(routine.frequency)}
				title={routine.prompt}
			/>
			{open && (
				<li className="omp-work-board-item">
					<div className="omp-work-board-detail" data-bot-routine-detail={routine.id}>
						<span
							className="max-h-32 overflow-auto break-words whitespace-pre-wrap text-(--sc-text)"
							data-bot-routine-prompt
						>
							{routine.prompt}
						</span>
						<span className="min-w-0 break-words" data-bot-routine-trigger>
							{frequencySummary(routine.frequency)}
						</span>
						{place ? <PathText path={place} /> : null}
						<WebhookCopy device={device} routine={routine} />
						<span className="flex flex-wrap gap-1 py-1">
							<Button
								data-bot-routine-test
								disabled={running || pending}
								icon={<Play aria-hidden />}
								onClick={() => void send({ action: "runNow", id: routine.id })}
								size="sm"
								title={t("botHome.routines.testTip")}
								variant="secondary"
							>
								{t("botHome.routines.test")}
							</Button>
							{done ? null : (
								<Button
									data-bot-routine-toggle
									disabled={pending}
									icon={routine.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
									onClick={() =>
										void send({ action: "setEnabled", id: routine.id, enabled: !routine.enabled })
									}
									size="sm"
									variant="ghost"
								>
									{routine.enabled ? t("botHome.routines.pause") : t("botHome.routines.resume")}
								</Button>
							)}
							<Button
								data-bot-routine-edit
								icon={<Pencil aria-hidden />}
								onClick={edit}
								size="sm"
								variant="ghost"
							>
								{t("botHome.routines.edit")}
							</Button>
							<Button
								data-bot-routine-delete
								disabled={pending}
								icon={<Trash2 aria-hidden />}
								onClick={() => setDeleting(true)}
								size="sm"
								variant="danger-soft"
							>
								{t("botHome.routines.delete")}
							</Button>
						</span>
						<RunHistory runs={routine.runs} />
					</div>
				</li>
			)}
			<ConfirmDialog
				confirmLabel={t("botHome.routines.delete")}
				message={t("botHome.routines.deleteMessage", { name: routine.name })}
				onCancel={() => setDeleting(false)}
				onConfirm={() => {
					setDeleting(false);
					void send({ action: "delete", id: routine.id });
				}}
				open={deleting}
				title={t("botHome.routines.deleteTitle")}
			/>
		</>
	);
}

export function BotRoutineRows({ routines, device }: { routines: readonly BotRoutine[]; device?: string }) {
	const t = useT();
	if (routines.length === 0)
		return (
			<li className="omp-work-board-more" data-bot-routines-empty>
				{t("botHome.routines.empty")}
			</li>
		);
	return (
		<CappedRows cap={SECTION_CAP.routines} items={routines}>
			{routine => <RoutineRow device={device} key={routine.id} routine={routine} />}
		</CappedRows>
	);
}
