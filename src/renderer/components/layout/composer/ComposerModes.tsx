/**
 * The session MODES of the composer's one Run chip (`RunChip`): Plan, Goal and Autopilot, each with its inline
 * config, plus the automatic Plan/Goal choice switch. This file owns the Mode section of the Run popover
 * (`ModesSection`), what the chip says about the modes (`useComposerModes`: accent = active mode), and the two
 * conditional chips that sit beside the Run chip while they apply (`ComposerModeExtras`: Autopilot's "show the run"
 * button and the auto mode's "This request" chip). Run behavior (thinking, approval, toggles) is in
 * `RunSettings`; model roles live in Settings › Models.
 *
 * `useUiStore.openModes(tab)` — palette commands, the goal dock, Settings › Features — opens the Run popover on
 * that mode in the focused pane (`RunChip` answers it); closing it clears the request.
 */

import { LayoutDashboard, ListChecks, Rocket, Sparkles, Target, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useAutoModePref } from "../../../hooks/use-auto-mode-pref";
import { goalIsActive } from "../../../lib/auto-mode-client";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { isLiveAutopilot, useAutopilotStore } from "../../../stores/autopilot";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { useAutopilotStateText } from "../../autopilot/use-autopilot-state-text";
import { Button, IconButton, SwitchField, Tabs, Tooltip } from "../../common";
import { AutopilotModeConfig } from "../../modes/AutopilotConfig";
import { GoalModeConfig } from "../../modes/ModeConfig";

export type ComposerModeId = "plan" | "goal" | "autopilot";

export const MODE_IDS: readonly ComposerModeId[] = ["plan", "goal", "autopilot"];

export const MODE_ICONS: Record<ComposerModeId, ReactNode> = {
	plan: <ListChecks aria-hidden />,
	goal: <Target aria-hidden />,
	autopilot: <Rocket aria-hidden />,
};

export interface ComposerModesView {
	active: Record<ComposerModeId, boolean>;
	/** The modes the chip names, in tab order (a Goal hidden from the footer by its preference is left out). */
	shown: ComposerModeId[];
	/** The chip's text for the shown modes ("Plan · Goal"); `null` with none. */
	summary: string | null;
	/** The shown modes spelled for the chip's accessible name ("Plan mode · Goal mode"); `null` with none. */
	fullName: string | null;
}

/** What the composer says about the session's modes; the Run chip paints and names itself from it. */
export function useComposerModes(): ComposerModesView {
	const t = useT();
	// A mode the automatic choice uses for one request is not the user's mode: the picker leaves it out (its chip shows it).
	const planModeEnabled = useSessionStore(s => s.planModeEnabled && s.autoMode !== "plan");
	// An Autopilot run is a Goal underneath: it shows as Autopilot, never as the user's Goal.
	const autopilotLive = useAutopilotStore(isLiveAutopilot);
	// goalIsActive is the one definition (a paused goal is still the session's goal), as the auto-mode chip reads it.
	const goalActive = useSessionStore(s => goalIsActive(s) && s.autoMode !== "goal") && !autopilotLive;
	const goalStatusInFooter = useDisplayPreference("goalStatusInFooter");
	const autopilotState = useAutopilotStateText();

	const active: Record<ComposerModeId, boolean> = {
		plan: planModeEnabled,
		goal: goalActive,
		autopilot: autopilotLive,
	};
	const shown = MODE_IDS.filter(mode => active[mode] && (mode !== "goal" || goalStatusInFooter));
	const named = (mode: ComposerModeId, key: "tab" | "name") =>
		mode === "autopilot" && autopilotState
			? `${t(`input.modes.${key}.autopilot`)} · ${autopilotState}`
			: t(`input.modes.${key}.${mode}`);
	return {
		active,
		shown,
		summary: shown.length > 0 ? shown.map(mode => named(mode, "tab")).join(" · ") : null,
		fullName: shown.length > 0 ? shown.map(mode => named(mode, "name")).join(" · ") : null,
	};
}

/**
 * The popover's Mode section: one tab per mode and the selected mode's config, then the automatic-choice switch.
 * `tab` is controlled so `openModes(tab)` and the chip's first-active-mode default can pick it.
 */
export function ModesSection({
	active,
	tab,
	onTabChange,
	onClose,
}: {
	active: Record<ComposerModeId, boolean>;
	tab: ComposerModeId;
	onTabChange: (tab: ComposerModeId) => void;
	/** Closes the Run popover (Autopilot's Start leaves it). */
	onClose: () => void;
}) {
	const t = useT();
	return (
		<section
			aria-label={t("input.modes.label")}
			className="flex flex-col gap-2 break-keep"
			data-composer-modes-section
		>
			<h3 className="text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">
				{t("input.modes.label")}
			</h3>
			{/* Underlined tabs, not a segmented pick: the selected tab is only which mode's controls show (the Plan
			    tab over an off Plan switch read as Plan chosen and off at once); a mode that is on says so in its badge. */}
			<Tabs
				activeId={tab}
				ariaLabel={t("input.modes.label")}
				className="w-full *:flex-1 *:justify-center"
				compact
				onChange={id => onTabChange(id as ComposerModeId)}
				tabs={MODE_IDS.map(mode => ({
					id: mode,
					label: t(`input.modes.tab.${mode}`),
					badge: active[mode] ? t("modesPanel.on") : undefined,
				}))}
			/>
			<div className="min-h-0">
				{tab === "plan" && <PlanModeConfig />}
				{tab === "goal" && <GoalModeConfig />}
				{tab === "autopilot" && <AutopilotModeConfig onStarted={onClose} />}
			</div>
			<div className="-mx-3 border-t border-(--sc-divider) px-3 pt-1.5">
				<AutoModeSwitch />
			</div>
		</section>
	);
}

/**
 * Autopilot's "show the run" button and the auto-mode "This request" chip: extra buttons beside the Run chip. The run
 * is shown on this pane's work board (docked, or its strip expanded), never in the side panel.
 */
export function ComposerModeExtras() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const autopilotLive = useAutopilotStore(isLiveAutopilot);
	return (
		<>
			{autopilotLive && (
				<IconButton
					className="omp-composer-chip"
					data-autopilot-chip-open
					icon={<LayoutDashboard />}
					label={t("autopilot.chip.open")}
					onClick={() => useUiStore.getState().revealWorkBoard(tabId)}
					size="sm"
				/>
			)}
			<AutoModeChip />
		</>
	);
}

/**
 * The user's plan mode and its switch (`set_plan_mode`): the Mode popover's Plan switch and the phone's Plan chip
 * are the same toggle. On only for the user's own plan mode, never for one the automatic choice uses for one request.
 */
export function usePlanToggle(): { enabled: boolean; pending: boolean; toggle: (next: boolean) => Promise<void> } {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const enabled = useSessionStore(s => s.planModeEnabled && s.autoMode !== "plan");
	const [pending, setPending] = useState(false);

	const toggle = async (next: boolean) => {
		if (pending) return;
		const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const originSession = session.getState().sessionId;
		setPending(true);
		try {
			const response = await rpc.setPlanMode(next);
			if (!response.success) throw new Error(response.error);
			const data = response.data as { enabled?: boolean } | undefined;
			if (typeof data?.enabled === "boolean" && session.getState().sessionId === originSession) {
				// Turned on over a plan the automatic choice used for one request: it is the user's plan mode now.
				session.setState({ planModeEnabled: data.enabled, autoMode: null });
			}
		} catch (cause) {
			toastError({ title: t("modesPanel.actionFailed"), error: cause });
		} finally {
			setPending(false);
		}
	};
	return { enabled, pending, toggle };
}

/** Plan mode has no config beyond on/off: the agent plans, then asks for approval. */
function PlanModeConfig() {
	const t = useT();
	const { enabled: planModeEnabled, pending, toggle } = usePlanToggle();

	return (
		<SwitchField
			checked={planModeEnabled}
			className="-mx-2"
			data-plan-mode
			description={t("input.modes.planDesc")}
			infoOnly
			disabled={pending}
			label={t("input.modes.planToggle")}
			onCheckedChange={next => void toggle(next)}
		/>
	);
}

/** The Mode popover's one switch for the automatic Plan/Goal choice (prefs `autoMode`, default on). */
function AutoModeSwitch() {
	const t = useT();
	const [enabled, setEnabled] = useAutoModePref();
	return (
		<SwitchField
			checked={enabled}
			className="-mx-2"
			data-auto-mode-switch
			description={t("input.autoMode.desc")}
			infoOnly
			label={t("input.autoMode.label")}
			onCheckedChange={setEnabled}
		/>
	);
}

/**
 * "This request: Plan" / "This request: Goal": the mode the automatic choice uses for the request it classified (the
 * Mode picker never shows it), with a one-click undo (leaves the mode and stops automatic decisions for this session).
 * Gone as soon as that mode ends by any route: the plan approved, rejected or replaced by an unrelated message, the
 * goal completed or stopped.
 */
function AutoModeChip() {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const auto = useSessionStore(s => s.autoMode);
	const live = useSessionStore(s =>
		s.autoMode === "plan" ? s.planModeEnabled : s.autoMode === "goal" && goalIsActive(s),
	);
	const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
	const [pending, setPending] = useState(false);

	useEffect(() => {
		if (auto && !live) session.setState({ autoMode: null });
	}, [auto, live, session]);

	if (!auto || !live) return null;
	const undo = async () => {
		if (pending) return;
		setPending(true);
		try {
			const response = await rpc.autoModeUndo(auto);
			if (!response.success) throw new Error(response.error);
			session.setState(
				auto === "plan"
					? { planModeEnabled: false, autoMode: null }
					: { goal: null, goalState: null, autoMode: null },
			);
		} catch (cause) {
			toastError({ title: t("modesPanel.actionFailed"), error: cause });
		} finally {
			setPending(false);
		}
	};
	return (
		<Tooltip content={t("input.autoMode.undoTitle")}>
			<Button
				className="omp-composer-chip omp-composer-fold-1"
				data-auto-mode-chip
				disabled={pending}
				icon={<Sparkles aria-hidden />}
				onClick={() => void undo()}
				size="sm"
				trailingIcon={<X aria-hidden className="text-(--sc-text-subtle)" />}
				variant="ghost"
			>
				<span className="omp-composer-control-label">{t(`input.autoMode.chip.${auto}`)}</span>
			</Button>
		</Tooltip>
	);
}
