/**
 * Composer Run settings (design-spec §2.2 / §7 "실행 설정"): one trigger and
 * one Popover for everything that tunes HOW the next turns run — thinking
 * level, fast mode, tool approval, and the lower-frequency behavior toggles
 * (auto-compaction, auto-retry, prewalk, steering and interrupt policy).
 * Session MODES (plan / goal / loop / vibe) are a separate control
 * (`ComposerModes`); model roles live in Settings › Models.
 *
 * The trigger always shows the thinking level and adds an icon for any
 * non-default state (fast on, stricter tool approval), so nothing that
 * changes behavior hides behind the popover. Every field applies on change;
 * nothing nests another overlay — granting full access closes the popover
 * first and then confirms in a Dialog.
 */

import {
	ArrowUpRight,
	Brain,
	ChevronDown,
	ChevronRight,
	ShieldCheck,
	SlidersHorizontal,
	Snail,
	Zap,
} from "lucide-react";
import { useRef, useState } from "react";
import type { RpcResponse, RpcSessionState } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { type SettingsStore, useSettingsStore } from "../../stores/settings";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, Popover, SwitchField, Tooltip } from "../common";
import { ApprovalModeField, FullAccessConfirmDialog } from "./ApprovalControl";
import { ContextSizeField } from "./ContextSizeField";
import { ThinkingLevelField, useThinkingSelector } from "./ThinkingControl";

type ToggleKind = "settings" | "prewalk";

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

export function RunSettings() {
	const t = useT();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [confirmFullAccess, setConfirmFullAccess] = useState(false);
	const thinking = useThinkingSelector();
	const autoResolved = useModelStore(s => s.thinkingAutoResolved);
	const supportsThinking = useModelStore(s => s.availableThinkingLevels.length > 0);
	const fastEnabled = useModelStore(s => s.fastModeEnabled);
	const ultrafastEnabled = useModelStore(s => s.ultrafastEnabled);
	const slowEnabled = useModelStore(s => s.slowModeEnabled);
	const approvalMode = useSettingsStore(s => s.approvalMode);
	const strictApproval = approvalMode !== "yolo";

	// Auto names the effort it picked for the latest turn once stock has classified one.
	const thinkingName = !supportsThinking
		? t("input.thinking.name.off")
		: thinking === "auto" && autoResolved
			? t("input.thinking.autoResolved", { level: t(`input.thinking.name.${autoResolved}`) })
			: t(`input.thinking.name.${thinking}`);
	const summary = [
		t("input.runSettings.summaryThinking", { level: thinkingName }),
		ultrafastEnabled ? t("input.ultrafast.on") : fastEnabled ? t("input.fast.on") : null,
		slowEnabled ? t("input.slow.on") : null,
		t("input.approval.title", { mode: t(`input.approval.${approvalMode}`) }),
	]
		.filter(Boolean)
		.join(", ");

	return (
		<>
			<Tooltip content={t("input.runSettings.title")} describe={false}>
				<Button
					aria-expanded={open}
					aria-haspopup="dialog"
					aria-label={`${t("input.runSettings.title")}: ${summary}`}
					className="omp-composer-chip"
					data-run-settings-trigger
					icon={<Brain aria-hidden />}
					onClick={() => setOpen(value => !value)}
					ref={triggerRef}
					size="sm"
					trailingIcon={<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />}
					variant="ghost"
				>
					<span className="omp-composer-control-label">{thinkingName}</span>
					{fastEnabled && (
						<Zap
							aria-hidden
							className="text-(--sc-accent)"
							data-speed={ultrafastEnabled ? "ultrafast" : "fast"}
							fill={ultrafastEnabled ? "currentColor" : "none"}
						/>
					)}
					{slowEnabled && <Snail aria-hidden className="text-(--sc-text-muted)" />}
					{strictApproval && <ShieldCheck aria-hidden className="text-(--sc-text-muted)" />}
				</Button>
			</Tooltip>
			<Popover
				anchorRef={triggerRef}
				ariaLabel={t("input.runSettings.title")}
				className="max-h-[calc(100dvh-var(--sc-space-4))] w-80 overflow-y-auto"
				onClose={() => setOpen(false)}
				open={open}
				placement="top-start"
			>
				<RunSettingsPanel
					onClose={() => setOpen(false)}
					onRequestFullAccess={() => {
						setOpen(false);
						setConfirmFullAccess(true);
					}}
				/>
			</Popover>
			<FullAccessConfirmDialog onClose={() => setConfirmFullAccess(false)} open={confirmFullAccess} />
		</>
	);
}

function RunSettingsPanel({ onClose, onRequestFullAccess }: { onClose: () => void; onRequestFullAccess: () => void }) {
	const t = useT();
	const rpc = useTabRpc();
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
		<div aria-busy={pending} className="flex flex-col break-keep">
			<h2 className="pb-3 text-sc-sm font-semibold text-(--sc-text)">{t("input.runSettings.title")}</h2>
			<div className="flex flex-col gap-3">
				<ThinkingLevelField />
				<SwitchField
					badge={
						fastEnabled && !fastActive ? (
							<Badge variant="muted">{t("input.runSettings.fastInactive")}</Badge>
						) : null
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
				<ApprovalModeField onRequestFullAccess={onRequestFullAccess} />
			</div>
			<div className="-mx-3 mt-3 border-t border-(--sc-divider) px-1 pt-1">
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
		</div>
	);
}
