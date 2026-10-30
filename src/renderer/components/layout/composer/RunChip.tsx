/**
 * The composer's ONE Run chip: a single trigger and a single popover for everything that tunes how the session
 * runs — Mode (Plan, Goal, Autopilot, the automatic choice), Thinking, Tool approval, Delegation, then Fast mode,
 * Advanced and Model roles. It replaces the three triggers (Mode, Run settings, Delegation) the toolbar used to carry.
 *
 * The chip says the state without opening: its text is the active modes ("Plan · Goal"), else the Run settings
 * title; trailing glyphs show the tool-approval shield and fast/slow. Thinking and Delegation draw nothing on it (the
 * popover holds both and the accessible name spells them); it paints accent while a mode is on (`data-active`, plain
 * CSS in components.css: never a class tied against the Button's own variant classes); its accessible name spells the
 * whole state. `useUiStore.openModes(tab)`
 * (palette, goal dock, Settings › Features) opens the popover on that mode in the focused pane; closing clears it.
 * Granting full access closes the popover first and then confirms in a Dialog.
 */

import { ChevronDown, SlidersHorizontal, Turtle, Zap } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { lazyChunk } from "../../../lib/chunk-load";
import { useT } from "../../../lib/i18n";
import { actionKbd, formatShortcut } from "../../../lib/keymap";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useSettingsStore } from "../../../stores/settings";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { Button, Popover, Tooltip } from "../../common";
import { APPROVAL_ICONS, ApprovalModeField, FullAccessConfirmDialog } from "./ApprovalControl";
import { type ComposerModeId, MODE_ICONS, ModesSection, useComposerModes } from "./ComposerModes";
import { DelegationField, useDelegation } from "./DelegationField";
import { AdvancedAndRoles, SpeedFields, useSpeedState, useThinkingName } from "./RunSettings";
import { ThinkingLevelField } from "./ThinkingControl";

// Not on the first screen and past its JavaScript budget: loaded when the popover first renders it.
const RunAdvisorRow = lazyChunk(() => import("./AdvisorUsageRow").then(module => ({ default: module.RunAdvisorRow })));

export function RunChip() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const activeTabId = useTabsStore(s => s.activeTabId);
	// openModes() is app-wide; only the focused pane's composer answers it.
	const requested = useUiStore(s => s.modesOpen) && (tabId === null || tabId === activeTabId);
	const requestedTab = useUiStore(s => s.modesTab);
	const closeModes = useUiStore(s => s.closeModes);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const approvalMode = useSettingsStore(s => s.approvalMode);

	const modes = useComposerModes();
	const thinkingName = useThinkingName();
	const speed = useSpeedState();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<ComposerModeId>("plan");
	// Opened from the chip, the section shows the tab's first mode and keeps following it until the person picks a
	// tab: on a run's new tab the Autopilot state can arrive after the sheet opened (until then the tab shows no mode,
	// or the run's underlying Goal), and a section left on Plan or Goal had none of the run's controls (open the
	// screen, End).
	const [followsModes, setFollowsModes] = useState(false);
	const [confirmFullAccess, setConfirmFullAccess] = useState(false);
	const delegation = useDelegation(open);

	useEffect(() => {
		if (!requested) return;
		setTab(requestedTab);
		setOpen(true);
	}, [requested, requestedTab]);

	const close = () => {
		setOpen(false);
		setFollowsModes(false);
		if (useUiStore.getState().modesOpen) closeModes();
	};

	const first = modes.shown[0];
	// Plan has no form to open on: the section follows the first mode that has one.
	const firstForm = modes.shown.find(mode => mode !== "plan");
	useEffect(() => {
		if (open && followsModes && firstForm) setTab(firstForm);
	}, [open, followsModes, firstForm]);
	const title = t("input.runSettings.title");
	const ApprovalGlyph = APPROVAL_ICONS[approvalMode];
	const delegationName = delegation.mode === null ? null : t(`input.delegation.mode.${delegation.mode}`);
	const full = [
		modes.fullName,
		t("input.runSettings.summaryThinking", { level: thinkingName }),
		speed.ultrafast ? t("input.ultrafast.on") : speed.fast ? t("input.fast.on") : null,
		speed.slow ? t("input.slow.on") : null,
		t("input.approval.title", { mode: t(`input.approval.${approvalMode}`) }),
		delegationName === null ? null : `${t("input.delegation.title")}: ${delegationName}`,
	]
		.filter(Boolean)
		.join(", ");
	const chords = t("input.runChip.chords", {
		plan: formatShortcut(actionKbd("plan.toggle", keymapOverrides)),
		thinking: formatShortcut(actionKbd("thinking.cycle", keymapOverrides)),
	});

	return (
		<>
			<Tooltip
				content={
					<>
						<span className="block">{full}</span>
						<span className="block font-normal opacity-70">{chords}</span>
					</>
				}
				describe={false}
				// Open, the popover says it all; the tooltip otherwise sat over the popover's last rows.
				hidden={open}
			>
				<Button
					aria-busy={delegation.pending || undefined}
					aria-expanded={open}
					aria-haspopup="dialog"
					aria-label={`${title}: ${full}`}
					className="omp-composer-chip omp-composer-fold-2"
					data-active={modes.shown.length > 0 ? "" : undefined}
					data-approval={approvalMode}
					data-mode={first}
					data-run-settings-trigger
					icon={first ? MODE_ICONS[first] : <SlidersHorizontal aria-hidden />}
					onClick={() => {
						if (open) {
							close();
							return;
						}
						setTab(firstForm ?? "plan");
						setFollowsModes(true);
						setOpen(true);
					}}
					ref={triggerRef}
					size="sm"
					trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
					variant="ghost"
				>
					<span className="omp-composer-control-label max-w-64 truncate">{modes.summary ?? title}</span>
					{modes.shown.length > 1 && <span className="omp-composer-count">{modes.shown.length}</span>}
					<span className="omp-composer-glyphs">
						<ApprovalGlyph aria-hidden data-approval={approvalMode} />
						{speed.fast && (
							<Zap
								aria-hidden
								className="text-(--sc-accent)"
								data-speed={speed.ultrafast ? "ultrafast" : "fast"}
								fill={speed.ultrafast ? "currentColor" : "none"}
							/>
						)}
						{speed.slow && <Turtle aria-hidden data-speed="slow" />}
					</span>
				</Button>
			</Tooltip>
			<Popover
				anchorRef={triggerRef}
				ariaLabel={title}
				className="max-h-[min(40rem,var(--omp-popover-room,calc(100dvh-6rem)))] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto"
				onClose={close}
				open={open}
				placement="top-start"
			>
				<div className="flex flex-col gap-3 break-keep">
					<h2 className="text-sc-sm font-semibold text-(--sc-text)">{title}</h2>
					<ModesSection
						active={modes.active}
						onClose={close}
						onTabChange={next => {
							setFollowsModes(false);
							setTab(next);
						}}
						tab={tab}
					/>
					<ThinkingLevelField />
					<ApprovalModeField
						onRequestFullAccess={() => {
							close();
							setConfirmFullAccess(true);
						}}
					/>
					{delegation.mode !== null && (
						<DelegationField mode={delegation.mode} onPick={next => void delegation.pick(next)} />
					)}
					<Suspense fallback={null}>
						<RunAdvisorRow open={open} />
					</Suspense>
					<SpeedFields />
					<AdvancedAndRoles onClose={close} />
				</div>
			</Popover>
			<FullAccessConfirmDialog onClose={() => setConfirmFullAccess(false)} open={confirmFullAccess} />
		</>
	);
}
