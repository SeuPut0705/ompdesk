/**
 * Settings › Updates: one honest overview (checking / up to date / update
 * available / could not verify) over the ompdesk desktop app, the optional
 * GitHub token for its release feed, and the system omp CLI — each with
 * its current state and its action — then diagnostics (stock
 * `omp plugin doctor`, plus a way to this computer's setup check) and About
 * (the repository and its star).
 */
import {
	Cpu,
	Download,
	FolderOpen,
	KeyRound,
	Package,
	RefreshCw,
	RotateCcw,
	Server,
	Star,
	Stethoscope,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	HostDesktopState,
	HostUpdateAction,
	UpdateAccess,
	UpdateAuthInfo,
	UpdateStatus,
} from "../../../shared/ipc-types";
import type { OmpUpdateState } from "../../../shared/omp-update";
import type { RpcDoctorCheck, RpcOmpUpdateResult, RpcPluginDoctorResult } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSecondsUntil } from "../../lib/use-seconds-until";
import { useFocusedHost, useHostView } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { useUpdaterStore } from "../../stores/updater";
import {
	Badge,
	Banner,
	type BannerVariant,
	BrandMark,
	Button,
	ErrorDetail,
	Input,
	ProgressBar,
	Spinner,
} from "../common";
import { DeviceChip } from "../remote/DeviceChip";
import { HostScoped } from "../remote/HostScope";
import { AppAutoUpdateRow } from "./AppAutoUpdateRow";
import { DiagnosticsRow } from "./DiagnosticsRow";
import { OmpUpdateFailureNotice } from "./OmpUpdateRows";
import { ProductStar } from "./ProductStar";
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

/**
 * One line per component under the failed-check banner: the app's and omp's
 * localized sentences read as text, each raw cause quieter beneath it.
 */
export function UpdateFailureLines({
	app,
	core,
}: {
	app: Extract<UpdateStatus, { state: "error" }> | null;
	core: InlineFailure | undefined;
}) {
	return (
		<>
			{app && (
				<>
					<span className="block">{app.message}</span>
					{app.detail && <ErrorDetail error={app.detail} />}
				</>
			)}
			{core && (
				<>
					<span className="mt-0.5 block">omp: {core.message}</span>
					{core.cause !== undefined && <ErrorDetail error={core.cause} />}
				</>
			)}
		</>
	);
}

/**
 * A row's running update: the app download with its percent, the omp update
 * (which reports none) as an indeterminate bar.
 */
export function UpdateProgress({ percent, label }: { percent?: number; label: string }) {
	return (
		<ProgressBar
			ariaLabel={label}
			className="w-32"
			tone="progress"
			value={percent === undefined ? undefined : percent / 100}
		/>
	);
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

	const overview = updateOverviewState(status, core, coreError?.message, checking);
	const appError = status.state === "error" ? status : null;

	return (
		<SettingsSection>
			{/* The check sits on the brand's line: the section needs no header row of its own. */}
			<div className="mb-3 flex items-center gap-3" data-about-brand>
				<BrandMark size={40} variant="tile" />
				<div className="min-w-0 flex-1">
					<div className="text-sc-lg font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)">OMPdesk</div>
					<div className="font-mono text-sc-xs text-(--sc-text-muted)">{guiVersion ? `v${guiVersion}` : "—"}</div>
				</div>
				<Button disabled={checking} icon={<RefreshCw />} loading={checking} onClick={check} size="sm">
					{t("updates.checkAll")}
				</Button>
			</div>

			<Banner className="my-3" live title={t(OVERVIEW_TITLE[overview])} variant={OVERVIEW_BANNER[overview]}>
				{overview === "error" && (appError || coreError) ? (
					<UpdateFailureLines app={appError} core={coreError} />
				) : status.state === "auth-required" ? (
					t(ACCESS_MESSAGE[status.reason])
				) : undefined}
			</Banner>

			<SettingsRow
				badge={host ? <Badge variant="muted">{t("settings.navGroup.app")}</Badge> : undefined}
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
						<UpdateProgress label={t("updates.gui.downloading")} percent={status.percent} />
					) : status.state === "downloaded" && status.installing ? (
						<Spinner label={t("updater.card.installing", { version: status.version })} size="sm" />
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
				footer={
					<>
						{/* The brand line above names this version; the row says only what is newer. */}
						{status.state !== "not-available" && "version" in status && status.version !== guiVersion && (
							<p className="mt-1 text-sc-xs text-(--sc-text-muted)">
								{t("updates.latest")} <span className="font-mono text-(--sc-text)">{status.version}</span>
							</p>
						)}
						{status.state === "downloaded" && status.mode === "manual" && (
							<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("updater.manualInstructions")}</p>
						)}
						{status.state === "downloaded" && status.restartAt !== undefined && (
							<AutoRestartNotice restartAt={status.restartAt} />
						)}
					</>
				}
				icon={<Package />}
				label={t("updates.gui.name")}
			/>

			<AppAutoUpdateRow />

			<UpdateAuthRow onChanged={check} />

			{/* This computer's omp is updated below (auto switch, Update now); this row is a paired host's omp, updated by that host's own OmpUpdater. */}
			{host && (
				<HostScoped>
					<HostOmpUpdateRow
						checking={checking}
						core={core}
						coreError={coreError}
						deviceId={host.deviceId}
						onSettled={checkCore}
					/>
				</HostScoped>
			)}

			{host && (
				<HostScoped>
					<HostDesktopRow deviceId={host.deviceId} key={host.deviceId} />
				</HostScoped>
			)}

			<PluginDoctorRow />

			<DiagnosticsRow />

			<SettingsRow
				control={<ProductStar />}
				description={t("about.repoDesc")}
				tipOnly
				icon={<Star />}
				id="setting-about-star"
				label={t("about.repo")}
			/>
		</SettingsSection>
	);
}

/** The quiet line before an automatic restart: the countdown, "Now" and "Later". Never a modal. */
function AutoRestartNotice({ restartAt }: { restartAt: number }) {
	const t = useT();
	const seconds = useSecondsUntil(restartAt) ?? 0;
	return (
		<p className="mt-1 flex items-center gap-2 text-sc-xs text-(--sc-text-muted)" data-testid="auto-restart-notice">
			<span>{t("updater.card.autoRestart", { seconds })}</span>
			<Button onClick={() => void window.omp.updater.apply()} size="sm" variant="primary">
				{t("updater.card.restartNow")}
			</Button>
			<Button onClick={() => void window.omp.updater.postpone()} size="sm" variant="ghost">
				{t("updater.card.later")}
			</Button>
		</p>
	);
}

/**
 * omp on the paired host the focused tab runs on: what `omp update --check` says there, and an update
 * run by that host's own OmpUpdater (helpers released and resumed, the setup supervisor, its tabs moved
 * to the new omp, one run at a time with its scheduled one). Its state is the one the host's own row shows:
 * read once, then followed through the host's pushes.
 */
export function HostOmpUpdateRow({
	deviceId,
	core,
	coreError,
	checking,
	onSettled,
}: {
	deviceId: string;
	core: RpcOmpUpdateResult | undefined;
	coreError: InlineFailure | undefined;
	checking: boolean;
	/** The host's check or update ended: read what `omp update --check` says there again. */
	onSettled: () => void;
}) {
	const t = useT();
	const hostName = useHostView(deviceId)?.name ?? t("remote.tab.unknownDevice");
	const [state, setState] = useState<OmpUpdateState>();
	const busy = state !== undefined && state.phase !== "idle";
	const wasBusy = useRef(false);
	const updatedToAtStart = useRef<string | null>(null);

	useEffect(() => {
		setState(undefined);
		let live = true;
		const unsubscribe = window.omp.hostOmpUpdate.onState(update => {
			if (update.device === deviceId) setState(update.state);
		});
		// Unreadable: the row keeps what `omp update --check` says.
		window.omp.hostOmpUpdate.get(deviceId).then(
			next => live && setState(next),
			() => undefined,
		);
		return () => {
			live = false;
			unsubscribe();
		};
	}, [deviceId]);

	useEffect(() => {
		if (!state) return;
		if (busy) {
			if (!wasBusy.current) updatedToAtStart.current = state.updatedTo;
			wasBusy.current = true;
			return;
		}
		if (!wasBusy.current) return;
		wasBusy.current = false;
		onSettled();
		if (state.failure === null && state.updatedTo !== null && state.updatedTo !== updatedToAtStart.current) {
			toast({ variant: "success", message: t("updates.core.updated", { version: state.updatedTo }) });
		}
	}, [busy, onSettled, state, t]);

	const update = async () => {
		try {
			setState(await window.omp.hostOmpUpdate.now(deviceId));
		} catch (cause) {
			toastError({ title: t("updates.core.updateFailed"), error: cause });
		}
	};

	return (
		<SettingsRow
			badge={<DeviceChip deviceId={deviceId} />}
			control={
				coreError ? (
					<Badge variant="error">{t("updates.checkFailed")}</Badge>
				) : busy ? (
					<UpdateProgress
						label={t(state.phase === "updating" ? "updates.core.updating" : "ompUpdate.status.checking")}
					/>
				) : !core || checking ? (
					<Spinner label={t("updates.checking")} size="sm" />
				) : core.updateAvailable ? (
					<Button icon={<Download />} onClick={() => void update()} size="sm">
						{t("updates.core.update")}
					</Button>
				) : (
					<Badge variant="success">{t("updates.upToDate")}</Badge>
				)
			}
			description={t("updates.core.hostDescription", { device: hostName })}
			tipOnly
			footer={
				<>
					<p className="mt-1 text-sc-xs text-(--sc-text-muted)">
						{t("updates.current")}{" "}
						<span className="font-mono text-(--sc-text)">{core?.currentVersion ?? "—"}</span>
						{" · "}
						{t("updates.latest")} <span className="font-mono text-(--sc-text)">{core?.latestVersion ?? "—"}</span>
					</p>
					{state && <OmpUpdateFailureNotice state={state} />}
				</>
			}
			icon={<Cpu />}
			label={t("updates.core.name")}
		/>
	);
}

/** How often the host row re-reads a host's check or download in progress. */
const HOST_UPDATE_POLL_MS = 1500;

/**
 * B26: OMPdesk on the paired host the focused tab runs on — its version and
 * updater state, with Check, Download and Install & restart run on the host.
 * The host refuses an install while anything runs there (`host_busy`) and one
 * that needs someone at it (`update_not_ready`, the macOS manual installer).
 */
export function HostDesktopRow({ deviceId }: { deviceId: string }) {
	const t = useT();
	const [state, setState] = useState<HostDesktopState>();
	const [failure, setFailure] = useState<InlineFailure>();
	const [pending, setPending] = useState<HostUpdateAction>();
	const updateState = state?.update.state;

	const read = useCallback(async () => {
		try {
			setState(await window.omp.hostDesktop.get(deviceId));
			setFailure(undefined);
		} catch (error) {
			setFailure(inlineFailure(error, t("updates.host.readFailed")));
		}
	}, [deviceId, t]);

	useEffect(() => {
		void read();
	}, [read]);

	// The host's check and download run on after its reply; follow them to their end.
	useEffect(() => {
		if (updateState !== "checking" && updateState !== "downloading") return;
		const timer = setInterval(() => void read(), HOST_UPDATE_POLL_MS);
		return () => clearInterval(timer);
	}, [read, updateState]);

	const run = async (action: HostUpdateAction) => {
		setPending(action);
		try {
			setState(await window.omp.hostDesktop.update(action, deviceId));
			if (action === "install") toast({ variant: "success", message: t("updates.host.installing") });
		} catch (error) {
			toastError({ title: t("updates.host.actionFailed"), error });
		} finally {
			setPending(undefined);
		}
	};

	const status = state?.update;
	const control = failure ? (
		<Button icon={<RefreshCw />} onClick={() => void read()} size="sm" variant="secondary">
			{t("common.retry")}
		</Button>
	) : !status || status.state === "checking" || pending === "check" ? (
		<Spinner label={t("updates.checking")} size="sm" />
	) : status.state === "available" ? (
		<Button
			icon={<Download />}
			loading={pending === "download"}
			onClick={() => void run("download")}
			size="sm"
			variant="primary"
		>
			{t("updates.host.download")}
		</Button>
	) : status.state === "downloading" ? (
		<UpdateProgress label={t("updates.gui.downloading")} percent={status.percent} />
	) : status.state === "downloaded" ? (
		status.mode === "manual" ? (
			<Badge variant="warning">{t("updates.host.manual")}</Badge>
		) : (
			<Button
				icon={<RotateCcw />}
				loading={pending === "install"}
				onClick={() => void run("install")}
				size="sm"
				variant="primary"
			>
				{t("updates.host.install")}
			</Button>
		)
	) : (
		<div className="flex items-center gap-2">
			{status.state === "error" ? (
				<Badge variant="error">{t("updates.checkFailed")}</Badge>
			) : status.state === "auth-required" ? (
				<Badge variant="warning">{t("updates.authRequired")}</Badge>
			) : status.state === "not-available" ? (
				<Badge variant="success">{t("updates.upToDate")}</Badge>
			) : null}
			<Button icon={<RefreshCw />} onClick={() => void run("check")} size="sm" variant="secondary">
				{t("updates.host.check")}
			</Button>
		</div>
	);

	return (
		<SettingsRow
			badge={<DeviceChip deviceId={deviceId} />}
			control={control}
			description={t("updates.host.description")}
			tipOnly
			footer={
				<>
					<p className="mt-1 text-sc-xs text-(--sc-text-muted)" data-host-desktop-version>
						{t("updates.current")} <span className="font-mono text-(--sc-text)">{state?.version ?? "—"}</span>
						{" · "}
						{t("updates.latest")}{" "}
						<span className="font-mono text-(--sc-text)">
							{status && "version" in status ? status.version : "—"}
						</span>
					</p>
					{failure ? (
						<p className="mt-1 text-sc-xs text-(--sc-danger)" role="alert">
							{failure.message}
						</p>
					) : status?.state === "error" ? (
						<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{status.message}</p>
					) : status?.state === "auth-required" ? (
						<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("updates.host.authRequired")}</p>
					) : status?.state === "downloaded" && status.mode === "manual" ? (
						<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("updates.host.manualHint")}</p>
					) : null}
				</>
			}
			icon={<Server />}
			id="setting-updates-host"
			label={t("updates.host.name")}
		/>
	);
}

const DOCTOR_BADGE: Record<RpcDoctorCheck["status"], "success" | "warning" | "error"> = {
	ok: "success",
	warning: "warning",
	error: "error",
};

/**
 * Diagnostics (mixdog's "Run doctor"): stock `omp plugin doctor --json` on the
 * tab's machine, run on demand; this computer's Bun/omp/Git/gh/Node check lives
 * in Settings › General › Machine setup, one click away.
 */
function PluginDoctorRow() {
	const t = useT();
	const tabRpc = useTabRpc();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const [result, setResult] = useState<RpcPluginDoctorResult>();
	const [error, setError] = useState<InlineFailure>();
	const [running, setRunning] = useState(false);
	const run = async () => {
		setRunning(true);
		setError(undefined);
		try {
			const response = await tabRpc.getPluginDoctor();
			if (response.success) setResult(response.data as RpcPluginDoctorResult);
			else setError(inlineFailure(response, t("diagnostics.failed")));
		} catch (cause) {
			setError(inlineFailure(cause, t("diagnostics.failed")));
		} finally {
			setRunning(false);
		}
	};
	const problems = result?.checks.filter(check => check.status !== "ok").length ?? 0;
	return (
		<HostScoped>
			<SettingsRow
				control={
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button
							icon={<Wrench />}
							onClick={() => useUiStore.getState().openSettings("updates:setting-machine-setup")}
							size="sm"
							variant="ghost"
						>
							{t("diagnostics.machine")}
						</Button>
						<Button
							disabled={!sidecarReady || running}
							icon={<Stethoscope />}
							loading={running}
							onClick={() => void run()}
							size="sm"
						>
							{t("diagnostics.run")}
						</Button>
					</div>
				}
				description={t("diagnostics.description")}
				tipOnly
				footer={
					error ? (
						<div className="mt-2 text-sc-xs text-(--sc-danger)" role="alert">
							<span className="block">{error.message}</span>
							{error.cause !== undefined && <ErrorDetail error={error.cause} />}
						</div>
					) : result ? (
						<div className="mt-2 flex flex-col gap-1" data-plugin-doctor>
							<p className="text-sc-xs text-(--sc-text-muted)">
								{problems === 0 ? t("diagnostics.allOk") : t("diagnostics.problems", { count: problems })}
							</p>
							<ul className="flex flex-col gap-1">
								{result.checks.map(check => (
									<li
										className="flex min-w-0 items-start gap-2 text-sc-xs"
										data-doctor-check={check.name}
										key={check.name}
									>
										<Badge variant={DOCTOR_BADGE[check.status]}>
											{t(`diagnostics.status.${check.status}`)}
										</Badge>
										<span className="min-w-0 font-mono break-all text-(--sc-text)">{check.name}</span>
										<span className="min-w-0 flex-1 break-words text-(--sc-text-muted)">{check.message}</span>
									</li>
								))}
							</ul>
						</div>
					) : null
				}
				icon={<Stethoscope />}
				id="setting-diagnostics"
				label={t("diagnostics.name")}
			/>
		</HostScoped>
	);
}

/**
 * Optional GitHub token for the update check (releases are public): which
 * source the updater uses (env → gh → saved token; none = anonymous), a masked
 * field to save a token (encrypted by the main process), a test, and removal
 * of the saved token.
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
			id="settings-updates-auth"
			control={
				info === undefined ? (
					<Spinner label={t("updates.checking")} size="sm" />
				) : (
					<Badge variant={info.source ? "success" : "muted"}>{t(`updates.auth.source.${source}`)}</Badge>
				)
			}
			description={t("updates.auth.description")}
			tipOnly
			footer={
				<div className="mt-1 flex flex-col gap-1">
					{info?.canStore === false && (
						<p className="text-sc-xs text-(--sc-text-muted)">{t("updates.auth.cannotStore")}</p>
					)}
					{/* One line: the field, then save, test and remove (it wraps only in a narrow column). */}
					<div className="flex flex-wrap items-center gap-2" data-updates-auth-actions>
						{info?.canStore !== false && (
							<>
								<Input
									aria-label={t("updates.auth.tokenLabel")}
									autoComplete="off"
									className="min-w-48 flex-1"
									controlSize="sm"
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
							</>
						)}
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
			icon={<KeyRound />}
			label={t("updates.auth.label")}
		/>
	);
}
