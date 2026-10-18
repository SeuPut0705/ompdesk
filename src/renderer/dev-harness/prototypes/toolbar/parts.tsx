/**
 * Shared pieces of the three toolbar prototypes (throwaway): the composer frame, the popover panels, the send
 * cluster slots. Everything is built from the real common components over fake state (`fake.ts`).
 */

import {
	ArrowUp,
	ChevronDown,
	CornerDownRight,
	Cpu,
	GitFork,
	History,
	Layers,
	ListChecks,
	ListPlus,
	Maximize2,
	Mic,
	Minimize2,
	Paperclip,
	Plus,
	Rocket,
	Shield,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	Square,
	Target,
} from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import {
	Button,
	type ContextMenuItem,
	IconButton,
	MenuButton,
	Popover,
	Select,
	SwitchField,
	Tabs,
	Tooltip,
} from "../../../components/common";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import {
	APPROVALS,
	type Approval,
	DELEGATIONS,
	type Delegation,
	type Fake,
	type FakeModel,
	LONG_MODEL,
	MODELS,
	THINKING_LEVELS,
	type Thinking,
} from "./fake";

export interface Ctl {
	fake: Fake;
	set: (patch: Partial<Fake>) => void;
}

export type T = (key: string, params?: Record<string, string | number>) => string;

export const MODE_ICON = { plan: ListChecks, goal: Target, autopilot: Rocket } as const;

export function thinkingName(t: T, fake: Fake): string {
	if (fake.thinking === "auto" && fake.autoResolved) {
		return t("input.thinking.autoResolved", { level: t(`input.thinking.name.${fake.autoResolved}`) });
	}
	return t(`input.thinking.name.${fake.thinking}`);
}

export function modeLabel(t: T, mode: "plan" | "goal" | "autopilot"): string {
	return t(`input.modes.name.${mode}`);
}

/** A chip trigger + its Popover: `trigger` gets the ref/open/toggle, the panel renders inside the real Popover. */
export function ChipPopover({
	id,
	ariaLabel,
	className,
	trigger,
	children,
	placement = "top-start",
}: {
	id: string;
	ariaLabel: string;
	className?: string;
	trigger: (args: { ref: RefObject<HTMLButtonElement | null>; open: boolean; toggle: () => void }) => ReactNode;
	children: (close: () => void) => ReactNode;
	placement?: "top-start" | "top-end";
}) {
	const ref = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	return (
		<>
			{trigger({ ref, open, toggle: () => setOpen(value => !value) })}
			<Popover
				anchorRef={ref}
				ariaLabel={ariaLabel}
				className={cx("max-h-[min(40rem,calc(100dvh-6rem))] overflow-y-auto", className)}
				onClose={() => setOpen(false)}
				open={open}
				placement={placement}
			>
				<div className="break-keep" data-proto-panel={id}>
					{children(() => setOpen(false))}
				</div>
			</Popover>
		</>
	);
}

/** The composer box and its field. Toolbar comes in as children; width is what a pane/window gives it. */
export function ComposerFrame({
	width,
	fake,
	set,
	children,
	boxAttrs,
	frameClass,
	boxClass,
	extra,
}: Ctl & {
	width: number;
	children: ReactNode;
	boxAttrs?: Record<string, string | undefined>;
	frameClass?: string;
	boxClass?: string;
	extra?: ReactNode;
}) {
	const t = useT();
	return (
		<div className={cx("proto-frame", frameClass)} data-frame style={{ width }}>
			<div
				className={cx(
					"omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)",
					boxClass,
				)}
				data-composer-draft={fake.draft !== "" || undefined}
				data-proto-box
				{...boxAttrs}
			>
				{extra}
				<div className="px-3 pt-2.5 pb-1">
					<textarea
						aria-label={t("input.placeholder.idle")}
						className="block max-h-24 min-h-6 w-full resize-none border-0 bg-transparent p-0 text-sc-md text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle)"
						data-composer-input
						onChange={event => set({ draft: event.target.value })}
						placeholder={fake.running ? t("input.placeholder.streaming") : t("input.placeholder.idle")}
						rows={1}
						wrap="off"
						value={fake.draft}
					/>
				</div>
				{children}
			</div>
		</div>
	);
}

/* ── popover panels ─────────────────────────────────────────────────────────────────────────────────────────── */

export function ModesPanel({ fake, set, dense }: Ctl & { dense?: boolean }) {
	const t = useT();
	const rows: Array<{ id: "plan" | "goal" | "autopilot"; label: string; desc?: string }> = [
		{ id: "plan", label: t("input.modes.planToggle"), desc: t("input.modes.planDesc") },
		{ id: "goal", label: t("input.modes.name.goal"), desc: t("input.addMenu.goalDesc") },
		{ id: "autopilot", label: t("input.modes.name.autopilot") },
	];
	return (
		<div className="flex flex-col gap-0.5">
			{rows.map(row => (
				<SwitchField
					checked={fake[row.id]}
					className="-mx-2"
					data-mode-switch={row.id}
					description={dense ? undefined : row.desc}
					infoOnly
					key={row.id}
					label={row.label}
					onCheckedChange={next => set({ [row.id]: next } as Partial<Fake>)}
					size="sm"
				/>
			))}
			<div className="-mx-3 mt-1 border-t border-(--sc-divider) px-3 pt-1.5">
				<SwitchField
					checked={fake.autoMode}
					className="-mx-2"
					description={t("input.autoMode.desc")}
					infoOnly
					label={t("input.autoMode.label")}
					onCheckedChange={next => set({ autoMode: next })}
					size="sm"
				/>
			</div>
		</div>
	);
}

export function ThinkingSelect({ fake, set }: Ctl) {
	const t = useT();
	return (
		<Select
			controlSize="sm"
			data-thinking-level
			hint={t(`input.thinking.level.${fake.thinking}`)}
			label={t("input.runSettings.thinking")}
			onChange={event => set({ thinking: event.target.value as Thinking })}
			options={THINKING_LEVELS.map(level => ({ value: level, label: t(`input.thinking.name.${level}`) }))}
			value={fake.thinking}
		/>
	);
}

/** Effort as one segmented row (the chips' own names; `minimal` and `xhigh` stay in Settings' Select). */
export function ThinkingSegments({ fake, set }: Ctl) {
	const t = useT();
	const levels: Thinking[] = ["off", "auto", "low", "medium", "high", "max"];
	return (
		<div className="flex flex-col gap-1.5" data-thinking-level>
			<span className="text-sc-sm font-medium text-(--sc-text)">{t("input.runSettings.thinking")}</span>
			<Tabs
				activeId={fake.thinking}
				ariaLabel={t("input.runSettings.thinking")}
				className="w-full *:flex-1 *:justify-center"
				compact
				onChange={id => set({ thinking: id as Thinking })}
				tabs={levels.map(level => ({ id: level, label: t(`input.thinking.name.${level}`) }))}
				variant="segmented"
			/>
			<span className="text-sc-xs text-(--sc-text-muted)">{t(`input.thinking.level.${fake.thinking}`)}</span>
		</div>
	);
}

export function ApprovalSelect({ fake, set }: Ctl) {
	const t = useT();
	return (
		<Select
			controlSize="sm"
			data-approval-mode
			hint={t(`input.approval.${fake.approval}.desc`)}
			label={t("input.runSettings.approval")}
			onChange={event => set({ approval: event.target.value as Approval })}
			options={APPROVALS.map(mode => ({ value: mode, label: t(`input.approval.${mode}`) }))}
			value={fake.approval}
		/>
	);
}

export function DelegationSelect({ fake, set }: Ctl) {
	const t = useT();
	return (
		<Select
			controlSize="sm"
			data-delegation-select
			hint={t(`input.delegation.desc.${fake.delegation}`)}
			label={t("input.delegation.title")}
			onChange={event => set({ delegation: event.target.value as Delegation })}
			options={DELEGATIONS.map(mode => ({ value: mode, label: t(`input.delegation.mode.${mode}`) }))}
			value={fake.delegation}
		/>
	);
}

/** The real chip's popover: the radiogroup with a line each (production `DelegationControl`). */
export function DelegationList({ fake, set }: Ctl) {
	const t = useT();
	return (
		<>
			<div className="flex flex-col gap-0.5" role="radiogroup" aria-label={t("input.delegation.title")}>
				{DELEGATIONS.map(option => (
					<button
						aria-checked={option === fake.delegation}
						className={cx(
							"flex w-full items-start gap-2 rounded-(--sc-radius-md) px-2 py-1.5 text-left hover:bg-(--sc-hover)",
							option === fake.delegation && "bg-(--sc-selected)",
						)}
						key={option}
						onClick={() => set({ delegation: option })}
						role="radio"
						type="button"
					>
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="text-sc-sm font-medium text-(--sc-text)">
								{t(`input.delegation.mode.${option}`)}
							</span>
							<span className="text-sc-xs text-(--sc-text-muted)">{t(`input.delegation.desc.${option}`)}</span>
						</span>
					</button>
				))}
			</div>
			<p className="mt-2 border-t border-(--sc-border-subtle) pt-2 text-sc-xs text-(--sc-text-muted)">
				{t("input.delegation.note")}
			</p>
		</>
	);
}

export function FastSwitch({ fake, set }: Ctl) {
	const t = useT();
	return (
		<SwitchField
			checked={fake.fast}
			className="-mx-2"
			data-fast-mode
			description={t("input.runSettings.fastDesc")}
			infoOnly
			label={t("input.runSettings.fast")}
			onCheckedChange={next => set({ fast: next })}
			size="sm"
		/>
	);
}

export function ModelList({ fake, set, onPick }: Ctl & { onPick: () => void }) {
	const models: FakeModel[] = [...MODELS, ...(fake.model === LONG_MODEL.id ? [LONG_MODEL] : [])];
	return (
		<div className="flex flex-col gap-0.5" role="radiogroup">
			{models.map(model => (
				<button
					aria-checked={model.id === fake.model}
					className={cx(
						"flex w-full min-w-0 items-center gap-2 rounded-(--sc-radius-md) px-2 py-1.5 text-left text-sc-sm hover:bg-(--sc-hover)",
						model.id === fake.model && "bg-(--sc-selected)",
					)}
					key={model.id}
					onClick={() => {
						set({ model: model.id });
						onPick();
					}}
					role="radio"
					type="button"
				>
					<Cpu aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
					<span className="min-w-0 flex-1 truncate font-medium text-(--sc-text)">{model.name}</span>
				</button>
			))}
		</div>
	);
}

/* ── glyphs and small controls ─────────────────────────────────────────────────────────────────────────────── */

export function ContextRing({ percent }: { percent: number }) {
	const radius = 5.5;
	const circumference = 2 * Math.PI * radius;
	const filled = (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	const tone =
		percent >= 95 ? "text-(--sc-danger)" : percent >= 80 ? "text-(--sc-warning)" : "text-(--sc-text-secondary)";
	return (
		<svg aria-hidden className={cx("size-(--sc-icon-sm) shrink-0 -rotate-90", tone)} viewBox="0 0 14 14">
			<circle cx="7" cy="7" fill="none" r={radius} stroke="var(--sc-border)" strokeWidth="2" />
			<circle
				cx="7"
				cy="7"
				fill="none"
				r={radius}
				stroke="currentColor"
				strokeDasharray={`${filled} ${circumference}`}
				strokeLinecap="round"
				strokeWidth="2"
				vectorEffect="none"
			/>
		</svg>
	);
}

/** Context meter: ring (+ percent while there is room, `tbl` says when it folds). Popover = the real actions. */
export function ContextButton({
	fake,
	className,
	pctClass,
	ringOnly,
}: {
	fake: Fake;
	className?: string;
	pctClass?: string;
	ringOnly?: boolean;
}) {
	const t = useT();
	const percent = fake.contextPercent;
	return (
		<ChipPopover
			ariaLabel={t("contextUsage.title")}
			className="w-72"
			id="context"
			placement="top-end"
			trigger={({ ref, open, toggle }) => (
				<Tooltip content={t("contextUsage.open", { percent })} describe={false}>
					<button
						aria-expanded={open}
						aria-label={t("contextUsage.open", { percent })}
						className={cx(
							"tb-ctx inline-flex h-(--sc-control-sm) min-w-0 shrink-0 select-none items-center gap-1.5 rounded-(--sc-radius-sm) px-1.5 text-sc-xs font-medium tabular-nums transition-colors duration-(--sc-duration-instant)",
							open
								? "bg-(--sc-selected) text-(--sc-text)"
								: "text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text)",
							className,
						)}
						data-proto="context"
						onClick={toggle}
						ref={ref}
						type="button"
					>
						<ContextRing percent={percent} />
						{!ringOnly && <span className={cx("tb-label", pctClass)}>{percent}%</span>}
					</button>
				</Tooltip>
			)}
		>
			{() => (
				<div className="flex flex-col gap-2">
					<h2 className="text-sc-sm font-semibold text-(--sc-text)">{t("contextUsage.title")}</h2>
					<p className="text-sc-xs text-(--sc-text-muted)">{t("contextUsage.progress", { percent })}</p>
					<div className="flex flex-wrap gap-1 border-t border-(--sc-divider) pt-2">
						<Button icon={<Minimize2 aria-hidden />} size="sm" variant="ghost">
							{t("contextUsage.compact")}
						</Button>
						<Button icon={<GitFork aria-hidden />} size="sm" variant="ghost">
							{t("contextUsage.handoff")}
						</Button>
					</div>
				</div>
			)}
		</ChipPopover>
	);
}

export function MicButton({ fake, set }: Ctl) {
	const t = useT();
	return (
		<IconButton
			className={cx(fake.recording && "bg-(--sc-danger-soft) text-(--sc-danger) hover:text-(--sc-danger)")}
			data-proto="mic"
			icon={fake.recording ? <Square className="omp-pulse-dot" fill="currentColor" /> : <Mic />}
			label={fake.recording ? t("voice.mic.stop") : t("voice.mic.start")}
			onClick={() => set({ recording: !fake.recording })}
			size="sm"
		/>
	);
}

/** The send-mode chip while a turn runs: toggles steer ⇄ follow-up and keeps typing focus in the field. */
export function SteerChip({
	fake,
	set,
	className,
	labelClass = "tb-label",
}: Ctl & { className?: string; labelClass?: string }) {
	const t = useT();
	const modeName = fake.sendMode === "followUp" ? t("input.followUp") : t("input.steer");
	return (
		<Tooltip content={t("input.sendModeHint")} shortcut={fake.sendMode === "followUp" ? undefined : "⌃↵"}>
			<Button
				aria-label={t("input.sendModeLabel", { mode: modeName })}
				className={cx("omp-composer-chip tb-chip", className)}
				data-proto="steer"
				data-send-mode={fake.sendMode}
				icon={fake.sendMode === "followUp" ? <ListPlus aria-hidden /> : <CornerDownRight aria-hidden />}
				onClick={() => set({ sendMode: fake.sendMode === "followUp" ? "steer" : "followUp" })}
				size="sm"
				variant="ghost"
			>
				<span className={labelClass}>{modeName}</span>
			</Button>
		</Tooltip>
	);
}

export function StopButton({ fake, set }: Ctl) {
	const t = useT();
	const withDraft = fake.draft.trim() !== "";
	return (
		<IconButton
			className="omp-composer-action"
			data-proto="stop"
			icon={<Square className="omp-composer-stop-glyph" fill="currentColor" />}
			label={t("input.abort")}
			onClick={() => set({ running: false })}
			shortcut="Esc"
			size="sm"
			variant={withDraft ? "secondary" : "primary"}
		/>
	);
}

/** Send keeps its place; while a turn runs its name and chord say what it does (steer ↵ / follow-up ⌃↵). */
export function SendButton({ fake, set }: Ctl) {
	const t = useT();
	const ready = fake.draft.trim() !== "" || fake.recording;
	const label = fake.running
		? fake.sendMode === "followUp"
			? t("input.followUp")
			: t("input.steer")
		: t("input.send");
	return (
		<IconButton
			className="omp-composer-action"
			data-proto="send"
			disabled={!ready}
			icon={<ArrowUp strokeWidth={2.25} />}
			label={label}
			onClick={() => set(fake.running ? { draft: "" } : { draft: "", running: true })}
			shortcut={fake.running && fake.sendMode === "followUp" ? "⌃↵" : "↵"}
			size="sm"
			variant="primary"
		/>
	);
}

/** Default modes chip glyph + label (accent when a mode is on): one source for A, B and C's tag. */
export function modeGlyph(active: Array<"plan" | "goal" | "autopilot">) {
	const Icon = active[0] ? MODE_ICON[active[0]] : Layers;
	return <Icon aria-hidden />;
}

export function ChevronMark() {
	return <ChevronDown aria-hidden className="tb-chev text-(--sc-text-subtle)" />;
}

export function approvalGlyph(approval: Approval) {
	const Icon = approval === "always-ask" ? ShieldCheck : approval === "write" ? Shield : ShieldAlert;
	return <Icon aria-hidden />;
}

/** The + menu. A/B keep production's items; C also holds the mode toggles (its chips have no Mode chip). */
export function PlusMenu({ fake, set, withModes }: Ctl & { withModes?: boolean }) {
	const t = useT();
	const items: ContextMenuItem[] = [
		{ id: "attach", label: t("input.attach"), icon: Paperclip, onSelect: () => {} },
		{
			id: "history",
			label: t("input.history.title"),
			description: t("input.history.menuDesc"),
			icon: History,
			shortcut: "⌃R",
			onSelect: () => {},
		},
		{ id: "expand", label: t("input.expanded.open"), icon: Maximize2, shortcut: "⌃G", onSelect: () => {} },
	];
	if (withModes) {
		items.push(
			{
				id: "plan",
				label: t("input.modes.planToggle"),
				icon: ListChecks,
				shortcut: "⌥⇧P",
				checked: fake.plan,
				separatorBefore: true,
				onSelect: () => set({ plan: !fake.plan }),
			},
			{
				id: "goal",
				label: t("input.modes.name.goal"),
				icon: Target,
				checked: fake.goal,
				onSelect: () => set({ goal: !fake.goal }),
			},
			{
				id: "autopilot",
				label: t("input.modes.name.autopilot"),
				icon: Rocket,
				checked: fake.autopilot,
				onSelect: () => set({ autopilot: !fake.autopilot }),
			},
			{
				id: "auto",
				label: t("input.autoMode.label"),
				description: t("input.autoMode.desc"),
				icon: Sparkles,
				checked: fake.autoMode,
				onSelect: () => set({ autoMode: !fake.autoMode }),
			},
		);
	} else {
		items.push({
			id: "goal",
			label: t("input.addMenu.goal"),
			description: t("input.addMenu.goalDesc"),
			icon: Target,
			separatorBefore: true,
			onSelect: () => set({ goal: true }),
		});
	}
	items.push({
		id: "skills",
		label: t("input.addMenu.skills"),
		icon: Sparkles,
		separatorBefore: true,
		onSelect: () => {},
	});
	return (
		<span className="contents" data-proto="plus">
			<MenuButton icon={<Plus />} items={items} label={t("input.addMenu")} side="above" size="sm" />
		</span>
	);
}
