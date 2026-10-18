/**
 * The Run chip popover's run-behavior sections (design-spec §2.2 / §7 "실행 설정"): everything that tunes HOW the
 * next turns run — the speed switches (fast, ultrafast, slow) and the lower-frequency behavior toggles
 * (auto-compaction, auto-retry, prewalk, steering and interrupt policy) under "Advanced", then Model roles.
 * Thinking level, tool approval, delegation and the session MODES are sections of their own
 * (`ThinkingControl`, `ApprovalControl`, `DelegationField`, `ComposerModes`); `RunChip` stacks them all.
 * `useRunSummary` is what the chip and the model chip say about the current run state.
 *
 * Every field applies on change; nothing nests another overlay — granting full access closes the popover first and
 * then confirms in a Dialog (`RunChip`).
 */

import { ArrowUpRight, ChevronRight, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import type { RpcResponse, RpcSessionState } from "../../../../shared/rpc-types";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useModelStore } from "../../../stores/model";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { type SettingsStore, useSettingsStore } from "../../../stores/settings";
import { toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Badge, Button, SwitchField } from "../../common";
import { ContextSizeField } from "./ContextSizeField";
import { useThinkingSelector } from "./ThinkingControl";

type ToggleKind = "settings" | "prewalk";

/** The thinking level as the composer names it: Auto names the effort it picked once stock has classified a turn. */
export function useThinkingName(): string {
	const t = useT();
	const thinking = useThinkingSelector();
	const autoResolved = useModelStore(s => s.thinkingAutoResolved);
	const supportsThinking = useModelStore(s => s.availableThinkingLevels.length > 0);
	if (!supportsThinking) return t("input.thinking.name.off");
	return thinking === "auto" && autoResolved
		? t("input.thinking.autoResolved", { level: t(`input.thinking.name.${autoResolved}`) })
		: t(`input.thinking.name.${thinking}`);
}

/** The speed tiers that are on: what the Run chip shows as a glyph and spells in its name. */
export function useSpeedState() {
	return {
		fast: useModelStore(s => s.fastModeEnabled),
		ultrafast: useModelStore(s => s.ultrafastEnabled),
		slow: useModelStore(s => s.slowModeEnabled),
	};
}

/**
 * Run one session-toggle RPC and fold the authoritative state back into the
 * stores of the tab that asked — never into a tab or session selected while
 * the call was in flight.
 */
function useSessionToggle() {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const [pending, setPending] = useState(false);
	const run = async (action: () => Promise<RpcResponse>, kind: ToggleKind = "settings") => {
		if (pending) return;
		const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const settings = sessionRuntimeStore<SettingsStore>(tabId, "settings") ?? useSettingsStore;
		const originSession = session.getState().sessionId;
		setPending(true);
		try {
			const response = await action();
			if (!response.success) throw new Error(response.error);
			const data = response.data as { enabled?: boolean } | undefined;
			if (kind === "prewalk" && typeof data?.enabled === "boolean") {
				if (session.getState().sessionId === originSession) session.setState({ prewalkArmed: data.enabled });
				return;
			}
			const current = await rpc.getState();
			if (!current.success) throw new Error(current.error);
			if (session.getState().sessionId !== originSession) return;
			const state = current.data as RpcSessionState;
			settings.getState().setFromState(state);
			session.setState({ planModeEnabled: state.planModeEnabled });
		} catch (cause) {
			toastError({ title: t("input.runSettings.failed"), error: cause });
		} finally {
			setPending(false);
		}
	};
	return { pending, run };
}

/** Fast, Ultrafast and Slow mode switches (each only where the model offers the tier). */
export function SpeedFields() {
	const t = useT();
	const fastEnabled = useModelStore(s => s.fastModeEnabled);
	const fastActive = useModelStore(s => s.fastModeActive);
	const toggleFastMode = useModelStore(s => s.toggleFastMode);
	const ultrafastSupported = useModelStore(s => s.ultrafastSupported);
	const ultrafastEnabled = useModelStore(s => s.ultrafastEnabled);
	const toggleUltrafastMode = useModelStore(s => s.toggleUltrafastMode);
	const slowSupported = useModelStore(s => s.slowModeSupported);
	const slowEnabled = useModelStore(s => s.slowModeEnabled);
	const slowScope = useModelStore(s => s.slowModeScope);
	const toggleSlowMode = useModelStore(s => s.toggleSlowMode);
	return (
		<>
			<SwitchField
				badge={
					fastEnabled && !fastActive ? <Badge variant="muted">{t("input.runSettings.fastInactive")}</Badge> : null
				}
				checked={fastEnabled}
				className="-mx-2"
				data-fast-mode
				description={t("input.runSettings.fastDesc")}
				label={t("input.runSettings.fast")}
				onCheckedChange={() => void toggleFastMode()}
				size="sm"
			/>
			{ultrafastSupported && (
				<SwitchField
					checked={ultrafastEnabled}
					className="-mx-2"
					data-ultrafast-mode
					description={t("input.runSettings.ultrafastDesc")}
					label={t("input.runSettings.ultrafast")}
					onCheckedChange={() => void toggleUltrafastMode()}
					size="sm"
				/>
			)}
			{slowSupported && (
				<SwitchField
					checked={slowEnabled}
					className="-mx-2"
					data-slow-mode
					description={t(
						slowScope === "global" ? "input.runSettings.slowDescGlobal" : "input.runSettings.slowDescSession",
					)}
					label={t("input.runSettings.slow")}
					onCheckedChange={() => void toggleSlowMode()}
					size="sm"
				/>
			)}
		</>
	);
}

/** The collapsed "Advanced" behavior toggles and the Model roles link (closes the popover on the way out). */
export function AdvancedAndRoles({ onClose }: { onClose: () => void }) {
	const t = useT();
	const rpc = useTabRpc();
	const autoCompaction = useSettingsStore(s => s.autoCompaction);
	const autoRetry = useSettingsStore(s => s.autoRetry);
	const steeringMode = useSettingsStore(s => s.steeringMode);
	const interruptMode = useSettingsStore(s => s.interruptMode);
	const prewalkArmed = useSessionStore(s => s.prewalkArmed);
	const { pending, run } = useSessionToggle();
	// Defaults: auto-compaction and auto-retry on, steering one at a time,
	// interrupts wait for the tool, prewalk unarmed. A changed value opens the
	// section so non-default behavior is never hidden.
	const advancedChanged =
		!autoCompaction || !autoRetry || prewalkArmed || steeringMode === "all" || interruptMode === "immediate";
	const [advancedOpen, setAdvancedOpen] = useState(advancedChanged);

	/** Advanced toggles are secondary: body-size, regular-weight labels. */
	const advancedLabel = (key: string) => <span className="text-sc-sm font-normal">{t(key)}</span>;

	return (
		<>
			<div aria-busy={pending} className="-mx-3 border-t border-(--sc-divider) px-1 pt-1">
				<Button
					aria-expanded={advancedOpen}
					className="w-full justify-start"
					icon={
						<ChevronRight
							aria-hidden
							className={cx(
								"text-(--sc-text-muted) transition-transform duration-(--sc-duration-fast) motion-reduce:transition-none",
								advancedOpen && "rotate-90",
							)}
						/>
					}
					onClick={() => setAdvancedOpen(value => !value)}
					size="sm"
					variant="ghost"
				>
					{t("input.runSettings.advanced")}
				</Button>
				{advancedOpen && (
					<div className="flex flex-col pb-1">
						<SwitchField
							checked={autoCompaction}
							disabled={pending}
							label={advancedLabel("input.more.autoCompact")}
							onCheckedChange={next => void run(() => rpc.setAutoCompaction(next))}
							size="sm"
						/>
						<ContextSizeField />
						<SwitchField
							checked={autoRetry}
							disabled={pending}
							label={advancedLabel("input.more.autoRetry")}
							onCheckedChange={next => void run(() => rpc.setAutoRetry(next))}
							size="sm"
						/>
						<SwitchField
							checked={prewalkArmed}
							description={t("cmd.prewalk.desc")}
							disabled={pending}
							label={advancedLabel("cmd.prewalk")}
							onCheckedChange={next => void run(() => rpc.setPrewalk(next), "prewalk")}
							size="sm"
						/>
						<SwitchField
							checked={steeringMode === "all"}
							disabled={pending}
							label={advancedLabel("input.more.steeringAll")}
							onCheckedChange={next => void run(() => rpc.setSteeringMode(next ? "all" : "one-at-a-time"))}
							size="sm"
						/>
						<SwitchField
							checked={interruptMode === "immediate"}
							disabled={pending}
							label={advancedLabel("input.more.interruptImmediate")}
							onCheckedChange={next => void run(() => rpc.setInterruptMode(next ? "immediate" : "wait"))}
							size="sm"
						/>
					</div>
				)}
			</div>
			<div className="-mx-3 -mb-1 border-t border-(--sc-divider) px-1 pt-1">
				<Button
					className="w-full justify-start"
					icon={<SlidersHorizontal aria-hidden className="text-(--sc-text-muted)" />}
					onClick={() => {
						onClose();
						useUiStore.getState().openSettings("models:roles");
					}}
					size="sm"
					trailingIcon={<ArrowUpRight aria-hidden className="ml-auto text-(--sc-text-subtle)" />}
					variant="ghost"
				>
					{t("input.runSettings.modelRoles")}
				</Button>
			</div>
		</>
	);
}
