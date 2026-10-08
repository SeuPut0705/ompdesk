/**
 * Settings › Updates: one honest overview (checking / up to date / update
 * available / could not verify) over the ompdesk desktop app, the GitHub
 * login its private release feed needs, and the system omp CLI — each with
 * its current state and its action.
 */
import { Download, FolderOpen, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { UpdateAccess, UpdateAuthInfo, UpdateStatus } from "../../../shared/ipc-types";
import type { RpcOmpUpdateResult, RpcOmpUpdateRunResult } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useFocusedHost } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { useUpdaterStore } from "../../stores/updater";
import { Badge, Banner, type BannerVariant, Button, ErrorDetail, Input, Spinner } from "../common";
import { DeviceChip } from "../remote/DeviceChip";
import { HostScoped, ThisDeviceTag } from "../remote/HostScope";
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

const ACCESS_MESSAGE: Record<UpdateAccess, string> = {
	ok: "updates.auth.ok",
	missing: "updates.auth.missing",
	invalid: "updates.auth.invalid",
	denied: "updates.auth.denied",
	network: "updates.auth.network",
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
	if (status.state === "auth-required" || appUpdateAvailable(status) || core.updateAvailable) return "attention";
	return "healthy";
}

export function UpdatesSection() {
	const tabRpc = useTabRpc();
	const t = useT();
	const host = useFocusedHost();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const status = useUpdaterStore(state => state.status);
	const setStatus = useUpdaterStore(state => state.setStatus);
	const [guiVersion, setGuiVersion] = useState<string>();
	const [core, setCore] = useState<RpcOmpUpdateResult>();
	const [checking, setChecking] = useState(false);
	const [coreError, setCoreError] = useState<InlineFailure>();
	const [coreUpdating, setCoreUpdating] = useState(false);

	// The app check and the omp check settle independently: `omp update
	// --check` can take up to a minute on a slow network, and the app's own
	// result must not wait behind it.
	const checkApp = useCallback(async () => {
		try {
			setStatus(await window.omp.updater.check());
		} catch (error) {
			setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}, [setStatus]);
	const checkCore = useCallback(async () => {
		setChecking(true);
		setCoreError(undefined);
		const fallback = t("updates.core.checkFailed");
		try {
			if (!sidecarReady) {
				setCoreError({ message: t("common.notConnected") });
				return;
			}
			const response = await tabRpc.getOmpUpdate();
			if (response.success) setCore(response.data as RpcOmpUpdateResult);
			else setCoreError(inlineFailure(response, fallback));
		} catch (error) {
			setCoreError(inlineFailure(error, fallback));
		} finally {
			setChecking(false);
		}
	}, [sidecarReady, t, tabRpc.getOmpUpdate]);
	const check = useCallback(async () => {
		await Promise.all([checkApp(), checkCore()]);
	}, [checkApp, checkCore]);

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
				toastError({ title: t("updates.core.updateFailed"), error: response });
				return;
			}
			const { version } = response.data as RpcOmpUpdateRunResult;
			toast({ variant: "success", message: t("updates.core.updated", { version }) });
			await check();
		} catch (cause) {
			toastError({ title: t("updates.core.updateFailed"), error: cause });
		} finally {
			setCoreUpdating(false);
		}
	}, [check, t, tabRpc.ompUpdate]);

	const overview = updateOverviewState(status, core, coreError?.message, checking);
	const appError = status.state === "error" ? status.message : null;

	return (
		<SettingsSection
			actions={
				<Button disabled={checking} icon={<RefreshCw />} loading={checking} onClick={check} size="sm">
					{t("updates.checkAll")}
				</Button>
			}
		>
			<Banner className="my-3" live title={t(OVERVIEW_TITLE[overview])} variant={OVERVIEW_BANNER[overview]}>
				{overview === "error" && (appError || coreError) ? (
					// One line per component: the app's message, then omp's own (often raw CLI) error, quieter.
					<>
						{appError && <ErrorDetail error={appError} />}
						{coreError && (
							<>
								<ErrorDetail className="mt-0.5" error={`omp: ${coreError.message}`} />
								{coreError.cause !== undefined && <ErrorDetail className="mt-0.5" error={coreError.cause} />}
							</>
						)}
					</>
				) : status.state === "auth-required" ? (
					t(ACCESS_MESSAGE[status.reason])
				) : (
					t("updates.deliveryNote")
				)}
			</Banner>

			<SettingsRow
				badge={<ThisDeviceTag />}
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
					) : status.state === "auth-required" ? (
						<Badge variant="warning">{t("updates.authRequired")}</Badge>
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

			<UpdateAuthRow onChanged={check} />

			<HostScoped>
				<SettingsRow
					badge={host && <DeviceChip deviceId={host.deviceId} />}
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
							{t("updates.latest")}{" "}
							<span className="font-mono text-(--sc-text)">{core?.latestVersion ?? "—"}</span>
						</p>
					}
					label={t("updates.core.name")}
				/>
			</HostScoped>
		</SettingsSection>
	);
}

/**
 * GitHub login for the private release feed: which source the updater uses
 * (env → gh → saved token), a masked field to save a token (encrypted by the
 * main process), a test, and removal of the saved token.
 */
function UpdateAuthRow({ onChanged }: { onChanged: () => Promise<void> }) {
	const t = useT();
	const [info, setInfo] = useState<UpdateAuthInfo>();
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<UpdateAccess>();

	useEffect(() => {
		void window.omp.updater.authInfo().then(setInfo);
	}, []);

	const run = useCallback(
		async (action: "test" | "save" | "clear") => {
			setBusy(true);
			setResult(undefined);
			try {
				if (action === "clear") {
					setInfo(await window.omp.updater.clearAuth());
				} else {
					const pasted = draft.trim();
					const outcome =
						action === "save"
							? await window.omp.updater.saveAuth(pasted)
							: await window.omp.updater.testAuth(pasted || undefined);
					setResult(outcome.access);
					if (action === "save" && outcome.access === "ok") setDraft("");
					setInfo(await window.omp.updater.authInfo());
				}
				if (action !== "test") await onChanged();
			} catch (error) {
				toastError({ title: t("updates.auth.failed"), error });
			} finally {
				setBusy(false);
			}
		},
		[draft, onChanged, t],
	);

	const source = info?.source ?? "none";
	return (
		<SettingsRow
			badge={<ThisDeviceTag />}
			control={
				info === undefined ? (
					<Spinner label={t("updates.checking")} size="sm" />
				) : (
					<Badge variant={info.source ? "success" : "warning"}>{t(`updates.auth.source.${source}`)}</Badge>
				)
			}
			description={t("updates.auth.description")}
			footer={
				<div className="mt-2 flex flex-col gap-2">
					{info?.canStore === false ? (
						<p className="text-sc-xs text-(--sc-text-muted)">{t("updates.auth.cannotStore")}</p>
					) : (
						<div className="flex flex-wrap items-center gap-2">
							<Input
								aria-label={t("updates.auth.tokenLabel")}
								autoComplete="off"
								className="min-w-60 flex-1"
								disabled={busy}
								mono
								onChange={event => setDraft(event.target.value)}
								placeholder={t("updates.auth.placeholder")}
								spellCheck={false}
								type="password"
								value={draft}
							/>
							<Button
								disabled={busy || draft.trim().length === 0}
								onClick={() => void run("save")}
								size="sm"
								variant="primary"
							>
								{t("updates.auth.save")}
							</Button>
						</div>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<Button disabled={busy} loading={busy} onClick={() => void run("test")} size="sm">
							{t("updates.auth.test")}
						</Button>
						{info?.hasStoredToken && (
							<Button disabled={busy} onClick={() => void run("clear")} size="sm" variant="ghost">
								{t("updates.auth.clear")}
							</Button>
						)}
					</div>
					{result && (
						<p
							className={`text-sc-xs ${result === "ok" ? "text-(--sc-text-muted)" : "text-(--sc-danger)"}`}
							role="status"
						>
							{t(ACCESS_MESSAGE[result])}
						</p>
					)}
				</div>
			}
			label={t("updates.auth.label")}
		/>
	);
}
