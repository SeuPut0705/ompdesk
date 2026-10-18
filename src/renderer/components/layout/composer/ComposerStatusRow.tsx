/**
 * The phone composer's status chip row: ONE 44 px row above the box with the live run state as chips (`Sonnet 5.5 ·
 * Auto`, Plan, the tool approval, the context share), a divider and then the prompt suggestions (the touch
 * `NextPromptChips`, passed in as `trailing`: they share the row and its sideways scroll). The model chip opens the
 * model picker, Plan is a one-tap toggle (a Goal or Autopilot mode opens the Run settings sheet instead), the approval
 * chip opens the Run sheet (Tool approval + Delegation as 44 px rows; Full access keeps its confirm dialog), and the
 * context chip opens the usage breakdown as a sheet. Every press keeps focus in the field (`keepFocus`).
 *
 * The row is gone while the soft keyboard is up and under 420 px of visible height (`useStatusRowRoom`): the `+` sheet
 * then carries Model / Mode / Tool approval / Delegation (`ComposerToolbar`), and the Run sheet this component owns
 * stays mounted so those rows can open it.
 */
import { Cpu, ListChecks, Network, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { useFirstRunStore } from "../../../stores/first-run";
import { useModelStore } from "../../../stores/model";
import { useSettingsStore } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import { ApprovalModeField, FullAccessConfirmDialog } from "./ApprovalControl";
import { ComposerModeExtras, useComposerModes, usePlanToggle } from "./ComposerModes";
import { ComposerSheet } from "./ComposerSheet";
import { ContextUsagePopover } from "./ContextUsagePopover";
import { DelegationField, type DelegationState, useDelegation } from "./DelegationField";
import { keepFocus } from "./keep-focus";
import { useThinkingName } from "./RunSettings";
import { useStatusRowRoom } from "./use-status-row-room";

const APPROVAL_GLYPHS = { yolo: ShieldAlert, write: Shield, "always-ask": ShieldCheck } as const;

interface ComposerStatusRowProps {
	/** False while the composer is expanded: no row, but the Run sheet stays reachable. */
	shown: boolean;
	/** The Run sheet (Tool approval, Delegation): owned by the composer so the + sheet can open it too. */
	runOpen: boolean;
	onRunOpenChange: (open: boolean) => void;
	/** The suggestion chips after the divider (they scroll with the status chips). */
	trailing?: ReactNode;
	/** The suggestions are away (typing, a menu): the divider keeps its place but is invisible. */
	trailingAway?: boolean;
}

export function ComposerStatusRow({ shown, runOpen, onRunOpenChange, trailing, trailingAway }: ComposerStatusRowProps) {
	const t = useT();
	const room = useStatusRowRoom();
	// One reading of the delegation strength for the chip and the sheet (re-read whenever the sheet opens).
	const delegation = useDelegation(runOpen);
	const rowRef = useRef<HTMLDivElement>(null);
	const [edge, setEdge] = useState({ start: false, end: false });
	const measure = useCallback(() => {
		const row = rowRef.current;
		if (!row) return;
		const start = row.scrollLeft > 2;
		const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 2;
		setEdge(current => (current.start === start && current.end === end ? current : { start, end }));
	}, []);
	// The fade follows what the row holds: measured after every render, on scroll and on a resize.
	useLayoutEffect(() => {
		measure();
	});
	useEffect(() => {
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [measure]);

	return (
		<>
			{shown && room && (
				<div
					aria-label={t("input.statusRow")}
					className="omp-status-row"
					data-edge-end={edge.end || undefined}
					data-edge-start={edge.start || undefined}
					data-status-row=""
					onScroll={measure}
					ref={rowRef}
					role="toolbar"
				>
					<ModelChip />
					<PlanChip />
					<ComposerModeExtras />
					<RunStatusChip delegation={delegation} onOpen={() => onRunOpenChange(true)} />
					<ContextUsagePopover variant="chip" />
					{trailing && (
						<>
							<span
								aria-hidden
								className="omp-status-divider"
								data-away={trailingAway || undefined}
								data-status-divider=""
							/>
							{trailing}
						</>
					)}
				</div>
			)}
			<RunSheet delegation={delegation} onOpenChange={onRunOpenChange} open={runOpen} />
		</>
	);
}

function ModelChip() {
	const t = useT();
	const model = useModelStore(s => s.model);
	const settingUp = useFirstRunStore(s => s.phase !== "idle");
	const openModelPicker = useUiStore(s => s.openModelPicker);
	const thinkingName = useThinkingName();
	const modelLabel = model && !settingUp ? model.name || model.id : t("input.chooseModel");
	return (
		<button
			{...keepFocus}
			aria-haspopup="dialog"
			aria-label={
				model && !settingUp
					? t("input.modelLabelThinking", { model: modelLabel, level: thinkingName })
					: t("input.modelLabel", { model: modelLabel })
			}
			className="omp-status-chip"
			data-chip="model"
			onClick={() => openModelPicker()}
			type="button"
		>
			<Cpu aria-hidden />
			<span className="truncate">{modelLabel}</span>
			{model && !settingUp && <span className="shrink-0 text-(--sc-text-muted)">· {thinkingName}</span>}
		</button>
	);
}

/** Plan: one tap flips the stock plan mode; a Goal or Autopilot mode names itself and opens the Run settings sheet. */
function PlanChip() {
	const t = useT();
	const modes = useComposerModes();
	const plan = usePlanToggle();
	const openModes = useUiStore(s => s.openModes);
	const planOnly = modes.shown.every(mode => mode === "plan");
	return (
		<button
			{...keepFocus}
			aria-haspopup={planOnly ? undefined : "dialog"}
			aria-label={planOnly ? t("input.modes.planToggle") : (modes.fullName ?? undefined)}
			aria-pressed={planOnly ? plan.enabled : undefined}
			className="omp-status-chip"
			data-active={modes.shown.length > 0 ? "" : undefined}
			data-chip="plan"
			disabled={plan.pending}
			onClick={() => (planOnly ? void plan.toggle(!plan.enabled) : openModes(modes.shown[0]))}
			type="button"
		>
			<ListChecks aria-hidden />
			<span className="truncate">{modes.summary ?? t("input.modes.tab.plan")}</span>
		</button>
	);
}

function RunStatusChip({ delegation, onOpen }: { delegation: DelegationState; onOpen: () => void }) {
	const t = useT();
	const approvalMode = useSettingsStore(s => s.approvalMode);
	const approval = t(`input.approval.${approvalMode}`);
	const delegationName =
		delegation.mode === null || delegation.mode === "default" ? null : t(`input.delegation.mode.${delegation.mode}`);
	const Glyph = APPROVAL_GLYPHS[approvalMode];
	return (
		<button
			{...keepFocus}
			aria-haspopup="dialog"
			aria-label={[
				`${t("input.runSettings.title")}: ${t("input.approval.title", { mode: approval })}`,
				delegationName === null ? null : `${t("input.delegation.title")}: ${delegationName}`,
			]
				.filter(Boolean)
				.join(", ")}
			className="omp-status-chip"
			data-approval={approvalMode}
			data-chip="run"
			onClick={onOpen}
			type="button"
		>
			<Glyph aria-hidden />
			<span className="truncate">{approval}</span>
			{delegationName !== null && (
				<>
					<Network aria-hidden />
					<span className="truncate">{delegationName}</span>
				</>
			)}
		</button>
	);
}

/** Tool approval and Delegation as 44 px rows; the rest of the Run settings (modes, speed, roles) is one row away. */
function RunSheet({
	open,
	onOpenChange,
	delegation,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	delegation: DelegationState;
}) {
	const t = useT();
	const openModes = useUiStore(s => s.openModes);
	const [confirmFullAccess, setConfirmFullAccess] = useState(false);
	return (
		<>
			<ComposerSheet label={t("input.runSettings.title")} onClose={() => onOpenChange(false)} open={open}>
				<div className="flex flex-col gap-1 break-keep px-1" data-run-sheet="">
					<h2 className="px-3 pt-1 text-sc-md font-semibold text-(--sc-text)">{t("input.runSettings.title")}</h2>
					<ApprovalModeField
						onRequestFullAccess={() => {
							onOpenChange(false);
							setConfirmFullAccess(true);
						}}
						variant="radios"
					/>
					{delegation.mode !== null && (
						<DelegationField mode={delegation.mode} onPick={next => void delegation.pick(next)} />
					)}
					<button
						className="flex min-h-(--sc-row-action) w-full items-center rounded-(--sc-radius-md) px-3 text-left text-sc-lg text-(--sc-text) hover:bg-(--sc-hover)"
						data-run-sheet-more=""
						onClick={() => {
							onOpenChange(false);
							openModes();
						}}
						type="button"
					>
						{t("input.runSheet.all")}
					</button>
				</div>
			</ComposerSheet>
			<FullAccessConfirmDialog onClose={() => setConfirmFullAccess(false)} open={confirmFullAccess} />
		</>
	);
}
