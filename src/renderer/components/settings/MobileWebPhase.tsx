/**
 * Settings › Mobile web: where setting it up stands, right under the switch. Each phase is one sentence and,
 * where the user (or the OS) must act, ONE primary button that sends the phase's next step to main
 * (`window.omp.mobileWeb.command`). Detecting and starting show a Spinner; a failure keeps the tool's own
 * words behind "Details". `ready` shows nothing here: the link and pairing sit in MobileWebConnect.
 */
import { ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { MobileWebInstall, MobileWebRequest, MobileWebState } from "../../../shared/mobile-web";
import type { SetupFailure } from "../../../shared/setup";
import { formatBytes, formatElapsed } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PLATFORM } from "../../lib/keymap";
import { useNowTick } from "../../lib/now-tick";
import { openExternal } from "../../lib/open-external";
import { mobileWebCommand } from "../../stores/mobile-web";
import { Banner, Button, CopyButton, InlineNotice, ProgressBar, Spinner } from "../common";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The requests a phase's button sends: the switch, the allowed users and the approval switch have their own controls. */
type PhaseAction = Exclude<
	MobileWebRequest["action"],
	"enable" | "set-allowed-users" | "set-confirm-new-devices" | "watch"
>;

/** Why Tailscale's install ended without it, as one sentence (setup's wording for the same reasons). */
function installFailureText(t: Translate, failure: SetupFailure): string {
	switch (failure.reason) {
		case "exit":
			return failure.exitCode === null || failure.exitCode === undefined
				? t("machineSetup.reason.exitUnknown")
				: t("machineSetup.reason.exit", { code: failure.exitCode });
		case "not-detected":
			return t("machineSetup.reason.notDetected", { name: "Tailscale" });
		case "prerequisite":
			return t("machineSetup.reason.prerequisite", { name: "Tailscale" });
		default:
			return t(`machineSetup.reason.${failure.reason}`);
	}
}

/** The running install's step, bytes and clock under a bar that fills only while main downloads. */
function InstallProgress({ install }: { install: MobileWebInstall }) {
	const t = useT();
	const progress = install.progress;
	const now = useNowTick(progress !== null);
	if (!progress) return null;
	const { download } = progress;
	const total = download?.total ?? null;
	const bytes =
		download === null
			? ""
			: total === null
				? t("machineSetup.progress.downloaded", { received: formatBytes(download.received) })
				: t("machineSetup.progress.download", {
						received: formatBytes(download.received),
						total: formatBytes(total),
					});
	const parts = [
		progress.steps > 1 ? t("mobileWeb.installStep", { step: progress.step, steps: progress.steps }) : "",
		bytes,
		formatElapsed(now - progress.startedAt),
	];
	return (
		<div className="flex min-w-0 flex-col gap-1" data-mobile-web-install-progress>
			<ProgressBar
				ariaLabel={t("mobileWeb.installLabel")}
				tone="progress"
				value={download && total !== null ? download.received / total : undefined}
			/>
			<p className="text-sc-xs break-words text-(--sc-text-muted) tabular-nums">
				{parts.filter(Boolean).join(" · ")}
			</p>
		</div>
	);
}

/** The tool's own words, closed by default. */
function DetailsDisclosure({ text }: { text: string }) {
	const t = useT();
	return (
		<details className="mt-1 min-w-0 text-sc-xs" data-mobile-web-details>
			<summary className="cursor-pointer text-(--sc-text-muted)">{t("mobileWeb.details")}</summary>
			<pre className="mt-1 max-h-40 overflow-auto rounded-(--sc-radius-sm) bg-(--sc-surface-2) p-2 font-mono break-all whitespace-pre-wrap text-(--sc-text-secondary) select-text">
				{text}
			</pre>
		</details>
	);
}

export function MobileWebPhasePanel({ state }: { state: MobileWebState }) {
	const t = useT();
	/** The action whose reply is pending, so its button shows a spinner and none is sent twice. */
	const [pending, setPending] = useState<PhaseAction | null>(null);
	const send = (request: MobileWebRequest & { action: PhaseAction }) => {
		setPending(request.action);
		void mobileWebCommand(request, t("mobileWeb.commandFailed")).finally(() => setPending(null));
	};
	const open = (url: string) => openExternal(url);
	const button = (action: PhaseAction, label: string, variant: "primary" | "secondary" | "ghost") => (
		<Button
			data-mobile-web-action={action}
			loading={pending === action}
			onClick={() => send({ action })}
			size="sm"
			variant={variant}
		>
			{label}
		</Button>
	);
	const retry = (
		<Button
			data-mobile-web-action="retry"
			icon={<RefreshCw />}
			loading={pending === "retry"}
			onClick={() => send({ action: "retry" })}
			size="sm"
			variant="secondary"
		>
			{t("common.retry")}
		</Button>
	);

	const funnel = state.funnelExposed && (
		<Banner actions={retry} className="mt-2" live title={t("mobileWeb.funnel.title")} variant="danger">
			{t("mobileWeb.funnel.body")}
		</Banner>
	);

	const body = (() => {
		switch (state.phase) {
			case "off":
			case "ready":
				return null;
			case "detecting":
			case "starting":
				return (
					<Spinner
						className="mt-2"
						label={t(state.phase === "detecting" ? "mobileWeb.phase.detecting" : "mobileWeb.phase.starting")}
						size="sm"
					/>
				);
			case "not-installed": {
				const failure = state.install?.failure;
				return (
					<>
						{failure && (
							<InlineNotice
								className="mt-1"
								detail={failure.detail}
								live
								title={`${t("mobileWeb.installFailed")} ${installFailureText(t, failure)}`}
								tone="danger"
							/>
						)}
						<Banner
							actions={
								<>
									{button("install", t("mobileWeb.install"), "primary")}
									{state.install?.manualUrl && (
										<Button
											icon={<ExternalLink />}
											onClick={() => open(state.install?.manualUrl ?? "")}
											size="sm"
											variant="ghost"
										>
											{t("mobileWeb.installManual")}
										</Button>
									)}
								</>
							}
							className="mt-2"
							title={t("mobileWeb.phase.notInstalled")}
						>
							{t("mobileWeb.phase.notInstalledDesc")}
						</Banner>
					</>
				);
			}
			case "installing":
				return (
					<div className="mt-2 flex min-w-0 flex-col gap-2">
						<div className="flex min-w-0 flex-wrap items-center gap-3">
							<Spinner label={t("mobileWeb.installing")} size="sm" />
							{button("cancel-install", t("common.cancel"), "ghost")}
						</div>
						{state.install && <InstallProgress install={state.install} />}
					</div>
				);
			case "app-not-running":
				return (
					<Banner actions={button("start-app", t("mobileWeb.startApp"), "primary")} className="mt-2">
						{t("mobileWeb.phase.appNotRunning")}
					</Banner>
				);
			case "needs-os-approval": {
				const windows = state.tailscale ? state.tailscale.variant === "windows" : PLATFORM === "windows";
				return (
					<Banner
						actions={
							windows ? undefined : button("open-system-settings", t("mobileWeb.openSystemSettings"), "primary")
						}
						className="mt-2"
						variant="warning"
					>
						{t(windows ? "mobileWeb.phase.needsOsApprovalWindows" : "mobileWeb.phase.needsOsApprovalMac")}
					</Banner>
				);
			}
			case "needs-login":
				return (
					<Banner actions={button("login", t("mobileWeb.signIn"), "primary")} className="mt-2">
						{t("mobileWeb.phase.needsLogin")}
					</Banner>
				);
			case "logging-in":
				return (
					<div className="mt-2 flex min-w-0 flex-wrap items-center gap-3">
						<Spinner label={t("mobileWeb.phase.loggingIn")} size="sm" />
						{button("login", t("mobileWeb.reopenLogin"), "secondary")}
						{button("disable", t("common.cancel"), "ghost")}
					</div>
				);
			case "needs-machine-approval":
				return (
					<Banner
						actions={
							state.guideUrl ? (
								<Button
									icon={<ExternalLink />}
									onClick={() => open(state.guideUrl ?? "")}
									size="sm"
									variant="primary"
								>
									{t("mobileWeb.openAdmin")}
								</Button>
							) : undefined
						}
						className="mt-2"
						title={t("mobileWeb.phase.needsMachineApproval")}
						variant="warning"
					>
						{t("mobileWeb.phase.needsMachineApprovalDesc")}
					</Banner>
				);
			case "https-disabled":
				return (
					<Banner
						actions={
							<Button
								disabled={!state.guideUrl}
								icon={<ExternalLink />}
								onClick={() => open(state.guideUrl ?? "")}
								size="sm"
								variant="primary"
							>
								{t("mobileWeb.enableHttps")}
							</Button>
						}
						className="mt-2"
						title={t("mobileWeb.phase.httpsDisabled")}
						variant="warning"
					>
						<p>{t("mobileWeb.phase.httpsDisabledDesc")}</p>
						<div className="mt-2 flex min-w-0 flex-col gap-1" data-mobile-web-admin-message>
							<span className="text-sc-xs font-medium text-(--sc-text-muted)">
								{t("mobileWeb.adminMessageLabel")}
							</span>
							<div className="flex min-w-0 items-start gap-1">
								<p className="min-w-0 flex-1 text-sc-sm break-words text-(--sc-text) select-text">
									{t("mobileWeb.adminMessage")}
								</p>
								<CopyButton label={t("mobileWeb.adminMessageCopy")} text={t("mobileWeb.adminMessage")} />
							</div>
						</div>
					</Banner>
				);
			case "serve-blocked":
			case "error":
				return (
					<Banner
						actions={retry}
						className="mt-2"
						live
						title={t(state.phase === "error" ? "mobileWeb.phase.error" : "mobileWeb.phase.serveBlocked")}
						variant="danger"
					>
						{state.detail && <DetailsDisclosure text={state.detail} />}
					</Banner>
				);
		}
	})();

	if (!body && !funnel) return null;
	return (
		<div data-mobile-web-phase={state.phase}>
			{funnel}
			{body}
		</div>
	);
}
