/**
 * Composer mode chip (design-spec §2.2): the one place for session MODES —
 * Plan and Goal — each with its inline config in a
 * Popover. Run behavior (thinking, approval, toggles) lives in `RunSettings`;
 * model roles in Settings › Models.
 *
 * The chip names the active mode(s) in the accent (accent = "active mode"),
 * or reads "모드" when none is on. `useUiStore.openModes(tab)` — palette
 * commands, the goal dock, Settings › Features — opens this popover on that mode in the focused pane;
 * closing it clears the request.
 */

import { ChevronDown, Layers, ListChecks, PanelRight, Rocket, Sparkles, Target, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAutoModePref } from "../../../hooks/use-auto-mode-pref";
import { goalIsActive } from "../../../lib/auto-mode-client";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { isLiveAutopilot, useAutopilotStore } from "../../../stores/autopilot";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Button, IconButton, Popover, SwitchField, Tabs, Tooltip } from "../../common";
import { AutopilotModeConfig } from "../../modes/AutopilotConfig";
import { GoalModeConfig } from "../../modes/ModeConfig";
import { useAutopilotStateText } from "../../panels/autopilot/AutopilotBoardCard";

export type ComposerModeId = "plan" | "goal" | "autopilot";

const MODE_ICONS: Record<ComposerModeId, ReactNode> = {
	plan: <ListChecks aria-hidden />,
	goal: <Target aria-hidden />,
	autopilot: <Rocket aria-hidden />,
};

export function ComposerModes() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const activeTabId = useTabsStore(s => s.activeTabId);
	// openModes() is app-wide; only the focused pane's composer answers it.
	const focusedPane = tabId === null || tabId === activeTabId;
	const requested = useUiStore(s => s.modesOpen) && focusedPane;
	const requestedTab = useUiStore(s => s.modesTab);
	const closeModes = useUiStore(s => s.closeModes);

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
	const modeIds: ComposerModeId[] = ["plan", "goal", "autopilot"];
	const shown = (Object.keys(active) as ComposerModeId[]).filter(
		mode => active[mode] && (mode !== "goal" || goalStatusInFooter),
	);

	const triggerRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<ComposerModeId>("plan");

	useEffect(() => {
		if (!requested) return;
		setTab(requestedTab);
		setOpen(true);
	}, [requested, requestedTab]);

	const close = () => {
		setOpen(false);
		if (useUiStore.getState().modesOpen) closeModes();
	};

	const modeName = (mode: ComposerModeId) =>
		mode === "autopilot" && autopilotState
			? `${t("input.modes.name.autopilot")} · ${autopilotState}`
			: t(`input.modes.name.${mode}`);
	const label = shown.length > 0 ? shown.map(modeName).join(" · ") : t("input.modes.label");
	const first = shown[0];

	return (
		<>
			<Tooltip content={t("input.modes.title")} describe={false}>
				<Button
					aria-expanded={open}
					aria-haspopup="dialog"
					aria-label={shown.length > 0 ? t("input.modes.activeTitle", { modes: label }) : t("input.modes.title")}
					className={cx(
						"omp-composer-chip",
						shown.length > 0 &&
							"bg-(--sc-accent-soft) text-(--sc-accent) hover:bg-(--sc-accent-soft) hover:text-(--sc-accent)",
					)}
					data-composer-modes-trigger
					icon={first ? MODE_ICONS[first] : <Layers aria-hidden />}
					onClick={() => {
						if (open) {
							close();
							return;
						}
						setTab(first ?? "plan");
						setOpen(true);
					}}
					ref={triggerRef}
					size="sm"
					trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
					variant="ghost"
				>
					<span className="omp-composer-control-label omp-composer-label-early max-w-64 truncate">{label}</span>
				</Button>
			</Tooltip>
			{autopilotLive && (
				<IconButton
					className="omp-composer-chip"
					data-autopilot-chip-open
					icon={<PanelRight />}
					label={t("autopilot.chip.open")}
					onClick={() => useUiStore.getState().openAutopilotPanel()}
					size="sm"
				/>
			)}
			<AutoModeChip />
			<Popover
				anchorRef={triggerRef}
				ariaLabel={t("input.modes.label")}
				className="max-h-[min(40rem,calc(100dvh-6rem))] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto"
				onClose={close}
				open={open}
				placement="top-start"
			>
				<div className="flex flex-col gap-2 break-keep">
					<Tabs
						activeId={tab}
						ariaLabel={t("input.modes.label")}
						className="w-full *:flex-1 *:justify-center"
						compact
						onChange={id => setTab(id as ComposerModeId)}
						tabs={modeIds.map(mode => ({
							id: mode,
							label: t(`input.modes.tab.${mode}`),
							badge: active[mode] ? t("modesPanel.on") : undefined,
						}))}
						variant="segmented"
					/>
					<div className="min-h-0">
						{tab === "plan" && <PlanModeConfig />}
						{tab === "goal" && <GoalModeConfig />}
						{tab === "autopilot" && <AutopilotModeConfig onStarted={close} />}
					</div>
					<div className="-mx-3 border-t border-(--sc-divider) px-3 pt-1.5">
						<AutoModeSwitch />
					</div>
				</div>
			</Popover>
		</>
	);
}

/** Plan mode has no config beyond on/off: the agent plans, then asks for approval. */
function PlanModeConfig() {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	// On only for the user's own plan mode, never for one the automatic choice uses for a single request.
	const planModeEnabled = useSessionStore(s => s.planModeEnabled && s.autoMode !== "plan");
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
				className="omp-composer-chip"
				data-auto-mode-chip
				disabled={pending}
				icon={<Sparkles aria-hidden />}
				onClick={() => void undo()}
				size="sm"
				trailingIcon={<X aria-hidden className="text-(--sc-text-subtle)" />}
				variant="ghost"
			>
				<span className="omp-composer-control-label omp-composer-label-early">
					{t(`input.autoMode.chip.${auto}`)}
				</span>
			</Button>
		</Tooltip>
	);
}
