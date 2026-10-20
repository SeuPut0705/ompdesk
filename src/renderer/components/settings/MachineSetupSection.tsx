/**
 * Settings › Updates & about › This computer: every tool OMPdesk sets up on this
 * machine (SETUP_ITEMS order), what detection found, and what main is doing
 * about it. Main installs on its own; this only shows it, with Cancel while an
 * item runs and Retry after a failure, a cancel or a backoff.
 */

import { ExternalLink, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import { useState } from "react";
import type { GitAslrAction, SetupItemState } from "../../../shared/setup";
import { useT } from "../../lib/i18n";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { Badge, Button, InlineNotice, SettingInfo } from "../common";
import {
	SETUP_DETAILED,
	SETUP_ITEM_NAMES,
	SETUP_RETRYABLE,
	SetupItemDetails,
	SetupManualSteps,
	SetupMark,
	SetupOutput,
	SetupProgressLine,
	setupFailureText,
	setupPhaseText,
	setupPresenceNote,
	setupPresencePath,
	useMachineSetupState,
} from "../onboarding/MachineSetupView";
import { CliUpdateRows } from "./CliUpdateRows";
import { DiskCareRow } from "./DiskCareRow";
import { ExtensionUpdateRows } from "./ExtensionUpdateRows";
import { MemoryComponentRow } from "./memory/MemoryComponentRow";
import { OmpUpdateRows } from "./OmpUpdateRows";
import { SettingsSection } from "./SettingsLayout";

/**
 * The Git item under Mandatory ASLR: the probe's finding with one Fix button, or, once Windows holds the
 * override, Undo when OMPdesk recorded what its Fix changed (`gitAslrUndoable`); an override without that record
 * says so and offers nothing. Each click is one elevated step (a UAC prompt) in main; detection runs again after.
 */
function GitAslrControl({ item }: { item: SetupItemState }) {
	const t = useT();
	const [busy, setBusy] = useState<GitAslrAction | null>(null);
	const [error, setError] = useState<string | null>(null);
	const presence = item.presence?.kind === "present" ? item.presence : null;
	const blocked = presence?.gitShell?.kind === "mandatory-aslr";
	if (!blocked && !presence?.gitAslrOverride) return null;
	const run = async (action: GitAslrAction) => {
		setBusy(action);
		setError(null);
		const result = await window.omp.setup.gitAslr(action).catch((cause: unknown) => ({
			ok: false as const,
			detail: cause instanceof Error ? cause.message : String(cause),
		}));
		setBusy(null);
		if (!result.ok) setError(result.detail || t("machineSetup.gitAslr.failed"));
	};
	const action: GitAslrAction = blocked ? "fix" : "undo";
	const offered = blocked || presence?.gitAslrUndoable === true;
	return (
		<InlineNotice
			action={
				offered && (
					<Button
						data-testid={`setup-git-aslr-${action}`}
						disabled={busy !== null}
						icon={action === "fix" ? <ShieldCheck /> : <Undo2 />}
						onClick={() => void run(action)}
						size="sm"
						variant={action === "fix" ? "primary" : "secondary"}
					>
						{t(action === "fix" ? "machineSetup.gitAslr.fix" : "machineSetup.gitAslr.undo")}
					</Button>
				)
			}
			detail={
				error ??
				(action === "fix"
					? t("machineSetup.gitAslr.fixDetail")
					: offered
						? undefined
						: t("machineSetup.gitAslr.noRecord"))
			}
			title={blocked ? t("machineSetup.presence.gitShellAslr") : t("machineSetup.gitAslr.applied")}
			tone={error ? "danger" : blocked ? "warning" : "info"}
		/>
	);
}
function SetupItemRow({ item, windows }: { item: SetupItemState; windows: boolean }) {
	const t = useT();
	const retry = useMachineSetupStore(store => store.retry);
	const cancel = useMachineSetupStore(store => store.cancel);
	const name = SETUP_ITEM_NAMES[item.id];
	// The Mandatory ASLR finding is its own notice with the Fix button below; the status line stays short.
	const note =
		item.presence?.kind === "present" && item.presence.gitShell?.kind === "mandatory-aslr"
			? null
			: setupPresenceNote(t, item);
	const path = setupPresencePath(item);
	const purpose = item.id === "git" && windows ? "gitWindows" : item.id;
	return (
		<div className="settings-row min-w-0 py-1.5" data-phase={item.phase} data-setup-item={item.id}>
			<div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
				<div className="min-w-0 flex-1">
					<div className="flex min-h-(--sc-control-sm) flex-wrap items-center gap-x-2 gap-y-0.5">
						<SetupMark phase={item.phase} />
						<span className="text-sc-md font-medium text-(--sc-text)">{name}</span>
						<Badge variant="muted">
							{item.required ? t("machineSetup.required") : t("machineSetup.optional")}
						</Badge>
						<SettingInfo text={t(`machineSetup.purpose.${purpose}`)} />
					</div>
					{/* The purpose rides the info glyph: one line per tool for its status and where it lives. */}
					<p className="flex min-w-0 items-baseline gap-x-2 ps-6 text-sc-xs text-(--sc-text-secondary)">
						<span className="shrink-0">
							{setupPhaseText(t, item)}
							{note && <span className="text-(--sc-text-muted)"> · {note}</span>}
						</span>
						{path && (
							<span className="min-w-0 truncate font-mono text-(--sc-text-muted) select-text" title={path}>
								{path}
							</span>
						)}
					</p>
					<SetupProgressLine className="mt-1" item={item} />
				</div>
				{(item.phase === "running" || SETUP_RETRYABLE.includes(item.phase)) && (
					<div className="flex max-w-full flex-wrap items-center gap-2">
						{item.phase === "running" && (
							<Button data-testid="setup-cancel" onClick={() => void cancel()} size="sm" variant="secondary">
								{t("common.cancel")}
							</Button>
						)}
						{SETUP_RETRYABLE.includes(item.phase) && (
							<Button
								data-testid="setup-retry"
								icon={<RefreshCw />}
								onClick={() => void retry(item.id)}
								size="sm"
								variant="secondary"
							>
								{t("common.retry")}
							</Button>
						)}
					</div>
				)}
			</div>
			{item.id === "git" && windows && <GitAslrControl item={item} />}
			{item.phase === "unavailable" && (
				<InlineNotice
					action={
						item.manualUrl ? (
							<Button
								icon={<ExternalLink />}
								onClick={() => void window.omp.system.openExternal(item.manualUrl)}
								size="sm"
								variant="ghost"
							>
								{t("machineSetup.manual.open")}
							</Button>
						) : undefined
					}
					title={t("machineSetup.unavailableHint", { name })}
					tone="info"
				/>
			)}
			{item.phase === "backoff" && (
				<InlineNotice
					detail={item.failure ? setupFailureText(t, item, item.failure) : undefined}
					title={t("machineSetup.backoffHint")}
					tone="warning"
				/>
			)}
			{item.phase === "failed" && (
				<InlineNotice
					detail={item.failure?.detail}
					title={item.failure ? setupFailureText(t, item, item.failure) : t("machineSetup.reason.unknown")}
					tone="danger"
				/>
			)}
			{item.phase === "cancelled" && <InlineNotice title={t("machineSetup.cancelledHint")} tone="warning" />}
			{SETUP_DETAILED.includes(item.phase) && (
				<div className="mt-2 flex min-w-0 flex-col gap-2">
					<SetupItemDetails item={item} />
					<SetupOutput item={item} />
					{item.phase !== "running" && <SetupManualSteps item={item} />}
				</div>
			)}
		</div>
	);
}

export function MachineSetupSection() {
	const t = useT();
	const state = useMachineSetupState();
	const loadError = useMachineSetupStore(store => store.loadError);
	if (state?.platform === "other") return null;
	return (
		<SettingsSection
			id="setting-machine-setup"
			// Settings › Updates & about holds this computer's tools beside the host's omp.
			scope="app"
			title={t("machineSetup.settings.title")}
		>
			{state && <OmpUpdateRows />}
			<DiskCareRow />
			{state ? (
				state.items.map(item => <SetupItemRow item={item} key={item.id} windows={state.platform === "win32"} />)
			) : loadError ? (
				<InlineNotice
					action={
						<Button onClick={() => void useMachineSetupStore.getState().load()} size="sm" variant="ghost">
							{t("common.retry")}
						</Button>
					}
					detail={loadError}
					title={t("machineSetup.loadFailed")}
					tone="danger"
				/>
			) : (
				<InlineNotice title={t("machineSetup.checking")} tone="pending" />
			)}
			{state && <CliUpdateRows />}
			{state && <ExtensionUpdateRows />}
			{state && <MemoryComponentRow />}
		</SettingsSection>
	);
}
