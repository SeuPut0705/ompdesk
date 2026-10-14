/**
 * Create or edit one scheduled run (Settings › Schedules): name, prompt,
 * project folder, repeat (an interval or a time of day on chosen weekdays),
 * model, --yolo, and whether it starts on. Validation is the shared
 * `scheduleDraftProblem`, the same check main applies before saving.
 */
import { FolderOpen } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	SCHEDULE_MAX_INTERVAL,
	type Schedule,
	type ScheduleDraft,
	scheduleDraftProblem,
} from "../../../shared/schedules";
import { cx, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { pickWorkspaceDirectory } from "../../lib/workspace-dirs";
import { Button, Input, Modal, Select, SwitchField, Tabs, TextArea } from "../common";

type IntervalUnit = "minutes" | "hours";

interface Form {
	name: string;
	prompt: string;
	cwd: string;
	kind: "interval" | "daily";
	every: string;
	unit: IntervalUnit;
	time: string;
	days: number[];
	model: string;
	autoApprove: boolean;
	enabled: boolean;
}

function formFor(schedule: Schedule | null, cwd: string): Form {
	const frequency = schedule?.frequency;
	const minutes = frequency?.kind === "interval" ? frequency.minutes : 60;
	const hours = minutes % 60 === 0;
	return {
		name: schedule?.name ?? "",
		prompt: schedule?.prompt ?? "",
		cwd: schedule?.cwd ?? cwd,
		kind: frequency?.kind ?? "daily",
		every: String(hours ? minutes / 60 : minutes),
		unit: hours ? "hours" : "minutes",
		time: frequency?.kind === "daily" ? frequency.time : "09:00",
		days: frequency?.kind === "daily" ? frequency.days : [],
		model: schedule?.model ?? "",
		autoApprove: schedule?.autoApprove ?? false,
		enabled: schedule?.enabled ?? true,
	};
}

function draftOf(form: Form): ScheduleDraft {
	const every = Number(form.every);
	return {
		name: form.name.trim(),
		prompt: form.prompt,
		cwd: form.cwd,
		frequency:
			form.kind === "interval"
				? { kind: "interval", minutes: form.unit === "hours" ? every * 60 : every }
				: { kind: "daily", time: form.time, days: form.days.toSorted() },
		model: form.model.trim() || null,
		autoApprove: form.autoApprove,
		enabled: form.enabled,
	};
}

/** Short weekday names in the UI language, Sunday first (2026-10-18 is a Sunday). */
export function weekdayNames(): string[] {
	const format = new Intl.DateTimeFormat(uiLocale(), { weekday: "short" });
	return Array.from({ length: 7 }, (_, day) => format.format(new Date(2026, 9, 18 + day)));
}

export function ScheduleDialog({
	open,
	schedule,
	defaultCwd,
	onClose,
	onSave,
}: {
	open: boolean;
	/** The schedule to edit; null creates one. */
	schedule: Schedule | null;
	defaultCwd: string;
	onClose: () => void;
	/** Resolves once main saved it; a rejection keeps the dialog open with the reason. */
	onSave: (draft: ScheduleDraft) => Promise<void>;
}) {
	const t = useT();
	const formId = useId();
	const [form, setForm] = useState<Form>(() => formFor(schedule, defaultCwd));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [touched, setTouched] = useState(false);
	// Each opening starts from the schedule it edits (or a blank one).
	useEffect(() => {
		if (!open) return;
		setForm(formFor(schedule, defaultCwd));
		setError(null);
		setTouched(false);
	}, [open, schedule, defaultCwd]);

	const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }));
	const draft = draftOf(form);
	const problem = scheduleDraftProblem(draft);
	const days = weekdayNames();

	const submit = async () => {
		setTouched(true);
		if (problem) return;
		setSaving(true);
		setError(null);
		try {
			await onSave(draft);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button form={formId} loading={saving} type="submit" variant="primary">
						{schedule ? t("schedules.save") : t("schedules.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="md"
			title={schedule ? t("schedules.dialog.edit") : t("schedules.dialog.new")}
		>
			<form
				className="flex flex-col gap-4"
				data-schedule-form
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					autoFocus
					error={touched && problem === "name" ? t("schedules.problem.name") : undefined}
					label={t("schedules.field.name")}
					onChange={event => set("name", event.target.value)}
					value={form.name}
				/>
				<TextArea
					error={touched && problem === "prompt" ? t("schedules.problem.prompt") : undefined}
					hint={t("schedules.field.promptHint")}
					label={t("schedules.field.prompt")}
					onChange={event => set("prompt", event.target.value)}
					rows={4}
					value={form.prompt}
				/>
				<div className="flex flex-col gap-1.5">
					<span className="text-sc-sm font-medium text-(--sc-text)">{t("schedules.field.project")}</span>
					<div className="flex min-w-0 items-center gap-2">
						<span
							className={cx(
								"min-w-0 flex-1 truncate font-mono text-sc-sm",
								form.cwd ? "text-(--sc-text)" : "text-(--sc-text-muted)",
							)}
							data-schedule-cwd
							title={form.cwd || undefined}
						>
							{form.cwd || t("schedules.field.noFolder")}
						</span>
						<Button
							icon={<FolderOpen />}
							onClick={async () => {
								const picked = await pickWorkspaceDirectory({ title: t("schedules.field.project") });
								if (picked) set("cwd", picked);
							}}
							size="sm"
							variant="secondary"
						>
							{t("schedules.field.chooseFolder")}
						</Button>
					</div>
					{touched && problem === "cwd" && (
						<p className="text-sc-xs text-(--sc-danger)" role="alert">
							{t("schedules.problem.cwd")}
						</p>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<span className="text-sc-sm font-medium text-(--sc-text)" id={`${formId}-repeat`}>
						{t("schedules.field.repeat")}
					</span>
					<Tabs
						activeId={form.kind}
						ariaLabel={t("schedules.field.repeat")}
						compact
						onChange={id => set("kind", id === "interval" ? "interval" : "daily")}
						tabs={[
							{ id: "daily", label: t("schedules.repeat.daily") },
							{ id: "interval", label: t("schedules.repeat.interval") },
						]}
						variant="segmented"
					/>
					{form.kind === "interval" ? (
						<div className="flex items-end gap-2">
							<Input
								className="w-24"
								error={touched && problem === "interval" ? t("schedules.problem.interval") : undefined}
								inputMode="numeric"
								label={t("schedules.field.every")}
								max={form.unit === "hours" ? SCHEDULE_MAX_INTERVAL / 60 : SCHEDULE_MAX_INTERVAL}
								min={1}
								onChange={event => set("every", event.target.value)}
								type="number"
								value={form.every}
							/>
							<Select
								aria-label={t("schedules.field.every")}
								onChange={event => set("unit", event.target.value === "hours" ? "hours" : "minutes")}
								options={[
									{ value: "minutes", label: t("schedules.unit.minutes") },
									{ value: "hours", label: t("schedules.unit.hours") },
								]}
								value={form.unit}
							/>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							<Input
								className="w-32"
								error={touched && problem === "time" ? t("schedules.problem.time") : undefined}
								label={t("schedules.field.time")}
								onChange={event => set("time", event.target.value)}
								type="time"
								value={form.time}
							/>
							<fieldset className="flex flex-col gap-1.5">
								<legend className="mb-1.5 text-sc-sm font-medium text-(--sc-text)">
									{t("schedules.field.days")}
								</legend>
								<div className="flex flex-wrap gap-1">
									{days.map((label, day) => {
										const on = form.days.includes(day);
										return (
											<Button
												aria-pressed={on}
												data-schedule-day={day}
												key={label}
												onClick={() =>
													set("days", on ? form.days.filter(item => item !== day) : [...form.days, day])
												}
												size="sm"
												variant={on ? "secondary" : "ghost"}
											>
												{label}
											</Button>
										);
									})}
								</div>
								<p className="text-sc-xs text-(--sc-text-muted)">{t("schedules.field.daysHint")}</p>
							</fieldset>
						</div>
					)}
				</div>
				<Input
					hint={t("schedules.field.modelHint")}
					label={t("schedules.field.model")}
					mono
					onChange={event => set("model", event.target.value)}
					placeholder={t("schedules.field.modelPlaceholder")}
					spellCheck={false}
					value={form.model}
				/>
				<SwitchField
					checked={form.autoApprove}
					description={t("schedules.field.autoApproveDesc")}
					label={t("schedules.field.autoApprove")}
					onCheckedChange={checked => set("autoApprove", checked)}
				/>
				<SwitchField
					checked={form.enabled}
					label={t("schedules.field.enabled")}
					onCheckedChange={checked => set("enabled", checked)}
				/>
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" role="alert">
						{error}
					</p>
				)}
			</form>
		</Modal>
	);
}
