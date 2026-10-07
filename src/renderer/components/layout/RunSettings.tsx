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

import { Brain, ChevronDown, ChevronRight, ShieldCheck, Zap } from "lucide-react";
import { useRef, useState } from "react";
import type { RpcResponse, RpcSessionState } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { type SettingsStore, useSettingsStore } from "../../stores/settings";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, Popover, SwitchField, Tooltip } from "../common";
import { ApprovalModeField, FullAccessConfirmDialog } from "./ApprovalControl";
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
			toast({ variant: "error", title: t("input.runSettings.failed"), message: String(cause) });
		} finally {
			setPending(false);
		}
	};
	return { pending, run };
}

export function RunSettings({ isChat }: { isChat: boolean }) {
	const t = useT();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [confirmFullAccess, setConfirmFullAccess] = useState(false);
	const thinking = useThinkingSelector();
	const supportsThinking = useModelStore(s => s.availableThinkingLevels.length > 0);
	const fastEnabled = useModelStore(s => s.fastModeEnabled);
	const approvalMode = useSettingsStore(s => s.approvalMode);
	const strictApproval = !isChat && approvalMode !== "yolo";

	const thinkingName = t(`input.thinking.name.${supportsThinking ? thinking : "off"}`);
	const summary = [
		t("input.runSettings.summaryThinking", { level: thinkingName }),
		fastEnabled ? t("input.fast.on") : null,
		isChat ? null : t("input.approval.title", { mode: t(`input.approval.${approvalMode}`) }),
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
					{fastEnabled && <Zap aria-hidden className="text-(--sc-accent)" />}
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
					isChat={isChat}
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

function RunSettingsPanel({
	isChat,
	onClose,
	onRequestFullAccess,
}: {
	isChat: boolean;
	onClose: () => void;
	onRequestFullAccess: () => void;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const fastEnabled = useModelStore(s => s.fastModeEnabled);
	const fastActive = useModelStore(s => s.fastModeActive);
	const toggleFastMode = useModelStore(s => s.toggleFastMode);
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

	return (
		<div aria-busy={pending} className="flex flex-col gap-3">
			<h2 className="text-sc-sm font-semibold text-(--sc-text)">{t("input.runSettings.title")}</h2>
			<ThinkingLevelField />
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
			{!isChat && (
				<>
					<ApprovalModeField onRequestFullAccess={onRequestFullAccess} />
					<div className="-mx-2 border-t border-(--sc-divider) pt-2">
						<Button
							aria-expanded={advancedOpen}
							className="w-full justify-start"
							icon={
								<ChevronRight
									aria-hidden
									className={cx(
										"text-(--sc-text-muted) transition-transform duration-(--sc-duration-fast)",
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
							<div className="mt-1 flex flex-col">
								<SwitchField
									checked={autoCompaction}
									disabled={pending}
									label={t("input.more.autoCompact")}
									onCheckedChange={next => void run(() => rpc.setAutoCompaction(next))}
									size="sm"
								/>
								<SwitchField
									checked={autoRetry}
									disabled={pending}
									label={t("input.more.autoRetry")}
									onCheckedChange={next => void run(() => rpc.setAutoRetry(next))}
									size="sm"
								/>
								<SwitchField
									checked={prewalkArmed}
									description={t("cmd.prewalk.desc")}
									disabled={pending}
									label={t("cmd.prewalk")}
									onCheckedChange={next => void run(() => rpc.setPrewalk(next), "prewalk")}
									size="sm"
								/>
								<SwitchField
									checked={steeringMode === "all"}
									disabled={pending}
									label={t("input.more.steeringAll")}
									onCheckedChange={next => void run(() => rpc.setSteeringMode(next ? "all" : "one-at-a-time"))}
									size="sm"
								/>
								<SwitchField
									checked={interruptMode === "immediate"}
									disabled={pending}
									label={t("input.more.interruptImmediate")}
									onCheckedChange={next => void run(() => rpc.setInterruptMode(next ? "immediate" : "wait"))}
									size="sm"
								/>
							</div>
						)}
					</div>
					<Button
						className="self-start"
						onClick={() => {
							onClose();
							useUiStore.getState().openSettings("models");
						}}
						size="sm"
						variant="ghost"
					>
						{t("input.runSettings.modelRoles")}
					</Button>
				</>
			)}
		</div>
	);
}
