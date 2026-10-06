/**
 * Settings › Updates: one honest overview (checking / up to date / update
 * available / could not verify) over two rows — the seucode desktop app and
 * the system omp CLI — each with its current/latest version and its action.
 */
import { Download, FolderOpen, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { UpdateStatus } from "../../../shared/ipc-types";
import type { RpcOmpUpdateResult, RpcOmpUpdateRunResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { useUpdaterStore } from "../../stores/updater";
import { Badge, Banner, type BannerVariant, Button, Spinner } from "../common";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

export type UpdateOverviewState = "checking" | "healthy" | "attention" | "error";

const OVERVIEW_BANNER: Record<UpdateOverviewState, BannerVariant> = {
	checking: "info",
	healthy: "success",
	attention: "warning",
	error: "danger",
};

const OVERVIEW_TITLE: Record<UpdateOverviewState, string> = {
	checking: "updates.systemChecking",
	healthy: "updates.systemHealthy",
	attention: "updates.systemAttention",
	error: "updates.systemError",
};

function appUpdateAvailable(status: UpdateStatus): boolean {
	return status.state === "available" || status.state === "downloading" || status.state === "downloaded";
}

/** Derive the honest aggregate state shown by the updates header. */
export function updateOverviewState(
	status: UpdateStatus,
	core: RpcOmpUpdateResult | undefined,
	coreError: string | undefined,
	checking: boolean,
): UpdateOverviewState {
	if (checking || status.state === "idle" || status.state === "checking") return "checking";
	if (status.state === "error" || coreError) return "error";
	if (!core) return "checking";
	if (appUpdateAvailable(status) || core.updateAvailable) return "attention";
	return "healthy";
}

export function UpdatesSection() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const status = useUpdaterStore(state => state.status);
	const setStatus = useUpdaterStore(state => state.setStatus);
	const [guiVersion, setGuiVersion] = useState<string>();
	const [core, setCore] = useState<RpcOmpUpdateResult>();
	const [checking, setChecking] = useState(false);
	const [coreError, setCoreError] = useState<string>();
	const [coreUpdating, setCoreUpdating] = useState(false);

	const check = useCallback(async () => {
		setChecking(true);
		setCoreError(undefined);
		const [appResult, coreResult] = await Promise.allSettled([
			window.omp.updater.check(),
			sidecarReady ? tabRpc.getOmpUpdate() : Promise.resolve(null),
		]);
		setStatus(
			appResult.status === "fulfilled"
				? appResult.value
				: {
						state: "error",
						message: appResult.reason instanceof Error ? appResult.reason.message : String(appResult.reason),
					},
		);
		if (coreResult.status === "fulfilled" && coreResult.value !== null && coreResult.value.success) {
			setCore(coreResult.value.data as RpcOmpUpdateResult);
		} else {
			setCoreError(
				!sidecarReady
					? t("common.notConnected")
					: coreResult.status === "rejected"
						? String(coreResult.reason)
						: coreResult.value === null || coreResult.value.success
							? t("updates.core.checkFailed")
							: coreResult.value.error,
			);
		}
		setChecking(false);
	}, [setStatus, sidecarReady, t, tabRpc.getOmpUpdate]);

	useEffect(() => {
		void window.omp.updater.version().then(setGuiVersion);
		void check();
	}, [check]);

	// Updates the user's system omp in place; running sessions keep their
	// already-loaded omp until they restart.
	const updateCore = useCallback(async () => {
		setCoreUpdating(true);
		try {
			const response = await tabRpc.ompUpdate();
			if (!response.success) {
				toast({ variant: "error", title: t("updates.core.updateFailed"), message: response.error });
				return;
			}
			const { version } = response.data as RpcOmpUpdateRunResult;
			toast({ variant: "success", message: t("updates.core.updated", { version }) });
			await check();
		} catch (cause) {
			toast({ variant: "error", title: t("updates.core.updateFailed"), message: String(cause) });
		} finally {
			setCoreUpdating(false);
		}
	}, [check, t, tabRpc.ompUpdate]);

	const overview = updateOverviewState(status, core, coreError, checking);
	const errorMessage = [status.state === "error" ? status.message : undefined, coreError].filter(Boolean).join(" · ");

	return (
		<SettingsSection
			actions={
				<Button disabled={checking} icon={<RefreshCw />} loading={checking} onClick={check} size="sm">
					{t("updates.checkAll")}
				</Button>
			}
		>
			<Banner className="my-3" live title={t(OVERVIEW_TITLE[overview])} variant={OVERVIEW_BANNER[overview]}>
				{overview === "error" && errorMessage ? errorMessage : t("updates.deliveryNote")}
			</Banner>

			<SettingsRow
				control={
					status.state === "available" ? (
						<Button
							icon={<Download />}
							onClick={() => void window.omp.updater.download()}
							size="sm"
							variant="primary"
						>
							{status.mode === "manual" ? t("updater.downloadInstaller") : t("updater.download")}
						</Button>
					) : status.state === "downloading" ? (
						<Badge variant="info">{status.percent}%</Badge>
					) : status.state === "downloaded" ? (
						<Button
							icon={status.mode === "manual" ? <FolderOpen /> : <RotateCcw />}
							onClick={() => void window.omp.updater.apply()}
							size="sm"
							variant="primary"
						>
							{status.mode === "manual" ? t("updater.openInstaller") : t("updater.restart")}
						</Button>
					) : status.state === "error" ? (
						<Badge variant="error">{t("updates.checkFailed")}</Badge>
					) : status.state === "not-available" ? (
						<Badge variant="success">{t("updates.upToDate")}</Badge>
					) : (
						<Spinner label={t("updates.checking")} size="sm" />
					)
				}
				description={t("updates.gui.description")}
				footer={
					<>
						<p className="mt-1 text-sc-xs text-(--sc-text-muted)">
							{t("updates.current")} <span className="font-mono text-(--sc-text)">{guiVersion ?? "—"}</span>
							{" · "}
							{t("updates.latest")}{" "}
							<span className="font-mono text-(--sc-text)">
								{guiVersion && "version" in status ? status.version : "—"}
							</span>
						</p>
						{status.state === "downloaded" && status.mode === "manual" && (
							<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("updater.manualInstructions")}</p>
						)}
					</>
				}
				label={t("updates.gui.name")}
			/>

			<SettingsRow
				control={
					coreError ? (
						<Badge variant="error">{t("updates.checkFailed")}</Badge>
					) : !core || checking ? (
						<Spinner label={t("updates.checking")} size="sm" />
					) : core.updateAvailable ? (
						<Button
							disabled={coreUpdating || !sidecarReady}
							icon={<Download />}
							loading={coreUpdating}
							onClick={() => void updateCore()}
							size="sm"
						>
							{coreUpdating ? t("updates.core.updating") : t("updates.core.update")}
						</Button>
					) : (
						<Badge variant="success">{t("updates.upToDate")}</Badge>
					)
				}
				description={t("updates.core.description")}
				footer={
					<p className="mt-1 text-sc-xs text-(--sc-text-muted)">
						{t("updates.current")}{" "}
						<span className="font-mono text-(--sc-text)">{core?.currentVersion ?? "—"}</span>
						{" · "}
						{t("updates.latest")} <span className="font-mono text-(--sc-text)">{core?.latestVersion ?? "—"}</span>
					</p>
				}
				label={t("updates.core.name")}
			/>
		</SettingsSection>
	);
}
