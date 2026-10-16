/**
 * Composer mode chip (design-spec §2.2): the one place for session MODES —
 * Plan, Goal, Loop, Ratchet and Vibe — each with its inline config in a
 * Popover. Run behavior (thinking, approval, toggles) lives in `RunSettings`;
 * model roles in Settings › Models.
 *
 * The chip names the active mode(s) in the accent (accent = "active mode"),
 * or reads "모드" when none is on. `useUiStore.openModes(tab)` — palette
 * commands, the goal dock, Settings › Features — opens this popover on that mode in the focused pane;
 * closing it clears the request.
 */

import { ChevronDown, Layers, ListChecks, Repeat, Rocket, Sparkles, Target, TrendingUp, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { RpcRatchetState } from "../../../../shared/rpc-types";
import { useAutoModePref } from "../../../hooks/use-auto-mode-pref";
import { goalIsActive } from "../../../lib/auto-mode-client";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Button, Popover, SwitchField, Tabs, Tooltip } from "../../common";
import { GoalModeConfig, LoopModeConfig, VibeModeConfig } from "../../modes/ModeConfig";

export type ComposerModeId = "plan" | "goal" | "loop" | "ratchet" | "vibe";

const MODE_ICONS: Record<ComposerModeId, ReactNode> = {
	plan: <ListChecks aria-hidden />,
	goal: <Target aria-hidden />,
	loop: <Repeat aria-hidden />,
	vibe: <Rocket aria-hidden />,
	ratchet: <TrendingUp aria-hidden />,
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

	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const goalActive = useSessionStore(s => s.goalState?.status === "active" || !!s.goal);
	const loopActive = useSessionStore(s => s.loopMode?.enabled === true);
	const vibeModeEnabled = useSessionStore(s => s.vibeModeEnabled);
	const ratchetSupported = useSessionStore(s => s.ratchet !== null);
	const ratchetActive = useSessionStore(s => s.ratchet?.enabled === true);
	const goalStatusInFooter = useDisplayPreference("goalStatusInFooter");

	const active: Record<ComposerModeId, boolean> = {
		plan: planModeEnabled,
		goal: goalActive,
		loop: loopActive,
		vibe: vibeModeEnabled,
		ratchet: ratchetActive,
	};
	const modeIds: ComposerModeId[] = ratchetSupported
		? ["plan", "goal", "loop", "ratchet", "vibe"]
		: ["plan", "goal", "loop", "vibe"];
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

	const label =
		shown.length > 0 ? shown.map(mode => t(`input.modes.name.${mode}`)).join(" · ") : t("input.modes.label");
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
					<span className="omp-composer-control-label omp-composer-label-early max-w-48 truncate">{label}</span>
				</Button>
			</Tooltip>
			<AutoModeChip />
			<Popover
				anchorRef={triggerRef}
				ariaLabel={t("input.modes.label")}
				className="max-h-[calc(100dvh-var(--sc-space-4))] w-96 overflow-y-auto"
				onClose={close}
				open={open}
				placement="top-start"
			>
				<div className="flex flex-col gap-3 break-keep">
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
						{tab === "loop" && <LoopModeConfig />}
						{tab === "vibe" && <VibeModeConfig />}
						{tab === "ratchet" && <RatchetModeConfig />}
					</div>
					<AutoModeSwitch />
					<p className="-mx-3 -mb-1 border-t border-(--sc-divider) px-3 pt-2.5 text-sc-xs text-(--sc-text-muted)">
						{t("modesPanel.footerNote")}
					</p>
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
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
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
				session.setState({ planModeEnabled: data.enabled });
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
			disabled={pending}
			label={t("input.modes.planToggle")}
			onCheckedChange={next => void toggle(next)}
		/>
	);
}

/**
 * Ratchet (stock `/ratchet`): turns stock's `ratchet.enabled` on for this session (never saved). It only arms the
 * eval helper; the user then describes the flow and goal in a message. Manual only: never chosen automatically.
 * Without the `eval` and `task` tools stock refuses, so the switch is off and says which tools are missing.
 */
function RatchetModeConfig() {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const ratchet = useSessionStore(s => s.ratchet);
	const [pending, setPending] = useState(false);
	const missing = ratchet?.missing ?? [];

	const toggle = async (next: boolean) => {
		if (pending) return;
		const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const originSession = session.getState().sessionId;
		setPending(true);
		try {
			const response = await rpc.setRatchet(next);
			if (!response.success) throw new Error(response.error);
			if (session.getState().sessionId === originSession) {
				session.setState({ ratchet: response.data as RpcRatchetState });
			}
		} catch (cause) {
			toastError({ title: t("modesPanel.actionFailed"), error: cause });
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="flex flex-col gap-1">
			<SwitchField
				checked={ratchet?.enabled === true}
				className="-mx-2"
				data-ratchet-mode
				description={t("input.modes.ratchetDesc")}
				disabled={pending || (missing.length > 0 && ratchet?.enabled !== true)}
				label={t("input.modes.ratchetToggle")}
				onCheckedChange={next => void toggle(next)}
			/>
			{missing.length > 0 && (
				<p className="text-sc-xs text-(--sc-warning)" data-ratchet-missing role="status">
					{t("input.modes.ratchetMissing", { tools: missing.join(", ") })}
				</p>
			)}
		</div>
	);
}

/** The Mode popover's one switch for the automatic Plan/Goal choice (prefs `autoMode`, default on). */
function AutoModeSwitch() {
	const t = useT();
	const [enabled, setEnabled] = useAutoModePref();
	return (
		<div className="flex flex-col gap-0.5">
			<SwitchField
				checked={enabled}
				className="-mx-2"
				data-auto-mode-switch
				label={t("input.autoMode.label")}
				onCheckedChange={setEnabled}
			/>
			<p className="text-sc-xs text-(--sc-text-muted)">{t("input.autoMode.desc")}</p>
		</div>
	);
}

/**
 * "Auto: Plan" / "Auto: Goal": the mode the app entered for the last prompt, with a one-click undo (leaves the mode
 * and stops automatic decisions for this session). Gone as soon as that mode ends by any route.
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
