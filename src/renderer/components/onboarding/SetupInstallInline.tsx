/**
 * One optional machine-setup item installing for a connection the user started
 * (the GitHub sign-in needs gh, the built-in REA server needs Node.js), shown
 * inside that connection's own UI: "Installing GitHub CLI…" with its step,
 * bytes and clock while it runs, then, if it ended without the tool, the
 * reason and Retry. Main installs on its own (src/main/setup/); this only
 * shows setup's state for that item.
 */

import { ExternalLink, RefreshCw } from "lucide-react";
import type { SetupItemState } from "../../../shared/setup";
import { useT } from "../../lib/i18n";
import { Button, InlineNotice, Spinner } from "../common";
import { SETUP_ITEM_NAMES, SetupProgressLine, setupFailureText } from "./MachineSetupView";

export interface SetupInstallInlineProps {
	item: SetupItemState;
	/** Another attempt; the user's own, so it skips setup's back-off. */
	onRetry: () => void;
	/** Stops the running install (and what waited on it). */
	onCancel?: () => void;
}

/** Whether `item` has something to show inline: it is installing, waiting to, or its install ended without it. */
export function setupInstallShown(item: SetupItemState | undefined): item is SetupItemState {
	if (!item || item.presence?.kind === "present") return false;
	return ["queued", "running", "failed", "cancelled", "unavailable"].includes(item.phase);
}

export function SetupInstallInline({ item, onRetry, onCancel }: SetupInstallInlineProps) {
	const t = useT();
	const name = SETUP_ITEM_NAMES[item.id];
	const retry = (
		<Button icon={<RefreshCw />} onClick={onRetry} size="sm" variant="secondary" data-testid="setup-install-retry">
			{t("common.retry")}
		</Button>
	);
	if (item.phase === "queued" || item.phase === "running") {
		return (
			<div
				className="mt-3 flex min-w-0 flex-col gap-2"
				data-setup-install={item.id}
				data-setup-install-phase="running"
			>
				<div className="flex min-w-0 flex-wrap items-center gap-3">
					<Spinner
						label={t(item.phase === "queued" ? "connectInstall.queued" : "connectInstall.installing", { name })}
						size="sm"
					/>
					{onCancel && (
						<Button onClick={onCancel} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
					)}
				</div>
				<SetupProgressLine item={item} />
			</div>
		);
	}
	if (item.phase === "unavailable") {
		return (
			<InlineNotice
				action={
					<Button
						icon={<ExternalLink />}
						onClick={() => void window.omp.system.openExternal(item.manualUrl)}
						size="sm"
						variant="secondary"
					>
						{t("machineSetup.manual.open")}
					</Button>
				}
				className="mt-2"
				live
				title={t("connectInstall.unavailable", { name })}
				tone="info"
			/>
		);
	}
	const reason =
		item.phase === "cancelled"
			? t("connectInstall.cancelled", { name })
			: item.failure
				? setupFailureText(t, item, item.failure)
				: t("machineSetup.reason.unknown");
	return (
		<div data-setup-install={item.id} data-setup-install-phase="failed">
			<InlineNotice
				action={retry}
				className="mt-2"
				detail={item.failure?.detail}
				live
				title={`${t("connectInstall.failed", { name })} ${reason}`}
				tone="danger"
			/>
		</div>
	);
}
