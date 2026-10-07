/**
 * Composer mode chip (design-spec §2.2): the one place for session MODES —
 * Plan, Goal, Loop, Vibe and the model pool — each with its inline config in a
 * Popover. Run behavior (thinking, approval, toggles) lives in `RunSettings`;
 * model roles in Settings › Models.
 *
 * The chip names the active mode(s) in the accent (accent = "active mode"),
 * or reads "모드" when none is on. `useUiStore.openModes(tab)` — palette
 * commands, the goal dock, Settings › Features, a model-pool pick returning
 * from the picker — opens this popover on that mode in the focused pane;
 * closing it clears the request.
 */

import { Boxes, ChevronDown, Layers, ListChecks, Repeat, Rocket, Target } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useDisplayPreference } from "../../lib/display-preferences";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Popover, SwitchField, Tabs, Tooltip } from "../common";
import { GoalModeConfig, LoopModeConfig, VibeModeConfig } from "../modes/ModeConfig";
import { ModelPoolConfig } from "../modes/ModelPoolConfig";

export type ComposerModeId = "plan" | "goal" | "loop" | "vibe" | "pool";

const MODE_ICONS: Record<ComposerModeId, ReactNode> = {
	plan: <ListChecks aria-hidden />,
	goal: <Target aria-hidden />,
	loop: <Repeat aria-hidden />,
	vibe: <Rocket aria-hidden />,
	pool: <Boxes aria-hidden />,
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
	const openModelPicker = useUiStore(s => s.openModelPicker);

	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const goalActive = useSessionStore(s => s.goalState?.status === "active" || !!s.goal);
	const loopActive = useSessionStore(s => s.loopMode?.enabled === true);
	const vibeModeEnabled = useSessionStore(s => s.vibeModeEnabled);
	const poolActive = useSessionStore(s => s.modelPool?.enabled === true && s.modelPool.members.length >= 2);
	const goalStatusInFooter = useDisplayPreference("goalStatusInFooter");

	const active: Record<ComposerModeId, boolean> = {
		plan: planModeEnabled,
		goal: goalActive,
		loop: loopActive,
		vibe: vibeModeEnabled,
		pool: poolActive,
	};
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
						tabs={(["plan", "goal", "loop", "vibe", "pool"] as const).map(mode => ({
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
						{tab === "pool" && (
							<ModelPoolConfig
								onAddModel={() => {
									// One overlay at a time: the picker replaces this popover and returns here.
									close();
									openModelPicker("pool");
								}}
							/>
						)}
					</div>
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
			toast({ variant: "error", title: t("modesPanel.actionFailed"), message: String(cause) });
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
