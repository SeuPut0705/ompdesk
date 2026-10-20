/**
 * Settings › Schedules: prompts main runs as stock `omp -p` in a project folder
 * on a timer while OMPdesk is open (src/main/schedules.ts). Lists each schedule
 * with its repeat, project, next start and last outcome; a master switch holds
 * them all, each has its own switch, Run now / Stop, Edit and Delete; recent
 * runs show their status, length and captured log. While the focused tab runs
 * on a paired host the section is that host's (SECTION_SCOPE `host`): every
 * read and change goes to its own ScheduleService and its pushes keep it live.
 */
import {
	CalendarClock,
	CalendarPlus,
	ChevronDown,
	ChevronRight,
	MoreHorizontal,
	Pencil,
	Play,
	Plus,
	RefreshCw,
	Square,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type {
	Schedule,
	ScheduleDraft,
	ScheduleFrequency,
	ScheduleRun,
	SchedulesRequest,
	SchedulesState,
} from "../../../shared/schedules";
import { AnsiText } from "../../lib/ansi";
import { basename, durationBetween, formatClock, formatTimeAgo } from "../../lib/format";
import { translate, useT } from "../../lib/i18n";
import { useFocusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { toastError } from "../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Banner,
	Button,
	ConfirmDialog,
	ErrorDetail,
	IconButton,
	MenuButton,
	SkeletonRows,
	Spinner,
	Switch,
} from "../common";
import { ScheduleDialog, weekdayNames } from "./ScheduleDialog";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

/** Runs listed before "Show all". */
const RUNS_SHOWN = 20;

const STATUS_BADGE: Record<ScheduleRun["status"], BadgeVariant> = {
	running: "info",
	succeeded: "success",
	failed: "error",
	stopped: "muted",
	skipped: "warning",
};

/** "Every 2 h" / "Every day at 09:30" / "Mon, Wed at 09:30", in the UI language. */
export function frequencySummary(frequency: ScheduleFrequency): string {
	if (frequency.kind === "interval") {
		return frequency.minutes % 60 === 0
			? translate("schedules.every.hours", { count: frequency.minutes / 60 })
			: translate("schedules.every.minutes", { count: frequency.minutes });
	}
	if (frequency.days.length === 0 || frequency.days.length === 7) {
		return translate("schedules.daily", { time: frequency.time });
	}
	const names = weekdayNames();
	return translate("schedules.weekly", {
		days: frequency.days.map(day => names[day]).join(", "),
		time: frequency.time,
	});
}

export function SchedulesSection() {
	const t = useT();
	const cwd = useSessionStore(state => state.cwd);
	// A tab on a paired host shows and edits that host's schedules: they run on the host, in its folders.
	const device = useFocusedTabDevice();
	const [state, setState] = useState<SchedulesState | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [editing, setEditing] = useState<{ schedule: Schedule | null } | null>(null);
	const [deleting, setDeleting] = useState<Schedule | null>(null);
	const [openLog, setOpenLog] = useState<string | null>(null);
	const [showAllRuns, setShowAllRuns] = useState(false);
	const masterId = useId();

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			setState(await window.omp.schedules.command({ action: "get" }, device));
		} catch (error) {
			setLoadError(error);
		}
	}, [device]);
	useEffect(() => {
		// Another machine's schedules never paint over this one's while it loads.
		setState(null);
		setOpenLog(null);
		const unsubscribe =
			device === undefined
				? window.omp.schedules.onState(setState)
				: window.omp.schedules.onHostState((from, next) => {
						if (from === device) setState(next);
					});
		void load();
		return unsubscribe;
	}, [load, device]);

	const send = async (request: SchedulesRequest): Promise<void> => {
		try {
			setState(await window.omp.schedules.command(request, device));
		} catch (error) {
			toastError({ title: t("schedules.actionFailed"), error });
		}
	};
	const save = async (draft: ScheduleDraft) => {
		const id = editing?.schedule?.id;
		setState(
			await window.omp.schedules.command(id ? { action: "save", id, draft } : { action: "save", draft }, device),
		);
		setEditing(null);
	};

	if (!state) {
		return (
			<SettingsSection>
				{loadError ? (
					<Banner
						actions={
							<Button icon={<RefreshCw />} onClick={() => void load()} size="sm">
								{t("common.retry")}
							</Button>
						}
						live
						title={t("schedules.loadFailed")}
						variant="danger"
					>
						<ErrorDetail error={loadError} />
					</Banner>
				) : (
					<SkeletonRows label={t("schedules.loading")} widths={[70, 52, 64]} />
				)}
			</SettingsSection>
		);
	}

	const running = new Map(state.runs.filter(run => run.status === "running").map(run => [run.scheduleId, run]));
	const lastRun = (id: string) => state.runs.find(run => run.scheduleId === id && run.status !== "running");
	const names = new Map(state.schedules.map(schedule => [schedule.id, schedule.name]));
	const runs = showAllRuns ? state.runs : state.runs.slice(0, RUNS_SHOWN);
	const newButton = (
		<Button
			data-schedule-new
			icon={<Plus />}
			onClick={() => setEditing({ schedule: null })}
			size="sm"
			variant={state.schedules.length === 0 ? "primary" : "secondary"}
		>
			{t("schedules.new")}
		</Button>
	);

	return (
		<>
			<SettingsSection actions={state.schedules.length > 0 ? newButton : undefined} id="settings-schedules-list">
				{/* The "only while OMPdesk is open" rule sits behind the master row's info glyph, not as a paragraph. */}
				<SettingsRow
					compactControl
					control={
						<Switch
							checked={!state.paused}
							data-schedules-master
							id={masterId}
							onCheckedChange={checked => void send({ action: "setPaused", paused: !checked })}
						/>
					}
					description={`${t("schedules.note")} ${t("schedules.masterDesc")}`}
					htmlFor={masterId}
					icon={<CalendarClock />}
					label={t("schedules.master")}
					tipOnly
				/>
				{state.schedules.length === 0 ? (
					<SettingsRow
						compactControl
						control={newButton}
						icon={<CalendarPlus />}
						id="settings-schedules-empty"
						label={<span className="text-(--sc-text-muted)">{t("schedules.empty")}</span>}
					/>
				) : (
					<ul
						className="flex flex-col divide-y divide-(--sc-divider) border-t border-(--sc-divider)"
						data-schedule-list
					>
						{state.schedules.map(schedule => {
							const active = running.get(schedule.id);
							const last = lastRun(schedule.id);
							const next = state.nextRuns[schedule.id];
							return (
								<li className="flex items-center gap-2 py-1.5" data-schedule={schedule.id} key={schedule.id}>
									<Switch
										checked={schedule.enabled}
										label={t("schedules.enabled", { name: schedule.name })}
										onCheckedChange={enabled => void send({ action: "setEnabled", id: schedule.id, enabled })}
									/>
									<CalendarClock aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="omp-sched-name truncate text-sc-md font-medium text-(--sc-text)">
											{schedule.name}
										</span>
										<span className="omp-sched-meta flex min-w-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
											{active ? (
												<Badge variant="info">
													<Spinner size="sm" /> {t("schedules.status.running")}
												</Badge>
											) : (
												last && (
													<Badge variant={STATUS_BADGE[last.status]}>
														{t(`schedules.status.${last.status}`)}
													</Badge>
												)
											)}
											<span className="omp-sched-detail min-w-0 truncate" title={schedule.cwd}>
												{frequencySummary(schedule.frequency)} · {basename(schedule.cwd) || schedule.cwd}
												{schedule.model ? ` · ${schedule.model}` : ""}
											</span>
											<span className="shrink-0" data-schedule-next>
												{!schedule.enabled
													? t("schedules.nextOff")
													: state.paused
														? t("schedules.nextPaused")
														: next
															? t("schedules.next", { time: formatClock(next) })
															: ""}
											</span>
										</span>
									</div>
									<div className="flex shrink-0 items-center gap-0.5">
										{active ? (
											<IconButton
												icon={<Square />}
												label={t("schedules.stop")}
												onClick={() => void send({ action: "stop", runId: active.id })}
												size="sm"
											/>
										) : (
											<IconButton
												data-schedule-run
												icon={<Play />}
												label={t("schedules.runNow")}
												onClick={() => void send({ action: "runNow", id: schedule.id })}
												size="sm"
											/>
										)}
										<MenuButton
											align="end"
											icon={<MoreHorizontal />}
											items={[
												{
													id: "edit",
													label: t("schedules.edit"),
													icon: Pencil,
													onSelect: () => setEditing({ schedule }),
												},
												{
													id: "delete",
													label: t("schedules.delete"),
													icon: Trash2,
													danger: true,
													onSelect: () => setDeleting(schedule),
												},
											]}
											label={t("schedules.menu", { name: schedule.name })}
											size="sm"
										/>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</SettingsSection>

			<SettingsSection id="settings-schedules-runs" title={t("schedules.runs")}>
				{state.runs.length === 0 ? (
					<p className="py-2 text-sc-sm text-(--sc-text-muted)">{t("schedules.runsEmpty")}</p>
				) : (
					<ul className="flex flex-col" data-schedule-runs>
						{runs.map(run => (
							<RunRow
								key={run.id}
								name={names.get(run.scheduleId) ?? t("schedules.deletedSchedule")}
								onStop={() => void send({ action: "stop", runId: run.id })}
								onToggleLog={() => setOpenLog(current => (current === run.id ? null : run.id))}
								open={openLog === run.id}
								run={run}
								device={device}
							/>
						))}
					</ul>
				)}
				{state.runs.length > RUNS_SHOWN && (
					<Button onClick={() => setShowAllRuns(value => !value)} size="sm" variant="ghost">
						{showAllRuns ? t("schedules.runsFewer") : t("schedules.runsAll", { count: state.runs.length })}
					</Button>
				)}
			</SettingsSection>

			<ScheduleDialog
				defaultCwd={cwd ?? ""}
				device={device}
				onClose={() => setEditing(null)}
				onSave={save}
				open={editing !== null}
				schedule={editing?.schedule ?? null}
			/>
			<ConfirmDialog
				confirmLabel={t("schedules.delete")}
				message={t("schedules.deleteMessage", { name: deleting?.name ?? "" })}
				onCancel={() => setDeleting(null)}
				onConfirm={() => {
					const target = deleting;
					setDeleting(null);
					if (target) void send({ action: "delete", id: target.id });
				}}
				open={deleting !== null}
				title={t("schedules.deleteTitle")}
			/>
		</>
	);
}

function RunRow({
	run,
	name,
	open,
	onToggleLog,
	onStop,
	device,
}: {
	run: ScheduleRun;
	name: string;
	open: boolean;
	onToggleLog: () => void;
	onStop: () => void;
	device: string | undefined;
}) {
	const t = useT();
	const [log, setLog] = useState<{ text: string } | { error: unknown } | null>(null);
	// The log loads when it opens, and again once a run that was still writing it ends.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a status change re-reads the finished log.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLog(null);
		window.omp.schedules.readLog(run.id, device).then(
			text => !cancelled && setLog({ text }),
			error => !cancelled && setLog({ error }),
		);
		return () => {
			cancelled = true;
		};
	}, [open, run.id, run.status, device]);
	const duration = run.status === "skipped" ? null : durationBetween(run.startedAt, run.endedAt);
	const Chevron = open ? ChevronDown : ChevronRight;
	return (
		<li className="border-b border-(--sc-divider) last:border-b-0" data-schedule-run-row={run.id}>
			<div className="omp-run-head flex min-w-0 items-center gap-2 py-2">
				<Badge variant={STATUS_BADGE[run.status]}>{t(`schedules.status.${run.status}`)}</Badge>
				<span className="omp-run-name min-w-0 flex-1 truncate text-sc-sm text-(--sc-text)">
					{name}
					{run.trigger === "manual" && (
						<span className="text-(--sc-text-muted)"> · {t("schedules.trigger.manual")}</span>
					)}
				</span>
				<span className="shrink-0 text-sc-xs text-(--sc-text-muted)" title={formatClock(run.startedAt)}>
					{formatTimeAgo(run.startedAt)}
					{duration ? ` · ${duration}` : ""}
				</span>
				{run.status === "running" && (
					<IconButton icon={<Square />} label={t("schedules.stop")} onClick={onStop} size="sm" />
				)}
				{run.status !== "skipped" && (
					<Button aria-expanded={open} icon={<Chevron />} onClick={onToggleLog} size="sm" variant="ghost">
						{open ? t("schedules.hideLog") : t("schedules.showLog")}
					</Button>
				)}
			</div>
			{(run.error || (run.status === "failed" && run.exitCode !== null)) && (
				<p className="pb-2 text-sc-xs text-(--sc-text-muted)">
					{run.error ?? t("schedules.exitCode", { code: run.exitCode ?? "" })}
				</p>
			)}
			{open && (
				<div
					className="mb-2 max-h-80 overflow-auto rounded-(--sc-radius-md) bg-(--sc-surface-2) p-2 font-mono text-sc-xs whitespace-pre-wrap"
					data-schedule-log
				>
					{log === null ? (
						<span className="text-(--sc-text-muted)">{t("schedules.logLoading")}</span>
					) : "error" in log ? (
						<ErrorDetail error={log.error} />
					) : log.text ? (
						<AnsiText text={log.text} />
					) : (
						<span className="text-(--sc-text-muted)">{t("schedules.logEmpty")}</span>
					)}
				</div>
			)}
		</li>
	);
}
