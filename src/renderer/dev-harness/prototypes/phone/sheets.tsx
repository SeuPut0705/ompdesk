import {
	Check,
	ChevronDown,
	ChevronRight,
	Cpu,
	History,
	Image as ImageIcon,
	ListChecks,
	Maximize2,
	Mic,
	Paperclip,
	Sparkles,
	Target,
	Trash2,
	Users,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../../../components/common";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import {
	APPROVALS,
	type Approval,
	DELEGATIONS,
	type Delegation,
	MODELS,
	MODES,
	type Mode,
	modelOf,
	THINKING,
	type ThinkingLevel,
	useSession,
} from "./fake";
import { keepFocus, OptionRow, ProtoSheet, Segmented, SheetTitle } from "./ProtoSheet";
import { useP } from "./strings";

/* ── Pickers: each one applies on tap and (when `done` is given) closes the sheet ──────────────────────────── */

export function ThinkingSegments({ done }: { done?: () => void }) {
	const t = useT();
	const { s, set, act } = useSession();
	return (
		<Segmented<ThinkingLevel>
			label={t("input.runSettings.thinking")}
			onChange={level => {
				act("thinking", level);
				set({ thinking: level });
				done?.();
			}}
			options={THINKING.map(level => ({ value: level, label: t(`input.thinking.name.${level}`) }))}
			value={s.thinking}
		/>
	);
}

export function ModelRows({ done }: { done?: () => void }) {
	const { s, set, act } = useSession();
	return (
		<>
			{MODELS.map(model => (
				<OptionRow
					checked={model.id === s.model}
					key={model.id}
					label={model.name}
					onSelect={() => {
						act("model", model.id);
						set({ model: model.id });
						done?.();
					}}
				/>
			))}
		</>
	);
}

export function ApprovalRows({ done }: { done?: () => void }) {
	const t = useT();
	const { s, set, act } = useSession();
	return (
		<>
			{APPROVALS.map((mode: Approval) => (
				<OptionRow
					checked={mode === s.approval}
					description={t(`input.approval.${mode}.desc`)}
					key={mode}
					label={t(`input.approval.${mode}`)}
					onSelect={() => {
						act("approval", mode);
						set({ approval: mode });
						done?.();
					}}
				/>
			))}
		</>
	);
}

export function DelegationRows({ done }: { done?: () => void }) {
	const t = useT();
	const { s, set, act } = useSession();
	return (
		<>
			{DELEGATIONS.map((mode: Delegation) => (
				<OptionRow
					checked={mode === s.delegation}
					description={t(`input.delegation.desc.${mode}`)}
					key={mode}
					label={t(`input.delegation.mode.${mode}`)}
					onSelect={() => {
						act("delegation", mode);
						set({ delegation: mode });
						done?.();
					}}
				/>
			))}
		</>
	);
}

function modeName(mode: Mode, p: (key: string) => string): string {
	return mode === "agent"
		? p("pp.normal")
		: mode === "plan"
			? p("pp.plan")
			: mode === "goal"
				? p("pp.goal")
				: p("pp.autopilot");
}

export function ModeRows({ done }: { done?: () => void }) {
	const t = useT();
	const p = useP();
	const { s, set, act } = useSession();
	return (
		<>
			{MODES.map(mode => (
				<OptionRow
					checked={mode === s.mode}
					description={mode === "plan" ? t("input.modes.planDesc") : undefined}
					key={mode}
					label={modeName(mode, p)}
					onSelect={() => {
						act("mode", mode);
						set({ mode });
						done?.();
					}}
				/>
			))}
		</>
	);
}

export function ModeSegments({ done }: { done?: () => void }) {
	const t = useT();
	const p = useP();
	const { s, set, act } = useSession();
	return (
		<Segmented<Mode>
			label={t("input.modes.label")}
			onChange={mode => {
				act("mode", mode);
				set({ mode });
				done?.();
			}}
			options={MODES.map(mode => ({ value: mode, label: modeName(mode, p) }))}
			value={s.mode}
		/>
	);
}

export function ApprovalSegments({ done }: { done?: () => void }) {
	const t = useT();
	const { s, set, act } = useSession();
	return (
		<Segmented<Approval>
			label={t("input.runSettings.approval")}
			onChange={mode => {
				act("approval", mode);
				set({ approval: mode });
				done?.();
			}}
			options={APPROVALS.map(mode => ({ value: mode, label: t(`input.approval.${mode}`) }))}
			value={s.approval}
		/>
	);
}

export function ContextCard({ done }: { done?: () => void }) {
	const t = useT();
	const p = useP();
	const { s, act } = useSession();
	return (
		<div className="px-3 pb-1">
			<div className="flex items-baseline justify-between text-sc-md">
				<span className="text-(--sc-text-secondary)">{t("contextUsage.used")}</span>
				<span className="tabular-nums text-(--sc-text)">{p("pp.contextUsed", { percent: s.context })}</span>
			</div>
			<div
				aria-label={t("contextUsage.progress", { percent: s.context })}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={s.context}
				className="mt-1.5 h-1.5 overflow-hidden rounded-(--sc-radius-full) bg-(--sc-border)"
				role="progressbar"
			>
				<div className="h-full bg-(--sc-accent)" style={{ width: `${s.context}%` }} />
			</div>
			<div className="mt-2 -mx-3">
				<OptionRow
					icon={<Check />}
					label={t("contextUsage.compact")}
					onSelect={() => {
						act("compact");
						done?.();
					}}
				/>
				<OptionRow label={t("contextUsage.handoff")} onSelect={() => done?.()} />
				<OptionRow label={t("contextUsage.fullReport")} onSelect={() => done?.()} />
			</div>
		</div>
	);
}

/* ── Sheets a variant opens from a status chip or the + button ────────────────────────────────────────────── */

export type SheetId = "attach" | "model" | "mode" | "approval" | "delegation" | "context" | "run" | "qactions";

export function AttachRows({
	done,
	includeModes,
	runRows,
}: {
	done: () => void;
	includeModes?: boolean;
	/** C only: the chip row is hidden (keyboard up, landscape), so the + sheet carries the run settings. */
	runRows?: (sheet: SheetId) => void;
}) {
	const t = useT();
	const p = useP();
	const { act, set, s } = useSession();
	const choose = (name: string, after?: () => void) => () => {
		act(name);
		done();
		after?.();
	};
	return (
		<>
			<OptionRow
				description={t("input.attachPhotosDesc")}
				icon={<ImageIcon />}
				label={t("input.attachPhotos")}
				onSelect={choose("attach-photo")}
			/>
			<OptionRow icon={<Paperclip />} label={t("input.attach")} onSelect={choose("attach-file")} />
			<OptionRow
				description={t("input.history.menuDesc")}
				icon={<History />}
				label={t("input.history.title")}
				onSelect={choose("history")}
			/>
			<OptionRow
				icon={<Maximize2 />}
				label={s.expanded ? t("input.expanded.collapse") : t("input.expanded.open")}
				onSelect={choose("expand", () => set(current => ({ expanded: !current.expanded })))}
			/>
			{includeModes && (
				<OptionRow
					description={t("input.addMenu.goalDesc")}
					icon={<Target />}
					label={`${p("pp.goal")} · ${p("pp.autopilot")}`}
					onSelect={choose("modes", () => set({ mode: "goal" }))}
					trailing={<ChevronRight aria-hidden className="size-(--sc-icon-md) text-(--sc-text-subtle)" />}
				/>
			)}
			<OptionRow icon={<Sparkles />} label={t("input.addMenu.skills")} onSelect={choose("skills")} />
			{runRows && (
				<>
					<div className="mx-3 my-1 border-t border-(--sc-divider)" />
					<OptionRow
						icon={<Cpu />}
						label={p("pp.model")}
						onSelect={() => runRows("model")}
						trailing={
							<span className="text-sc-md text-(--sc-text-muted)">
								{modelOf(s.model).short} · {t(`input.thinking.name.${s.thinking}`)}
							</span>
						}
					/>
					<OptionRow
						icon={<ListChecks />}
						label={t("input.modes.label")}
						onSelect={() => runRows("mode")}
						trailing={<span className="text-sc-md text-(--sc-text-muted)">{modeName(s.mode, p)}</span>}
					/>
					<OptionRow
						label={t("input.runSettings.approval")}
						onSelect={() => runRows("approval")}
						trailing={
							<span className="text-sc-md text-(--sc-text-muted)">{t(`input.approval.${s.approval}`)}</span>
						}
					/>
					<OptionRow
						icon={<Users />}
						label={t("input.delegation.title")}
						onSelect={() => runRows("delegation")}
						trailing={
							<span className="text-sc-md text-(--sc-text-muted)">
								{t(`input.delegation.mode.${s.delegation}`)}
							</span>
						}
					/>
				</>
			)}
		</>
	);
}

/** Variant A and C: the sheet each chip / the + button opens. A pick applies and closes it. */
export function ChipSheets({
	open,
	onClose,
	onClosed,
	includeModes,
	runRows,
}: {
	open: SheetId | null;
	onClose: () => void;
	onClosed?: () => void;
	includeModes?: boolean;
	runRows?: (sheet: SheetId) => void;
}) {
	const t = useT();
	const p = useP();
	const label =
		open === "attach"
			? t("input.addMenu")
			: open === "model"
				? p("pp.model")
				: open === "mode"
					? t("input.modes.title")
					: open === "approval"
						? t("input.runSettings.approval")
						: open === "delegation"
							? t("input.delegation.title")
							: t("contextUsage.title");
	return (
		<ProtoSheet label={label} onClose={onClose} onClosed={onClosed} open={open !== null}>
			{open === "attach" && <AttachRows done={onClose} includeModes={includeModes} runRows={runRows} />}
			{open === "model" && (
				<>
					<SheetTitle>{t("input.runSettings.thinking")}</SheetTitle>
					<div className="px-3 pb-2">
						<ThinkingSegments done={onClose} />
					</div>
					<SheetTitle>{p("pp.model")}</SheetTitle>
					<ModelRows done={onClose} />
				</>
			)}
			{open === "mode" && <ModeRows done={onClose} />}
			{open === "approval" && <ApprovalRows done={onClose} />}
			{open === "delegation" && <DelegationRows done={onClose} />}
			{open === "context" && (
				<>
					<SheetTitle>{t("contextUsage.title")}</SheetTitle>
					<ContextCard done={onClose} />
				</>
			)}
		</ProtoSheet>
	);
}

/* ── Variant B: ONE "Run controls" sheet, live values, changes in place ───────────────────────────────────── */

function Tile({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
	return (
		<button
			{...keepFocus}
			className="pp-tile flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-2) px-1 text-center text-sc-sm text-(--sc-text) hover:bg-(--sc-hover) [&>svg]:size-(--sc-icon-lg)"
			onClick={onClick}
			type="button"
		>
			{icon}
			<span className="max-w-full text-sc-sm leading-tight break-keep">{label}</span>
		</button>
	);
}

function ValueRow({
	icon,
	label,
	value,
	open,
	onToggle,
	children,
}: {
	icon: ReactNode;
	label: string;
	value: string;
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<div className="border-t border-(--sc-divider)">
			<button
				aria-expanded={open}
				className="flex min-h-11 w-full items-center gap-3 px-3 text-left"
				onClick={onToggle}
				type="button"
			>
				<span className="shrink-0 text-(--sc-text-muted) [&>svg]:size-(--sc-icon-md)">{icon}</span>
				<span className="shrink-0 text-sc-md text-(--sc-text-secondary)">{label}</span>
				<span className="min-w-0 flex-1 truncate text-right text-sc-lg font-medium text-(--sc-text)">{value}</span>
				{open ? (
					<ChevronDown aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-subtle)" />
				) : (
					<ChevronRight aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-subtle)" />
				)}
			</button>
			{open && <div className="pb-1">{children}</div>}
		</div>
	);
}

export function RunControlsSheet({
	open,
	onClose,
	onClosed,
	initialOpenRow,
}: {
	open: boolean;
	onClose: () => void;
	onClosed?: () => void;
	initialOpenRow?: "model" | "delegation" | null;
}) {
	const t = useT();
	const p = useP();
	const { s, set, act } = useSession();
	const [row, setRow] = useState<"model" | "delegation" | null>(initialOpenRow ?? null);
	const model = MODELS.find(item => item.id === s.model) ?? MODELS[0];
	const toggle = (name: "model" | "delegation") => setRow(current => (current === name ? null : name));
	const tile = (name: string) => () => {
		act(name);
		onClose();
	};
	return (
		<ProtoSheet label={p("pp.runControls")} onClose={onClose} onClosed={onClosed} open={open}>
			<SheetTitle>{p("pp.runControls")}</SheetTitle>
			<div className="grid grid-cols-4 gap-2 px-3 pb-3" data-run-tiles="">
				<Tile icon={<ImageIcon />} label={t("input.attachPhotos")} onClick={tile("attach-photo")} />
				<Tile icon={<Paperclip />} label={t("input.attach")} onClick={tile("attach-file")} />
				<Tile icon={<History />} label={t("input.history.title")} onClick={tile("history")} />
				<Tile
					icon={<Maximize2 />}
					label={s.expanded ? t("input.expanded.collapse") : t("input.expanded.open")}
					onClick={() => {
						act("expand");
						set(current => ({ expanded: !current.expanded }));
						onClose();
					}}
				/>
				{s.stt && <Tile icon={<Mic />} label={t("voice.mic.start")} onClick={tile("voice")} />}
				<Tile icon={<Sparkles />} label={t("input.addMenu.skills")} onClick={tile("skills")} />
				<Tile icon={<Target />} label={t("input.addMenu.goal")} onClick={tile("goal")} />
			</div>
			<div className="px-3 pb-2">
				<div className="mb-1 text-sc-sm text-(--sc-text-muted)">{t("input.runSettings.thinking")}</div>
				<ThinkingSegments />
			</div>
			<div className="px-3 pb-2">
				<div className="mb-1 text-sc-sm text-(--sc-text-muted)">{t("input.modes.label")}</div>
				<ModeSegments />
			</div>
			<div className="px-3 pb-2">
				<div className="mb-1 text-sc-sm text-(--sc-text-muted)">{t("input.runSettings.approval")}</div>
				<ApprovalSegments />
			</div>
			<ValueRow
				icon={<Cpu />}
				label={p("pp.model")}
				onToggle={() => toggle("model")}
				open={row === "model"}
				value={model.name}
			>
				<ModelRows done={() => setRow(null)} />
			</ValueRow>
			<ValueRow
				icon={<Users />}
				label={t("input.delegation.title")}
				onToggle={() => toggle("delegation")}
				open={row === "delegation"}
				value={t(`input.delegation.mode.${s.delegation}`)}
			>
				<DelegationRows done={() => setRow(null)} />
			</ValueRow>
			<div className="flex min-h-11 items-center gap-3 border-t border-(--sc-divider) px-3">
				<ListChecks aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
				<span className="shrink-0 text-sc-md text-(--sc-text-secondary)">{t("contextUsage.title")}</span>
				<span className="min-w-0 flex-1 text-right text-sc-lg font-medium tabular-nums text-(--sc-text)">
					{s.context} %
				</span>
				<Button {...keepFocus} onClick={() => act("compact")} size="sm" variant="secondary">
					{t("contextUsage.compact")}
				</Button>
			</div>
		</ProtoSheet>
	);
}

/* ── Queue row actions sheet (A and C) ─────────────────────────────────────────────────────────────────────── */

export function QueueActionsSheet({
	itemId,
	onClose,
	onEdit,
}: {
	itemId: number | null;
	onClose: () => void;
	onEdit: (id: number) => void;
}) {
	const t = useT();
	const p = useP();
	const { s, set, act } = useSession();
	const item = s.queue.find(entry => entry.id === itemId);
	return (
		<ProtoSheet label={p("pp.messageActions")} onClose={onClose} open={itemId !== null && item !== undefined}>
			{item && (
				<>
					<SheetTitle>{p("pp.messageActions")}</SheetTitle>
					<OptionRow
						label={t("queuePanel.edit")}
						onSelect={() => {
							onClose();
							onEdit(item.id);
						}}
					/>
					<OptionRow
						label={item.lane === "followUp" ? t("composerQueue.sendNow") : t("composerQueue.sendLater")}
						onSelect={() => {
							act("queue-move", item.id);
							set(current => ({
								queue: current.queue.map(entry =>
									entry.id === item.id
										? { ...entry, lane: entry.lane === "followUp" ? "steering" : "followUp" }
										: entry,
								),
							}));
							onClose();
						}}
					/>
					<OptionRow
						icon={<Trash2 />}
						label={<span className={cx("text-(--sc-danger)")}>{t("queuePanel.remove")}</span>}
						onSelect={() => {
							act("queue-remove", item.id);
							set(current => ({ queue: current.queue.filter(entry => entry.id !== item.id) }));
							onClose();
						}}
					/>
				</>
			)}
		</ProtoSheet>
	);
}
