/**
 * The Run chip popover's run-behavior sections: everything that tunes HOW the
 * next turns run — the speed switches (fast, slow, ultrafast) and the lower-frequency behavior toggles
 * (auto-compaction, context, auto-retry, prewalk, steering and interrupt policy) under "Advanced", both as switch tiles
 * two to a row (`SwitchTile`, one line each, the explanation behind an (i)), then Model roles.
 * Thinking level, tool approval, delegation and the session MODES are sections of their own
 * (`ThinkingControl`, `ApprovalControl`, `DelegationField`, `ComposerModes`); `RunChip` stacks them all.
 * `useRunSummary` is what the chip and the model chip say about the current run state.
 *
 * Every field applies on change; nothing nests another overlay — granting full access closes the popover first and
 * then confirms in a Dialog (`RunChip`).
 */

import {
	ArrowUpRight,
	ChevronRight,
	Gauge,
	Layers,
	OctagonX,
	Rocket,
	RotateCw,
	Shrink,
	SlidersHorizontal,
	Turtle,
	Zap,
} from "lucide-react";
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
import { Button, SwitchTile } from "../../common";
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

/**
 * Fast, Slow and Ultrafast as switch tiles, two to a row (each only where the model offers the tier). The explanation
 * of each is behind its (i); "not on this model" dims the glyph and joins the explanation instead of a badge.
 */
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
	const fastIdle = fastEnabled && !fastActive;
	return (
		// Tiles pair up; a tile left alone on its row (Fast without Slow, Ultrafast after the pair) takes the whole row,
		// so its switch lines up at the right edge with the rows above instead of stopping mid-sheet.
		<div className="-mx-1.5 grid grid-cols-2 gap-x-1 [&>:last-child:nth-child(odd)]:col-span-2" data-switch-grid>
			<SwitchTile
				checked={fastEnabled}
				data-fast-mode
				description={
					fastIdle
						? `${t("input.runSettings.fastDesc")} ${t("input.runSettings.fastInactive")}`
						: t("input.runSettings.fastDesc")
				}
				icon={<Zap className={cx(fastIdle && "opacity-50")} />}
				label={t("input.runSettings.fast")}
				onCheckedChange={() => void toggleFastMode()}
			/>
			{slowSupported && (
				<SwitchTile
					checked={slowEnabled}
					data-slow-mode
					description={t(
						slowScope === "global" ? "input.runSettings.slowDescGlobal" : "input.runSettings.slowDescSession",
					)}
					icon={<Turtle />}
					label={t("input.runSettings.slow")}
					onCheckedChange={() => void toggleSlowMode()}
				/>
			)}
			{ultrafastSupported && (
				<SwitchTile
					checked={ultrafastEnabled}
					data-ultrafast-mode
					description={t("input.runSettings.ultrafastDesc")}
					icon={<Gauge />}
					label={t("input.runSettings.ultrafast")}
					onCheckedChange={() => void toggleUltrafastMode()}
				/>
			)}
		</div>
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
	const [advancedOpen, setAdvancedOpen] = useState(false);

	return (
		<>
			<div aria-busy={pending} className="-mx-3 border-t border-(--sc-divider) px-1 pt-1">
				<Button
					aria-expanded={advancedOpen}
					className="w-full justify-start"
					data-run-sheet-row
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
					<div className="grid grid-cols-2 gap-x-1 pb-1" data-switch-grid>
						<SwitchTile
							checked={autoCompaction}
							description={t("input.more.autoCompactDesc")}
							disabled={pending}
							icon={<Shrink />}
							label={t("input.more.autoCompact")}
							onCheckedChange={next => void run(() => rpc.setAutoCompaction(next))}
						/>
						<ContextSizeField />
						<SwitchTile
							checked={autoRetry}
							description={t("input.more.autoRetryDesc")}
							disabled={pending}
							icon={<RotateCw />}
							label={t("input.more.autoRetry")}
							onCheckedChange={next => void run(() => rpc.setAutoRetry(next))}
						/>
						<SwitchTile
							checked={prewalkArmed}
							description={t("cmd.prewalk.desc")}
							disabled={pending}
							icon={<Rocket />}
							label={t("cmd.prewalk")}
							onCheckedChange={next => void run(() => rpc.setPrewalk(next), "prewalk")}
						/>
						<SwitchTile
							checked={steeringMode === "all"}
							description={t("input.more.steeringAllDesc")}
							disabled={pending}
							icon={<Layers />}
							label={t("input.more.steeringAll")}
							onCheckedChange={next => void run(() => rpc.setSteeringMode(next ? "all" : "one-at-a-time"))}
						/>
						<SwitchTile
							checked={interruptMode === "immediate"}
							description={t("input.more.interruptImmediateDesc")}
							disabled={pending}
							icon={<OctagonX />}
							label={t("input.more.interruptImmediate")}
							onCheckedChange={next => void run(() => rpc.setInterruptMode(next ? "immediate" : "wait"))}
						/>
					</div>
				)}
			</div>
			{/* Pinned to the popover's foot (flush with its edge: sticky counts the surface's 12 px padding in): in a short
			    window the rows above scroll under it, so it is never half cut. A phone's sheet scrolls as one, unpinned. */}
			<div className="sticky -bottom-3 z-10 -mx-3 -mb-1 border-t border-(--sc-divider) bg-(--sc-elevated) px-1 pt-1 in-[.omp-action-sheet]:static">
				<Button
					className="w-full justify-start"
					data-run-sheet-row
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
